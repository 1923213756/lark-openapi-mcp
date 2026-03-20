import { Express, Request, Response } from 'express';
import { LarkAuthHandler, LarkOAuthClientConfig } from '../../src/auth/handler/handler';
import { LarkOAuth2OAuthServerProvider } from '../../src/auth/provider';
import { authStore } from '../../src/auth/store';
import { generatePKCEPair } from '../../src/auth/utils/pkce';
import { larkAuthRouter } from '../../src/auth/router';

jest.mock('../../src/auth/provider');
jest.mock('../../src/auth/store');
jest.mock('../../src/auth/utils/pkce');
jest.mock('../../src/auth/router');
jest.mock('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), trace: jest.fn() },
}));

const mockApp = {
  use: jest.fn(),
  get: jest.fn(),
} as unknown as Express;

const mockProvider = {
  exchangeAuthorizationCode: jest.fn(),
  exchangeRefreshToken: jest.fn(),
  verifyAccessToken: jest.fn(),
} as any;

const mockAuthStore = {
  getTransaction: jest.fn(),
  updateTransaction: jest.fn(),
  removeTransaction: jest.fn(),
  getCodeVerifier: jest.fn(),
  removeCodeVerifier: jest.fn(),
  getToken: jest.fn(),
  getMcpSession: jest.fn(),
  getLarkCredential: jest.fn(),
  registerClient: jest.fn(),
  storeCodeVerifier: jest.fn(),
} as any;

describe('LarkAuthHandler', () => {
  const options: Partial<LarkOAuthClientConfig> = {
    port: 3000,
    host: 'localhost',
    domain: 'https://open.feishu.cn',
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    scope: ['scope1'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (LarkOAuth2OAuthServerProvider as jest.Mock).mockImplementation(() => mockProvider);
    (larkAuthRouter as jest.Mock).mockReturnValue(jest.fn());
    Object.assign(authStore, mockAuthStore);
    (generatePKCEPair as jest.Mock).mockReturnValue({
      codeVerifier: 'test-verifier',
      codeChallenge: 'test-challenge',
    });
  });

  it('builds hosted callback URL with oauth base path', () => {
    const handler = new LarkAuthHandler(mockApp, {
      ...options,
      publicBaseUrl: 'http://mcp.intra.local:3000',
      oauthBasePath: '/oauth',
    });

    expect(handler.callbackUrl).toBe('http://mcp.intra.local:3000/oauth/callback');
    expect(handler.issuerUrl).toBe('http://mcp.intra.local:3000');
  });

  it('mounts custom auth router and callback route', () => {
    const handler = new LarkAuthHandler(mockApp, {
      ...options,
      publicBaseUrl: 'http://mcp.intra.local:3000',
      oauthBasePath: '/oauth',
      resourceServerUrl: 'http://mcp.intra.local:3000/mcp',
    });

    handler.setupRoutes();

    expect(larkAuthRouter).toHaveBeenCalled();
    expect(mockApp.get).toHaveBeenCalledWith('/oauth/callback', expect.any(Function));
  });

  it('handles upstream transaction callback and redirects to client redirect_uri', async () => {
    const handler = new LarkAuthHandler(mockApp, options);
    const mockReq = {
      query: { tx_id: 'tx-1', code: 'lark-code', state: 'tx-1' },
    } as unknown as Request;
    const mockRes = {
      redirect: jest.fn(),
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    mockAuthStore.getTransaction.mockResolvedValue({
      txId: 'tx-1',
      redirectUri: 'http://client.example/callback',
      state: 'client-state',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    await handler['callback'](mockReq, mockRes);

    expect(mockAuthStore.updateTransaction).toHaveBeenCalledWith('tx-1', { larkCode: 'lark-code' });
    expect((mockRes.redirect as jest.Mock).mock.calls[0][0]).toBe(
      'http://client.example/callback?code=tx-1&state=client-state',
    );
  });

  it('handles local reauthorize callback and exchanges the internal authorization code', async () => {
    const handler = new LarkAuthHandler(mockApp, options);
    const mockReq = {
      query: { code: 'internal-auth-code', state: 'reauthorize' },
    } as unknown as Request;
    const mockRes = {
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    mockAuthStore.getCodeVerifier.mockReturnValue('test-verifier');

    await handler['callback'](mockReq, mockRes);

    expect(mockProvider.exchangeAuthorizationCode).toHaveBeenCalledWith(
      { client_id: 'LOCAL', redirect_uris: [] },
      'internal-auth-code',
      'test-verifier',
      'http://localhost:3000/callback',
    );
    expect(mockRes.end).toHaveBeenCalledWith('success, you can close this page now');
  });

  it('refreshes an MCP session token with provider refresh flow', async () => {
    const handler = new LarkAuthHandler(mockApp, options);
    mockAuthStore.getToken.mockResolvedValue(undefined);
    mockAuthStore.getMcpSession.mockResolvedValue({
      token: 'mcp-session-token',
      clientId: 'client-1',
      scopes: ['scope1'],
      extra: { refreshToken: 'mcp-refresh-token' },
    });
    mockProvider.exchangeRefreshToken.mockResolvedValue({ access_token: 'new-token' });

    const result = await handler.refreshToken('mcp-session-token');

    expect(mockProvider.exchangeRefreshToken).toHaveBeenCalledWith(
      { client_id: 'client-1', redirect_uris: ['http://localhost:3000/callback'] },
      'mcp-refresh-token',
      ['scope1'],
    );
    expect(result).toEqual({ access_token: 'new-token' });
  });

  it('resolves bearer session token to the underlying Lark user token', async () => {
    const handler = new LarkAuthHandler(mockApp, options);
    mockAuthStore.getMcpSession.mockResolvedValue({
      token: 'mcp-session-token',
      clientId: 'client-1',
      scopes: ['scope1'],
      extra: { credentialId: 'cred-1' },
    });
    mockAuthStore.getLarkCredential.mockResolvedValue({ credentialId: 'cred-1', accessToken: 'lark-user-token' });

    await expect(handler.resolveUserAccessToken('mcp-session-token')).resolves.toBe('lark-user-token');
  });
});
