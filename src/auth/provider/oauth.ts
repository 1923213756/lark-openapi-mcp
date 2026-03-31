import crypto from 'crypto';
import { Response } from 'express';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthClientInformationFull, OAuthTokens, OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { authStore } from '../store';
import { LarkProxyOAuthServerProviderOptions } from './types';
import { commonHttpInstance } from '../../utils/http-instance';
import { logger } from '../../utils/logger';
import { AUTH_CONFIG } from '../config';
import {
  fetchLarkUserInfo,
  getExpiresAt,
  getScopes,
  issueMcpSessionTokens,
  rotateMcpSessionTokens,
  upsertLarkCredential,
} from './shared';

interface OAuth2OAuthEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl: string;
}

export class LarkOAuth2OAuthServerProvider implements OAuthServerProvider {
  private readonly _endpoints: OAuth2OAuthEndpoints;
  private readonly _options: LarkProxyOAuthServerProviderOptions;
  skipLocalPkceValidation = false;

  constructor(options: LarkProxyOAuthServerProviderOptions) {
    const { domain } = options;
    this._endpoints = {
      authorizationUrl: `${domain}/open-apis/authen/v1/authorize`,
      tokenUrl: `${domain}/open-apis/authen/v2/oauth/token`,
      registrationUrl: `${domain}/open-apis/authen/v1/index`,
    };
    this._options = options;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return authStore;
  }

  private generateTxId() {
    return crypto.randomUUID();
  }

  private isDirectAccessTokenClient(client: OAuthClientInformationFull) {
    return client.client_id === 'LOCAL' || client.client_id === 'client_id_for_local_auth';
  }

  private buildCallbackUrl(txId: string) {
    const callbackUrl = new URL(this._options.callbackUrl);
    callbackUrl.searchParams.set('tx_id', txId);
    return callbackUrl.toString();
  }

  private async exchangeLarkAuthorizationCode(authorizationCode: string, redirectUri: string) {
    const params = {
      grant_type: 'authorization_code',
      client_id: this._options.appId,
      client_secret: this._options.appSecret,
      code: authorizationCode,
      redirect_uri: redirectUri,
    };

    const response = await commonHttpInstance.post(this._endpoints.tokenUrl, params, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });

    const data = response.data;
    const parseResult = OAuthTokensSchema.safeParse(data);
    if (!parseResult.success) {
      throw new Error(`Token parse failed: invalid response: ${data?.code}, ${data?.msg}`);
    }

