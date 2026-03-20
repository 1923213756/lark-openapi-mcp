import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface LarkUserInfo {
  openId?: string;
  unionId?: string;
  userId?: string;
  name?: string;
  enName?: string;
  avatarUrl?: string;
  email?: string;
  tenantKey?: string;
}

export interface AuthTransaction {
  txId: string;
  clientId: string;
  redirectUri: string;
  callbackUrl: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
  larkCode?: string;
  consumedAt?: number;
}

export interface LarkCredential {
  credentialId: string;
  accessToken: string;
  refreshToken?: string;
  appId: string;
  appSecret: string;
  scopes: string[];
  expiresAt?: number;
  refreshExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  userInfo?: LarkUserInfo;
}

export interface StorageData {
  localTokens?: { [appId: string]: string }; // encrypted local tokens by appId
  tokens: { [key: string]: AuthInfo }; // encrypted tokens
  clients: { [key: string]: OAuthClientInformationFull }; // encrypted clients
  transactions?: { [txId: string]: AuthTransaction };
  larkCredentials?: { [credentialId: string]: LarkCredential };
  mcpSessions?: { [accessToken: string]: AuthInfo };
}
