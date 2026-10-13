/**
 * POSTING MAP Authentication Module
 * Phase 2-H-4-A: API認証ゲート基盤
 */

/**
 * リクエストペイロードからトークンを抽出し、LINE APIで検証する
 * @param {Object} payload GET時の e.parameter または POST時の postData
 * @return {Object} { success: true, user: { ... } } または { success: false, message: "..." }
 */
function authenticateRequest(payload) {
  // 1. Tokenの存在確認
  if (!payload || !payload.liffToken) {
    return {
      success: false,
      code: "UNAUTHORIZED",
      errorType: "PERMANENT",
      retryable: false,
      message: "Unauthorized: Missing liffToken"
    };
  }

  const token = payload.liffToken;

  // 2. Session Cache の確認 (HIT)
  const cachedSession = getSession(token);
  if (cachedSession) {
    console.log("AUTH CACHE HIT");
    return {
      success: true,
      user: {
        lineUserId: cachedSession.lineUserId,
        displayName: cachedSession.displayName,
        pictureUrl: cachedSession.pictureUrl
      }
    };
  }

  // 3. Cache MISS の場合: LINE API による Token 検証
  console.log("AUTH CACHE MISS: Fetching from LINE API...");
  try {
    const url = 'https://api.line.me/v2/profile';
    const options = {
      method: 'get',
      headers: {
        'Authorization': 'Bearer ' + token
      },
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();
    
    if (statusCode !== 200) {
      console.warn("Authentication failed with status " + statusCode + ": " + response.getContentText());
      return {
        success: false,
        code: "UNAUTHORIZED",
        errorType: "PERMANENT",
        retryable: false,
        message: "Unauthorized: Invalid or expired liffToken"
      };
    }

    const profileData = JSON.parse(response.getContentText());

    const user = {
      lineUserId: profileData.userId,
      displayName: profileData.displayName,
      pictureUrl: profileData.pictureUrl
    };

    // 4. 検証成功後に Session 保存
    saveSession(token, user);

    // 5. 成功時、ユーザー情報を返却
    return {
      success: true,
      user: user
    };

  } catch (err) {
    console.error("Authentication Error: " + err.toString());
    return {
      success: false,
      code: "INTERNAL_ERROR",
      errorType: "TRANSIENT",
      retryable: true,
      message: "Unauthorized: Authentication service error: " + err.toString()
    };
  }
}
