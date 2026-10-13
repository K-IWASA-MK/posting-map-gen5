/**
 * active/h-app/components/sync-status.js
 * H-App Sync Status Presentation Component (Target Architecture B' Wave 17)
 *
 * 責務:
 * - オンライン / オフライン / 同期中（ONLINE / OFFLINE / SYNCING）のヘッダー表示制御
 * - DOM (#sync-status, #sync-text) のスタイルクラスおよびラベル更新
 *
 * 制約:
 * - Presentation 専任（0 State, 0 API, 0 Timer, 0 Promise, 0 Auth, 0 Storage）
 * - 自己完結（app.js 由来の global / lexical ヘルパーへの逆依存なし）
 * - 元コード完全移植（式・順序・クラス文字列・null ガードの完全一致）
 */
window.SyncStatusView = (function() {
  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(state) {
    const statusEl = $('sync-status');
    const textEl = $('sync-text');
    if (!statusEl) return;
    statusEl.className = 'w-2 h-2 rounded-full transition-all duration-300';

    if (textEl) {
      textEl.className = 'text-[8px] font-black uppercase tracking-[0.2em] transition-all duration-300';
    }

    if (state === 'online') {
      statusEl.classList.add('bg-[#22c55e]', 'shadow-[0_0_8px_#22c55e]', 'animate-soft-pulse');
      if (textEl) {
        textEl.textContent = 'ONLINE';
        textEl.classList.add('text-[#22c55e]');
      }
    } else if (state === 'offline') {
      statusEl.classList.add('bg-[#f59e0b]', 'shadow-[0_0_8px_#f59e0b]');
      if (textEl) {
        textEl.textContent = 'OFFLINE';
        textEl.classList.add('text-[#f59e0b]');
      }
    } else if (state === 'syncing') {
      statusEl.classList.add('bg-[#2563eb]', 'shadow-[0_0_8px_#2563eb]', 'animate-pulse');
      if (textEl) {
        textEl.textContent = 'SYNCING';
        textEl.classList.add('text-[#2563eb]', 'animate-pulse');
      }
    }
  }

  return { setStatus };
})();