    return parseResult.data;
  }

  private async refreshLarkToken(refreshToken: string, scopes?: string[]) {
    const originalToken = await authStore.getTokenByRefreshToken(refreshToken);
    if (!originalToken) {
      throw new InvalidGrantError('refresh token is invalid');
    }

    const appId = (originalToken.extra?.appId as string) || this._options.appId;
    const appSecret = (originalToken.extra?.appSecret as string) || this._options.appSecret;
    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: refreshToken,
    };
    if (scopes?.length) {
      params.scope = scopes.join(' ');
    }

    const response = await commonHttpInstance.post(this._endpoints.tokenUrl, params, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    const data = response.data;
    const parseResult = OAuthTokensSchema.safeParse(data);
    if (!parseResult.success) {
      throw new Error(`Token parse failed: invalid response: ${data?.code}, ${data?.msg}`);
    }

    const token = parseResult.data;
    const credentialId = originalToken.extra?.credentialId as string | undefined;
    const userInfo = await fetchLarkUserInfo(this._options.domain, token.access_token);
    await upsertLarkCredential({
      existingCredentialId: credentialId,
      client: { client_id: originalToken.clientId, redirect_uris: [this._options.callbackUrl] },
      appId,
      appSecret,
      tokenPayload: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresIn: token.expires_in,
        scope: token.scope,
      },
      userInfo,
      rawToken: token,
    });

    await authStore.removeToken(originalToken.token);
    return token;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const txId = this.generateTxId();
    const callbackUrl = this.buildCallbackUrl(txId);
    const targetUrl = new URL(this._endpoints.authorizationUrl);

    await authStore.storeTransaction({
      txId,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      callbackUrl,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes || [],
      expiresAt: Math.floor(Date.now() / 1000) + authStore.getTransactionTTL(),
    });

    targetUrl.searchParams.set('client_id', this._options.appId);
    targetUrl.searchParams.set('response_type', 'code');
    targetUrl.searchParams.set('redirect_uri', callbackUrl);
    targetUrl.searchParams.set('state', txId);
    if (params.scopes?.length) {
      targetUrl.searchParams.set('scope', params.scopes.join(' '));
    }

    logger.info(
      `[LarkOAuth2OAuthServerProvider] Authorizing client ${client.client_id} via Lark redirect ${targetUrl.toString()}`,
    );
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const transaction = await authStore.getTransaction(authorizationCode);
    if (!transaction || transaction.clientId !== client.client_id) {
      throw new InvalidGrantError('authorization code is invalid');
    }
    if (transaction.expiresAt < Date.now() / 1000) {
      throw new InvalidGrantError('authorization code has expired');
    }
    return transaction.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const transaction = await authStore.getTransaction(authorizationCode);
    if (!transaction || transaction.clientId !== client.client_id) {
      throw new InvalidGrantError('authorization code is invalid');
    }
    if (transaction.expiresAt < Date.now() / 1000) {
      throw new InvalidGrantError('authorization code has expired');
    }
    if (transaction.consumedAt) {
      throw new InvalidGrantError('authorization code already used');
    }
    if (redirectUri && redirectUri !== transaction.redirectUri) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    if (!transaction.larkCode) {
      throw new InvalidGrantError('upstream authorization code not found');
    }

    try {
      const token = await this.exchangeLarkAuthorizationCode(transaction.larkCode, transaction.callbackUrl);
      const userInfo = await fetchLarkUserInfo(this._options.domain, token.access_token);
      const credential = await upsertLarkCredential({
        client,
        appId: this._options.appId,
        appSecret: this._options.appSecret,
        tokenPayload: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresIn: token.expires_in,
          scope: token.scope,
        },
        userInfo,
        rawToken: token,
      });

      await authStore.updateTransaction(transaction.txId, { consumedAt: Math.floor(Date.now() / 1000) });
      if (this.isDirectAccessTokenClient(client)) {
        return token;
      }
      return issueMcpSessionTokens({ client, credential, scopes: getScopes(token.scope, transaction.scopes) });
    } catch (error: any) {
      logger.error(
        `[LarkOAuth2OAuthServerProvider] Token exchange failed: ${error.response?.status || error.status} ${error.response?.data || error.message}`,
      );
      throw new Error(
        `Token exchange failed: ${error.response?.status || error.status} ${error.response?.data || error.message}`,
      );
    }
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const session = await authStore.getMcpSessionByRefreshToken(refreshToken);
    if (!session) {
      return this.refreshLarkToken(refreshToken, scopes);
    }

    const credentialId = session.extra?.credentialId as string | undefined;
    if (!credentialId) {
      throw new InvalidGrantError('credentialId missing from session');
    }

    const credential = await authStore.getLarkCredential(credentialId);
    if (!credential) {
      throw new InvalidGrantError('lark credential not found');
    }

    const now = Date.now() / 1000;
    const safetyWindow = AUTH_CONFIG.OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS;
    const shouldRefreshCredential =
      (credential.expiresAt && credential.expiresAt <= now + safetyWindow) ||
      (credential.refreshExpiresAt && credential.refreshExpiresAt <= now + safetyWindow);

    if (shouldRefreshCredential) {
      if (!credential.refreshToken) {
        throw new InvalidGrantError('lark refresh token not found');
      }

      const refreshedToken = await this.refreshLarkToken(credential.refreshToken, scopes);
      const refreshedCredential = await authStore.getLarkCredential(credentialId);
      if (!refreshedCredential) {
        throw new InvalidGrantError('lark credential not found after refresh');
      }

      await authStore.removeMcpSession(session.token);
      return issueMcpSessionTokens({
        client,
        credential: refreshedCredential,
        scopes: getScopes(refreshedToken.scope, scopes || session.scopes),
      });
    }

    return rotateMcpSessionTokens(session);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = await authStore.getMcpSession(token);
    if (session) {
      return session;
    }

    const storedToken = await authStore.getToken(token);
    if (storedToken) {
      return storedToken;
    }

    throw new InvalidTokenError('Invalid access token');
  }
}
