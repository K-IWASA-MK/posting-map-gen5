/**
 * Infrastructure Layer - Cache Adapter Module
 * 
 * Section: SEC-033 CacheServiceProvider
 * Owner Layer: Infrastructure Layer
 * Responsibility: CacheService によるキャッシュアクセスのカプセル化
 */

class CacheServiceProvider {
  constructor() {
    this.configProvider = null;
  }
  static getInstance() {
    if (!CacheServiceProvider.instance) {
      CacheServiceProvider.instance = new CacheServiceProvider();
    }
    return CacheServiceProvider.instance;
  }
  makeKey(tenantId, branchId, category) {
    return tenantId + ":" + branchId + ":" + category;
  }
  get(key) {
    try {
      return CacheService.getScriptCache().get(key);
    } catch (e) {
      return null;
    }
  }
  put(key, value, ttlSeconds) {
    try {
      const expiry = ttlSeconds !== undefined ? ttlSeconds : (this.configProvider ? this.configProvider.getCacheTTL() : 600);
      CacheService.getScriptCache().put(key, value, Math.min(expiry, 21600));
    } catch (e) {}
  }
  remove(key) {
    try {
      CacheService.getScriptCache().remove(key);
    } catch (e) {}
  }
}
CacheServiceProvider.instance = null;
