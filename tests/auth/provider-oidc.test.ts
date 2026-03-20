import { Response } from 'express';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { LarkOIDC2OAuthServerProvider } from '../../src/auth/provider';
import { authStore } from '../../src/auth/store';
import { commonHttpInstance } from '../../src/utils/http-instance';
import * as sharedHelpers from '../../src/auth/provider/shared';

jest.mock('../../src/auth/store');
jest.mock('../../src/utils/http-instance');
jest.mock('../../src/auth/provider/shared');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), trace: jest.fn() },
}));

describe('LarkOIDC2OAuthServerProvider', () => {
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

  it('creates a hosted transaction and redirects to Lark OIDC authorize page', async () => {
    const provider = new LarkOIDC2OAuthServerProvider(options);
    const res = { redirect: jest.fn() } as unknown as Response;

    await provider.authorize(
      mockClient,
      {
        codeChallenge: 'pkce-challenge',
        redirectUri: 'http://example.com/callback',
        state: 'client-state',
      },
      res,
    );

    expect(authStore.storeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'test-client-id',
        redirectUri: 'http://example.com/callback',
        state: 'client-state',
      }),
    );
    expect((res.redirect as jest.Mock).mock.calls[0][0]).toContain('/open-apis/authen/v1/index');
  });

  it('exchanges OIDC authorization code into MCP session token', async () => {
    const provider = new LarkOIDC2OAuthServerProvider(options);
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
    (commonHttpInstance.post as jest.Mock)
      .mockResolvedValueOnce({ data: { app_access_token: 'app-access-token' } })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            access_token: 'lark-access-token',
            refresh_token: 'lark-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_expires_in: 7200,
            scope: 'scope1',
          },
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
  });

  it('verifies stored MCP session token', async () => {
    const provider = new LarkOIDC2OAuthServerProvider(options);
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
