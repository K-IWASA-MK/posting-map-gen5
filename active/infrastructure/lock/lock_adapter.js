/**
 * Infrastructure Layer - Lock Adapter Module
 * 
 * Section: SEC-032 LockServiceProvider
 * Owner Layer: Infrastructure Layer
 * Responsibility: LockService による排他ロック制御のカプセル化
 */

class LockServiceProvider {
  constructor() {
    this.configProvider = null;
  }
  static getInstance() {
    if (!LockServiceProvider.instance) {
      LockServiceProvider.instance = new LockServiceProvider();
    }
    return LockServiceProvider.instance;
  }
  executeWithLock(action) {
    const lock = LockService.getScriptLock();
    const timeoutMs = this.configProvider ? this.configProvider.getLockTimeout() : 10000;
    const startTime = Date.now();
    const hasLock = lock.tryLock(timeoutMs);
    if (!hasLock) {
      throw new Error("Lock Timeout: Failed to acquire lock within " + timeoutMs + "ms.");
    }
    try {
      return action();
    } finally {
      try {
        lock.releaseLock();
      } catch (e) {}
    }
  }
}
LockServiceProvider.instance = null;
