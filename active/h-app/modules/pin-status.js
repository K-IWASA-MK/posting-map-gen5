/**
 * active/h-app/modules/pin-status.js
 * H-App Pin Status Feature Module (Architecture B' Wave 3)
 *
 * 単一責任:
 * - 現場端末における Pin Status (inProgress / completed) のローカルキャッシュ管理
 * - 定期同期 (fetchStatus: 10s throttle)
 * - 選択中ピンのリアルタイム排他制御 (setInProgress: FIFO serialized queue)
 * - 活動完了事実のローカル反映 (reflectCompleted)
 *
 * 厳格な制約:
 * - DOM/Map/UI/Globals への直接依存は一切禁止
 * - app.js private 関数への直接参照禁止 (DI hooks 経由)
 * - 状態公開は厳密に5つの関数のみ。状態オブジェクトや mutable callback は外部露出しない
 * - Classic-script lexical binding (window/global property export なし)
 */
const PinStatusModule = (() => {
  // Private State (外部露出 0)
  let _inProgress = [];
  let _completed = [];
  let _lastSyncTime = 0;
  let _actionPromiseChain = Promise.resolve();

  /**
   * 1. Fetch & Throttle Lifecycle
   * @param {Object} [hooks]
   * @param {Function} [hooks.onStatusUpdated]
   * @param {Function} [hooks.onError]
   * @returns {Promise<void>}
   */
  async function fetchStatus(hooks) {
    const currentHooks = hooks || {};
    const now = Date.now();
    if (now - _lastSyncTime < 10000) {
      return;
    }
    _lastSyncTime = now;
    try {
      if (typeof callApiPost !== 'function') {
        throw new Error('callApiPost is not available');
      }
      const res = await callApiPost('getGlobalPinStatus');
      if (res && res.success) {
        _inProgress = Array.isArray(res.inProgress) ? res.inProgress.slice() : [];
        _completed = Array.isArray(res.completed) ? res.completed.slice() : [];
        if (typeof currentHooks.onStatusUpdated === 'function') {
          currentHooks.onStatusUpdated();
        }
      }
    } catch (err) {
      if (typeof currentHooks.onError === 'function') {
        currentHooks.onError(err);
      }
    }
  }

  /**
   * 2. Mutation & Serialized FIFO Queue
   * @param {number|string} rowId
   * @param {'add'|'remove'} action
   * @param {Object} [hooks]
   * @param {Function} [hooks.authorize]
   * @param {Function} [hooks.onError]
   * @returns {Promise<void>}
   */
  function setInProgress(rowId, action, hooks) {
    const currentHooks = hooks || {};
    const numericRowId = parseInt(rowId, 10);
    if (!isNaN(numericRowId)) {
      if (action === "remove") {
        _inProgress = _inProgress.filter(id => id !== numericRowId);
      } else if (action === "add") {
        if (!_inProgress.includes(numericRowId)) {
          _inProgress.push(numericRowId);
        }
      }
    }

    // FIFO 直列化チェーン
    _actionPromiseChain = _actionPromiseChain.then(async () => {
      try {
        if (typeof currentHooks.authorize === 'function') {
          await currentHooks.authorize();
        }
        if (typeof callApiPost !== 'function') {
          throw new Error('callApiPost is not available');
        }
        await callApiPost('setPinInProgress', { rowId: rowId, pinAction: action });
      } catch (err) {
        if (typeof currentHooks.onError === 'function') {
          currentHooks.onError(err);
        }
      }
    });

    return _actionPromiseChain;
  }

  /**
   * 3. Status Query API (isInProgress)
   * @param {number|string} rowId
   * @returns {boolean}
   */
  function isInProgress(rowId) {
    const numericRowId = Number(rowId);
    return !isNaN(numericRowId) && _inProgress.includes(numericRowId);
  }

  /**
   * 3. Status Query API (isCompleted)
   * @param {number|string} rowId
   * @returns {boolean}
   */
  function isCompleted(rowId) {
    const numericRowId = Number(rowId);
    return !isNaN(numericRowId) && _completed.includes(numericRowId);
  }

  /**
   * 4. Activity Derived Snapshot Reflection API
   * Backend / Activity で確定した完了事実をローカルキャッシュへ反映
   * (完成Authorityではなく、ローカル同期のみ。API通信は一切行わない)
   * @param {number|string} rowId
   */
  function reflectCompleted(rowId) {
    const numericRowId = Number(rowId);
    if (!isNaN(numericRowId)) {
      if (!_completed.includes(numericRowId)) {
        _completed.push(numericRowId);
      }
      _inProgress = _inProgress.filter(id => id !== numericRowId);
    }
  }

  return {
    fetchStatus,
    setInProgress,
    isInProgress,
    isCompleted,
    reflectCompleted
  };
})();
