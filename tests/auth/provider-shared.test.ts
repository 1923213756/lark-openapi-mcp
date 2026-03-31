import { AUTH_CONFIG } from '../../src/auth/config';
import { getMcpSessionExpiryWindow } from '../../src/auth/provider/shared';

jest.mock('../../src/auth/store', () => ({
  authStore: {
    getMcpSessionTTL: jest.fn(() => 60 * 60),
    getMcpRefreshTTL: jest.fn(() => 30 * 24 * 60 * 60),
  },
}));

describe('getMcpSessionExpiryWindow', () => {
  it('keeps MCP access token shorter than the upstream Feishu access token', () => {
    const now = 1_700_000_000;
    const window = getMcpSessionExpiryWindow(
      {
        credentialId: 'cred-1',
        accessToken: 'lark-access-token',
        refreshToken: 'lark-refresh-token',
        appId: 'app-id',
        appSecret: 'app-secret',
        scopes: ['scope1'],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 7200,
        refreshExpiresAt: now + 86400,
      },
      now,
    );

    expect(window.accessExpiresAt).toBe(now + 7200 - AUTH_CONFIG.OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS);
    expect(window.accessExpiresIn).toBe(7200 - AUTH_CONFIG.OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS);
    expect(window.refreshExpiresAt).toBe(now + 86400 - AUTH_CONFIG.OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS);
  });

  it('falls back to the default MCP refresh ttl when upstream refresh expiry is unavailable', () => {
    const now = 1_700_000_000;
    const window = getMcpSessionExpiryWindow(
      {
        credentialId: 'cred-1',
        accessToken: 'lark-access-token',
        refreshToken: 'lark-refresh-token',
        appId: 'app-id',
        appSecret: 'app-secret',
        scopes: ['scope1'],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 7200,
      },
      now,
    );

    expect(window.refreshExpiresAt).toBe(now + 30 * 24 * 60 * 60);
  });
});
