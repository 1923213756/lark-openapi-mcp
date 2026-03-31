import { LoginHandler } from '../../src/cli/login-handler';
import { authStore } from '../../src/auth/store';
import { LarkAuthHandlerLocal } from '../../src/auth/handler/handler-local';
import { isTokenExpired, isTokenValid } from '../../src/auth/utils';
import open from 'open';

jest.mock('../../src/auth/store', () => ({
  authStore: {
    getLocalAccessToken: jest.fn(),
    removeLocalAccessToken: jest.fn(),
    removeAllLocalAccessTokens: jest.fn(),
    getAllLocalAccessTokens: jest.fn(),
    getToken: jest.fn(),
    getStorageStatus: jest.fn(),
  },
}));

jest.mock('../../src/auth/utils', () => ({
  isTokenExpired: jest.fn(),
  isTokenValid: jest.fn(),
}));

jest.mock('../../src/auth/handler/handler-local', () => ({
  LarkAuthHandlerLocal: jest.fn(),
}));

jest.mock('express', () => {
  const mockApp = {
    use: jest.fn(),
    get: jest.fn(),
    listen: jest.fn(),
  };
  const expressFn = jest.fn(() => mockApp);
  (expressFn as any).json = jest.fn(() => (req: any, res: any, next: any) => next());
  return expressFn;
});

jest.mock('open', () => jest.fn());

const consoleSpy = {
  log: jest.spyOn(console, 'log').mockImplementation(),
  error: jest.spyOn(console, 'error').mockImplementation(),
};

const mockProcessExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

