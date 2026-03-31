import { Express, Request, Response, NextFunction } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { LarkOIDC2OAuthServerProvider, LarkOAuth2OAuthServerProvider } from '../provider';
import { authStore } from '../store';
import { generatePKCEPair } from '../utils/pkce';
import { logger } from '../../utils/logger';
import { AUTH_CONFIG } from '../config';
import { getOAuthProtectedResourceMetadataUrl, larkAuthRouter } from '../router';

export interface LarkOAuthClientConfig {
  port: number;
  host: string;
  domain: string;
  appId: string;
  appSecret: string;
  scope?: string[];
  publicBaseUrl?: string;
  oauthBasePath?: string;
  resourceServerUrl?: string;
}

export class LarkAuthHandler {
  protected readonly options: LarkOAuthClientConfig;
  protected readonly provider: LarkOIDC2OAuthServerProvider | LarkOAuth2OAuthServerProvider;

  protected get isHostedOAuth() {
    return Boolean(this.options.publicBaseUrl);
  }

  protected get authBasePath() {
    return this.isHostedOAuth ? this.options.oauthBasePath || AUTH_CONFIG.DEFAULT_OAUTH_BASE_PATH : '';
  }

  protected get callbackPath() {
    return this.isHostedOAuth ? `${this.authBasePath}/callback` : '/callback';
  }

  protected get authorizePath() {
    return `${this.authBasePath}/authorize`;
  }

  protected get statusPath() {
    return `${this.authBasePath}/status`;
  }

  get callbackUrl() {
    return new URL(this.callbackPath, this.baseUrl).toString();
  }

  get issuerUrl() {
    return this.baseUrl;
  }

  get baseUrl() {
    return this.options.publicBaseUrl || `http://${this.options.host}:${this.options.port}`;
  }

  get resourceMetadataUrl() {
    return getOAuthProtectedResourceMetadataUrl(new URL(this.baseUrl));
  }

  constructor(
    protected readonly app: Express,
    options: Partial<LarkOAuthClientConfig>,
  ) {
    const { port, host, domain, appId, appSecret } = options;

    if (!port || !host || !domain || !appId || !appSecret) {
      throw new Error('[Lark MCP] appId, appSecret, host and port are required');
    }

    this.options = {
      oauthBasePath: AUTH_CONFIG.DEFAULT_OAUTH_BASE_PATH,
      ...options,
    } as LarkOAuthClientConfig;

    const params = {
      domain,
      host,
      port,
      appId,
      appSecret,
      publicBaseUrl: this.options.publicBaseUrl,
      oauthBasePath: this.options.oauthBasePath,
      callbackUrl: this.callbackUrl,
    };

    if (!this.options.scope?.length) {
      this.provider = new LarkOIDC2OAuthServerProvider(params);
    } else {
      this.provider = new LarkOAuth2OAuthServerProvider(params);
    }
  }

  protected async handleTransactionCallback(req: Request, res: Response) {
    const txId = req.query.tx_id as string | undefined;
    if (!txId) {
      return false;
    }

    const transaction = await authStore.getTransaction(txId);
    if (!transaction) {
      res.status(400).end('error: transaction not found or expired');
      return true;
    }
    if (transaction.expiresAt < Date.now() / 1000) {
      await authStore.removeTransaction(txId);
      res.status(400).end('error: transaction expired');
      return true;
    }
    if (req.query.state && req.query.state !== txId) {
      res.status(400).end('error: invalid upstream state');
      return true;
    }

    if (req.query.error) {
      const finalRedirectUri = new URL(transaction.redirectUri);
      finalRedirectUri.searchParams.set('error', String(req.query.error));
      if (req.query.error_description) {
        finalRedirectUri.searchParams.set('error_description', String(req.query.error_description));
      }
      if (transaction.state) {
        finalRedirectUri.searchParams.set('state', transaction.state);
      }
      res.redirect(finalRedirectUri.toString());
      return true;
    }

    if (!req.query.code || typeof req.query.code !== 'string') {
      logger.error(`[LarkAuthHandler] Failed to receive authorization code: ${req.query.code}`);
      res.end('error, failed to exchange authorization code, please try again');
      return true;
    }

    await authStore.updateTransaction(txId, { larkCode: req.query.code });
    const finalRedirectUri = new URL(transaction.redirectUri);
    finalRedirectUri.searchParams.set('code', txId);
    if (transaction.state) {
      finalRedirectUri.searchParams.set('state', transaction.state);
    }
    res.redirect(finalRedirectUri.toString());
    return true;
  }

  protected async handleLocalReauthorizeCallback(req: Request, res: Response) {
    if (req.query.state !== 'reauthorize') {
      return false;
    }

    if (!req.query.code || typeof req.query.code !== 'string') {
      logger.error(`[LarkAuthHandler] Failed to exchange authorization code: ${req.query.code}`);
      res.end('error, failed to exchange authorization code, please try again');
      return true;
    }

    const codeVerifier = authStore.getCodeVerifier('reauthorize');
    if (!codeVerifier) {
      logger.error('[LarkAuthHandler] Code verifier not found');
      res.end('error: code_verifier not found, please try again');
      return true;
    }

    await this.provider.exchangeAuthorizationCode(
      { client_id: 'LOCAL', redirect_uris: [] },
      req.query.code,
      codeVerifier,
      this.callbackUrl,
    );

    authStore.removeCodeVerifier('reauthorize');
    res.end('success, you can close this page now');
    return true;
  }

