import crypto from 'crypto';
import { Response } from 'express';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import { authStore } from '../store';
import { LarkProxyOAuthServerProviderOptions } from './types';
import { commonHttpInstance } from '../../utils/http-instance';
import { logger } from '../../utils/logger';
import { AUTH_CONFIG } from '../config';
import {
  fetchLarkUserInfo,
  getScopes,
  issueMcpSessionTokens,
  rotateMcpSessionTokens,
  upsertLarkCredential,
} from './shared';

const LarkOIDCTokenSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({
    access_token: z.string(),
    token_type: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    refresh_expires_in: z.number().optional(),
    scope: z.string().optional(),
  }),
});

interface OAuth2OAuthEndpoints {
  appAccessTokenUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  refreshTokenUrl: string;
  registrationUrl: string;
}

export class LarkOIDC2OAuthServerProvider implements OAuthServerProvider {
  private readonly _endpoints: OAuth2OAuthEndpoints;
  private readonly _options: LarkProxyOAuthServerProviderOptions;
  skipLocalPkceValidation = false;

  constructor(options: LarkProxyOAuthServerProviderOptions) {
    const { domain } = options;
    this._endpoints = {
      appAccessTokenUrl: `${domain}/open-apis/auth/v3/app_access_token/internal`,
      authorizationUrl: `${domain}/open-apis/authen/v1/index`,
      tokenUrl: `${domain}/open-apis/authen/v1/oidc/access_token`,
      refreshTokenUrl: `${domain}/open-apis/authen/v1/oidc/refresh_access_token`,
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

  private async getAppAccessToken(appId: string, appSecret: string) {
    const response = await commonHttpInstance.post(
      this._endpoints.appAccessTokenUrl,
      { app_id: appId, app_secret: appSecret },
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
    return response.data.app_access_token as string;
  }

  private async exchangeLarkAuthorizationCode(authorizationCode: string) {
    const appAccessToken = await this.getAppAccessToken(this._options.appId, this._options.appSecret);
    const response = await commonHttpInstance.post(
      this._endpoints.tokenUrl,
      { grant_type: 'authorization_code', code: authorizationCode },
      { headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${appAccessToken}` } },
    );

    const data = response.data;
    const parseResult = LarkOIDCTokenSchema.safeParse(data);
    if (!parseResult.success) {
      throw new Error(`Token parse failed: invalid response: ${data?.code}, ${data?.msg}`);
    }
    return parseResult.data;
  }

  private async refreshLarkToken(refreshToken: string) {
    const originalToken = await authStore.getTokenByRefreshToken(refreshToken);
    if (!originalToken) {
      throw new InvalidGrantError('refresh token is invalid');
    }

    const appId = (originalToken.extra?.appId as string) || this._options.appId;
    const appSecret = (originalToken.extra?.appSecret as string) || this._options.appSecret;
    const appAccessToken = await this.getAppAccessToken(appId, appSecret);
    const response = await commonHttpInstance.post(
      this._endpoints.refreshTokenUrl,
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      { headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${appAccessToken}` } },
    );

    const data = response.data;
    const parseResult = LarkOIDCTokenSchema.safeParse(data);
    if (!parseResult.success) {
      throw new Error(`Token parse failed: invalid response: ${data?.code}, ${data?.msg}`);
    }

    const token = parseResult.data;
    const credentialId = originalToken.extra?.credentialId as string | undefined;
    const userInfo = await fetchLarkUserInfo(this._options.domain, token.data.access_token);
    await upsertLarkCredential({
      existingCredentialId: credentialId,
      client: { client_id: originalToken.clientId, redirect_uris: [this._options.callbackUrl] },
      appId,
      appSecret,
      tokenPayload: {
        accessToken: token.data.access_token,
        refreshToken: token.data.refresh_token,
        expiresIn: token.data.expires_in,
        refreshExpiresIn: token.data.refresh_expires_in,
        scope: token.data.scope,
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

    targetUrl.searchParams.set('app_id', this._options.appId);
    targetUrl.searchParams.set('redirect_uri', callbackUrl);
    targetUrl.searchParams.set('state', txId);

    logger.info(`[LarkOIDC2OAuthServerProvider] Redirecting to authorization URL: ${targetUrl.toString()}`);
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
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
      const token = await this.exchangeLarkAuthorizationCode(transaction.larkCode);
      const userInfo = await fetchLarkUserInfo(this._options.domain, token.data.access_token);
      const credential = await upsertLarkCredential({
        client,
        appId: this._options.appId,
        appSecret: this._options.appSecret,
        tokenPayload: {
          accessToken: token.data.access_token,
          refreshToken: token.data.refresh_token,
          expiresIn: token.data.expires_in,
          refreshExpiresIn: token.data.refresh_expires_in,
          scope: token.data.scope,
        },
        userInfo,
        rawToken: token,
      });

      await authStore.updateTransaction(transaction.txId, { consumedAt: Math.floor(Date.now() / 1000) });
      if (this.isDirectAccessTokenClient(client)) {
        return {
          access_token: token.data.access_token,
          refresh_token: token.data.refresh_token,
          token_type: token.data.token_type,
          expires_in: token.data.expires_in,
          scope: token.data.scope,
        };
      }
      return issueMcpSessionTokens({ client, credential, scopes: getScopes(token.data.scope, transaction.scopes) });
    } catch (error: any) {
      logger.error(
        `[LarkOIDC2OAuthServerProvider] exchangeAuthorizationCode failed: ${error.response?.status || error.status} ${error.response?.data || error.message}`,
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
      const token = await this.refreshLarkToken(refreshToken);
      return {
        access_token: token.data.access_token,
        refresh_token: token.data.refresh_token,
        token_type: token.data.token_type,
        expires_in: token.data.expires_in,
        scope: token.data.scope,
      };
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
      const refreshedToken = await this.refreshLarkToken(credential.refreshToken);
      const refreshedCredential = await authStore.getLarkCredential(credentialId);
      if (!refreshedCredential) {
        throw new InvalidGrantError('lark credential not found after refresh');
      }
      await authStore.removeMcpSession(session.token);
      return issueMcpSessionTokens({
        client,
        credential: refreshedCredential,
        scopes: getScopes(refreshedToken.data.scope, scopes || session.scopes),
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
