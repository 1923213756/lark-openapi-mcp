import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import fs from 'fs';
import { storageManager } from './utils/storage-manager';
import { AuthTransaction, LarkCredential, StorageData } from './types';
import { logger } from '../utils/logger';
import { AUTH_CONFIG } from './config';

export class AuthStore implements OAuthRegisteredClientsStore {
  private storageDataCache: StorageData = {
    tokens: {},
    clients: {},
    transactions: {},
    larkCredentials: {},
    mcpSessions: {},
  };
  private codeVerifiers: Map<string, string> = new Map();
  private initializePromise: Promise<void> | undefined;
  private fileWatcher: fs.FSWatcher | undefined;
  private isReloading = false;
  private isInitializedStorageSuccess = false;

  constructor() {
    this.initialize();
  }

  private normalizeStorageData(storageData?: StorageData): StorageData {
    return {
      tokens: storageData?.tokens || {},
      clients: storageData?.clients || {},
      localTokens: storageData?.localTokens || {},
      transactions: storageData?.transactions || {},
      larkCredentials: storageData?.larkCredentials || {},
      mcpSessions: storageData?.mcpSessions || {},
    };
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.performInitialization();
    await this.initializePromise;
  }

  private async performInitialization(): Promise<void> {
    try {
      await this.loadFromStorage();
      this.isInitializedStorageSuccess = storageManager.isReady();

      if (!this.isInitializedStorageSuccess) {
        logger.warn(
          `[AuthStore] Persistent storage is unavailable: ${storageManager.getInitializationError()?.message || 'unknown error'}`,
        );
        return;
      }

      logger.info(
        `[AuthStore] Initialized storage successfully with ${Object.keys(this.storageDataCache.tokens).length} Lark tokens and ${Object.keys(this.storageDataCache.mcpSessions || {}).length} MCP sessions`,
      );
      await this.clearExpiredRecords();
      this.setupFileWatcher();
    } catch (error) {
      logger.error(`[AuthStore] Failed to initialize: ${error}`);
      this.isInitializedStorageSuccess = false;
    }
  }

  private setupFileWatcher(): void {
    try {
      if (fs.existsSync(storageManager.storageFile)) {
        logger.info(`[AuthStore] Setup file watcher for ${storageManager.storageFile}`);
        this.fileWatcher = fs.watch(storageManager.storageFile, () => {
          this.handleFileChange();
        });
      }
    } catch (error) {
      logger.error(`[AuthStore] Failed to setup file watcher: ${error}`);
    }
  }

