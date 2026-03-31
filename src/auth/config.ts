import { ENV_PATHS } from '../utils/constants';

export const AUTH_CONFIG = {
  SERVER_NAME: 'lark-mcp',
  AES_KEY_NAME: 'encryption-key',
  STORAGE_DIR: process.env.LARK_AUTH_STORE_PATH || ENV_PATHS.data,
  STORAGE_FILE: process.env.LARK_AUTH_STORE_FILE || 'storage.json',
  ENV_AES_KEY_NAME: 'LARK_AUTH_ENCRYPTION_KEY',
  DEFAULT_OAUTH_BASE_PATH: '/oauth',
  OAUTH_EXPIRY_SAFETY_WINDOW_SECONDS: 5 * 60,
  TRANSACTION_TTL_SECONDS: 10 * 60,
  MCP_SESSION_TTL_SECONDS: 60 * 60,
  MCP_REFRESH_TTL_SECONDS: 30 * 24 * 60 * 60,
  ENCRYPTION: {
    ALGORITHM: 'aes-256-cbc' as const,
    KEY_LENGTH: 32, // 256 bits
    IV_LENGTH: 16, // 128 bits
  },
} as const;

export type AuthConfig = typeof AUTH_CONFIG;
