import crypto from 'crypto';
import express from 'express';
import { z } from 'zod';
import { authenticateClient } from '@modelcontextprotocol/sdk/server/auth/middleware/clientAuth.js';
import { rateLimit, Options as RateLimitOptions } from 'express-rate-limit';
import { allowedMethods } from '@modelcontextprotocol/sdk/server/auth/middleware/allowedMethods.js';
import {
  OAuthError,
  ServerError,
  TooManyRequestsError,
  UnsupportedGrantTypeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { LarkInvalidRequestError, LarkServerError } from './errors';

const cors = require('cors');

const TokenRequestSchema = z.object({
  grant_type: z.string(),
});

const AuthorizationCodeGrantSchema = z.object({
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string().optional(),
});

const RefreshTokenGrantSchema = z.object({
  refresh_token: z.string(),
  scope: z.string().optional(),
});

interface TokenHandlerOptions {
  provider: OAuthServerProvider;
  rateLimit?: Partial<RateLimitOptions> | false;
}

async function verifyPkceChallenge(codeVerifier: string, expectedChallenge: string) {
  const challenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return challenge === expectedChallenge;
}

export function larkTokenHandler({ provider, rateLimit: rateLimitConfig }: TokenHandlerOptions) {
  const router = express.Router();

  router.use(cors());
  router.use(allowedMethods(['POST']));
  router.use(express.urlencoded({ extended: false }));
  router.use(express.json());

  if (rateLimitConfig !== false) {
    router.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 50,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          ...new TooManyRequestsError('You have exceeded the rate limit for token requests').toResponseObject(),
          lark_mcp_error: 'server_error',
        },
        ...rateLimitConfig,
      }),
    );
  }

  router.use(authenticateClient({ clientsStore: provider.clientsStore }));

  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
      const tokenRequest = TokenRequestSchema.safeParse(req.body);
      if (!tokenRequest.success) {
        throw new LarkInvalidRequestError(tokenRequest.error.message);
      }

      const { grant_type } = tokenRequest.data;
      const client = req.client;
      if (!client) {
        throw new LarkServerError('Internal Server Error');
      }

      switch (grant_type) {
        case 'authorization_code': {
          const authorizationCodeRequest = AuthorizationCodeGrantSchema.safeParse(req.body);
          if (!authorizationCodeRequest.success) {
            throw new LarkInvalidRequestError(authorizationCodeRequest.error.message);
          }

          const { code, code_verifier, redirect_uri } = authorizationCodeRequest.data;
          const skipLocalPkceValidation = provider.skipLocalPkceValidation;
          if (!skipLocalPkceValidation) {
            const codeChallenge = await provider.challengeForAuthorizationCode(client, code);
            if (!(await verifyPkceChallenge(code_verifier, codeChallenge))) {
              throw new LarkInvalidRequestError('code_verifier does not match the challenge', 'pkce_required');
            }
          }

          const tokens = await provider.exchangeAuthorizationCode(
            client,
            code,
            skipLocalPkceValidation ? code_verifier : undefined,
            redirect_uri,
          );
          res.status(200).json(tokens);
          return;
        }
        case 'refresh_token': {
          const refreshTokenRequest = RefreshTokenGrantSchema.safeParse(req.body);
          if (!refreshTokenRequest.success) {
            throw new LarkInvalidRequestError(refreshTokenRequest.error.message);
          }

          const { refresh_token, scope } = refreshTokenRequest.data;
          const scopes = scope?.split(' ');
          const tokens = await provider.exchangeRefreshToken(client, refresh_token, scopes);
          res.status(200).json(tokens);
          return;
        }
        default:
          throw new UnsupportedGrantTypeError('The grant type is not supported by this authorization server.');
      }
    } catch (error) {
      if (error instanceof OAuthError) {
        const status = error instanceof ServerError ? 500 : 400;
        const body = error.toResponseObject();
        res.status(status).json(
          'lark_mcp_error' in body ? body : { ...body, lark_mcp_error: error.errorCode as string },
        );
        return;
      }

      console.error('Unexpected error exchanging token:', error);
      const serverError = new LarkServerError('Internal Server Error');
      res.status(500).json(serverError.toResponseObject());
    }
  });

  return router;
}
