/**
 * POSTING MAP - Auth & Identity Lifecycle Feature Module (modules/auth.js)
 *
 * 責務:
 * - LIFF認証状態（_liffAuthState, _liffAuthError, _liffAuthReadyPromise）の所有
 * - Backend本人確認状態（_identityVerified, _identitySyncPromise, _identityLastError）の所有
 * - Auth Readiness Gate（waitForLiffAuthReady, isLiffAuthReady）の実装
 * - Identity Safety Gate（waitForIdentityVerified, isIdentityVerifiedReady）の実装
 * - 純粋な原子的セッター（Atomic Setters）の提供
 * - DIプロバイダ（getLiffAuthToken, isLiffLoggedIn）による外部環境依存の受領（グローバル直接参照ゼロ）
 */
const AuthModule = (function() {
  let _getLiffAuthToken = null;
  let _isLiffLoggedIn = null;

  function configure(providers) {
    if (providers) {
      if (typeof providers.getLiffAuthToken === 'function') {
        _getLiffAuthToken = providers.getLiffAuthToken;
      }
      if (typeof providers.isLiffLoggedIn === 'function') {
        _isLiffLoggedIn = providers.isLiffLoggedIn;
      }
    }
  }

  // --- Auth Readiness State ---
  let _liffAuthState = 'PENDING'; // 'PENDING' | 'READY' | 'FAILED'
  let _liffAuthError = null;
  let _liffAuthReadyResolver = null;
  let _liffAuthReadyRejecter = null;
  const _liffAuthReadyPromise = new Promise((resolve, reject) => {
    _liffAuthReadyResolver = resolve;
    _liffAuthReadyRejecter = reject;
  });
  _liffAuthReadyPromise.catch(() => {});

  function markAuthReady() {
    _liffAuthState = 'READY';
    if (typeof _liffAuthReadyResolver === 'function') {
      _liffAuthReadyResolver(true);
    }
  }

  function markAuthFailed(err) {
    _liffAuthState = 'FAILED';
    _liffAuthError = err;
    if (typeof _liffAuthReadyRejecter === 'function') {
      _liffAuthReadyRejecter(err);
    }
  }

  function waitForLiffAuthReady() {
    const currentToken = typeof _getLiffAuthToken === 'function' ? _getLiffAuthToken() : null;
    const hasValidToken = typeof currentToken === 'string' && currentToken.trim().length > 0;
    const isLoggedIn = typeof _isLiffLoggedIn === 'function' ? _isLiffLoggedIn() : false;

    if (isLoggedIn && hasValidToken) {
      return Promise.resolve(true);
    }

    if (_liffAuthState === 'READY') {
      const err = new Error("LIFF_TOKEN_MISSING");
      err.code = "UNAUTHORIZED";
      err.errorType = "PERMANENT";
      err.retryable = false;
      return Promise.reject(err);
    }

    if (_liffAuthState === 'FAILED') {
      return Promise.reject(_liffAuthError || new Error("LIFF_AUTH_FAILED"));
    }

    return _liffAuthReadyPromise;
  }

  function isLiffAuthReady() {
    const isLoggedIn = typeof _isLiffLoggedIn === 'function' ? _isLiffLoggedIn() : false;
    if (!isLoggedIn) return false;
    const token = typeof _getLiffAuthToken === 'function' ? _getLiffAuthToken() : null;
    return typeof token === 'string' && token.trim().length > 0;
  }

  // --- Identity Safety State ---
  let _identityVerified = false;
  let _identitySyncPromise = null;
  let _identityLastError = null;

  // 原子的セッター (Pure Assignment Only)
  function setIdentityVerified(v) { _identityVerified = v; }
  function setIdentityLastError(e) { _identityLastError = e; }
  function setIdentitySyncPromise(p) { _identitySyncPromise = p; }

  async function waitForIdentityVerified() {
    if (_identityVerified === true) return true;

    if (_identitySyncPromise) {
      await _identitySyncPromise;

      if (_identityVerified === true) return true;

      throw _identityLastError ||
        Object.assign(new Error('IDENTITY_NOT_VERIFIED'), {
          code: 'UNAUTHORIZED',
          errorType: 'PERMANENT',
          retryable: false
        });
    }

    throw Object.assign(new Error('IDENTITY_NOT_INITIALIZED'), {
      code: 'UNAUTHORIZED',
      errorType: 'PERMANENT',
      retryable: false
    });
  }

  function isIdentityVerifiedReady() {
    return isLiffAuthReady() && _identityVerified === true;
  }

  // Read-only Accessors
  function isIdentityVerified() { return _identityVerified === true; }
  function getIdentityLastError() { return _identityLastError; }
  function getIdentitySyncPromise() { return _identitySyncPromise; }
  function getAuthState() { return _liffAuthState; }
  function getAuthError() { return _liffAuthError; }

  return {
    configure,
    markAuthReady,
    markAuthFailed,
    waitForLiffAuthReady,
    isLiffAuthReady,
    setIdentityVerified,
    setIdentityLastError,
    setIdentitySyncPromise,
    waitForIdentityVerified,
    isIdentityVerifiedReady,
    isIdentityVerified,
    getIdentityLastError,
    getIdentitySyncPromise,
    getAuthState,
    getAuthError
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AuthModule;
}
