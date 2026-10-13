/**
 * active/h-app/modules/transfer.js
 * Flyer Transfer Request Feature & Lifecycle Module (Wave 5)
 *
 * 責務:
 * - 受渡要請フローのセッション世代管理 (Session Generation Guard)
 * - 要請コンテキスト（Private State）の保持・リセット
 * - 連絡先入力値のバリデーション (validateContact)
 * - 認証前ロック (Pre-Auth In-Flight Lock) と多重送信遮断
 * - callApiPost('requestFlyerTransfer') による通信調整と結果判定
 * - DOM/HTML/render.js への直接依存ゼロ
 */

const TransferModule = (function() {
  let _sessionSequence = 0;
  let _currentSessionId = null;
  let _currentRequest = null;
  let _isSubmitting = false;
  let _isApiInFlight = false;

  /**
   * 新しい受渡要請セッションを開始し、一意の世代IDを発行
   * @param {string} holderName
   * @param {string} holderUserId
   * @param {string} requestArea
   * @param {number} stockCount
   * @param {string} storageId
   * @returns {number} sessionId (世代ID)
   */
  function startSession(holderName, holderUserId, requestArea, stockCount, storageId) {
    _sessionSequence++;
    _currentSessionId = _sessionSequence;
    _currentRequest = {
      holderName: holderName || '',
      holderUserId: holderUserId || '',
      requestArea: requestArea || '',
      stockCount: typeof stockCount === 'number' ? stockCount : 0,
      storageId: String(storageId || '').trim()
    };
    _isSubmitting = false;
    _isApiInFlight = false;
    return _currentSessionId;
  }

  /**
   * 指定セッションまたは現在のセッションを安全に無効化（破棄）
   * @param {number} [sessionId] - 指定がない場合は現在のアクティブセッションを無効化
   */
  function invalidateSession(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === _currentSessionId) {
      _currentSessionId = null;
      _currentRequest = null;
      _isSubmitting = false;
      _isApiInFlight = false;
    }
  }

  /**
   * 現在のセッションがアクティブかつ指定世代と一致するか検証
   * @param {number} sessionId
   * @returns {boolean}
   */
  function isSessionActive(sessionId) {
    return typeof sessionId === 'number' && sessionId > 0 && sessionId === _currentSessionId;
  }

  /**
   * 現在保持されている要請コンテキストの安全なコピーを取得
   * @returns {Object|null}
   */
  function getCurrentRequest() {
    return _currentRequest ? { ..._currentRequest } : null;
  }

  /**
   * 現在のアクティブ世代IDを取得
   * @returns {number|null}
   */
  function getCurrentSessionId() {
    return _currentSessionId;
  }

  /**
   * 送信中フラグの状態を取得
   * @returns {boolean}
   */
  function isSubmitting() {
    return _isSubmitting;
  }

  /**
   * 認証待機前の最前段で送信中フラグを設定（Pre-Auth In-Flight Lock）
   * @param {boolean} submitting
   */
  function setSubmitting(submitting) {
    _isSubmitting = !!submitting;
  }

  /**
   * 連絡先入力値のバリデーション
   * @param {string} contactMethod
   * @param {string} contactValue
   * @returns {{ valid: boolean, error?: string, message?: string, value: string }}
   */
  function validateContact(contactMethod, contactValue) {
    const trimmed = String(contactValue || '').trim();
    if (!trimmed) {
      return {
        valid: false,
        error: 'EMPTY_CONTACT',
        message: '連絡先を入力してください。',
        value: ''
      };
    }
    return {
      valid: true,
      value: trimmed
    };
  }

  /**
   * 受渡要請の送信処理（API通信・世代検証・多重送信抑止）
   * @param {Object} params
   * @param {number} params.sessionId - 世代ID
   * @param {string} params.contactMethod - 'LINE' | '電話' | 'メール'
   * @param {string} params.contactValue - 連絡先文字列
   * @param {string} params.requestUserId - 要請者のスタッフID
   * @param {string} params.requestId - 冪等性キー ('req_tr_...')
   * @param {Function} [params.callApiFn] - 外部注入可能なAPI関数（未指定時は callApiPost）
   * @returns {Promise<Object>}
   */
  async function submitTransferRequest(params) {
    const { sessionId, contactMethod, contactValue, requestUserId, requestId, callApiFn } = params;

    // 1. 世代チェック
    if (!isSessionActive(sessionId)) {
      return { aborted: true, reason: 'SESSION_INVALID' };
    }

    // 2. API多重実行ガード（既に通信中の場合はブロック）
    if (_isApiInFlight) {
      return { busy: true, aborted: true };
    }
    _isApiInFlight = true;
    _isSubmitting = true;

    // 3. 入力値バリデーション
    const valRes = validateContact(contactMethod, contactValue);
    if (!valRes.valid) {
      _isApiInFlight = false;
      _isSubmitting = false;
      return { validationError: true, message: valRes.message };
    }

    const targetRequest = _currentRequest;
    if (!targetRequest) {
      _isApiInFlight = false;
      _isSubmitting = false;
      return { aborted: true, reason: 'NO_REQUEST_DATA' };
    }

    const payload = {
      requestId: requestId,
      requestUserId: String(requestUserId || 'UNKNOWN').trim(),
      holderUserId: targetRequest.holderUserId,
      storageId: targetRequest.storageId || '',
      contactMethod: contactMethod || 'LINE',
      contactValue: valRes.value
    };

    const apiPost = typeof callApiFn === 'function' ? callApiFn : (typeof callApiPost === 'function' ? callApiPost : null);
    if (!apiPost) {
      _isApiInFlight = false;
      _isSubmitting = false;
      throw new Error('callApiPost is not available');
    }

    try {
      const res = await apiPost('requestFlyerTransfer', payload);

      // 4. API復帰後の世代チェック（待機中にダイアログが閉じられた・再生成された場合は結果破棄）
      if (!isSessionActive(sessionId)) {
        _isApiInFlight = false;
        _isSubmitting = false;
        return { aborted: true, reason: 'SESSION_SUPERSEDED' };
      }

      _isApiInFlight = false;
      _isSubmitting = false;
      return { success: true, res };
    } catch (err) {
      // 5. エラー復帰後の世代チェック
      if (!isSessionActive(sessionId)) {
        _isApiInFlight = false;
        _isSubmitting = false;
        return { aborted: true, reason: 'SESSION_SUPERSEDED', error: err };
      }

      _isApiInFlight = false;
      _isSubmitting = false;
      return { success: false, error: err };
    }
  }

  /**
   * テスト用状態リセット
   */
  function reset() {
    _sessionSequence = 0;
    _currentSessionId = null;
    _currentRequest = null;
    _isSubmitting = false;
    _isApiInFlight = false;
  }

  return {
    startSession,
    invalidateSession,
    isSessionActive,
    getCurrentRequest,
    getCurrentSessionId,
    isSubmitting,
    setSubmitting,
    validateContact,
    submitTransferRequest,
    reset
  };
})();
