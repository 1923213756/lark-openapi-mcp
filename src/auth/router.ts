import express, { NextFunction, Request, Response } from 'express';
import { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { LarkInvalidRequestError } from './errors';
import { larkAuthorizationHandler } from './authorize-handler';
import { larkTokenHandler } from './token-handler';

export interface LarkAuthRouterOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  baseUrl?: URL;
  basePath?: string;
  resourceServerUrl?: URL;
  scopesSupported?: string[];
  resourceName?: string;
}

function joinPath(basePath: string, leaf: string) {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  return `${normalizedBase}${leaf}`;
}

function createHttpOAuthMetadata(options: LarkAuthRouterOptions): OAuthMetadata {
  const baseUrl = options.baseUrl || options.issuerUrl;
  const basePath = options.basePath || '';

  return {
    issuer: options.issuerUrl.href,
    authorization_endpoint: new URL(joinPath(basePath, '/authorize'), baseUrl).href,
    token_endpoint: new URL(joinPath(basePath, '/token'), baseUrl).href,
    registration_endpoint: options.provider.clientsStore.registerClient
      ? new URL(joinPath(basePath, '/register'), baseUrl).href
      : undefined,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported: options.scopesSupported,
  };
}

export function getOAuthProtectedResourceMetadataUrl(serverUrl: URL): string {
  return new URL('/.well-known/oauth-protected-resource', serverUrl).href;
}

export function larkAuthRouter(options: LarkAuthRouterOptions) {
  const router = express.Router();
  const basePath = options.basePath || '';
  const oauthMetadata = createHttpOAuthMetadata(options);
  const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
    resource: (options.resourceServerUrl || options.issuerUrl).href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: options.scopesSupported,
    resource_name: options.resourceName,
  };

  router.use(joinPath(basePath, '/authorize'), (req: Request, res: Response, next: NextFunction) => {
    const codeChallenge = req.query.code_challenge;
    const codeChallengeMethod = req.query.code_challenge_method;

    if (typeof codeChallenge !== 'string' || typeof codeChallengeMethod !== 'string') {
      res
        .status(400)
        .json(
          new LarkInvalidRequestError(
            'PKCE is required. Provide code_challenge and code_challenge_method=S256.',
            'pkce_required',
          ).toResponseObject(),
        );
      return;
    }

    if (codeChallengeMethod !== 'S256') {
      res
        .status(400)
        .json(
          new LarkInvalidRequestError(
            'Unsupported code_challenge_method. Only S256 is supported.',
            'pkce_required',
          ).toResponseObject(),
        );
      return;
    }

    next();
  });
  router.use(joinPath(basePath, '/authorize'), larkAuthorizationHandler({ provider: options.provider }));
  router.use(joinPath(basePath, '/token'), larkTokenHandler({ provider: options.provider }));

  if (oauthMetadata.registration_endpoint) {
    router.use(
      joinPath(basePath, '/register'),
      clientRegistrationHandler({ clientsStore: options.provider.clientsStore }),
    );
  }

  router.use('/.well-known/oauth-authorization-server', metadataHandler(oauthMetadata));
  router.use('/.well-known/oauth-protected-resource', metadataHandler(protectedResourceMetadata));

  return router;
}
