function getApiUrl() {
  if (typeof window !== 'undefined' && window.PMS_CLIENT_CONFIG && window.PMS_CLIENT_CONFIG.api && window.PMS_CLIENT_CONFIG.api.gasWebAppUrl) {
    return window.PMS_CLIENT_CONFIG.api.gasWebAppUrl;
  }
  throw new Error('[H-App Config Error] PMS_CLIENT_CONFIG.api.gasWebAppUrl が未設定です。config.js を確認してください。');
}
const API_URL = getApiUrl();

function getLiffAuthToken() {
  if (typeof liff === "undefined") {
    return null;
  }
  try {
    if (!liff.isLoggedIn()) {
      return null;
    }
    return liff.getAccessToken();
  } catch (e) {
    return null;
  }
}

const PUBLIC_ACTIONS = [
  'getMapsApiKey',
  'getTier1',
  'registerOrValidateDevice',
  'getDeviceStatus',
  'verifyManagerPassword'
];

const IDENTITY_BOOTSTRAP_ACTIONS = [
  'getStaffIdentity',
  'registerStaff'
];

const PROTECTED_WRITE_ACTIONS = [
  'updateRecordWithGPSPhoto',
  'submitDistribution',
  'updateFlyerStock',
  'requestFlyerTransfer',
  'createBulletinPost',
  'sendBulletinContact',
  'setPinInProgress',
  'resolveTransferRequest'
];

const TRANSIENT_ERROR_CODES = [
  'NETWORK_FAILURE',
  'LOCK_TIMEOUT',
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_ERROR'
];

let apiAuthGates = null;

function setApiAuthGates(gates) {
  apiAuthGates = gates;
}

