/**
 * POSTING MAP Authentication Session Cache Module
 * Phase 2-H-4-C: 認証最適化 (Auth Session Cache)
 */

/**
 * Tokenを安全なキャッシュキーに変換する
 * @param {string} token 
 * @return {string} キャッシュキー
 */
function getAuthSessionKey(token) {
  if (!token) return null;
  // Utilities.computeDigest を用いて SHA-256 ハッシュ化
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
  // hex文字列に変換
  let hexString = '';
  for (let i = 0; i < digest.length; i++) {
    let byte = digest[i];
    if (byte < 0) byte += 256;
    let hex = byte.toString(16);
    if (hex.length === 1) hex = '0' + hex;
    hexString += hex;
  }
  return 'AUTH_SESSION_' + hexString;
}

/**
 * キャッシュからユーザー情報を取得する
 * @param {string} token 
 * @return {Object|null} ユーザー情報（見つからない場合はnull）
 */
function getSession(token) {
  const key = getAuthSessionKey(token);
  if (!key) return null;

  const cache = CacheService.getScriptCache();
  const cachedData = cache.get(key);

  if (cachedData) {
    try {
      const session = JSON.parse(cachedData);
      return session;
    } catch (e) {
      console.warn("Session cache parse error: " + e.toString());
      return null;
    }
  }
  return null;
}

/**
 * ユーザー情報をキャッシュに保存する (1800秒 = 30分)
 * トークン本体は保存しない
 * @param {string} token 
 * @param {Object} user { lineUserId, displayName, pictureUrl }
 */
function saveSession(token, user) {
  const key = getAuthSessionKey(token);
  if (!key) return;

  const sessionData = {
    lineUserId: user.lineUserId,
    displayName: user.displayName,
    pictureUrl: user.pictureUrl,
    createdAt: Date.now()
  };

  const cache = CacheService.getScriptCache();
  // 第三引数は有効期限(秒)
  cache.put(key, JSON.stringify(sessionData), 1800);
}

// ============================================================================
// Dashboard 管理者用 共有PIN サーバーサイドセッション管理基盤 (SEC-001)
// ============================================================================

function hashSessionToken(token) {
  if (!token || typeof token !== 'string') return '';
  if (typeof Utilities !== 'undefined' && Utilities.computeDigest) {
    try {
      const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
      let hexString = '';
      for (let i = 0; i < digest.length; i++) {
        let byte = digest[i];
        if (byte < 0) byte += 256;
        let hex = byte.toString(16);
        if (hex.length === 1) hex = '0' + hex;
        hexString += hex;
      }
      return hexString;
    } catch (e) {}
  }
  if (typeof require !== 'undefined') {
    try {
      const crypto = require('crypto');
      return crypto.createHash('sha256').update(token).digest('hex');
    } catch (e) {}
  }
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash) + token.charCodeAt(i);
    hash |= 0;
  }
  return 'fallback_' + Math.abs(hash);
}

/**
 * 6桁PIN認証成功時に呼ばれる Dashboard セッション生成
 * @param {string} districtId
 * @param {number} ttlSeconds 有効期間（秒、デフォルト: 21600秒 = 6時間）
 * @return {{ token: string, expiresAt: number, districtId: string }}
 */
function createDashboardSession(districtId, ttlSeconds = 21600) {
  const cleanDistrict = String(districtId || "").trim();
  if (!cleanDistrict) {
    throw new Error("districtId is required for dashboard session");
  }

  let uuid = "";
  if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
    uuid = Utilities.getUuid().replace(/-/g, '');
  } else {
    uuid = 'uuid_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
  }
  const entropy = String(Date.now()) + '_' + Math.random().toString(36).substring(2) + '_' + cleanDistrict;
  const hashPart = hashSessionToken(entropy).substring(0, 16);
  const token = 'pms_dash_' + uuid + hashPart;

  const now = Date.now();
  const expiresAt = now + (ttlSeconds * 1000);

  const sessionData = {
    token: token,
    districtId: cleanDistrict,
    role: 'MANAGER',
    createdAt: now,
    expiresAt: expiresAt
  };

  const key = 'DASH_SESSION_' + hashSessionToken(token);
  if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
    const cache = CacheService.getScriptCache();
    if (cache) {
      cache.put(key, JSON.stringify(sessionData), ttlSeconds);
    }
  }

  return {
    token: token,
    expiresAt: expiresAt,
    districtId: cleanDistrict
  };
}

/**
 * Dashboard セッション検証
 * @param {string} token クライアントから送信されたセッショントークン
 * @param {string} requestedDistrictId アクセス対象地区コード
 * @return {{ success: boolean, code?: string, message?: string, session?: Object }}
 */
function verifyDashboardSession(token, requestedDistrictId = "") {
  if (!token || typeof token !== 'string' || !token.trim()) {
    return {
      success: false,
      code: "UNAUTHORIZED",
      message: "Dashboard session token is missing."
    };
  }

  const cleanToken = token.trim();
  const key = 'DASH_SESSION_' + hashSessionToken(cleanToken);
  let cachedData = null;

  if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
    const cache = CacheService.getScriptCache();
    if (cache) {
      cachedData = cache.get(key);
    }
  }

  if (!cachedData) {
    return {
      success: false,
      code: "UNAUTHORIZED",
      message: "Invalid or expired dashboard session."
    };
  }

  let session = null;
  try {
    session = JSON.parse(cachedData);
  } catch (e) {
    return {
      success: false,
      code: "UNAUTHORIZED",
      message: "Corrupted dashboard session data."
    };
  }

  if (!session || !session.expiresAt || Date.now() > session.expiresAt) {
    return {
      success: false,
      code: "UNAUTHORIZED",
      message: "Dashboard session has expired."
    };
  }

  // districtId 拘束 (Tenant Binding)
  const reqDistrict = String(requestedDistrictId || "").trim();
  if (reqDistrict && session.districtId && session.districtId.toUpperCase() !== reqDistrict.toUpperCase()) {
    return {
      success: false,
      code: "DISTRICT_MISMATCH",
      message: `Dashboard session belongs to district "${session.districtId}", cannot access "${reqDistrict}".`
    };
  }

  return {
    success: true,
    session: session
  };
}

/**
 * Dashboard セッション破棄（ログアウト）
 * @param {string} token
 * @return {{ success: boolean, message: string }}
 */
function revokeDashboardSession(token) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    return { success: true, message: "Logged out." };
  }
  const cleanToken = token.trim();
  const key = 'DASH_SESSION_' + hashSessionToken(cleanToken);
  if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
    const cache = CacheService.getScriptCache();
    if (cache) {
      cache.remove(key);
    }
  }
  return { success: true, message: "Logged out successfully." };
}
