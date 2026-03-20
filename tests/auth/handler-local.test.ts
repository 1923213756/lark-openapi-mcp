import { LarkAuthHandlerLocal } from '../../src/auth/handler/handler-local';
import { LarkAuthHandler } from '../../src/auth/handler/handler';
import { authStore } from '../../src/auth/store';
import { generatePKCEPair } from '../../src/auth/utils/pkce';
import { isTokenValid } from '../../src/auth/utils/is-token-valid';

jest.mock('../../src/auth/store');
jest.mock('../../src/auth/utils/pkce');
jest.mock('../../src/auth/utils/is-token-valid');
jest.mock('../../src/auth/provider');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), trace: jest.fn() },
}));

const mockApp = {
  use: jest.fn(),
  get: jest.fn(),
  listen: jest.fn(),
} as any;

const mockAuthStore = {
  getCodeVerifier: jest.fn(),
  removeCodeVerifier: jest.fn(),
  storeLocalAccessToken: jest.fn(),
  getLocalAccessToken: jest.fn(),
  storeCodeVerifier: jest.fn(),
  registerClient: jest.fn(),
} as any;

describe('LarkAuthHandlerLocal', () => {
  const options = {
    port: 3000,
    host: 'localhost',
    domain: 'https://open.feishu.cn',
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(authStore, mockAuthStore);
    (generatePKCEPair as jest.Mock).mockReturnValue({
      codeVerifier: 'test-verifier',
      codeChallenge: 'test-challenge',
    });
    (isTokenValid as jest.Mock).mockResolvedValue({ valid: true, isExpired: false, token: {} });
  });

  it('returns existing local token when it is still valid', async () => {
    const handler = new LarkAuthHandlerLocal(mockApp, options);
    mockAuthStore.getLocalAccessToken.mockResolvedValue('existing-local-token');

    const result = await handler.reAuthorize();

    expect(result).toEqual({ accessToken: 'existing-local-token', authorizeUrl: '' });
  });

  it('creates a local authorize URL when login is required', async () => {
    const handler = new LarkAuthHandlerLocal(mockApp, options);
    mockAuthStore.getLocalAccessToken.mockResolvedValue(undefined);
    (isTokenValid as jest.Mock).mockResolvedValue({ valid: false, isExpired: false, token: undefined });
    mockApp.listen.mockImplementation((_port: any, _host: any, callback: any) => {
      callback();
      return { close: jest.fn((cb) => cb?.()) };
    });

    const result = await handler.reAuthorize();

    expect(mockAuthStore.registerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'client_id_for_local_auth',
        redirect_uris: ['http://localhost:3000/callback'],
      }),
    );
    expect(result.authorizeUrl).toContain('http://localhost:3000/authorize');
    expect(result.accessToken).toBe('');
  });

  it('stores the exchanged Lark access token after the second callback hop', async () => {
    const handler = new LarkAuthHandlerLocal(mockApp, options);
    const mockReq = { query: { code: 'internal-auth-code', state: 'reauthorize' } } as any;
    const mockRes = { end: jest.fn() } as any;

    mockAuthStore.getCodeVerifier.mockReturnValue('test-verifier');
    (handler as any).provider = {
      exchangeAuthorizationCode: jest.fn().mockResolvedValue({ access_token: 'new-lark-token' }),
    };

    await handler['callback'](mockReq, mockRes);

    expect(mockAuthStore.storeLocalAccessToken).toHaveBeenCalledWith('new-lark-token', 'test-app-id');
    expect(mockRes.end).toHaveBeenCalledWith('success, you can close this page now');
  });

  it('stores refreshed local token after refreshToken succeeds', async () => {
    const handler = new LarkAuthHandlerLocal(mockApp, options);
    const superRefreshToken = jest.spyOn(LarkAuthHandler.prototype, 'refreshToken');
    superRefreshToken.mockResolvedValue({ access_token: 'refreshed-token' } as any);

    const result = await handler.refreshToken('expired-token');

    expect(mockAuthStore.storeLocalAccessToken).toHaveBeenCalledWith('refreshed-token', 'test-app-id');
    expect(result).toEqual({ access_token: 'refreshed-token' });

    superRefreshToken.mockRestore();
  });
});