async function callApiPost(action, payload = {}) {
  const isPublic = PUBLIC_ACTIONS.includes(action);
  const isIdentityBootstrap = IDENTITY_BOOTSTRAP_ACTIONS.includes(action);
  const isProtectedWrite = PROTECTED_WRITE_ACTIONS.includes(action);

  // 1. Auth Readiness Gates (Fail-Closed: 存在しない場合も送信拒否)
  if (!isPublic) {
    if (!apiAuthGates || typeof apiAuthGates.waitForLiffAuthReady !== 'function') {
      const authErr = new Error("AUTH_GATE_UNAVAILABLE");
      authErr.code = "UNAUTHORIZED";
      authErr.errorType = "PERMANENT";
      authErr.retryable = false;
      throw authErr;
    }
    await apiAuthGates.waitForLiffAuthReady();

    if (isProtectedWrite) {
      if (!apiAuthGates || typeof apiAuthGates.waitForIdentityVerified !== 'function') {
        const identErr = new Error("IDENTITY_GATE_UNAVAILABLE");
        identErr.code = "UNAUTHORIZED";
        identErr.errorType = "PERMANENT";
        identErr.retryable = false;
        throw identErr;
      }
      await apiAuthGates.waitForIdentityVerified();
    }
  }

  const MAX_RETRIES = 3;
  const districtId = (typeof window !== 'undefined' && window.PMS_CLIENT_CONFIG && window.PMS_CLIENT_CONFIG.districtId) || "";
  if (districtId && !payload.districtId) {
    payload.districtId = districtId;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // リトライ毎に前回のトークンを削除し、最新の有効トークンを動的取得
    delete payload.liffToken;
    if (!isPublic) {
      const token = getLiffAuthToken();
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        const authErr = new Error("LIFF_TOKEN_MISSING_FOR_ATTEMPT");
        authErr.code = "UNAUTHORIZED";
        authErr.errorType = "PERMANENT";
        authErr.retryable = false;
        throw authErr;
      }
      payload.liffToken = token;
    } else {
      const token = getLiffAuthToken();
      if (token && typeof token === 'string' && token.trim().length > 0) {
        payload.liffToken = token;
      }
    }

    const url = `${API_URL}?_t=${Date.now()}`;
    const body = JSON.stringify({ action, ...payload });

    const options = {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow'
    };

    try {
      logDebug(`[callApiPost] START (Attempt ${attempt}/${MAX_RETRIES}): action=${action}, bodySize=${body.length}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);
      let response;
      try {
        response = await fetch(url, { ...options, body, signal: controller.signal });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const netErr = new Error(fetchErr.name === 'AbortError' ? "通信がタイムアウトしました (90秒)" : `ネットワークエラー: ${fetchErr.message}`);
        netErr.code = "NETWORK_FAILURE";
        netErr.errorType = "TRANSIENT";
        netErr.retryable = true;
        throw netErr;
      }
      clearTimeout(timeoutId);
      logDebug(`[callApiPost] FETCH OK. status=${response.status}`);

      const text = await response.text();
      logDebug(`[callApiPost] TEXT RECEIVED (length=${text.length}, status=${response.status})`);

      let data = null;
      let jsonParsed = false;
      try {
        data = JSON.parse(text);
        jsonParsed = true;
      } catch (parseErr) {
        // JSON パース失敗時はスキップし後続の判定へ
      }

      // レスポンスの展開
      let targetResult = data;
      if (data && typeof data === 'object' && 'data' in data && data.data !== null) {
        targetResult = data.data;
      }

      // 1. GAS JSON 契約最優先: 失敗レスポンスの場合のみ例外化
      if (jsonParsed && targetResult && typeof targetResult === 'object') {
        const isExplicitFailure = targetResult.success === false;
        const isImplicitFailure = targetResult.success === undefined && (Boolean(targetResult.errorType) || Boolean(targetResult.code));
        if (isExplicitFailure || isImplicitFailure) {
          const apiErr = new Error(targetResult.message || data.message || `API Error (${response.status})`);
          apiErr.code = targetResult.code || data.code || "UNKNOWN_ERROR";
          apiErr.errorType = targetResult.errorType || data.errorType || "PERMANENT";
          apiErr.retryable = targetResult.retryable !== undefined
            ? targetResult.retryable
            : (data.retryable !== undefined ? data.retryable : TRANSIENT_ERROR_CODES.includes(apiErr.code));
          throw apiErr;
        }
      }

      // 2. HTTP 非2xx かつ 構造化JSONエラーがない場合の HTTP status mapping fallback
      if (!response.ok) {
        const status = response.status;
        const httpErr = new Error(`HTTP Error: ${status}`);
        if (status === 401) {
          httpErr.code = "UNAUTHORIZED";
          httpErr.errorType = "PERMANENT";
          httpErr.retryable = false;
        } else if (status === 403) {
          httpErr.code = "FORBIDDEN";
          httpErr.errorType = "PERMANENT";
          httpErr.retryable = false;
        } else if (status === 404) {
          httpErr.code = "RESOURCE_NOT_FOUND";
          httpErr.errorType = "PERMANENT";
          httpErr.retryable = false;
        } else if (status === 429) {
          httpErr.code = "RATE_LIMIT_EXCEEDED";
          httpErr.errorType = "TRANSIENT";
          httpErr.retryable = true;
        } else if (status >= 500) {
          httpErr.code = "INTERNAL_ERROR";
          httpErr.errorType = "TRANSIENT";
          httpErr.retryable = true;
        } else {
          httpErr.code = "NETWORK_FAILURE";
          httpErr.errorType = "PERMANENT";
          httpErr.retryable = false;
        }
        throw httpErr;
      }

      // 3. HTTP 2xx かつ JSON パース失敗時のエラー
      if (!jsonParsed) {
        const jsonErr = new Error("JSON形式ではない応答を受け取りました");
        jsonErr.code = "MALFORMED_JSON";
        jsonErr.errorType = "PERMANENT";
        jsonErr.retryable = false;
        throw jsonErr;
      }

      return targetResult;

    } catch (err) {
      logDebug(`[callApiPost] Attempt ${attempt} failed: [${err.code || 'NO_CODE'}] ${err.message}`);

      // リトライ判定: Backendの retryable を優先、未定義時は TRANSIENT_ERROR_CODES 照合 (Fail-Closed)
      const isRetryable = err.retryable === true || (err.retryable === undefined && TRANSIENT_ERROR_CODES.includes(err.code));

      if (!isRetryable || attempt === MAX_RETRIES) {
        console.error(`API POST Error (${action}):`, err);
        throw err;
      }

      // wait = 1s → 2s (3回目失敗後は待ちなしでthrow)
      const waitMs = attempt === 1 ? 1000 : 2000;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

window.getApiUrl = getApiUrl;
window.getLiffAuthToken = getLiffAuthToken;
window.callApiPost = callApiPost;
