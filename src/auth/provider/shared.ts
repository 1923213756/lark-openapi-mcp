import crypto from 'crypto';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { authStore } from '../store';
import { LarkCredential, LarkUserInfo } from '../types';
import { commonHttpInstance } from '../../utils/http-instance';
import { logger } from '../../utils/logger';

interface SessionTokenParams {
  client: OAuthClientInformationFull;
  credential: LarkCredential;
  scopes?: string[];
}

interface CredentialTokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
  scope?: string;
}

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function generateOpaqueToken(prefix: string) {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

export function getExpiresAt(expiresIn?: number) {
  return expiresIn ? nowInSeconds() + expiresIn : undefined;
}

export function getScopes(scope?: string, fallback?: string[]) {
  if (scope) {
    return scope.split(' ').filter(Boolean);
  }
  return fallback || [];
}

export async function fetchLarkUserInfo(domain: string, accessToken: string): Promise<LarkUserInfo | undefined> {
  try {
    const response = await commonHttpInstance.get(`${domain}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = response.data?.data || response.data || {};
    return {
      openId: data.open_id,
      unionId: data.union_id,
      userId: data.user_id,
      name: data.name,
      enName: data.en_name,
      avatarUrl: data.avatar_url || data.avatar_big,
      email: data.email,
      tenantKey: data.tenant_key,
    };
  } catch (error) {
    logger.warn(`[AuthProvider] Failed to fetch Lark user info: ${error}`);
    return undefined;
  }
}

export async function upsertLarkCredential(params: {
  existingCredentialId?: string;
  client: OAuthClientInformationFull;
  appId: string;
  appSecret: string;
  tokenPayload: CredentialTokenPayload;
  userInfo?: LarkUserInfo;
  rawToken: unknown;
}): Promise<LarkCredential> {
  const credentialId = params.existingCredentialId || generateOpaqueToken('lark_cred');
  const credential: LarkCredential = {
    credentialId,
    accessToken: params.tokenPayload.accessToken,
    refreshToken: params.tokenPayload.refreshToken,
    appId: params.appId,
    appSecret: params.appSecret,
    scopes: getScopes(params.tokenPayload.scope),
    expiresAt: getExpiresAt(params.tokenPayload.expiresIn),
    refreshExpiresAt: getExpiresAt(params.tokenPayload.refreshExpiresIn),
    createdAt: nowInSeconds(),
    updatedAt: nowInSeconds(),
    userInfo: params.userInfo,
  };

  const existingCredential = params.existingCredentialId
    ? await authStore.getLarkCredential(params.existingCredentialId)
    : undefined;
  const mergedCredential = existingCredential
    ? {
        ...existingCredential,
        ...credential,
        createdAt: existingCredential.createdAt,
      }
    : credential;

  if (existingCredential?.accessToken && existingCredential.accessToken !== mergedCredential.accessToken) {
    await authStore.removeToken(existingCredential.accessToken);
  }

  await authStore.storeLarkCredential(mergedCredential);
  await authStore.storeToken({
    clientId: params.client.client_id,
    token: mergedCredential.accessToken,
    scopes: mergedCredential.scopes,
    expiresAt: mergedCredential.expiresAt,
    extra: {
      credentialId: mergedCredential.credentialId,
      refreshToken: mergedCredential.refreshToken,
      appId: mergedCredential.appId,
      appSecret: mergedCredential.appSecret,
      userInfo: mergedCredential.userInfo,
      token: params.rawToken,
    },
  });

  return mergedCredential;
}

export async function issueMcpSessionTokens({ client, credential, scopes }: SessionTokenParams): Promise<OAuthTokens> {
  const accessToken = generateOpaqueToken('mcp_at');
  const refreshToken = generateOpaqueToken('mcp_rt');
  const sessionScopes = scopes?.length ? scopes : credential.scopes;
  const expiresAt = nowInSeconds() + authStore.getMcpSessionTTL();
  const refreshExpiresAt = nowInSeconds() + authStore.getMcpRefreshTTL();

  const authInfo: AuthInfo = {
    clientId: client.client_id,
    token: accessToken,
    scopes: sessionScopes,
    expiresAt,
    extra: {
      refreshToken,
      refreshExpiresAt,
      credentialId: credential.credentialId,
      userInfo: credential.userInfo,
    },
  };

  await authStore.storeMcpSession(authInfo);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: authStore.getMcpSessionTTL(),
    scope: sessionScopes.join(' '),
  };
}

export async function rotateMcpSessionTokens(session: AuthInfo): Promise<OAuthTokens> {
  const credentialId = session.extra?.credentialId as string | undefined;
  if (!credentialId) {
    throw new Error('credentialId missing from MCP session');
  }

  const credential = await authStore.getLarkCredential(credentialId);
  if (!credential) {
    throw new Error('Lark credential not found');
  }

  await authStore.removeMcpSession(session.token);
  return issueMcpSessionTokens({
    client: { client_id: session.clientId, redirect_uris: [], scope: session.scopes.join(' ') },
    credential,
    scopes: session.scopes,
  });
}
