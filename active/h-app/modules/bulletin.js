const BulletinModule = (() => {
  // Private Feature State
  let _cachedBulletinPosts = null;       // 投稿データのメモリキャッシュ
  let _bulletinFetched = false;          // 取得成功実績フラグ
  let _activeBulletinPromise = null;      // 実際の通信プロミス（callApiPostが真にsettleするまで保持）
  let _bulletinReqSeq = 0;               // 最新リクエスト世代番号
  let _bulletinNeedsRefresh = false;     // in-flight中にforceが要求された場合の遅延再取得フラグ

  /**
   * メッセージのバリデーション
   * @param {string} message
   * @returns {{ valid: boolean, error?: string, message?: string, value?: string }}
   */
  function validateMessage(message) {
    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (!trimmed) {
      return { valid: false, error: 'EMPTY', message: 'メッセージを入力してください。' };
    }
    if (trimmed.length > 150) {
      return { valid: false, error: 'TOO_LONG', message: 'メッセージは150文字以内で入力してください。' };
    }
    return { valid: true, value: trimmed };
  }

  /**
   * 掲示板投稿の取得ライフサイクル
   *
   * 判定順序（絶対契約）:
   * ① Cache判定 (cache !== null && !force)
   * ② 初回Loading判定 (!fetched)
   * ③ In-flight判定 (_activeBulletinPromise !== null)
   * ④ 新規Network開始 (15s UI timeout race vs networkPromise)
   *
   * @param {Object} options
   * @param {boolean} [options.force=false]
   * @param {Object} hooks
   * @param {Function} hooks.isPageActive
   * @param {Function} hooks.onLoading
   * @param {Function} hooks.onRender
   * @param {Function} hooks.onError
   * @returns {Promise<Array>}
   */
  function fetchPosts(options = {}, hooks = {}) {
    const force = options.force === true;
    const isPageActive = typeof hooks.isPageActive === 'function' ? hooks.isPageActive : () => true;
    const onLoading = typeof hooks.onLoading === 'function' ? hooks.onLoading : () => {};
    const onRender = typeof hooks.onRender === 'function' ? hooks.onRender : () => {};
    const onError = typeof hooks.onError === 'function' ? hooks.onError : () => {};

    // ① Cache判定（最優先: in-flight判定より前）
    if (_cachedBulletinPosts !== null && !force) {
      if (isPageActive()) {
        onRender(_cachedBulletinPosts);
      }
      return Promise.resolve(_cachedBulletinPosts);
    }

    // ② 初回Loading判定
    if (!_bulletinFetched && isPageActive()) {
      onLoading();
    }

    // ③ In-flight判定
    if (_activeBulletinPromise) {
      if (force) {
        _bulletinNeedsRefresh = true;
      }
      return _activeBulletinPromise;
    }

    // ④ 新規Network開始
    const currentSeq = ++_bulletinReqSeq;
    let isUiSettled = false;
    let uiTimeoutTimer = null;

    // 15秒の「UI待機限界」タイマー
    const uiTimeoutPromise = new Promise((_, reject) => {
      uiTimeoutTimer = setTimeout(() => {
        if (!isUiSettled) {
          reject(new Error("UI_TIMEOUT"));
        }
      }, 15000);
    });

    // 実際の通信処理（callApiPostが真にsettleするまで管理）
    const networkPromise = callApiPost('getBulletinPosts')
      .then(data => {
        if (data && data.success && Array.isArray(data.posts)) {
          return data.posts;
        }
        throw new Error((data && data.message) || "データ取得に失敗しました");
      });

    _activeBulletinPromise = networkPromise;

    // UI層への反映：networkPromise と uiTimeoutPromise のレース
    // ※ただし networkPromise はバックグラウンドで最後まで走り続ける
    Promise.race([networkPromise, uiTimeoutPromise])
      .then(posts => {
        isUiSettled = true;
        if (uiTimeoutTimer) clearTimeout(uiTimeoutTimer);

        // 防御的世代チェック
        if (currentSeq !== _bulletinReqSeq) return;

        _cachedBulletinPosts = posts;
        _bulletinFetched = true;

        if (isPageActive()) {
          onRender(posts);
        }
      })
      .catch(err => {
        isUiSettled = true;
        if (uiTimeoutTimer) clearTimeout(uiTimeoutTimer);

        // 防御的世代チェック
        if (currentSeq !== _bulletinReqSeq) return;

        // キャッシュがあれば維持
        if (_cachedBulletinPosts !== null) {
          if (isPageActive()) {
            onRender(_cachedBulletinPosts);
          }
          return;
        }

        // 初回でキャッシュがない場合のみエラーUIを通知
        if (isPageActive()) {
          onError({
            error: err,
            isTimeout: err.message === "UI_TIMEOUT",
            message: err.message === "UI_TIMEOUT" ? "通信がタイムアウトしました" : "データ取得に失敗しました"
          });
        }
      });

    // 通信本体（networkPromise）が真にsettleしたときのライフサイクルクリーンアップ
    networkPromise
      .then(posts => {
        // UIタイムアウト後遅延成功時、または通常成功時の二重描画経路
        if (currentSeq === _bulletinReqSeq) {
          _cachedBulletinPosts = posts;
          _bulletinFetched = true;
          if (isPageActive()) {
            onRender(posts);
          }
        }
      })
      .catch(err => {
        console.warn("[Bulletin Network Settle Warn]", err.message);
      })
      .finally(() => {
        if (_activeBulletinPromise === networkPromise) {
          _activeBulletinPromise = null;
        }
        if (_bulletinNeedsRefresh) {
          _bulletinNeedsRefresh = false;
          fetchPosts({ force: true }, hooks);
        }
      });

    // 返却PromiseはnetworkPromise本体（UI raceではない）
    return networkPromise;
  }

  /**
   * 掲示板投稿の作成 API 発行
   * @param {Object} payload
   * @param {string} payload.staffId
   * @param {string} payload.staffName
   * @param {string} payload.message
   * @returns {Promise<Object>}
   */
  async function createPost(payload) {
    const valRes = validateMessage(payload && payload.message);
    if (!valRes.valid) {
      return { success: false, validationError: valRes.error, message: valRes.message };
    }

    return await callApiPost('createBulletinPost', {
      staffId: payload.staffId,
      staffName: payload.staffName,
      message: valRes.value
    });
  }

  /**
   * 掲示板連絡の送信 API 発行
   * @param {Object} payload
   * @param {string} payload.requestId
   * @param {string} payload.requestUserId
   * @param {string} payload.targetStaffId
   * @param {string} payload.contactMethod
   * @param {string} payload.contactValue
   * @returns {Promise<Object>}
   */
  async function sendContact(payload) {
    return await callApiPost('sendBulletinContact', {
      requestId: payload.requestId,
      requestUserId: payload.requestUserId,
      targetStaffId: payload.targetStaffId,
      contactMethod: payload.contactMethod,
      contactValue: payload.contactValue
    });
  }

  return {
    fetchPosts,
    createPost,
    sendContact,
    validateMessage
  };
})();

