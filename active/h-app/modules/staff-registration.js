/**
 * POSTING MAP - Staff Registration Feature Module (modules/staff-registration.js)
 * 
 * 責務:
 * - スタッフ登録状態（isRegistering, registrationError, activeRegistrationPromise）の単一SSOT管理
 * - registerStaff API通信の実行とIn-flight重複防止
 * - 登録ライフサイクル（onStart, onSuccess, onError, onFinally）のフック発火
 * - UI/DOM非依存（DOMやStorageViewには一切触れず、結果をhooks経由でComposition Rootへ通知）
 */
const StaffRegistrationModule = (function() {
  let _isRegistering = false;
  let _registrationError = false;
  let _activeRegistrationPromise = null;

  function registerStaff(profile, hooks) {
    if (_activeRegistrationPromise) {
      return _activeRegistrationPromise;
    }

    _isRegistering = true;
    window.isRegistering = true;
    _registrationError = false;
    window.registrationError = false;

    if (hooks && hooks.onStart) {
      hooks.onStart();
    }

    logDebug("API START (初回登録・非同期)");
    _activeRegistrationPromise = callApiPost('registerStaff', {
      lastName: profile.displayName,
      firstName: "(LINE)",
      lineUserId: profile.userId
    }).then(res => {
      logDebug("API OK (初回登録完了)");
      if (res && res.success && res.id && String(res.id).trim() !== '') {
        if (hooks && hooks.onSuccess) {
          hooks.onSuccess(res, profile);
        }
        return res;
      } else {
        const errMsg = (res && res.error) ? res.error : "GAS registration returned invalid response (missing id)";
        throw new Error(errMsg);
      }
    }).catch(err => {
      _registrationError = true;
      window.registrationError = true;
      logDebug("Background registration failed: " + (err ? err.message : err));

      if (hooks && hooks.onError) {
        hooks.onError(err);
      }
      throw err;
    }).finally(() => {
      _isRegistering = false;
      window.isRegistering = false;
      _activeRegistrationPromise = null;
    });

    return _activeRegistrationPromise;
  }

  function getStatus() {
    return {
      isRegistering: _isRegistering,
      registrationError: _registrationError
    };
  }

  return {
    registerStaff,
    getStatus
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StaffRegistrationModule;
}