  protected async callback(req: Request, res: Response) {
    if (await this.handleTransactionCallback(req, res)) {
      return;
    }
    if (await this.handleLocalReauthorizeCallback(req, res)) {
      return;
    }
    if (typeof res.status === 'function') {
      res.status(400);
    }
    res.end('error: invalid callback');
  }

  protected async getOAuthStatus() {
    const storageStatus = await authStore.getStorageStatus();
    return {
      oauth_enabled: true,
      issuer: this.issuerUrl,
      public_base_url: this.options.publicBaseUrl || null,
      callback_url: this.callbackUrl,
      oauth_base_path: this.authBasePath || '',
      resource_server_url: this.options.resourceServerUrl || this.baseUrl,
      storage_ready: storageStatus.storageReady,
      persistent_storage: storageStatus.persistentStorage,
      storage_file: storageStatus.storageFile,
      initialization_error: storageStatus.initializationError || null,
      loaded_clients: storageStatus.counts.clients,
      loaded_tokens: storageStatus.counts.tokens,
      loaded_mcp_sessions: storageStatus.counts.mcpSessions,
      loaded_lark_credentials: storageStatus.counts.larkCredentials,
      loaded_transactions: storageStatus.counts.transactions,
    };
  }

  setupRoutes = (): void => {
    logger.info(`[LarkAuthHandler] setupRoutes: issuerUrl: ${this.issuerUrl}`);
    const resourceServerUrl = this.options.resourceServerUrl
      ? new URL(this.options.resourceServerUrl)
      : new URL(this.baseUrl);

    this.app.use(
      larkAuthRouter({
        provider: this.provider,
        issuerUrl: new URL(this.issuerUrl),
        baseUrl: new URL(this.baseUrl),
        basePath: this.authBasePath,
        resourceServerUrl,
      }),
    );
    this.app.get(this.statusPath, async (_req, res) => {
      res.json(await this.getOAuthStatus());
    });
    this.app.get(this.callbackPath, (req, res) => this.callback(req, res));
    if (!this.isHostedOAuth && this.callbackPath !== '/callback') {
      this.app.get('/callback', (req, res) => this.callback(req, res));
    }
  };

  authenticateRequest(req: Request, res: Response, next: NextFunction): void {
    requireBearerAuth({
      verifier: this.provider,
      requiredScopes: [],
      resourceMetadataUrl: this.resourceMetadataUrl,
    })(req, res, next);
  }

  async resolveUserAccessToken(token?: string): Promise<string | undefined> {
    if (!token) {
      return undefined;
    }

    const session = await authStore.getMcpSession(token);
    if (session) {
      const credentialId = session.extra?.credentialId as string | undefined;
      if (!credentialId) {
        return undefined;
      }
      const credential = await authStore.getLarkCredential(credentialId);
      return credential?.accessToken;
    }

    return token;
  }

  async refreshToken(accessToken: string) {
    const token = (await authStore.getToken(accessToken)) || (await authStore.getMcpSession(accessToken));
    if (!token) {
      logger.error('[LarkAuthHandler] refreshToken: No token found');
      throw new Error('No local access token found');
    }
    if (!token.extra?.refreshToken) {
      logger.error('[LarkAuthHandler] refreshToken: No refresh token found');
      throw new Error('No refresh token found');
    }

    const newToken = await this.provider.exchangeRefreshToken(
      { client_id: token.clientId, redirect_uris: [this.callbackUrl] },
      token.extra.refreshToken as string,
      token.scopes,
    );

    logger.info('[LarkAuthHandler] refreshToken: Successfully refreshed token');
    if (await authStore.getMcpSession(accessToken)) {
      await authStore.removeMcpSession(accessToken);
    } else {
      await authStore.removeToken(accessToken);
    }
    return newToken;
  }

  async reAuthorize(accessToken?: string) {
    if (!accessToken) {
      logger.error('[LarkAuthHandler] reAuthorize: Invalid access token, please reconnect the mcp server');
      throw new Error('Invalid access token, please reconnect the mcp server');
    }

    const token =
      (await authStore.getToken(accessToken)) ||
      (await authStore.getMcpSession(accessToken)) ||
      (await authStore.getToken(await this.resolveUserAccessToken(accessToken) || ''));

    if (!token) {
      logger.error('[LarkAuthHandler] reAuthorize: Invalid access token, please reconnect the mcp server');
      throw new Error('Invalid access token, please reconnect the mcp server');
    }

    const { codeVerifier, codeChallenge } = generatePKCEPair();
    authStore.storeCodeVerifier('reauthorize', codeVerifier);

    await authStore.registerClient({
      client_id: 'LOCAL',
      client_secret: 'LOCAL',
      redirect_uris: [this.callbackUrl],
      scope: this.options.scope?.join(' '),
    });

    const authorizeUrl = new URL(this.authorizePath, this.baseUrl);
    authorizeUrl.searchParams.set('client_id', 'LOCAL');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('redirect_uri', this.callbackUrl);
    authorizeUrl.searchParams.set('state', 'reauthorize');
    if (this.options.scope?.length) {
      authorizeUrl.searchParams.set('scope', this.options.scope.join(' '));
    }

    return {
      accessToken: '',
      authorizeUrl: authorizeUrl.toString(),
    };
  }
}
