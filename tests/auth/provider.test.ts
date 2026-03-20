import { Response } from 'express';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { LarkOAuth2OAuthServerProvider } from '../../src/auth/provider';
import { authStore } from '../../src/auth/store';
import { commonHttpInstance } from '../../src/utils/http-instance';
import * as sharedHelpers from '../../src/auth/provider/shared';

jest.mock('../../src/auth/store');
jest.mock('../../src/utils/http-instance');
jest.mock('../../src/auth/provider/shared');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), trace: jest.fn() },
}));

describe('LarkOAuth2OAuthServerProvider', () => {
  const options = {
    domain: 'https://open.feishu.cn',
    host: 'localhost',
    port: 3000,
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    callbackUrl: 'http://localhost:3000/callback',
  };

  const mockClient = {
    client_id: 'test-client-id',
    redirect_uris: ['http://example.com/callback'],
  } as OAuthClientInformationFull;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(authStore, {
      storeTransaction: jest.fn(),
      getTransaction: jest.fn(),
      updateTransaction: jest.fn(),
      getMcpSession: jest.fn(),
      getToken: jest.fn(),
      getMcpSessionByRefreshToken: jest.fn(),
      getLarkCredential: jest.fn(),
      removeMcpSession: jest.fn(),
      getTokenByRefreshToken: jest.fn(),
      removeToken: jest.fn(),
      getTransactionTTL: jest.fn().mockReturnValue(600),
    });
  });

  it('creates an auth transaction and redirects to Lark authorize URL', async () => {
    const provider = new LarkOAuth2OAuthServerProvider(options);
    const res = { redirect: jest.fn() } as unknown as Response;

    await provider.authorize(
      mockClient,
      {
        codeChallenge: 'pkce-challenge',
        redirectUri: 'http://example.com/callback',
        state: 'client-state',
        scopes: ['scope1'],
      },
      res,
    );

    expect(authStore.storeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'test-client-id',
        redirectUri: 'http://example.com/callback',
        state: 'client-state',
        codeChallenge: 'pkce-challenge',
      }),
    );
    expect((res.redirect as jest.Mock).mock.calls[0][0]).toContain('/open-apis/authen/v1/authorize');
  });

  it('returns code challenge for a valid internal authorization code', async () => {
    const provider = new LarkOAuth2OAuthServerProvider(options);
    (authStore.getTransaction as jest.Mock).mockResolvedValue({
      txId: 'tx-1',
      clientId: 'test-client-id',
      codeChallenge: 'stored-challenge',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    await expect(provider.challengeForAuthorizationCode(mockClient, 'tx-1')).resolves.toBe('stored-challenge');
  });

  it('exchanges a completed transaction into an MCP session token', async () => {
    const provider = new LarkOAuth2OAuthServerProvider(options);
    (authStore.getTransaction as jest.Mock).mockResolvedValue({
      txId: 'tx-1',
      clientId: 'test-client-id',
      redirectUri: 'http://example.com/callback',
      callbackUrl: 'http://localhost:3000/callback?tx_id=tx-1',
      codeChallenge: 'stored-challenge',
      scopes: ['scope1'],
      larkCode: 'lark-auth-code',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    (commonHttpInstance.post as jest.Mock).mockResolvedValue({
      data: {
        access_token: 'lark-access-token',
        refresh_token: 'lark-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'scope1',
      },
    });
    (sharedHelpers.fetchLarkUserInfo as jest.Mock).mockResolvedValue({ openId: 'ou_xxx' });
    (sharedHelpers.upsertLarkCredential as jest.Mock).mockResolvedValue({
      credentialId: 'cred-1',
      accessToken: 'lark-access-token',
      scopes: ['scope1'],
    });
    (sharedHelpers.issueMcpSessionTokens as jest.Mock).mockResolvedValue({
      access_token: 'mcp-session-token',
      refresh_token: 'mcp-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'scope1',
    });

    await expect(provider.exchangeAuthorizationCode(mockClient, 'tx-1')).resolves.toEqual({
      access_token: 'mcp-session-token',
      refresh_token: 'mcp-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'scope1',
    });
    expect(sharedHelpers.issueMcpSessionTokens).toHaveBeenCalled();
  });

  it('verifies MCP session tokens before falling back to stored Lark tokens', async () => {
    const provider = new LarkOAuth2OAuthServerProvider(options);
    (authStore.getMcpSession as jest.Mock).mockResolvedValue({
      token: 'mcp-session-token',
      clientId: 'test-client-id',
      scopes: ['scope1'],
    });

    await expect(provider.verifyAccessToken('mcp-session-token')).resolves.toEqual({
      token: 'mcp-session-token',
      clientId: 'test-client-id',
      scopes: ['scope1'],
    });
  });
});
