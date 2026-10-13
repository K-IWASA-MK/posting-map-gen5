/**
 * POSTING MAP - System Summary State & In-flight Ownership Feature Module (modules/summary.js)
 *
 * 責務:
 * - lastSummaryData キャッシュの所有
 * - _systemSummaryPromise インフライト/解決済みPromiseキャッシュの所有
 * - 純粋な原子的セッター (Atomic Setters) およびゲッターの提供
 * - 外部環境依存ゼロ (window / globalThis / DOM / callApiPost / LIFF / タイマーへの直接依存ゼロ)
 */
const SummaryModule = (function() {
  let _lastSummaryData = null;
  let _systemSummaryPromise = null;

  function getLastSummaryData() {
    return _lastSummaryData;
  }

  function setLastSummaryData(data) {
    _lastSummaryData = data;
  }

  function getSystemSummaryPromise() {
    return _systemSummaryPromise;
  }

  function setSystemSummaryPromise(promise) {
    _systemSummaryPromise = promise;
  }

  return {
    getLastSummaryData,
    setLastSummaryData,
    getSystemSummaryPromise,
    setSystemSummaryPromise
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SummaryModule;
}