  private async handleFileChange(): Promise<void> {
    if (this.isReloading) {
      return;
    }

    this.isReloading = true;
    try {
      logger.info(`[AuthStore] Reloading storage from ${storageManager.storageFile}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.loadFromStorage();
    } catch (error) {
      logger.error(`[AuthStore] Failed to reload storage: ${error}`);
    } finally {
      this.isReloading = false;
    }
  }

  private async loadFromStorage(): Promise<void> {
    const storageData = await storageManager.loadStorageData();
    this.storageDataCache = this.normalizeStorageData(storageData);
  }

  private async saveToStorage(): Promise<void> {
    if (!this.isInitializedStorageSuccess) {
      return;
    }
    await storageManager.saveStorageData(this.storageDataCache);
  }

  private async clearExpiredRecords(): Promise<void> {
    if (!this.storageDataCache || !this.storageDataCache.tokens) {
      return;
    }

    const now = Date.now() / 1000;
    let shouldPersist = false;

    for (const [tokenKey, token] of Object.entries(this.storageDataCache.tokens)) {
      if (token.expiresAt && token.expiresAt + 7 * 24 * 60 * 60 < now) {
        delete this.storageDataCache.tokens[tokenKey];
        shouldPersist = true;
      }
    }

    for (const [appId, tokenKey] of Object.entries(this.storageDataCache.localTokens || {})) {
      if (!this.storageDataCache.tokens[tokenKey]) {
        delete this.storageDataCache.localTokens?.[appId];
        shouldPersist = true;
      }
    }

    for (const [txId, transaction] of Object.entries(this.storageDataCache.transactions || {})) {
      if (transaction.expiresAt < now || transaction.consumedAt) {
        delete this.storageDataCache.transactions?.[txId];
        shouldPersist = true;
      }
    }

    for (const [sessionToken, session] of Object.entries(this.storageDataCache.mcpSessions || {})) {
      const refreshExpiresAt = Number(session.extra?.refreshExpiresAt || 0);
      if (refreshExpiresAt > 0 && refreshExpiresAt < now) {
        delete this.storageDataCache.mcpSessions?.[sessionToken];
        shouldPersist = true;
        continue;
      }
      if (session.expiresAt && session.expiresAt + 7 * 24 * 60 * 60 < now) {
        delete this.storageDataCache.mcpSessions?.[sessionToken];
        shouldPersist = true;
      }
    }

    if (shouldPersist) {
      logger.info('[AuthStore] Cleared expired auth records');
      await this.saveToStorage();
    }
  }

  // Backward-compatible alias used by existing tests.
  private async clearExpiredTokens(): Promise<void> {
    await this.clearExpiredRecords();
  }

  async storeToken(token: AuthInfo): Promise<AuthInfo> {
    await this.initialize();
    this.storageDataCache.tokens[token.token] = token;
    await this.saveToStorage();
    return token;
  }

  async removeToken(accessToken: string): Promise<void> {
    await this.initialize();
    delete this.storageDataCache.tokens[accessToken];

    for (const [appId, tokenKey] of Object.entries(this.storageDataCache.localTokens || {})) {
      if (tokenKey === accessToken) {
        delete this.storageDataCache.localTokens?.[appId];
      }
    }

    await this.saveToStorage();
  }

  async getToken(accessToken: string): Promise<AuthInfo | undefined> {
    await this.initialize();
    return this.storageDataCache.tokens[accessToken];
  }

  async getTokenByRefreshToken(refreshToken: string): Promise<AuthInfo | undefined> {
    await this.initialize();
    return Object.values(this.storageDataCache.tokens).find((token) => token.extra?.refreshToken === refreshToken);
  }

  async getLocalAccessToken(appId: string): Promise<string | undefined> {
    await this.initialize();
    return this.storageDataCache.localTokens?.[appId];
  }

  async storeLocalAccessToken(accessToken: string, appId: string): Promise<string> {
    await this.initialize();

    if (!this.storageDataCache.localTokens) {
      this.storageDataCache.localTokens = {};
    }
    this.storageDataCache.localTokens[appId] = accessToken;

    await this.saveToStorage();
    return accessToken;
  }

  async removeLocalAccessToken(appId: string): Promise<void> {
    await this.initialize();
    if (this.storageDataCache.localTokens?.[appId]) {
      logger.info(`[AuthStore] Removing local access token for app: ${appId}`);
      const tokenToRemove = this.storageDataCache.localTokens[appId];
      delete this.storageDataCache.tokens[tokenToRemove];
      delete this.storageDataCache.localTokens[appId];
      await this.saveToStorage();
    }
  }

  async removeAllLocalAccessTokens(): Promise<void> {
    await this.initialize();
    logger.info('[AuthStore] Removing all local access tokens');
    if (this.storageDataCache.localTokens) {
      for (const token of Object.values(this.storageDataCache.localTokens)) {
        delete this.storageDataCache.tokens[token];
      }
    }
    this.storageDataCache.localTokens = {};
    await this.saveToStorage();
  }

  async getAllLocalAccessTokens(): Promise<{ [appId: string]: string }> {
    await this.initialize();
    return this.storageDataCache.localTokens || {};
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    await this.initialize();
    this.storageDataCache.clients[client.client_id] = client;
    await this.saveToStorage();
    return client;
  }

  async getClient(id: string): Promise<OAuthClientInformationFull | undefined> {
    await this.initialize();
    return this.storageDataCache.clients[id];
  }

  async removeClient(clientId: string): Promise<void> {
    await this.initialize();
    delete this.storageDataCache.clients[clientId];
    await this.saveToStorage();
  }

  async storeTransaction(transaction: AuthTransaction): Promise<AuthTransaction> {
    await this.initialize();
    if (!this.storageDataCache.transactions) {
      this.storageDataCache.transactions = {};
    }
    this.storageDataCache.transactions[transaction.txId] = transaction;
    await this.saveToStorage();
    return transaction;
  }

  async getTransaction(txId: string): Promise<AuthTransaction | undefined> {
    await this.initialize();
    return this.storageDataCache.transactions?.[txId];
  }

  async updateTransaction(txId: string, patch: Partial<AuthTransaction>): Promise<AuthTransaction | undefined> {
    await this.initialize();
    const current = this.storageDataCache.transactions?.[txId];
    if (!current) {
      return undefined;
    }
    const next = { ...current, ...patch };
    this.storageDataCache.transactions![txId] = next;
    await this.saveToStorage();
    return next;
  }

  async removeTransaction(txId: string): Promise<void> {
    await this.initialize();
    delete this.storageDataCache.transactions?.[txId];
    await this.saveToStorage();
  }

  async storeLarkCredential(credential: LarkCredential): Promise<LarkCredential> {
    await this.initialize();
    if (!this.storageDataCache.larkCredentials) {
      this.storageDataCache.larkCredentials = {};
    }
    this.storageDataCache.larkCredentials[credential.credentialId] = credential;
    await this.saveToStorage();
    return credential;
  }

  async getLarkCredential(credentialId: string): Promise<LarkCredential | undefined> {
    await this.initialize();
    return this.storageDataCache.larkCredentials?.[credentialId];
  }

  async getLarkCredentialByAccessToken(accessToken: string): Promise<LarkCredential | undefined> {
    await this.initialize();
    return Object.values(this.storageDataCache.larkCredentials || {}).find(
      (credential) => credential.accessToken === accessToken,
    );
  }

  async removeLarkCredential(credentialId: string): Promise<void> {
    await this.initialize();
    delete this.storageDataCache.larkCredentials?.[credentialId];
    await this.saveToStorage();
  }

  async storeMcpSession(session: AuthInfo): Promise<AuthInfo> {
    await this.initialize();
    if (!this.storageDataCache.mcpSessions) {
      this.storageDataCache.mcpSessions = {};
    }
    this.storageDataCache.mcpSessions[session.token] = session;
    await this.saveToStorage();
    return session;
  }

  async getMcpSession(accessToken: string): Promise<AuthInfo | undefined> {
    await this.initialize();
    return this.storageDataCache.mcpSessions?.[accessToken];
  }

  async getMcpSessionByRefreshToken(refreshToken: string): Promise<AuthInfo | undefined> {
    await this.initialize();
    return Object.values(this.storageDataCache.mcpSessions || {}).find(
      (session) => session.extra?.refreshToken === refreshToken,
    );
  }

  async removeMcpSession(accessToken: string): Promise<void> {
    await this.initialize();
    delete this.storageDataCache.mcpSessions?.[accessToken];
    await this.saveToStorage();
  }

  async removeMcpSessionsByClient(clientId: string, exceptToken?: string): Promise<number> {
    await this.initialize();

    let removedCount = 0;
    for (const [accessToken, session] of Object.entries(this.storageDataCache.mcpSessions || {})) {
      if (accessToken === exceptToken) {
        continue;
      }
      if (session.clientId !== clientId) {
        continue;
      }
      delete this.storageDataCache.mcpSessions?.[accessToken];
      removedCount += 1;
    }

    if (removedCount > 0) {
      await this.saveToStorage();
    }

    return removedCount;
  }

  storeCodeVerifier(key: string, codeVerifier: string): void {
    this.codeVerifiers.set(key, codeVerifier);
  }

  getCodeVerifier(key: string): string | undefined {
    return this.codeVerifiers.get(key);
  }

  removeCodeVerifier(key: string): void {
    this.codeVerifiers.delete(key);
  }

  clearExpiredCodeVerifiers(): void {
    this.codeVerifiers.clear();
  }

  getTransactionTTL(): number {
    return AUTH_CONFIG.TRANSACTION_TTL_SECONDS;
  }

  getMcpSessionTTL(): number {
    return AUTH_CONFIG.MCP_SESSION_TTL_SECONDS;
  }

  getMcpRefreshTTL(): number {
    return AUTH_CONFIG.MCP_REFRESH_TTL_SECONDS;
  }

  async ensurePersistentStorage(reason = 'Hosted OAuth requires persistent storage'): Promise<void> {
    await this.initialize();
    if (this.isInitializedStorageSuccess) {
      return;
    }

    const error = new Error(
      `${reason}${storageManager.getInitializationError() ? `: ${storageManager.getInitializationError()!.message}` : ''}`,
    ) as Error & { code?: string };
    error.code = 'persistent_storage_unavailable';
    throw error;
  }

  async getStorageStatus() {
    await this.initialize();
    const storageStatus = storageManager.getStatus();

    return {
      storageReady: this.isInitializedStorageSuccess,
      persistentStorage: storageStatus.persistentStorage,
      storageFile: storageStatus.storageFile,
      initializationError: storageStatus.initializationError,
      counts: {
        tokens: Object.keys(this.storageDataCache.tokens || {}).length,
        clients: Object.keys(this.storageDataCache.clients || {}).length,
        localTokens: Object.keys(this.storageDataCache.localTokens || {}).length,
        transactions: Object.keys(this.storageDataCache.transactions || {}).length,
        larkCredentials: Object.keys(this.storageDataCache.larkCredentials || {}).length,
        mcpSessions: Object.keys(this.storageDataCache.mcpSessions || {}).length,
      },
    };
  }

  destroy(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = undefined;
    }
  }
}

export const authStore = new AuthStore();
