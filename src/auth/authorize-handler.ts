import express from 'express';
import { rateLimit, Options as RateLimitOptions } from 'express-rate-limit';
import { z } from 'zod';
import { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InvalidClientError,
  InvalidRequestError,
  InvalidScopeError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { allowedMethods } from '@modelcontextprotocol/sdk/server/auth/middleware/allowedMethods.js';

const ClientAuthorizationParamsSchema = z.object({
  client_id: z.string(),
  redirect_uri: z
    .string()
    .optional()
    .refine((value) => value === undefined || URL.canParse(value), { message: 'redirect_uri must be a valid URL' }),
});

const RequestAuthorizationParamsSchema = z.object({
  response_type: z.literal('code'),
  code_challenge: z.string(),
  code_challenge_method: z.literal('S256'),
  scope: z.string().optional(),
  state: z.string().optional(),
});

interface AuthorizationHandlerOptions {
  provider: OAuthServerProvider;
  rateLimit?: Partial<RateLimitOptions> | false;
}

function isLoopbackRedirect(redirectUri?: string) {
  if (!redirectUri) return false;
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function createErrorRedirect(redirectUri: string, error: OAuthError, state?: string, larkMcpError?: string) {
  const errorUrl = new URL(redirectUri);
  errorUrl.searchParams.set('error', error.errorCode);
  errorUrl.searchParams.set('error_description', error.message);
  if (larkMcpError) {
    errorUrl.searchParams.set('lark_mcp_error', larkMcpError);
  }
  if (error.errorUri) {
    errorUrl.searchParams.set('error_uri', error.errorUri);
  }
  if (state) {
    errorUrl.searchParams.set('state', state);
  }
  return errorUrl.href;
}

function renderBrowserError(error: OAuthError, larkMcpError?: string) {
  const code = larkMcpError || error.errorCode;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Lark MCP Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
    .card { max-width: 720px; padding: 32px; border-radius: 16px; background: #111827; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
    h1 { margin: 0 0 12px; color: #fca5a5; }
    p { line-height: 1.6; color: #cbd5e1; }
    code { display: block; margin-top: 16px; padding: 12px; border-radius: 12px; background: #1f2937; color: #fecaca; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorization Failed</h1>
    <p>The MCP authorization request could not be completed.</p>
    <code>${code}: ${error.message}</code>
  </div>
</body>
</html>`;
}

export function larkAuthorizationHandler({ provider, rateLimit: rateLimitConfig }: AuthorizationHandlerOptions) {
  const router = express.Router();

  router.use(allowedMethods(['GET', 'POST']));
  router.use(express.urlencoded({ extended: false }));

  if (rateLimitConfig !== false) {
    router.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        message: new TooManyRequestsError(
          'You have exceeded the rate limit for authorization requests',
        ).toResponseObject(),
        ...rateLimitConfig,
      }),
    );
  }

  router.all('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    let client_id: string;
    let redirect_uri: string | undefined;
    let client: Awaited<ReturnType<typeof provider.clientsStore.getClient>>;
    let state: string | undefined;

    try {
      const clientParams = ClientAuthorizationParamsSchema.safeParse(req.method === 'POST' ? req.body : req.query);
      if (!clientParams.success) {
        throw new InvalidRequestError(clientParams.error.message);
      }

      client_id = clientParams.data.client_id;
      redirect_uri = clientParams.data.redirect_uri;
      client = await provider.clientsStore.getClient(client_id);
      if (!client) {
        throw new InvalidClientError('Invalid client_id');
      }

      if (redirect_uri !== undefined) {
        if (!client.redirect_uris.includes(redirect_uri)) {
          throw new InvalidRequestError('Unregistered redirect_uri');
        }
      } else if (client.redirect_uris.length === 1) {
        redirect_uri = client.redirect_uris[0];
      } else {
        throw new InvalidRequestError('redirect_uri must be specified when client has multiple registered URIs');
      }
    } catch (error) {
      if (error instanceof OAuthError) {
        if (error instanceof InvalidClientError && isLoopbackRedirect(redirect_uri)) {
          res.redirect(302, createErrorRedirect(redirect_uri!, error, undefined, 'invalid_client'));
          return;
        }

        const status = error instanceof ServerError ? 500 : 400;
        res.status(status).type('html').send(renderBrowserError(error, error.errorCode));
        return;
      }

      const serverError = new ServerError('Internal Server Error');
      res.status(500).type('html').send(renderBrowserError(serverError, 'server_error'));
      return;
    }

    try {
      const authParams = RequestAuthorizationParamsSchema.safeParse(req.method === 'POST' ? req.body : req.query);
      if (!authParams.success) {
        throw new InvalidRequestError(authParams.error.message);
      }

      const { scope, code_challenge, state: nextState } = authParams.data;
      state = nextState;
      let requestedScopes: string[] = [];
      if (scope !== undefined) {
        requestedScopes = scope.split(' ');
        const allowedScopes = new Set(client!.scope?.split(' '));
        for (const requestedScope of requestedScopes) {
          if (!allowedScopes.has(requestedScope)) {
            throw new InvalidScopeError(`Client was not registered with scope ${requestedScope}`);
          }
        }
      }

      await provider.authorize(
        client!,
        {
          state,
          scopes: requestedScopes,
          redirectUri: redirect_uri!,
          codeChallenge: code_challenge,
        },
        res,
      );
    } catch (error) {
      if (error instanceof OAuthError) {
        res.redirect(302, createErrorRedirect(redirect_uri!, error, state, error.errorCode));
        return;
      }

      const serverError = new ServerError('Internal Server Error');
      res.redirect(302, createErrorRedirect(redirect_uri!, serverError, state, 'server_error'));
    }
  });

  return router;
}