describe('LoginHandler', () => {
  const mockSetupRoutes = jest.fn();
  const mockRefreshToken = jest.fn();
  const mockReAuthorize = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    (authStore.getStorageStatus as jest.Mock).mockResolvedValue({
      storageReady: true,
      persistentStorage: true,
      storageFile: '/mock/storage/path/storage.json',
      initializationError: undefined,
      counts: {
        tokens: 1,
        clients: 1,
        localTokens: 1,
        transactions: 0,
        larkCredentials: 1,
        mcpSessions: 0,
      },
    });

    (LarkAuthHandlerLocal as unknown as jest.Mock).mockImplementation(() => ({
      setupRoutes: mockSetupRoutes,
      refreshToken: mockRefreshToken,
      reAuthorize: mockReAuthorize,
      callbackUrl: 'http://localhost:3000/callback',
    }));
  });

  afterAll(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
    mockProcessExit.mockRestore();
  });

  it('fails fast when app credentials are missing', async () => {
    await expect(
      LoginHandler.handleLogin({
        appId: '',
        appSecret: '',
        domain: 'https://open.feishu.cn',
        host: 'localhost',
        port: '3000',
      }),
    ).rejects.toThrow('Process exit 1');

    expect(consoleSpy.error).toHaveBeenCalledWith(
      'Error: Missing App Credentials (appId and appSecret are required for login)',
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it('reuses a valid stored login without opening the browser', async () => {
    (authStore.getLocalAccessToken as jest.Mock).mockResolvedValue('stored-access-token');
    (isTokenValid as jest.Mock).mockResolvedValue({ valid: true, isExpired: false, token: { token: 'stored' } });

    await expect(
      LoginHandler.handleLogin({
        appId: 'app-id',
        appSecret: 'app-secret',
        domain: 'https://open.feishu.cn',
        host: 'localhost',
        port: '3000',
      }),
    ).rejects.toThrow('Process exit 0');

    expect(mockRefreshToken).not.toHaveBeenCalled();
    expect(mockReAuthorize).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('silently refreshes an expired stored login before falling back to browser auth', async () => {
    (authStore.getLocalAccessToken as jest.Mock).mockResolvedValue('expired-access-token');
    (isTokenValid as jest.Mock).mockResolvedValue({
      valid: false,
      isExpired: true,
      token: {
        token: 'expired-access-token',
        extra: { refreshToken: 'refresh-token' },
      },
    });
    mockRefreshToken.mockResolvedValue({ access_token: 'new-access-token' });

    await expect(
      LoginHandler.handleLogin({
        appId: 'app-id',
        appSecret: 'app-secret',
        domain: 'https://open.feishu.cn',
        host: 'localhost',
        port: '3000',
      }),
    ).rejects.toThrow('Process exit 0');

    expect(mockRefreshToken).toHaveBeenCalledWith('expired-access-token');
    expect(mockReAuthorize).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('opens the browser when silent refresh fails', async () => {
    (authStore.getLocalAccessToken as jest.Mock).mockResolvedValue('expired-access-token');
    (isTokenValid as jest.Mock).mockResolvedValue({
      valid: false,
      isExpired: true,
      token: {
        token: 'expired-access-token',
        extra: { refreshToken: 'refresh-token' },
      },
    });
    mockRefreshToken.mockRejectedValue(new Error('refresh failed'));
    mockReAuthorize.mockResolvedValue({
      authorizeUrl: 'http://oauth.example.com/authorize',
      accessToken: '',
    });
    jest.spyOn(LoginHandler, 'checkTokenWithTimeout').mockResolvedValue(true);

    await expect(
      LoginHandler.handleLogin({
        appId: 'app-id',
        appSecret: 'app-secret',
        domain: 'https://open.feishu.cn',
        host: 'localhost',
        port: '3000',
      }),
    ).rejects.toThrow('Process exit 0');

    expect(mockReAuthorize).toHaveBeenCalledWith(undefined, false);
    expect(open).toHaveBeenCalledWith('http://oauth.example.com/authorize');
    expect(authStore.removeLocalAccessToken).toHaveBeenCalledWith('app-id');
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('forces a full browser login when --force is used', async () => {
    (authStore.getLocalAccessToken as jest.Mock).mockResolvedValue('valid-access-token');
    (isTokenValid as jest.Mock).mockResolvedValue({ valid: true, isExpired: false, token: { token: 'stored' } });
    mockReAuthorize.mockResolvedValue({
      authorizeUrl: 'http://oauth.example.com/authorize',
      accessToken: '',
    });
    jest.spyOn(LoginHandler, 'checkTokenWithTimeout').mockResolvedValue(true);

    await expect(
      LoginHandler.handleLogin({
        appId: 'app-id',
        appSecret: 'app-secret',
        domain: 'https://open.feishu.cn',
        host: 'localhost',
        port: '3000',
        force: true,
      }),
    ).rejects.toThrow('Process exit 0');

    expect(mockRefreshToken).not.toHaveBeenCalled();
    expect(mockReAuthorize).toHaveBeenCalledWith(undefined, true);
    expect(open).toHaveBeenCalledWith('http://oauth.example.com/authorize');
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('prints auth store diagnostics in whoami output', async () => {
    (authStore.getAllLocalAccessTokens as jest.Mock).mockResolvedValue({
      'app-id': 'access-token',
    });
    (authStore.getToken as jest.Mock).mockResolvedValue({
      clientId: 'client-id',
      token: 'access-token',
      scopes: ['scope1'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: {
        refreshToken: 'refresh-token',
        appId: 'app-id',
        appSecret: 'secret',
      },
    });
    (isTokenExpired as jest.Mock).mockReturnValue(false);

    await expect(LoginHandler.handleWhoAmI()).rejects.toThrow('Process exit 0');

    expect(authStore.getStorageStatus).toHaveBeenCalled();
    expect(authStore.getToken).toHaveBeenCalledWith('access-token');
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('prints diagnostics even when there is no active login session', async () => {
    (authStore.getAllLocalAccessTokens as jest.Mock).mockResolvedValue({});

    await expect(LoginHandler.handleWhoAmI()).rejects.toThrow('Process exit 0');

    expect(authStore.getStorageStatus).toHaveBeenCalled();
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });
});
