import fs from 'fs';
import path from 'path';
import { EncryptionUtil } from './encryption';
import { AUTH_CONFIG } from '../config';
import { StorageData } from '../types';
import { logger } from '../../utils/logger';

export class StorageManager {
  private encryptionUtil: EncryptionUtil | undefined;
  private initializePromise: Promise<void> | undefined;
  private isInitializedStorageSuccess = false;
  private initializationError: Error | undefined;

  constructor() {
    this.initialize();
  }

  get storageFile(): string {
    return path.join(AUTH_CONFIG.STORAGE_DIR, AUTH_CONFIG.STORAGE_FILE);
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
      await this.initializeEncryption();
      this.ensureStorageDir();
      this.isInitializedStorageSuccess = true;
      this.initializationError = undefined;
    } catch (error) {
      logger.warn(`[StorageManager] Failed to initialize: ${error}`);
      logger.warn(
        '[StorageManager] ⚠️ Builtin User Access Token Store will be disabled. but you can still use it with memory store',
      );
      this.isInitializedStorageSuccess = false;
      this.initializationError = error instanceof Error ? error : new Error(String(error));
    }
  }

  private async initializeEncryption(): Promise<void> {
    const envKey = process.env[AUTH_CONFIG.ENV_AES_KEY_NAME];
    if (envKey) {
      this.encryptionUtil = new EncryptionUtil(envKey);
      return;
    }

    try {
      const keytar = await import('keytar');
      let key = await keytar.getPassword(AUTH_CONFIG.SERVER_NAME, AUTH_CONFIG.AES_KEY_NAME);
      if (!key) {
        key = EncryptionUtil.generateKey();
        await keytar.setPassword(AUTH_CONFIG.SERVER_NAME, AUTH_CONFIG.AES_KEY_NAME, key);
      }
      this.encryptionUtil = new EncryptionUtil(key);
    } catch (error) {
      logger.warn(`[StorageManager] Failed to initialize encryption: ${error}`);
      throw error;
    }
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(AUTH_CONFIG.STORAGE_DIR)) {
      fs.mkdirSync(AUTH_CONFIG.STORAGE_DIR, { recursive: true });
    }
  }

  encrypt(data: string): string {
    if (!this.isInitializedStorageSuccess || !this.encryptionUtil) {
      throw new Error('StorageManager not initialized - call initialize() first');
    }
    return this.encryptionUtil.encrypt(data);
  }

  decrypt(encryptedData: string): string {
    if (!this.isInitializedStorageSuccess || !this.encryptionUtil) {
      throw new Error('StorageManager not initialized - call initialize() first');
    }
    return this.encryptionUtil.decrypt(encryptedData);
  }

  async loadStorageData(): Promise<StorageData> {
    await this.initialize();
    if (!this.isInitializedStorageSuccess || !fs.existsSync(this.storageFile)) {
      return { tokens: {}, clients: {} };
    }
    try {
      const data = fs.readFileSync(this.storageFile, 'utf8');
      return data ? JSON.parse(this.decrypt(data)) : { tokens: {}, clients: {} };
    } catch (error) {
      logger.error(`[StorageManager] Failed to load storage data: ${error}`);
      logger.error(
        '[StorageManager] ⚠️ Builtin User Access Token Store will be disabled. but you can still use it with memory store',
      );
      return { tokens: {}, clients: {} };
    }
  }

  async saveStorageData(data: StorageData): Promise<void> {
    if (!this.isInitializedStorageSuccess) {
      return;
    }
    await this.initialize();
    try {
      const encryptedData = this.encrypt(JSON.stringify(data, null, 2));
      fs.writeFileSync(this.storageFile, encryptedData);
    } catch (error) {
      logger.error(`[StorageManager] Failed to save storage data: ${error}`);
      throw error;
    }
  }

  isReady(): boolean {
    return this.isInitializedStorageSuccess;
  }

  getInitializationError(): Error | undefined {
    return this.initializationError;
  }

  getStatus() {
    return {
      ready: this.isInitializedStorageSuccess,
      persistentStorage: this.isInitializedStorageSuccess,
      storageFile: this.storageFile,
      initializationError: this.initializationError?.message,
    };
  }
}

export const storageManager = new StorageManager();
