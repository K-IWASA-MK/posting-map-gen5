/**
 * GAS v2 - 純粋 JSON API エンジン
 * UI(HTML)は一切返却せず、ContentService を通じて JSON のみを応答する。
 * Version: 2.2.0-modular
 */


// =============================
// ① 基本設定
// =============================

function getMonthlySheet(type) {
  if (typeof MonthlySheetResolver !== 'undefined' && MonthlySheetResolver.getInstance) {
    return MonthlySheetResolver.getInstance().getCurrentSheet(type);
  }
  return null;
}

function computeSha256(str) {
  if (!str || typeof str !== 'string') return '';
  try {
    const rawDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
    let hexHash = '';
    for (let i = 0; i < rawDigest.length; i++) {
      let byte = rawDigest[i];
      if (byte < 0) byte += 256;
      let hex = byte.toString(16);
      if (hex.length === 1) hex = '0' + hex;
      hexHash += hex;
    }
    return hexHash;
  } catch (e) {
    return '';
  }
}

function verifyProvisioningToken(token) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    return { success: false, code: "UNAUTHORIZED", message: "Provisioning token is missing." };
  }
  const props = PropertiesService.getScriptProperties();
  const storedHash = (props.getProperty('PROVISIONING_TOKEN_HASH') || '').trim().toLowerCase();

  // Fail-Closed: PROVISIONING_TOKEN_HASH が Script Properties に設定されていない場合は即座に遮断
  if (!storedHash) {
    return { success: false, code: "UNAUTHORIZED", message: "PROVISIONING_TOKEN_HASH is not configured in Script Properties (Fail-Closed)." };
  }

  const clientHash = computeSha256(token.trim()).toLowerCase();

  if (clientHash === storedHash) {
    return { success: true };
  }

  return { success: false, code: "UNAUTHORIZED", message: "Invalid provisioning token for configured district." };
}

/**
 * SEC-007: 地区別 Google Maps API Key 解決ハンドラ
 * @param {string} districtId - 対象地区コード (任意・推奨)
 * @param {string} sessionToken - Dashboardセッショントークン (任意)
 * @return {Object} レスポンスオブジェクト
 */
function handleGetMapsApiKey(districtId, sessionToken) {
  const cleanDistrictId = String(districtId || '').trim().toUpperCase();
  const props = (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties)
    ? PropertiesService.getScriptProperties()
    : null;
  const hasRegistry = props && !!props.getProperty('DISTRICT_REGISTRY');

  // 1. cleanDistrictId が指定されている場合の検証
  if (cleanDistrictId) {
    // Gate 1: DISTRICT_REGISTRY による地区存在確認
    let isRegistered = false;
    if (hasRegistry) {
      try {
        const regRaw = props.getProperty('DISTRICT_REGISTRY') || '{}';
        const registry = JSON.parse(regRaw);
        const foundKey = Object.keys(registry).find(k => k.trim().toUpperCase() === cleanDistrictId);
        if (foundKey) {
          const entry = registry[foundKey];
          isRegistered = (typeof entry === 'object' && entry !== null) ? entry.enabled !== false : !!entry;
        }
      } catch (eReg) {
        console.error('[handleGetMapsApiKey] Failed to parse DISTRICT_REGISTRY:', eReg);
      }
    } else {
      // DISTRICT_REGISTRY 未設定時の動的確認
      const currentDistrict = props ? (props.getProperty('DISTRICT_ID') || '').trim().toUpperCase() : '';
      const hasDedicatedKey = props ? !!props.getProperty('GOOGLE_MAPS_API_KEY_' + cleanDistrictId) : false;
      if (cleanDistrictId === 'UNKNOWN' || cleanDistrictId.startsWith('UNKNOWN')) {
        isRegistered = false;
      } else if (currentDistrict && currentDistrict === cleanDistrictId) {
        isRegistered = true;
      } else if (hasDedicatedKey) {
        isRegistered = true;
      } else {
        isRegistered = (cleanDistrictId !== 'UNKNOWN' && !cleanDistrictId.startsWith('UNKNOWN'));
      }
    }

    if (!isRegistered) {
      return {
        success: false,
        code: "DISTRICT_NOT_FOUND",
        message: `District '${cleanDistrictId}' is not registered in DISTRICT_REGISTRY.`
      };
    }

    // Gate 2: Dashboard Session Binding (tokenが存在する場合)
    if (sessionToken && typeof verifyDashboardSession === 'function') {
      const dashCheck = verifyDashboardSession(sessionToken, cleanDistrictId);
      if (!dashCheck.success) {
        return {
          success: false,
          code: "UNAUTHORIZED",
          message: "Session district mismatch. Cross-district key access denied."
        };
      }
    }

    // Gate 3: Integrity Guard (DISTRICT_MISMATCH 照合)
    if (hasRegistry && typeof SpreadsheetResolver !== 'undefined' && SpreadsheetResolver.getInstance) {
      try {
        SpreadsheetResolver.getInstance().getSpreadsheet(cleanDistrictId);
      } catch (eResolver) {
        const errStr = eResolver.toString();
        if (errStr.includes("DISTRICT_MISMATCH")) {
          return {
            success: false,
            code: "DISTRICT_MISMATCH",
            message: eResolver.message
          };
        }
        if (errStr.includes("not found in DISTRICT_REGISTRY")) {
          return {
            success: false,
            code: "DISTRICT_NOT_FOUND",
            message: `District '${cleanDistrictId}' is not registered in DISTRICT_REGISTRY.`
          };
        }
      }
    }

    // Gate 4: Contract Gate (契約状態確認)
    if (hasRegistry && typeof SystemInfoService !== 'undefined' && SystemInfoService.getInstance) {
      try {
        const contract = SystemInfoService.getInstance().getContractStatus(null, new Date(), cleanDistrictId);
        if (contract && (contract.isExpired || contract.code === 'CONTRACT_EXPIRED')) {
          return {
            success: false,
            code: "CONTRACT_EXPIRED",
            message: contract.message || "契約期間が終了しているため利用できません。"
          };
        }
      } catch (eContract) {}
    }

    // Layer 2: 地区別Key探索 (最優先)
    const districtKeyProp = 'GOOGLE_MAPS_API_KEY_' + cleanDistrictId;
    const districtKey = props ? props.getProperty(districtKeyProp) : null;
    if (districtKey && districtKey.trim()) {
      return {
        success: true,
        districtId: cleanDistrictId,
        mapsApiKey: districtKey.trim(),
        isFallback: false
      };
    }
  }

  // 2. districtId 未指定時 or 地区別Key未設定時の Phase 1 Legacy Fallback
  const legacyKey = props ? props.getProperty('GOOGLE_MAPS_API_KEY') : null;
  if (legacyKey && legacyKey.trim()) {
    return {
      success: true,
      districtId: cleanDistrictId || '',
      mapsApiKey: legacyKey.trim(),
      isFallback: true
    };
  }

  // 3. Key未設定 (地区別Keyも旧Keyも存在しない)
  return {
    success: false,
    code: cleanDistrictId ? "MAPS_KEY_NOT_CONFIGURED" : "MISSING_DISTRICT_ID",
    message: cleanDistrictId
      ? `Google Maps API Key is not configured for district '${cleanDistrictId}'.`
      : "districtId is required to resolve Google Maps API Key."
  };
}

/**
 * 既存地区のSpreadsheet世代切替専用ハンドラ (switchDistrictSpreadsheet)
 * DISTRICT_REGISTRY[districtId].spreadsheetId のみを OLD_ID -> NEW_ID へ安全に切り替える。
 * 他Property (enabled, storageFolderId, name 等) および他Script Properties は完全不変。
 */
function handleSwitchDistrictSpreadsheet(postData, params) {
  // 1. Provisioning Token検証
  const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
             || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
  const tokenCheck = verifyProvisioningToken(token);
  if (!tokenCheck.success) {
    return tokenCheck;
  }

  // 2. districtId / expectedCurrentSpreadsheetId / targetSpreadsheetId 必須検証
  const targetDistrictId = String((postData && postData.districtId) || (params && params.districtId) || "").trim();
  const expectedCurrentId = String((postData && postData.expectedCurrentSpreadsheetId) || (params && params.expectedCurrentSpreadsheetId) || "").trim();
  const targetNewId = String((postData && postData.targetSpreadsheetId) || (params && params.targetSpreadsheetId) || "").trim();

  if (!targetDistrictId || !expectedCurrentId || !targetNewId) {
    return {
      success: false,
      code: "INVALID_ARGUMENT",
      message: "districtId, expectedCurrentSpreadsheetId, and targetSpreadsheetId are all required."
    };
  }

  // 3. DISTRICT_REGISTRY取得
  const props = (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties)
    ? PropertiesService.getScriptProperties()
    : null;
  const regRaw = props ? props.getProperty("DISTRICT_REGISTRY") : null;

  // 4. 未設定・空文字・JSON破損 → Fail-Closed、mutation 0
  if (!regRaw || typeof regRaw !== 'string' || !regRaw.trim()) {
    return {
      success: false,
      code: "CORRUPTED_REGISTRY",
      message: "DISTRICT_REGISTRY is not configured or empty."
    };
  }

  let registry;
  try {
    registry = JSON.parse(regRaw);
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      return {
        success: false,
        code: "CORRUPTED_REGISTRY",
        message: "DISTRICT_REGISTRY is not a valid JSON object."
      };
    }
  } catch (e) {
    return {
      success: false,
      code: "CORRUPTED_REGISTRY",
      message: "Failed to parse DISTRICT_REGISTRY JSON: " + e.message
    };
  }

  // 5. 対象地区が存在しない → Fail-Closed
  const districtKey = Object.keys(registry).find(k => k.trim().toUpperCase() === targetDistrictId.toUpperCase());
  if (!districtKey || !registry[districtKey]) {
    return {
      success: false,
      code: "DISTRICT_NOT_FOUND",
      message: `District "${targetDistrictId}" not found in DISTRICT_REGISTRY.`
    };
  }

  const districtEntry = registry[districtKey];
  const currentSpreadsheetId = String(
    (typeof districtEntry === 'object' && districtEntry !== null)
      ? districtEntry.spreadsheetId
      : districtEntry
  ).trim();

  // 6. 現在のspreadsheetId !== expectedCurrentSpreadsheetId → STALE_WRITEとしてFail-Closed、mutation 0
  if (currentSpreadsheetId !== expectedCurrentId) {
    return {
      success: false,
      code: "STALE_WRITE",
      message: `Current spreadsheetId "${currentSpreadsheetId}" does not match expected "${expectedCurrentId}". Stale write prevented.`
    };
  }

  // 7. SpreadsheetApp.openById(targetSpreadsheetId) で新DB実在確認
  let newSS;
  try {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.openById) {
      throw new Error("SpreadsheetApp.openById unavailable");
    }
    newSS = SpreadsheetApp.openById(targetNewId);
    if (!newSS) {
      return {
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: `Target spreadsheet "${targetNewId}" could not be opened.`
      };
    }
  } catch (eSS) {
    return {
      success: false,
      code: "RESOURCE_NOT_FOUND",
      message: `Target spreadsheet "${targetNewId}" does not exist or cannot be accessed: ${eSS.message}`
    };
  }

  // 8. 新DBの SYSTEM_INFO["地区コード"] === districtId を直接検証
  try {
    const sysSheet = newSS.getSheetByName("SYSTEM_INFO");
    if (!sysSheet) {
      return {
        success: false,
        code: "DISTRICT_MISMATCH",
        message: `Target spreadsheet "${targetNewId}" lacks SYSTEM_INFO sheet.`
      };
    }
    const lr = sysSheet.getLastRow ? sysSheet.getLastRow() : 0;
    if (lr < 2) {
      return {
        success: false,
        code: "DISTRICT_MISMATCH",
        message: `SYSTEM_INFO in target spreadsheet "${targetNewId}" has no data rows.`
      };
    }
    let foundCode = "";
    const data = sysSheet.getRange(1, 1, lr, 2).getValues();
    for (let r = 0; r < data.length; r++) {
      if (String(data[r][0] || '').trim() === "地区コード") {
        foundCode = String(data[r][1] || '').trim().toUpperCase();
        break;
      }
    }
    if (!foundCode || foundCode !== targetDistrictId.toUpperCase()) {
      return {
        success: false,
        code: "DISTRICT_MISMATCH",
        message: `Target spreadsheet SYSTEM_INFO district code "${foundCode}" does not match "${targetDistrictId}".`
      };
    }
  } catch (eSys) {
    return {
      success: false,
      code: "DISTRICT_MISMATCH",
      message: `Failed to verify target spreadsheet SYSTEM_INFO: ${eSys.message}`
    };
  }

  // 9. Registryを deep copy
  const newRegistry = JSON.parse(JSON.stringify(registry));

  // 10. 対象地区の spreadsheetId だけ変更
  if (typeof newRegistry[districtKey] === 'object' && newRegistry[districtKey] !== null) {
    newRegistry[districtKey].spreadsheetId = targetNewId;
  } else {
    newRegistry[districtKey] = targetNewId;
  }

  // 11. props.setProperty("DISTRICT_REGISTRY", JSON.stringify(newRegistry)) を1回だけ実行
  try {
    props.setProperty("DISTRICT_REGISTRY", JSON.stringify(newRegistry));
  } catch (eSet) {
    return {
      success: false,
      code: "REGISTRY_UPDATE_FAILED",
      message: "Failed to persist updated DISTRICT_REGISTRY: " + eSet.message
    };
  }

  // 12. READ BACK して新ID一致を検証
  try {
    const readBackRaw = props.getProperty("DISTRICT_REGISTRY");
    const readBackRegistry = JSON.parse(readBackRaw);
    const readBackEntry = readBackRegistry[districtKey];
    const readBackId = String(
      (typeof readBackEntry === 'object' && readBackEntry !== null)
        ? readBackEntry.spreadsheetId
        : readBackEntry
    ).trim();
    if (readBackId !== targetNewId) {
      return {
        success: false,
        code: "REGISTRY_UPDATE_FAILED",
        message: `Read-back verification failed: expected "${targetNewId}", got "${readBackId}".`
      };
    }
  } catch (eRb) {
    return {
      success: false,
      code: "REGISTRY_UPDATE_FAILED",
      message: "Read-back verification error: " + eRb.message
    };
  }

  // 13. Resolver cache を clear
  try {
    if (typeof SpreadsheetResolver !== 'undefined' && SpreadsheetResolver.getInstance) {
      SpreadsheetResolver.getInstance().clearCache();
    }
  } catch (eCache) {
    console.warn("[switchDistrictSpreadsheet] Resolver clearCache warning:", eCache);
  }

  // 14. 成功結果を返す
  return {
    success: true,
    districtId: targetDistrictId,
    previousSpreadsheetId: currentSpreadsheetId,
    newSpreadsheetId: targetNewId,
    message: `District "${targetDistrictId}" spreadsheet switched successfully to "${targetNewId}".`
  };
}

/**
 * ACTIVE地区のDrive Binding安全是正ハンドラ (repairDistrictDriveBinding)
 * - 認可: Provisioning Token 必須 (verifyProvisioningToken)
 * - 対象地区: 既存 DISTRICT_REGISTRY に存在必須（新地区作成不可）
 * - BRANCH_ROOT_FOLDER_ID:
 *     未設定時: target Folder実在確認、caller token認証後に初期設定
 *     設定済・同値: idempotent success (no-op)
 *     設定済・異値: BRANCH_ROOT_MISMATCH で Fail-Closed (mutation 0)
 * - REGISTRY STORAGE CAS:
 *     current storageFolderId === expectedCurrentStorageFolderId (STALE_WRITE if mismatch)
 *     expectedRegistryRaw / expectedRegistryRawHash CAS (STALE_WRITE if mismatch)
 *     spreadsheetId, name, enabled (true stays true) その他field完全維持
 *     他地区 entry 完全不変 (0 diff)
 * - TARGET STORAGE VALIDATION:
 *     Server側導出: branchRootFolderId -> districtFolder -> canonical storage folder
 *     targetStorageFolderId === canonicalStorageFolderId (STORAGE_FOLDER_MISMATCH if mismatch)
 * - STORAGE_PARENT_ID:
 *     current STORAGE_PARENT_ID === expectedCurrentStorageFolderId (STALE_WRITE if mismatch)
 *     canonical targetStorageFolderId へ同期
 * - MUTATION ALLOWLIST:
 *     最大3箇所のみ (BRANCH_ROOT_FOLDER_ID, DISTRICT_REGISTRY[district].storageFolderId, STORAGE_PARENT_ID)
 * - READ-BACK:
 *     3箇所を再取得して期待値・不変性を完全機械検証
 * - FAILURE SEMANTICS:
 *     mutation前に全Validation/CAS完了。途中失敗時は変更済みkeyのみ局所rollback。
 */
function handleRepairDistrictDriveBinding(postData, params) {
  // 1. Provisioning Token検証
  const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
             || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
  const tokenCheck = verifyProvisioningToken(token);
  if (!tokenCheck.success) {
    return tokenCheck;
  }

  // 2. 必須パラメータ検証
  const targetDistrictId = String((postData && postData.districtId) || (params && params.districtId) || "").trim();
  const cleanDistrictId = targetDistrictId.toUpperCase();
  const branchRootFolderId = String((postData && postData.branchRootFolderId) || (params && params.branchRootFolderId) || "").trim();
  const expectedCurrentStorageId = String((postData && postData.expectedCurrentStorageFolderId) || (params && params.expectedCurrentStorageFolderId) || "").trim();
  const targetStorageId = String((postData && postData.targetStorageFolderId) || (params && params.targetStorageFolderId) || "").trim();

  if (!cleanDistrictId || !branchRootFolderId || !expectedCurrentStorageId || !targetStorageId) {
    return {
      success: false,
      code: "INVALID_ARGUMENT",
      message: "districtId, branchRootFolderId, expectedCurrentStorageFolderId, and targetStorageFolderId are all required."
    };
  }

  // 3. DISTRICT_REGISTRY取得・構文検証
  const props = (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties)
    ? PropertiesService.getScriptProperties()
    : null;
  const regRaw = props ? props.getProperty("DISTRICT_REGISTRY") : null;

  if (!regRaw || typeof regRaw !== 'string' || !regRaw.trim()) {
    return {
      success: false,
      code: "CORRUPTED_REGISTRY",
      message: "DISTRICT_REGISTRY is not configured or empty."
    };
  }

  let registry;
  try {
    registry = JSON.parse(regRaw);
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      return {
        success: false,
        code: "CORRUPTED_REGISTRY",
        message: "DISTRICT_REGISTRY is not a valid JSON object."
      };
    }
  } catch (e) {
    return {
      success: false,
      code: "CORRUPTED_REGISTRY",
      message: "Failed to parse DISTRICT_REGISTRY JSON: " + e.message
    };
  }

  // 4. 対象地区が既存Registryに存在すること（新地区作成不可）
  const districtKey = Object.keys(registry).find(k => k.trim().toUpperCase() === cleanDistrictId);
  if (!districtKey || !registry[districtKey]) {
    return {
      success: false,
      code: "DISTRICT_NOT_FOUND",
      message: `District "${targetDistrictId}" not found in DISTRICT_REGISTRY. repairDistrictDriveBinding cannot be used for new district creation.`
    };
  }

  const currentEntry = registry[districtKey];
  const currentStorageFolderId = String(
    (typeof currentEntry === 'object' && currentEntry !== null)
      ? currentEntry.storageFolderId
      : ""
  ).trim();

  // 5. REGISTRY CAS検証
  // 5a. expectedRegistryRawHash / expectedRegistryRaw 検証（指定時）
  const expHash = String((postData && postData.expectedRegistryRawHash) || (params && params.expectedRegistryRawHash) || "").trim().toLowerCase();
  if (expHash) {
    const actualHash = computeSha256(regRaw).toLowerCase();
    if (actualHash !== expHash) {
      return {
        success: false,
        code: "STALE_WRITE",
        message: `DISTRICT_REGISTRY hash mismatch (expected: "${expHash}", actual: "${actualHash}"). Stale write prevented.`
      };
    }
  }
  const expRaw = (postData && postData.expectedRegistryRaw) || (params && params.expectedRegistryRaw);
  if (typeof expRaw === 'string' && expRaw.trim()) {
    if (regRaw.trim() !== expRaw.trim()) {
      return {
        success: false,
        code: "STALE_WRITE",
        message: "DISTRICT_REGISTRY raw mismatch. Stale write prevented."
      };
    }
  }

  // 5b. current storageFolderId === expectedCurrentStorageFolderId
  if (currentStorageFolderId !== expectedCurrentStorageId) {
    return {
      success: false,
      code: "STALE_WRITE",
      message: `Current storageFolderId "${currentStorageFolderId}" does not match expected "${expectedCurrentStorageId}". Stale write prevented.`
    };
  }

  // 6. BRANCH_ROOT_FOLDER_ID 検証 & Idempotency
  const currentBranchRootId = (props.getProperty("BRANCH_ROOT_FOLDER_ID") || "").trim();
  if (currentBranchRootId) {
    if (currentBranchRootId !== branchRootFolderId) {
      return {
        success: false,
        code: "BRANCH_ROOT_MISMATCH",
        message: `Existing BRANCH_ROOT_FOLDER_ID "${currentBranchRootId}" does not match provided "${branchRootFolderId}". Root cannot be overwritten.`
      };
    }
  }

  // 7. target Folder 実在確認 & Server-Side Deterministic Resolution
  let branchFolder;
  try {
    if (typeof DriveApp === 'undefined' || !DriveApp.getFolderById) {
      throw new Error("DriveApp unavailable");
    }
    branchFolder = DriveApp.getFolderById(branchRootFolderId);
    if (!branchFolder) {
      return {
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: `Branch root folder "${branchRootFolderId}" not found.`
      };
    }
  } catch (eBranch) {
    return {
      success: false,
      code: "RESOURCE_NOT_FOUND",
      message: `Branch root folder "${branchRootFolderId}" cannot be opened: ${eBranch.message}`
    };
  }

  // 03_BRANCH/{districtId} 探索
  const distFolders = branchFolder.getFoldersByName(cleanDistrictId);
  let distFolder = null;
  let distCount = 0;
  while (distFolders.hasNext()) {
    distFolder = distFolders.next();
    distCount++;
  }
  if (distCount === 0 || !distFolder) {
    return {
      success: false,
      code: "RESOURCE_NOT_FOUND",
      message: `District folder "${cleanDistrictId}" not found under branch root "${branchRootFolderId}".`
    };
  }
  if (distCount > 1) {
    return {
      success: false,
      code: "AMBIGUOUS_DISTRICT_FOLDER",
      message: `Multiple folders named "${cleanDistrictId}" found under branch root.`
    };
  }

  // {districtId} 支部_STORAGE 探索
  const storageName = `${cleanDistrictId} 支部_STORAGE`;
  const storageFolders = distFolder.getFoldersByName(storageName);
  let storageFolder = null;
  let sCount = 0;
  while (storageFolders.hasNext()) {
    storageFolder = storageFolders.next();
    sCount++;
  }
  if (sCount === 0 || !storageFolder) {
    return {
      success: false,
      code: "RESOURCE_NOT_FOUND",
      message: `Storage folder "${storageName}" not found under district folder.`
    };
  }
  if (sCount > 1) {
    return {
      success: false,
      code: "AMBIGUOUS_STORAGE_FOLDER",
      message: `Multiple folders named "${storageName}" found under district folder.`
    };
  }

  const canonicalStorageFolderId = storageFolder.getId();

  // targetStorageFolderId === canonicalStorageFolderId Assertion
  if (targetStorageId !== canonicalStorageFolderId) {
    return {
      success: false,
      code: "STORAGE_FOLDER_MISMATCH",
      message: `Specified targetStorageFolderId "${targetStorageId}" does not match canonical resolved storage folder "${canonicalStorageFolderId}".`
    };
  }

  // 8. STORAGE_PARENT_ID CAS検証
  const currentStorageParentId = (props.getProperty("STORAGE_PARENT_ID") || "").trim();
  if (currentStorageParentId && currentStorageParentId !== expectedCurrentStorageId) {
    return {
      success: false,
      code: "STALE_WRITE",
      message: `Current STORAGE_PARENT_ID "${currentStorageParentId}" does not match expected "${expectedCurrentStorageId}". Stale write prevented.`
    };
  }

  // 9. Atomic Mutations (Allowlist: 最大3箇所のみ)
  const originalBranchRoot = currentBranchRootId;
  const originalRegRaw = regRaw;
  const originalStorageParent = currentStorageParentId;

  let branchRootMutated = false;
  let registryMutated = false;
  let storageParentMutated = false;

  try {
    // 1) BRANCH_ROOT_FOLDER_ID (未設定時のみ初期シード)
    if (!currentBranchRootId) {
      props.setProperty("BRANCH_ROOT_FOLDER_ID", branchRootFolderId);
      branchRootMutated = true;
    }

    // 2) DISTRICT_REGISTRY (対象district.storageFolderId のみ変更、他全field・他地区0 diff)
    const newRegistry = JSON.parse(JSON.stringify(registry));
    if (typeof newRegistry[districtKey] === 'object' && newRegistry[districtKey] !== null) {
      newRegistry[districtKey].storageFolderId = targetStorageId;
    } else {
      newRegistry[districtKey] = {
        spreadsheetId: currentEntry,
        storageFolderId: targetStorageId,
        name: targetDistrictId,
        enabled: true
      };
    }
    props.setProperty("DISTRICT_REGISTRY", JSON.stringify(newRegistry));
    registryMutated = true;

    // 3) STORAGE_PARENT_ID
    props.setProperty("STORAGE_PARENT_ID", targetStorageId);
    storageParentMutated = true;

    // 10. READ-BACK 機械検証
    const rbBranchRoot = (props.getProperty("BRANCH_ROOT_FOLDER_ID") || "").trim();
    const rbRegRaw = props.getProperty("DISTRICT_REGISTRY");
    const rbStorageParent = (props.getProperty("STORAGE_PARENT_ID") || "").trim();

    if (rbBranchRoot !== branchRootFolderId) {
      throw new Error(`Read-back mismatch for BRANCH_ROOT_FOLDER_ID: expected "${branchRootFolderId}", got "${rbBranchRoot}"`);
    }
    if (rbStorageParent !== targetStorageId) {
      throw new Error(`Read-back mismatch for STORAGE_PARENT_ID: expected "${targetStorageId}", got "${rbStorageParent}"`);
    }

    const rbRegistry = JSON.parse(rbRegRaw);
    const rbEntry = rbRegistry[districtKey];
    if (!rbEntry || rbEntry.storageFolderId !== targetStorageId) {
      throw new Error(`Read-back mismatch for DISTRICT_REGISTRY[${districtKey}].storageFolderId`);
    }
    if (typeof currentEntry === 'object' && currentEntry !== null) {
      if (rbEntry.spreadsheetId !== currentEntry.spreadsheetId) {
        throw new Error(`Read-back violation: spreadsheetId was mutated!`);
      }
      if (rbEntry.enabled !== currentEntry.enabled) {
        throw new Error(`Read-back violation: enabled status was mutated!`);
      }
      if (rbEntry.name !== currentEntry.name) {
        throw new Error(`Read-back violation: name was mutated!`);
      }
    }

    // 他地区 0 diff 確認
    for (const [k, v] of Object.entries(registry)) {
      if (k === districtKey) continue;
      if (JSON.stringify(rbRegistry[k]) !== JSON.stringify(v)) {
        throw new Error(`Read-back violation: other district "${k}" was mutated!`);
      }
    }
    for (const k of Object.keys(rbRegistry)) {
      if (k === districtKey) continue;
      if (!registry[k]) {
        throw new Error(`Read-back violation: unexpected district "${k}" appeared in registry!`);
      }
    }

    // 11. キャッシュクリア
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache()) {
      CacheService.getScriptCache().remove("CONFIG_STORE");
    }
    if (typeof SpreadsheetResolver !== 'undefined' && SpreadsheetResolver.getInstance) {
      SpreadsheetResolver.getInstance().clearCache();
    }

    // 12. 成功返却
    return {
      success: true,
      message: `District "${targetDistrictId}" drive binding repaired successfully.`,
      districtId: cleanDistrictId,
      branchRootFolderId: rbBranchRoot,
      storageFolderId: targetStorageId,
      storageParentId: rbStorageParent,
      districtRegistryUpdated: true
    };
  } catch (errMutation) {
    // 途中失敗時の局所ロールバック
    try {
      if (storageParentMutated) {
        if (originalStorageParent) props.setProperty("STORAGE_PARENT_ID", originalStorageParent);
        else props.deleteProperty("STORAGE_PARENT_ID");
      }
      if (registryMutated) {
        props.setProperty("DISTRICT_REGISTRY", originalRegRaw);
      }
      if (branchRootMutated) {
        if (originalBranchRoot) props.setProperty("BRANCH_ROOT_FOLDER_ID", originalBranchRoot);
        else props.deleteProperty("BRANCH_ROOT_FOLDER_ID");
      }
    } catch (eRollback) {
      console.error("[repairDistrictDriveBinding] Critical rollback error:", eRollback);
    }
    return {
      success: false,
      code: "MUTATION_FAILED",
      message: errMutation.message
    };
  }
}

/**
 * ACTIVE地区の写真ファイル群安全移動ハンドラ (migrateDistrictPhotos)
 * 既存写真ファイル群を現在の親フォルダから対象districtのCanonical Storageへ安全に物理移動する
 *
 * 認可: PROVISIONING_TOKEN 必須 (verifyProvisioningToken)
 * 挙動:
 * 1. 排他ロック取得 (LockService.getScriptLock)
 * 2. verifyProvisioningToken(token) による認証
 * 3. 入力検証 (districtId, fileIds[], expectedSourceFolderId)
 *    - fileIds は重複除去 (Deduplicate)
 *    - 上限 (BATCH_SIZE_EXCEEDED: 200件)
 * 4. 対象districtのRegistry照合 & targetStorageFolderId確定 (Server Authority)
 *    - DISTRICT_REGISTRY[districtId].storageFolderId を正本とし、DriveAppで存在確認
 *    - caller指定の expectedTargetStorageFolderId は Assertion-only (不一致時は STORAGE_FOLDER_MISMATCH)
 *    - Script Properties / Registry は 0 diff (変更禁止)
 * 5. 全件事前検査 (All-Files Preflight Before Mutation):
 *    - 1件でも移動する前に fileIds 全件を検査
 *    - DriveApp.getFileById で取得可能、!isTrashed()、MIMEが image/* (jpeg, png, webp, gif等)
 *    - parent が expectedSourceFolderId または既に canonicalTargetStorageFolderId
 *    - どちらでもない場合は SOURCE_FOLDER_MISMATCH で即座に全中断 (mutation 0)
 * 6. 移動執行 (Atomic Move with Moved Ledger):
 *    - toMigrate 対象を file.moveTo(targetFolder) で順次移動
 *    - 成功ごとに movedLedger に記録
 *    - 途中エラー時は movedLedger のみを sourceFolder へロールバック (失敗時は ROLLBACK_INCOMPLETE)
 * 7. 事後Read-back検証 (Post-Move Read-Back):
 *    - 全件について parent が canonicalTargetStorageFolderId、source未含有、!isTrashed() を再確認
 * 8. 結果返却 (Secret漏洩なし)
 */
function handleMigrateDistrictPhotos(postData, params) {
  // 1. 排他制御
  let lock;
  try {
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      lock = LockService.getScriptLock();
      lock.waitLock(30000);
    }
  } catch (eLock) {
    return {
      success: false,
      code: "LOCK_TIMEOUT",
      message: "Could not acquire script lock within 30 seconds."
    };
  }

  try {
    // 2. Token認証 (PROVISIONING_TOKEN)
    const token = (postData && (postData.provisioningToken || postData.token))
               || (params && (params.provisioningToken || params.token));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return tokenCheck;
    }

    // 3. 入力検証
    const targetDistrictId = String((postData && postData.districtId) || (params && params.districtId) || "").trim();
    const cleanDistrictId = targetDistrictId.toUpperCase();
    if (!cleanDistrictId) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "districtId is required."
      };
    }

    const rawFileIds = (postData && (postData.fileIds || postData.photoIds))
                    || (params && (params.fileIds || params.photoIds));
    if (!Array.isArray(rawFileIds) || rawFileIds.length === 0) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "fileIds must be a non-empty array of file IDs."
      };
    }

    // 重複除去 (Deduplicate)
    const uniqueFileIds = Array.from(new Set(rawFileIds.map(id => String(id || '').trim()).filter(Boolean)));
    if (uniqueFileIds.length === 0) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "fileIds contains no valid non-empty file IDs."
      };
    }

    // 上限チェック (安全上限: 200件)
    const MAX_BATCH_SIZE = 200;
    if (uniqueFileIds.length > MAX_BATCH_SIZE) {
      return {
        success: false,
        code: "BATCH_SIZE_EXCEEDED",
        message: `fileIds count (${uniqueFileIds.length}) exceeds maximum batch size of ${MAX_BATCH_SIZE}.`
      };
    }

    const expectedSourceFolderId = String(
      (postData && postData.expectedSourceFolderId) || (params && params.expectedSourceFolderId) || ""
    ).trim();
    if (!expectedSourceFolderId) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "expectedSourceFolderId is required."
      };
    }

    const expectedTargetStorageFolderId = String(
      (postData && postData.expectedTargetStorageFolderId) || (params && params.expectedTargetStorageFolderId) || ""
    ).trim();

    // 4. District Safety & Target Storage Authority
    const props = (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties)
      ? PropertiesService.getScriptProperties()
      : null;
    if (!props) {
      return {
        success: false,
        code: "CONFIGURATION_ERROR",
        message: "PropertiesService is unavailable."
      };
    }

    const regRaw = (props.getProperty("DISTRICT_REGISTRY") || "").trim();
    if (!regRaw) {
      return {
        success: false,
        code: "UNINITIALIZED_REGISTRY",
        message: "DISTRICT_REGISTRY is not configured or empty."
      };
    }

    let registry;
    try {
      registry = JSON.parse(regRaw);
    } catch (e) {
      return {
        success: false,
        code: "CORRUPTED_REGISTRY",
        message: "Failed to parse DISTRICT_REGISTRY JSON: " + e.message
      };
    }

    const districtKey = Object.keys(registry).find(k => k.trim().toUpperCase() === cleanDistrictId);
    if (!districtKey || !registry[districtKey]) {
      return {
        success: false,
        code: "DISTRICT_NOT_FOUND",
        message: `District "${targetDistrictId}" not found in DISTRICT_REGISTRY.`
      };
    }

    const currentEntry = registry[districtKey];
    const canonicalStorageFolderId = String(
      (typeof currentEntry === 'object' && currentEntry !== null)
        ? currentEntry.storageFolderId
        : ""
    ).trim();

    if (!canonicalStorageFolderId) {
      return {
        success: false,
        code: "STORAGE_FOLDER_NOT_CONFIGURED",
        message: `Canonical storageFolderId is not configured for district "${targetDistrictId}".`
      };
    }

    // Caller 指定の expectedTargetStorageFolderId は Assertion-only
    if (expectedTargetStorageFolderId && expectedTargetStorageFolderId !== canonicalStorageFolderId) {
      return {
        success: false,
        code: "STORAGE_FOLDER_MISMATCH",
        message: `Expected target storage folder ID "${expectedTargetStorageFolderId}" does not match canonical storage folder ID "${canonicalStorageFolderId}".`
      };
    }

    if (expectedSourceFolderId === canonicalStorageFolderId) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "expectedSourceFolderId cannot be identical to canonical target storage folder ID."
      };
    }

    if (typeof DriveApp === 'undefined' || !DriveApp.getFileById || !DriveApp.getFolderById) {
      return {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "DriveApp service is not available."
      };
    }

    let sourceFolder;
    try {
      sourceFolder = DriveApp.getFolderById(expectedSourceFolderId);
      if (!sourceFolder) throw new Error("Folder null");
    } catch (eSrc) {
      return {
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: `Source folder "${expectedSourceFolderId}" cannot be opened: ${eSrc.message}`
      };
    }

    let targetFolder;
    try {
      targetFolder = DriveApp.getFolderById(canonicalStorageFolderId);
      if (!targetFolder) throw new Error("Folder null");
    } catch (eTgt) {
      return {
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: `Target storage folder "${canonicalStorageFolderId}" cannot be opened: ${eTgt.message}`
      };
    }

    // 5. All-Files Preflight Before Mutation (全件事前検査)
    const alreadyMigrated = [];
    const toMigrate = [];

    for (const fid of uniqueFileIds) {
      let file;
      try {
        file = DriveApp.getFileById(fid);
        if (!file) throw new Error("File null");
      } catch (eFile) {
        return {
          success: false,
          code: "RESOURCE_NOT_FOUND",
          message: `Preflight failed: file "${fid}" cannot be opened: ${eFile.message}`
        };
      }

      if (file.isTrashed && file.isTrashed()) {
        return {
          success: false,
          code: "FILE_TRASHED",
          message: `Preflight failed: file "${fid}" is in trash.`
        };
      }

      const mime = (file.getMimeType ? file.getMimeType() : "").toLowerCase();
      // 最低限 image/jpeg, image/png, image/webp, image/gif を含む画像MIMEを許可
      if (!mime.startsWith("image/")) {
        return {
          success: false,
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: `Preflight failed: file "${fid}" has unsupported MIME type "${mime}". Only images are permitted.`
        };
      }

      // 親フォルダ検査
      const parentsIter = file.getParents ? file.getParents() : null;
      const parentIds = [];
      if (parentsIter) {
        while (parentsIter.hasNext()) {
          parentIds.push(parentsIter.next().getId());
        }
      }

      const inTarget = parentIds.includes(canonicalStorageFolderId);
      const inSource = parentIds.includes(expectedSourceFolderId);

      if (inTarget) {
        alreadyMigrated.push(fid);
      } else if (inSource) {
        toMigrate.push({ id: fid, file: file });
      } else {
        return {
          success: false,
          code: "SOURCE_FOLDER_MISMATCH",
          message: `Preflight failed: file "${fid}" is not located in expected source folder "${expectedSourceFolderId}". Actual parents: ${JSON.stringify(parentIds)}`
        };
      }
    }

    // 6. 移動執行 (Atomic Move with Moved Ledger)
    const movedLedger = [];
    let mutationError = null;

    for (const item of toMigrate) {
      try {
        if (typeof item.file.moveTo === 'function') {
          item.file.moveTo(targetFolder);
        } else {
          // DriveApp 古い互換フォールバック: addFile / removeFile
          targetFolder.addFile(item.file);
          sourceFolder.removeFile(item.file);
        }
        movedLedger.push(item.id);
      } catch (errMove) {
        mutationError = errMove;
        console.error(`[migrateDistrictPhotos] Error moving file "${item.id}":`, errMove);
        break;
      }
    }

    // 途中エラー発生時の局所ロールバック
    if (mutationError) {
      const rollbackFailures = [];
      for (const rbId of movedLedger) {
        try {
          const rbFile = DriveApp.getFileById(rbId);
          if (typeof rbFile.moveTo === 'function') {
            rbFile.moveTo(sourceFolder);
          } else {
            sourceFolder.addFile(rbFile);
            targetFolder.removeFile(rbFile);
          }
        } catch (eRb) {
          console.error(`[migrateDistrictPhotos] Critical rollback failure for file "${rbId}":`, eRb);
          rollbackFailures.push(rbId);
        }
      }

      if (rollbackFailures.length > 0) {
        return {
          success: false,
          code: "ROLLBACK_INCOMPLETE",
          message: `Move failed and rollback was incomplete. Mutation error: ${mutationError.message}. Unrecovered files: ${JSON.stringify(rollbackFailures)}`
        };
      }

      return {
        success: false,
        code: "MUTATION_FAILED",
        message: `Move aborted and successfully rolled back. Error: ${mutationError.message}`
      };
    }

    // 7. Post-Move Read-Back Verification (事後検証)
    for (const fid of uniqueFileIds) {
      let rbFile;
      try {
        rbFile = DriveApp.getFileById(fid);
        if (!rbFile) throw new Error("File null on read-back");
      } catch (eRbRead) {
        return {
          success: false,
          code: "READ_BACK_MISMATCH",
          message: `Read-back verification failed: file "${fid}" could not be retrieved.`
        };
      }

      if (rbFile.isTrashed && rbFile.isTrashed()) {
        return {
          success: false,
          code: "READ_BACK_MISMATCH",
          message: `Read-back verification failed: file "${fid}" is trashed.`
        };
      }

      const rbParentsIter = rbFile.getParents ? rbFile.getParents() : null;
      const rbParentIds = [];
      if (rbParentsIter) {
        while (rbParentsIter.hasNext()) {
          rbParentIds.push(rbParentsIter.next().getId());
        }
      }

      if (!rbParentIds.includes(canonicalStorageFolderId)) {
        return {
          success: false,
          code: "READ_BACK_MISMATCH",
          message: `Read-back verification failed: file "${fid}" parent does not include canonical storage folder.`
        };
      }

      if (rbParentIds.includes(expectedSourceFolderId)) {
        return {
          success: false,
          code: "READ_BACK_MISMATCH",
          message: `Read-back verification failed: file "${fid}" still contains source folder in parents.`
        };
      }
    }

    // 8. 成功レスポンス返却
    return {
      success: true,
      message: `District "${targetDistrictId}" photos migrated successfully.`,
      districtId: cleanDistrictId,
      requestedCount: uniqueFileIds.length,
      migratedCount: movedLedger.length,
      alreadyMigratedCount: alreadyMigrated.length,
      failedCount: 0,
      targetStorageFolderId: canonicalStorageFolderId,
      migratedFileIds: movedLedger
    };
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

/**
 * GETリクエスト：JSONデータの取得
 */
function doGet(e) {
  isWebAppCall = true;
  let params = (e && e.parameter) ? Object.assign({}, e.parameter) : {};

  if (params.json) {
    try {
      const parsed = typeof params.json === 'string' ? JSON.parse(params.json) : params.json;
      if (parsed && typeof parsed === 'object') {
        Object.assign(params, parsed);
      }
    } catch (errJ) {}
  }
  if (e) {
    e.parameter = params;
  }

  if (params.liffToken || params.dashboardSessionToken || params.managerSessionToken) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: "Token transmission via GET is prohibited."
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const action = params.action || "";

  if (action === 'healSchemaHeaders' || action === 'runIdentityMigration' || action === 'switchDistrictSpreadsheet' || action === 'repairDistrictDriveBinding' || action === 'migrateDistrictPhotos' || action === 'syncSystemInfo' || action === 'resetRoster') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: `${action} requires POST request.`
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const isPublicAction = [
    'getMapsApiKey',
    'getTier1',
    'registerOrValidateDevice',
    'getDeviceStatus',
    'verifyManagerPassword'
  ].includes(action);

  const isDashboardOnlyAction = [
    'getRoster',
    'getTransferRequests',
    'getDashboardSnapshot',
    'getSystemInfo'
  ].includes(action);

  const isDualAuthAction = [
    'getSystemSummary',
    'getDashboardData',
    'getRanking',
    'getFlyerStock',
    'getLatestDistribution',
    'getDeliveryStats',
    'getAreaDetails',
    'getGlobalPinStatus',
    'getBulletinPosts'
  ].includes(action);

  if (action === 'registerOrValidateDevice') {
    return ContentService.createTextOutput(JSON.stringify({ success: true, authorized: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'resetDeviceManagement') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "FORBIDDEN",
      message: "resetDeviceManagement is disabled on Web App endpoint."
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'bootstrapEnvironment') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "bootstrapEnvironment requires POST request."
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'provisionDistrict') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "provisionDistrict requires POST request."
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'switchDistrictSpreadsheet') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "switchDistrictSpreadsheet requires POST request."
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'repairDistrictDriveBinding') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "repairDistrictDriveBinding requires POST request."
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'migrateDistrictPhotos') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "migrateDistrictPhotos requires POST request."
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'getDeviceStatus') {
    return ContentService.createTextOutput(JSON.stringify({ success: true, exists: false, rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'getMapsApiKey') {
    const sessionToken = params && (params.dashboardSessionToken || params.token);
    const targetDistrictId = (params && params.districtId) || "";
    const result = handleGetMapsApiKey(targetDistrictId, sessionToken);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const districtId = String((params && params.districtId) || "").trim();

  // 1. マルチ地区環境における districtId 必須チェック (Routing Gate)
  try {
    const props = PropertiesService.getScriptProperties();
    if (props && props.getProperty("DISTRICT_REGISTRY") && !districtId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "MISSING_DISTRICT_ID",
        message: "districtId is required for multi-district routing."
      })).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (eProps) {}

  // 2. DISTRICT_REGISTRY 照合 & 対象DB確定 & Integrity Guard
  if (districtId) {
    try {
      SpreadsheetResolver.getInstance().getSpreadsheet(districtId);
    } catch (eResolver) {
      const errStr = eResolver.toString();
      if (errStr.includes("DISTRICT_MISMATCH")) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "DISTRICT_MISMATCH",
          message: eResolver.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
      if (errStr.includes("not found in DISTRICT_REGISTRY")) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "DISTRICT_NOT_FOUND",
          message: eResolver.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "CONTRACT_CHECK_FAILED",
        message: "契約情報の検証に失敗したため安全のためアクセスを遮断しました。"
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 3. 契約確認 (Contract Gate)
  if (typeof SystemInfoService !== 'undefined' && SystemInfoService.getInstance) {
    const contract = SystemInfoService.getInstance().getContractStatus(null, new Date(), districtId);
    if (contract.isExpired) {
      const errorCode = contract.code || "CONTRACT_EXPIRED";
      const errorMsg = contract.message || "契約期間が終了しているため利用できません。";
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: errorCode,
        message: errorMsg
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 4. 厳格な認証ゲート (SEC-001)
  if (!isPublicAction) {
    const dashToken = (params && (params.dashboardSessionToken || params.managerSessionToken)) || "";
    let isDashAuthed = false;
    if (dashToken && typeof verifyDashboardSession === 'function') {
      const dashCheck = verifyDashboardSession(dashToken, districtId);
      if (dashCheck.success) {
        isDashAuthed = true;
        e.user = { role: 'MANAGER', districtId: dashCheck.session.districtId };
      } else if (isDashboardOnlyAction) {
        return ContentService.createTextOutput(JSON.stringify(dashCheck))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (isDashboardOnlyAction || isDualAuthAction) {
      if (!isDashAuthed) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "UNAUTHORIZED",
          message: isDashboardOnlyAction ? "Dashboard session token is required." : "Authentication required for this resource."
        })).setMimeType(ContentService.MimeType.JSON);
      }
    } else {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "UNAUTHORIZED",
        message: "Authentication required."
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  const res = processGetActionLegacy(action, e, districtId);
  if (res && typeof res.setMimeType === 'function') {
    return res;
  }
  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}


/**
 * 従来のGETリクエストの処理（後方互換用）
 */
function processGetActionLegacy(action, e, districtId = "") {
  let response;
  switch (action) {
      case 'getDashboardData':
      case 'getSystemSummary':
        response = typeof SystemSummaryService !== 'undefined' ? SystemSummaryService.getInstance().getSystemSummary(districtId) : { success: true, ...getDashboardData() };
        break;
      case 'getMapsApiKey': {
        const dashToken = (e && e.parameter && (e.parameter.dashboardSessionToken || e.parameter.managerSessionToken)) || "";
        response = handleGetMapsApiKey(districtId, dashToken);
        break;
      }
      case 'getTier1':
        response = typeof Tier1Service !== 'undefined' ? Tier1Service.getInstance().getTier1() : { success: false };
        break;
      case 'getSystemInfo':
        try {
          const ss = typeof getSS === 'function'
            ? getSS(districtId)
            : (typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp.getActiveSpreadsheet() : null);
          if (!ss) {
            response = { success: false, message: 'Spreadsheet unavailable' };
          } else {
            const sysSheet = ss.getSheetByName('SYSTEM_INFO');
            const sysValues = (sysSheet && sysSheet.getLastRow() > 0 && sysSheet.getLastColumn() > 0)
              ? sysSheet.getRange(1, 1, sysSheet.getLastRow(), sysSheet.getLastColumn()).getValues()
              : [];
            const safeSystemInfoRows = sysValues.map(row => {
              if (Array.isArray(row) && String(row[0] || '').trim() === 'Manager認証パスワード') {
                const safeRow = row.slice();
                safeRow[1] = '[REDACTED]';
                return safeRow;
              }
              return row;
            });
            const sheetsSummary = ss.getSheets().map(s => ({
              name: s.getName(),
              lastRow: s.getLastRow(),
              lastColumn: s.getLastColumn(),
              dataRows: Math.max(0, s.getLastRow() - 1)
            }));
            response = {
              success: true,
              spreadsheetName: ss.getName(),
              spreadsheetId: ss.getId(),
              systemInfoRows: safeSystemInfoRows,
              sheets: sheetsSummary
            };
          }
        } catch (err) {
          response = { success: false, error: err.toString() };
        }
        break;
      case 'getRanking': {
        const rankPayload = DistributionService.getInstance().getRankingPayload("", districtId);
        response = { success: true, mySummary: rankPayload.mySummary, ranking: rankPayload.ranking };
        break;
      }
      case 'getLatestDistribution':
        try {
          const records = typeof DistributionRepository !== 'undefined' && DistributionRepository.getInstance
            ? DistributionRepository.getInstance().fetchLatestRecords(20, "", districtId)
            : [];
          response = { success: true, records: records };
        } catch (err) {
          response = { success: false, error: err.toString(), records: [] };
        }
        break;
      case 'getRoster': {
        const rawRoster = StaffService.getInstance().getRoster(districtId);
        let stocks = [];
        let ranking = [];
        try {
          stocks = FlyerRepository.getInstance().findAllStocks("", districtId);
          ranking = DistributionRepository.getInstance().fetchRankingData("", districtId, rawRoster);
        } catch (eAgg) {}
        const aggregatedRoster = rawRoster.map(r => {
          const staffStocks = stocks.filter(st => st.staffId === r.id);
          const stockTotal = staffStocks.reduce((acc, st) => acc + (Number(st.count) || 0), 0);
          const staffRank = ranking.find(rk => rk.staffId === r.id);
          const deliveredTotal = staffRank ? Number(staffRank.count || 0) : 0;
          return {
            id: r.id,
            name: r.name,
            registeredAt: r.registeredAt,
            stockTotal: stockTotal,
            deliveredTotal: deliveredTotal
          };
        });
        response = { success: true, roster: aggregatedRoster };
        break;
      }
      case 'resetDeviceManagement':
        response = { success: false, code: "FORBIDDEN", message: "resetDeviceManagement is disabled on Web App endpoint." };
        break;
      case 'getAreaDetails':
        response = AreaService.getInstance().getAreaDetails(e.name, districtId);
        break;
      case 'submitDistribution':
        response = { success: false, message: 'Write operations require POST. Please update the client.' };
        break;
      case 'registerStaff':
        response = { success: false, error: 'Registration requires POST request for security reasons.' };
        break;
      case 'getDeliveryStats':
        response = DistributionService.getInstance().getDeliveryStats(districtId);
        break;
      case 'getFlyerStock': {
        const stockPayload = FlyerService.getInstance().getFlyerStock("", districtId);
        response = { success: true, myStock: stockPayload.myStock, stocks: stockPayload.stocks };
        break;
      }
      case 'getTransferRequests':
        response = { success: true, requests: TransferService.getInstance().getTransferRequests("", districtId) };
        break;


      default:
        response = { success: true, message: 'POSTING MAP API is online.' };
    }
  return response;
}

/**
 * POSTリクエスト：データの登録・更新
 */
function doPost(e) {
  isWebAppCall = true;
  let params = (e && e.parameter) ? Object.assign({}, e.parameter) : {};
  let postData = null;
  if (e && e.postData && e.postData.contents) {
    try {
      postData = JSON.parse(e.postData.contents);
    } catch (errP) {}
  }
  if (params.json) {
    try {
      const parsedJson = typeof params.json === 'string' ? JSON.parse(params.json) : params.json;
      postData = { ...(postData || {}), ...parsedJson };
    } catch (errJson) {}
  }
  const action = (postData && postData.action) || params.action || (e && e.parameter && e.parameter.action) || "";
  const districtId = String((postData && postData.districtId) || (params && params.districtId) || "").trim();

  const isManagementAction = [
    'bootstrapEnvironment',
    'provisionDistrict',
    'createEmptyTemplate',
    'createDistrictDatabase',
    'syncSystemInfo',
    'healSchemaHeaders',
    'runIdentityMigration',
    'resetRoster',
    'registerOrValidateDevice',
    'resetDeviceManagement',
    'getDeviceStatus',
    'issueMobilePairingToken',
    'pairMobileDevice',
    'switchDistrictSpreadsheet',
    'repairDistrictDriveBinding',
    'migrateDistrictPhotos'
  ].includes(action);

  if (!isManagementAction) {
    try {
      const props = PropertiesService.getScriptProperties();
      if (props.getProperty("DISTRICT_REGISTRY") && !districtId) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "MISSING_DISTRICT_ID",
          message: "districtId is required for multi-district routing."
        })).setMimeType(ContentService.MimeType.JSON);
      }
    } catch (eProps) {}
  }

  const isPublicAction = [
    'getMapsApiKey',
    'getTier1',
    'registerOrValidateDevice',
    'getDeviceStatus',
    'verifyManagerPassword'
  ].includes(action);

  const isDashboardOnlyAction = [
    'getRoster',
    'getTransferRequests',
    'getDashboardSnapshot',
    'getSystemInfo',
    'logoutManager'
  ].includes(action);

  const isDualAuthAction = [
    'getSystemSummary',
    'getDashboardData',
    'getRanking',
    'getFlyerStock',
    'getLatestDistribution',
    'getDeliveryStats',
    'getAreaDetails',
    'getGlobalPinStatus',
    'getBulletinPosts'
  ].includes(action);

  const isDashboardAction = isDashboardOnlyAction;
  const isReadOnlyAction = isDashboardOnlyAction || isDualAuthAction;

  if (action === 'registerOrValidateDevice') {
    return ContentService.createTextOutput(JSON.stringify({ success: true, authorized: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'resetDeviceManagement') {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      code: "FORBIDDEN",
      message: "resetDeviceManagement is disabled on Web App endpoint."
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'getDeviceStatus') {
    return ContentService.createTextOutput(JSON.stringify({ success: true, exists: false, rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'issueMobilePairingToken') {
    return ContentService.createTextOutput(JSON.stringify({ success: true, message: "OK" }))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'pairMobileDevice') {
    return ContentService.createTextOutput(JSON.stringify({ success: true, message: "OK" }))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'bootstrapEnvironment') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));

    const props = PropertiesService.getScriptProperties();
    const storedHash = (props.getProperty('PROVISIONING_TOKEN_HASH') || '').trim().toLowerCase();
    const existingTargetSsId = (props.getProperty('TARGET_SPREADSHEET_ID') || props.getProperty('SPREADSHEET_ID') || '').trim();

    // 既に初期化済み（PROVISIONING_TOKEN_HASH または TARGET_SPREADSHEET_ID が存在）の場合は厳格なトークン認証が必須
    if (storedHash || existingTargetSsId) {
      const tokenCheck = verifyProvisioningToken(token);
      if (!tokenCheck.success) {
        return ContentService.createTextOutput(JSON.stringify(tokenCheck))
          .setMimeType(ContentService.MimeType.JSON);
      }
    } else {
      // 初回ブートストラップ時の安全防壁:
      // provisioningToken が必須（空文字・16文字未満の脆弱トークンを拒絶）
      if (!token || typeof token !== 'string' || token.trim().length < 16) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "UNAUTHORIZED",
          message: "Provisioning token with at least 16 characters is required for initial bootstrap."
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    const districtId = String((postData && postData.districtId) || (params && params.districtId) || "").trim();
    if (!districtId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "INVALID_ARGUMENT",
        message: "districtId is required."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const cleanDistrictId = String(districtId).trim().toUpperCase();
    const canonicalDbName = cleanDistrictId;

    // Server-side Deterministic Resolution: 03_BRANCH 配下から districtFolder, storageFolder を解決
    let driveStructure;
    try {
      if (typeof DistrictProvisioner !== 'undefined' && DistrictProvisioner.getInstance) {
        driveStructure = DistrictProvisioner.getInstance().resolveOrCreateDistrictDriveStructure(cleanDistrictId);
      } else {
        throw new Error("DistrictProvisioner unavailable");
      }
    } catch (errDrive) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "DRIVE_RESOLUTION_FAILED",
        message: errDrive.message
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const canonicalDistrictFolderId = driveStructure.districtFolderId;
    const canonicalStorageFolderId = driveStructure.storageFolderId;

    // districtFolder 直下から canonical DB を探索して一意解決
    let distFolder;
    try {
      distFolder = DriveApp.getFolderById(canonicalDistrictFolderId);
    } catch (eF) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: `District folder "${canonicalDistrictFolderId}" cannot be opened: ${eF.toString()}`
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const ssFiles = distFolder.getFilesByName(canonicalDbName);
    let ssFile = null;
    let ssCount = 0;
    while (ssFiles.hasNext()) {
      ssFile = ssFiles.next();
      ssCount++;
    }

    // 互換性フォールバック: 過去形式（旧命名: POSTING_MAP_DB_<districtId>）の探索
    if (ssCount === 0) {
      const legacyFiles = distFolder.getFilesByName(`POSTING_MAP_DB_${cleanDistrictId}`);
      while (legacyFiles.hasNext()) {
        ssFile = legacyFiles.next();
        ssCount++;
      }
    }

    if (ssCount === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: `Canonical spreadsheet "${canonicalDbName}" not found in district folder "${canonicalDistrictFolderId}".`
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (ssCount > 1) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "AMBIGUOUS_DISTRICT_DB",
        message: `Multiple spreadsheets found in district folder "${canonicalDistrictFolderId}".`
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ショートカットの厳格拒絶
    if (ssFile.getMimeType && ssFile.getMimeType() === "application/vnd.google-apps.shortcut") {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "SHORTCUT_REJECTED",
        message: `Drive shortcut "${ssFile.getName()}" cannot be used as canonical spreadsheet.`
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const canonicalSpreadsheetId = ssFile.getId();

    // Legacy parameter assertions (Optional Assertion Only)
    const targetSpreadsheetId = String(
      (postData && (postData.targetSpreadsheetId || postData.spreadsheetId)) ||
      (params && (params.targetSpreadsheetId || params.spreadsheetId)) || ""
    ).trim();
    if (targetSpreadsheetId && targetSpreadsheetId !== canonicalSpreadsheetId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "SPREADSHEET_ID_MISMATCH",
        message: `Specified targetSpreadsheetId "${targetSpreadsheetId}" does not match canonical resolved spreadsheet "${canonicalSpreadsheetId}". Caller cannot override DB location.`
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const storageParentId = String(
      (postData && (postData.storageParentId || postData.storageFolderId)) ||
      (params && (params.storageParentId || params.storageFolderId)) || ""
    ).trim();
    if (storageParentId && storageParentId !== canonicalStorageFolderId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "STORAGE_FOLDER_MISMATCH",
        message: `Specified storageParentId "${storageParentId}" does not match canonical resolved storage folder "${canonicalStorageFolderId}". Caller cannot override storage location.`
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 実在リソース検証: 対象スプレッドシートのアクセス確認
    let ss;
    try {
      ss = SpreadsheetApp.openById(canonicalSpreadsheetId);
    } catch (e) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: "Target spreadsheet cannot be opened: " + e.toString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 地区名SSOT検証: スプレッドシート名が canonicalDbName (cleanDistrictId) または過去形式と一致すること
    const ssName = (ss.getName() || "").trim();
    if (ssName !== canonicalDbName && ssName !== `POSTING_MAP_DB_${cleanDistrictId}`) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "DISTRICT_MISMATCH",
        message: `Spreadsheet name "${ssName}" does not match canonical DB name "${canonicalDbName}".`
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 実在リソース検証: ストレージフォルダのアクセス確認
    try {
      DriveApp.getFolderById(canonicalStorageFolderId);
    } catch (e) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "RESOURCE_NOT_FOUND",
        message: "Storage parent folder cannot be opened: " + e.toString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Generation 2: DISTRICT_REGISTRY への追加・更新（既存他地区の完全保護）
    const regRaw = props.getProperty("DISTRICT_REGISTRY");
    let registry = {};

    if (regRaw === null) {
      registry = {}; // 初回・Legacy 未設定環境
    } else {
      if (typeof regRaw === "string" && regRaw.trim() === "") {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "CORRUPTED_REGISTRY",
          message: "DISTRICT_REGISTRY is configured but empty (corrupted)."
        })).setMimeType(ContentService.MimeType.JSON);
      }
      try {
        registry = JSON.parse(regRaw);
      } catch (eReg) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "CORRUPTED_REGISTRY",
          message: "DISTRICT_REGISTRY JSON is corrupted."
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    registry[cleanDistrictId] = {
      spreadsheetId: canonicalSpreadsheetId,
      storageFolderId: canonicalStorageFolderId,
      name: districtId,
      enabled: false // Acceptance 前は disabled
    };

    const newProps = {
      DISTRICT_REGISTRY: JSON.stringify(registry),
      STORAGE_PARENT_ID: canonicalStorageFolderId,
      PROVISIONING_TOKEN_HASH: computeSha256(token.trim()).toLowerCase()
    };

    // 初期環境向けGeneration 1互換（既存のTARGET_SPREADSHEET_IDが未設定の場合のみ初期設定）
    if (!props.getProperty("TARGET_SPREADSHEET_ID")) {
      newProps.TARGET_SPREADSHEET_ID = canonicalSpreadsheetId;
      newProps.SPREADSHEET_ID = canonicalSpreadsheetId;
      newProps.DISTRICT_ID = districtId;
    }

    props.setProperties(newProps);

    // キャッシュクリア
    if (typeof CacheService !== "undefined" && CacheService.getScriptCache()) {
      CacheService.getScriptCache().remove("CONFIG_STORE");
    }
    if (typeof SpreadsheetResolver !== "undefined" && SpreadsheetResolver.getInstance) {
      SpreadsheetResolver.getInstance().clearCache();
    }

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: "Environment bootstrapped successfully.",
      districtId: districtId,
      targetSpreadsheetId: canonicalSpreadsheetId,
      storageParentId: canonicalStorageFolderId,
      districtRegistryUpdated: true
    })).setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'provisionDistrict') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return ContentService.createTextOutput(JSON.stringify(tokenCheck))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const addresses = (postData && postData.addresses) || (params && params.addresses);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "INVALID_ARGUMENT",
        message: "addresses must be a non-empty array of address master records."
      })).setMimeType(ContentService.MimeType.JSON);
    }
    const options = (postData && postData.options) || (params && params.options) || {};
    if (options && options.spreadsheet) {
      delete options.spreadsheet;
    }
    if (postData && postData.skipSystemInfo !== undefined && options.skipSystemInfo === undefined) {
      options.skipSystemInfo = postData.skipSystemInfo;
    }
    options.provisioningToken = token;
    const targetDistrictId = String((postData && (postData.districtId || (postData.options && postData.options.districtId))) || (params && (params.districtId || (params.options && params.options.districtId))) || "").trim().toUpperCase();
    const explicitSsId = String((postData && (postData.targetSpreadsheetId || postData.spreadsheetId)) || (params && (params.targetSpreadsheetId || params.spreadsheetId)) || (options && (options.targetSpreadsheetId || options.spreadsheetId)) || "").trim();
    if (explicitSsId) {
      options.targetSpreadsheetId = explicitSsId;
    }
    let result;
    if (typeof DistrictProvisioner !== 'undefined' && DistrictProvisioner.getInstance) {
      result = DistrictProvisioner.getInstance().provisionNewDistrict(addresses, options, targetDistrictId);
    } else {
      result = { success: false, message: 'DistrictProvisioner not available' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'createEmptyTemplate') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return ContentService.createTextOutput(JSON.stringify(tokenCheck))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const sourceSpreadsheetId = (postData && postData.sourceSpreadsheetId) || (params && params.sourceSpreadsheetId);
    const targetFolderId = (postData && postData.targetFolderId) || (params && params.targetFolderId);
    const options = (postData && postData.options) || (params && params.options) || {};
    options.provisioningToken = token;

    let result;
    if (typeof DistrictProvisioner !== 'undefined' && DistrictProvisioner.getInstance) {
      result = DistrictProvisioner.getInstance().createEmptyTemplate(sourceSpreadsheetId, targetFolderId, options);
    } else {
      result = { success: false, message: 'DistrictProvisioner not available' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'createDistrictDatabase') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return ContentService.createTextOutput(JSON.stringify(tokenCheck))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const templateSpreadsheetId = (postData && postData.templateSpreadsheetId) || (params && params.templateSpreadsheetId);
    const targetDistrictName = (postData && (postData.targetDistrictName || postData.districtId)) || (params && (params.targetDistrictName || params.districtId));
    const targetFolderId = (postData && postData.targetFolderId) || (params && params.targetFolderId);
    const options = (postData && postData.options) || (params && params.options) || {};
    options.provisioningToken = token;
    const reqDistrictId = (postData && postData.districtId) || (params && params.districtId);
    if (reqDistrictId && !options.districtId) {
      options.districtId = reqDistrictId;
    }

    let result;
    if (typeof DistrictProvisioner !== 'undefined' && DistrictProvisioner.getInstance) {
      result = DistrictProvisioner.getInstance().createDistrictDatabase(templateSpreadsheetId, targetDistrictName, targetFolderId, options);
    } else {
      result = { success: false, message: 'DistrictProvisioner not available' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'syncSystemInfo') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return ContentService.createTextOutput(JSON.stringify(tokenCheck))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const options = (postData && postData.options) || (params && params.options) || {};
    if (options && options.spreadsheet) {
      delete options.spreadsheet;
    }
    options.provisioningToken = token;
    const targetDistrictId = String((postData && (postData.districtId || (postData.options && postData.options.districtId))) || (params && (params.districtId || (params.options && params.options.districtId))) || "").trim().toUpperCase();
    const explicitSsId = String((postData && (postData.targetSpreadsheetId || postData.spreadsheetId)) || (params && (params.targetSpreadsheetId || params.spreadsheetId)) || (options && (options.targetSpreadsheetId || options.spreadsheetId)) || "").trim();
    if (explicitSsId) {
      options.targetSpreadsheetId = explicitSsId;
    }
    let result;
    if (typeof SystemInfoService !== 'undefined' && SystemInfoService.getInstance) {
      result = SystemInfoService.getInstance().syncSystemInfo(options, targetDistrictId);
    } else if (typeof DistrictProvisioner !== 'undefined' && DistrictProvisioner.getInstance) {
      const ss = DistrictProvisioner.getInstance().getSS(targetDistrictId);
      result = DistrictProvisioner.getInstance().createOrSyncSystemInfo(ss, options);
    } else {
      result = { success: false, message: 'SystemInfoService not available' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'healSchemaHeaders') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return ContentService.createTextOutput(JSON.stringify(tokenCheck))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const targetDistrictId = String((postData && postData.districtId) || districtId || (params && params.districtId) || "").trim();
    if (!targetDistrictId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "MISSING_DISTRICT_ID",
        message: "districtId is required for healSchemaHeaders."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const targetMonth = String((postData && postData.targetMonth) || (postData && postData.options && postData.options.targetMonth) || (params && params.targetMonth) || "").trim();
    if (!targetMonth || !/^\d{4}-\d{2}$/.test(targetMonth)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "INVALID_ARGUMENT",
        message: "Valid targetMonth (YYYY-MM) is required for healSchemaHeaders."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // targetSpreadsheetId直接指定やClient spreadsheet objectは禁止（Runtime Resolver 経由のみ）
    const isDryRun = (postData && postData.isDryRun !== undefined)
      ? !!postData.isDryRun
      : ((postData && postData.options && postData.options.isDryRun !== undefined) ? !!postData.options.isDryRun : true);

    let result;
    if (typeof healSchemaHeaders === 'function') {
      result = healSchemaHeaders({ isDryRun: isDryRun, targetMonth: targetMonth, districtId: targetDistrictId }, targetDistrictId);
    } else {
      result = { success: false, message: 'healSchemaHeaders not available' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'runIdentityMigration') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return ContentService.createTextOutput(JSON.stringify(tokenCheck))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const targetDistrictId = String((postData && postData.districtId) || districtId || (params && params.districtId) || "").trim();
    const isDryRun = (postData && postData.isDryRun !== undefined) ? !!postData.isDryRun : true;
    let result;
    if (typeof migrateIdentityColumns === 'function') {
      result = migrateIdentityColumns(isDryRun, { districtId: targetDistrictId }, targetDistrictId);
    } else {
      result = { success: false, message: 'migrateIdentityColumns not available' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'switchDistrictSpreadsheet') {
    const result = handleSwitchDistrictSpreadsheet(postData, params);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'repairDistrictDriveBinding') {
    const result = handleRepairDistrictDriveBinding(postData, params);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'migrateDistrictPhotos') {
    const result = handleMigrateDistrictPhotos(postData, params);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'resetRoster') {
    const token = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)))
               || (params && (params.provisioningToken || (params.options && params.options.provisioningToken)));
    const tokenCheck = verifyProvisioningToken(token);
    if (!tokenCheck.success) {
      return ContentService.createTextOutput(JSON.stringify(tokenCheck))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const targetDistrictId = String((postData && postData.districtId) || districtId || (params && params.districtId) || "").trim().toUpperCase();
    if (!targetDistrictId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "MISSING_DISTRICT_ID",
        message: "districtId is required for resetRoster."
      })).setMimeType(ContentService.MimeType.JSON);
    }
    const result = { success: true, message: setupRosterSheet(targetDistrictId) };
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } else if (action === 'getMapsApiKey') {
    const sessionToken = (postData && (postData.dashboardSessionToken || postData.token)) || (params && (params.dashboardSessionToken || params.token));
    const targetDistrictId = (postData && postData.districtId) || districtId || (params && params.districtId);
    const result = handleGetMapsApiKey(targetDistrictId, sessionToken);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 1. DISTRICT_REGISTRY 照合 & 対象DB確定 & Integrity Guard
  if (districtId) {
    try {
      SpreadsheetResolver.getInstance().getSpreadsheet(districtId);
    } catch (eResolver) {
      const errStr = eResolver.toString();
      if (errStr.includes("DISTRICT_MISMATCH")) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "DISTRICT_MISMATCH",
          message: eResolver.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
      if (errStr.includes("not found in DISTRICT_REGISTRY")) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "DISTRICT_NOT_FOUND",
          message: eResolver.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: "CONTRACT_CHECK_FAILED",
        message: "契約情報の検証に失敗したため安全のためアクセスを遮断しました。"
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 2. 契約確認 (Contract Gate)
  if (typeof SystemInfoService !== 'undefined' && SystemInfoService.getInstance) {
    const contract = SystemInfoService.getInstance().getContractStatus(null, new Date(), districtId);
    if (contract.isExpired) {
      const errorCode = contract.code || "CONTRACT_EXPIRED";
      const errorMsg = contract.message || "契約期間が終了しているため利用できません。";
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        code: errorCode,
        message: errorMsg
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 3. 厳格な認証ゲート (SEC-001)
  if (!isPublicAction && !isManagementAction) {
    const dashToken = (postData && (postData.dashboardSessionToken || postData.managerSessionToken))
                   || (params && (params.dashboardSessionToken || params.managerSessionToken)) || "";
    let isDashAuthed = false;

    if (dashToken && typeof verifyDashboardSession === 'function') {
      const dashCheck = verifyDashboardSession(dashToken, districtId);
      if (dashCheck.success) {
        isDashAuthed = true;
        if (postData) {
          postData.user = { role: 'MANAGER', districtId: dashCheck.session.districtId };
        }
      } else if (isDashboardOnlyAction) {
        return ContentService.createTextOutput(JSON.stringify(dashCheck))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (isDashboardOnlyAction) {
      if (!isDashAuthed) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "UNAUTHORIZED",
          message: "Dashboard session token is required."
        })).setMimeType(ContentService.MimeType.JSON);
      }
    } else if (isDualAuthAction) {
      if (!isDashAuthed) {
        // Dashboardセッションがない場合、Hアプリの LINE 認証を検証
        const auth = authenticateRequest(postData || {});
        if (!auth.success) {
          return ContentService.createTextOutput(JSON.stringify(auth))
            .setMimeType(ContentService.MimeType.JSON);
        }
        if (postData) postData.user = auth.user;
      }
    } else {
      // staffDependentActions や registerStaff 等の厳格 LINE 認証アクション
      const auth = authenticateRequest(postData || {});
      if (!auth.success) {
        return ContentService.createTextOutput(JSON.stringify(auth))
          .setMimeType(ContentService.MimeType.JSON);
      }
      if (postData) postData.user = auth.user;
    }
  }
  const res = processPostAction(action, postData, e, districtId);
  if (res && typeof res.setMimeType === 'function') {
    return res;
  }
  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}


/**
 * 実際のPOSTアクション処理のスイッチケース
 */
function processPostAction(action, postData, e, districtId = "") {
  // 認証済み操作主体（Server Authority）の保護
  const authenticatedUser = (postData && postData.user) ? postData.user : null;

  if (e && e.parameter && e.parameter.json) {
    try {
      const parsedJson = typeof e.parameter.json === 'string' ? JSON.parse(e.parameter.json) : e.parameter.json;
      postData = { ...(postData || {}), ...parsedJson };
    } catch (errJson) {}
  }

  // Client 入力（e.parameter.json 等）による操作主体の改ざん・上書きを無力化
  if (authenticatedUser) {
    postData = postData || {};
    postData.user = authenticatedUser;
  }

  // Staff依存業務アクションに対する操作主体（LINE User ID）の検証・Identity強制
  const staffDependentActions = [
    'updateFlyerStock',
    'submitDistribution',
    'updateRecordWithGPSPhoto',
    'createBulletinPost',
    'sendBulletinContact',
    'requestFlyerTransfer',
    'resolveTransferRequest'
  ];
  if (staffDependentActions.includes(action)) {
    const lineUserId = (postData && postData.user && postData.user.lineUserId) ? String(postData.user.lineUserId).trim() : "";
    if (!lineUserId) {
      return { success: false, code: "UNAUTHORIZED", message: "LINE User ID が取得できません。" };
    }
    const identity = (typeof StaffService !== 'undefined' && StaffService.getInstance)
      ? StaffService.getInstance().resolveStaffIdentity(lineUserId, districtId)
      : null;
    if (!identity || !identity.found) {
      return {
        success: false,
        code: "NOT_REGISTERED",
        message: "配布員登録が完了していません。名簿登録を行ってください。"
      };
    }
    // 操作主体の Identity を Backend 側で強制確定（クライアント送信値を無力化）
    postData.staffId = identity.staffId;
    postData.staffName = identity.staffName;
    postData.requestUserId = identity.staffId;
    postData.resolvedStaffId = identity.staffId;
    postData.resolvedStaffName = identity.staffName;
    postData.resolvedLineUserId = identity.lineUserId;
  }

  const reqLineUserId = (postData && postData.user && postData.user.lineUserId) ? String(postData.user.lineUserId).trim() : "";

  switch (action) {

    case 'getStaffIdentity': {
      const lineUserId = (postData && postData.user && postData.user.lineUserId) ? String(postData.user.lineUserId).trim() : "";
      if (!lineUserId) {
        return { success: false, code: "UNAUTHORIZED", message: "LINE User ID が取得できません。" };
      }
      const identity = (typeof StaffService !== 'undefined' && StaffService.getInstance)
        ? StaffService.getInstance().resolveStaffIdentity(lineUserId, districtId)
        : null;
      if (identity && identity.found) {
        return {
          success: true,
          registered: true,
          staffId: identity.staffId,
          staffName: identity.staffName
        };
      } else {
        return {
          success: true,
          registered: false,
          code: "NOT_REGISTERED",
          message: "Staff not registered"
        };
      }
    }

    case 'getDashboardSnapshot': {
      const snapshot = {
        success: true,
        status: "SUCCESS",
        districtId: districtId,
        timestamp: new Date().toISOString(),
        domains: {},
        errors: {}
      };

      // 共通キャッシュ用 名簿データ（同一実行内での再読込排除）
      let sharedRoster = null;
      try {
        if (typeof StaffService !== 'undefined' && StaffService.getInstance) {
          sharedRoster = StaffService.getInstance().getRoster(districtId) || [];
        }
      } catch (eR) {}

      // 1. Summary ドメイン
      try {
        const summaryData = typeof SystemSummaryService !== 'undefined'
          ? SystemSummaryService.getInstance().getSystemSummary(districtId)
          : { success: false, message: 'SystemSummaryService unavailable' };
        snapshot.domains.summary = summaryData;
        if (!summaryData.success) {
          snapshot.status = "PARTIAL_SUCCESS";
          snapshot.errors.summary = summaryData.message || "Summary fetch failed";
        }
      } catch (eSummary) {
        snapshot.status = "PARTIAL_SUCCESS";
        snapshot.domains.summary = { success: false, error: eSummary.toString() };
        snapshot.errors.summary = eSummary.toString();
      }

      // 2. Flyer Stock ドメイン
      let sharedStocks = [];
      try {
        if (typeof FlyerRepository !== 'undefined' && FlyerRepository.getInstance) {
          sharedStocks = FlyerRepository.getInstance().findAllStocks("", districtId) || [];
        }
        const stockPayload = typeof FlyerService !== 'undefined' && FlyerService.getInstance
          ? FlyerService.getInstance().getFlyerStock(reqLineUserId, districtId)
          : { myStock: [], stocks: sharedStocks };
        snapshot.domains.flyerStock = { success: true, myStock: stockPayload.myStock, stocks: stockPayload.stocks };
      } catch (eStock) {
        snapshot.status = "PARTIAL_SUCCESS";
        snapshot.domains.flyerStock = { success: false, error: eStock.toString(), stocks: [] };
        snapshot.errors.flyerStock = eStock.toString();
      }

      // 3. Ranking ドメイン
      let sharedRanking = [];
      try {
        if (typeof DistributionRepository !== 'undefined' && DistributionRepository.getInstance) {
          sharedRanking = DistributionRepository.getInstance().fetchRankingData(reqLineUserId, districtId, sharedRoster) || [];
        }
        const rankPayload = typeof DistributionService !== 'undefined' && DistributionService.getInstance
          ? DistributionService.getInstance().getRankingPayload(reqLineUserId, districtId)
          : { mySummary: null, ranking: sharedRanking };
        snapshot.domains.ranking = { success: true, mySummary: rankPayload.mySummary, ranking: rankPayload.ranking };
      } catch (eRank) {
        snapshot.status = "PARTIAL_SUCCESS";
        snapshot.domains.ranking = { success: false, error: eRank.toString(), ranking: [] };
        snapshot.errors.ranking = eRank.toString();
      }

      // 4. Pin Status ドメイン
      try {
        const pinData = typeof PinStatusService !== 'undefined' && PinStatusService.getInstance
          ? PinStatusService.getInstance().getStatus(districtId)
          : { success: false, inProgress: [], completed: [] };
        snapshot.domains.pinStatus = pinData;
        if (!pinData.success) {
          snapshot.status = "PARTIAL_SUCCESS";
          snapshot.errors.pinStatus = pinData.message || "PinStatus fetch failed";
        }
      } catch (ePin) {
        snapshot.status = "PARTIAL_SUCCESS";
        snapshot.domains.pinStatus = { success: false, error: ePin.toString(), inProgress: [], completed: [] };
        snapshot.errors.pinStatus = ePin.toString();
      }

      // 5. Roster ドメイン
      try {
        const rawRoster = sharedRoster || (typeof StaffService !== 'undefined' ? StaffService.getInstance().getRoster(districtId) : []);
        const aggregatedRoster = (rawRoster || []).map(r => {
          const staffStocks = (sharedStocks || []).filter(st => st.staffId === r.id);
          const stockTotal = staffStocks.reduce((acc, st) => acc + (Number(st.count) || 0), 0);
          const staffRank = (sharedRanking || []).find(rk => rk.staffId === r.id);
          const deliveredTotal = staffRank ? Number(staffRank.count || 0) : 0;
          return {
            id: r.id,
            name: r.name,
            registeredAt: r.registeredAt,
            stockTotal: stockTotal,
            deliveredTotal: deliveredTotal
          };
        });
        snapshot.domains.roster = { success: true, roster: aggregatedRoster };
      } catch (eRoster) {
        snapshot.status = "PARTIAL_SUCCESS";
        snapshot.domains.roster = { success: false, error: eRoster.toString(), roster: [] };
        snapshot.errors.roster = eRoster.toString();
      }

      // 6. Transfer Requests ドメイン
      try {
        const transferData = typeof TransferService !== 'undefined' && TransferService.getInstance
          ? { success: true, requests: TransferService.getInstance().getTransferRequests(reqLineUserId, districtId) }
          : { success: false, requests: [] };
        snapshot.domains.transfer = transferData;
      } catch (eTransfer) {
        snapshot.status = "PARTIAL_SUCCESS";
        snapshot.domains.transfer = { success: false, error: eTransfer.toString(), requests: [] };
        snapshot.errors.transfer = eTransfer.toString();
      }

      // 7. Latest Distribution ドメイン
      try {
        const distLimit = (postData && postData.limit) ? Number(postData.limit) : 20;
        const records = typeof DistributionRepository !== 'undefined' && DistributionRepository.getInstance
          ? DistributionRepository.getInstance().fetchLatestRecords(distLimit, reqLineUserId, districtId)
          : [];
        snapshot.domains.latestDistribution = { success: true, records: records };
      } catch (eLatest) {
        snapshot.status = "PARTIAL_SUCCESS";
        snapshot.domains.latestDistribution = { success: false, error: eLatest.toString(), records: [] };
        snapshot.errors.latestDistribution = eLatest.toString();
      }

      return snapshot;
    }

    case 'getSystemSummary':
      return typeof SystemSummaryService !== 'undefined' ? SystemSummaryService.getInstance().getSystemSummary(districtId) : { success: false };
    case 'getMapsApiKey': {
      const dashToken = (postData && (postData.dashboardSessionToken || postData.managerSessionToken))
                     || (e && e.parameter && (e.parameter.dashboardSessionToken || e.parameter.managerSessionToken)) || "";
      return handleGetMapsApiKey(districtId, dashToken);
    }
    case 'getTier1':
      return typeof Tier1Service !== 'undefined' ? Tier1Service.getInstance().getTier1() : { success: false };
    case 'getSystemInfo':
      try {
        const ss = typeof getSS === 'function' ? getSS(districtId) : (typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp.getActiveSpreadsheet() : null);
        if (!ss) {
          return { success: false, message: 'Spreadsheet unavailable' };
        }
        const sysSheet = ss.getSheetByName('SYSTEM_INFO');
        const sysValues = (sysSheet && sysSheet.getLastRow() > 0 && sysSheet.getLastColumn() > 0)
          ? sysSheet.getRange(1, 1, sysSheet.getLastRow(), sysSheet.getLastColumn()).getValues()
          : [];
        const safeSystemInfoRows = sysValues.map(row => {
          if (Array.isArray(row) && String(row[0] || '').trim() === 'Manager認証パスワード') {
            const safeRow = row.slice();
            safeRow[1] = '[REDACTED]';
            return safeRow;
          }
          return row;
        });
        const sheetsSummary = ss.getSheets().map(s => ({
          name: s.getName(),
          lastRow: s.getLastRow(),
          lastColumn: s.getLastColumn(),
          dataRows: Math.max(0, s.getLastRow() - 1)
        }));
        return {
          success: true,
          spreadsheetName: ss.getName(),
          spreadsheetId: ss.getId(),
          systemInfoRows: safeSystemInfoRows,
          sheets: sheetsSummary
        };
      } catch (err) {
        return { success: false, error: err.toString() };
      }

    case 'getEvidence':
      try {
        const rosterSheet = getMonthlySheet('staff', districtId);
        const rosterLastRow = rosterSheet ? rosterSheet.getLastRow() : 0;
        return {
          success: true,
          rosterLatest: rosterLastRow > 0 ? rosterSheet.getRange(rosterLastRow, 1, 1, rosterSheet.getLastColumn()).getValues()[0] : null,
          traceLatest: null
        };
      } catch (err) {
        return { success: false, error: err.toString() };
      }

    case 'getRanking': {
      const rankPayload = DistributionService.getInstance().getRankingPayload(reqLineUserId, districtId);
      return { success: true, mySummary: rankPayload.mySummary, ranking: rankPayload.ranking };
    }
    case 'getLatestDistribution':
      try {
        const records = typeof DistributionRepository !== 'undefined' && DistributionRepository.getInstance
          ? DistributionRepository.getInstance().fetchLatestRecords(postData.limit || 20, reqLineUserId, districtId)
          : [];
        return { success: true, records: records };
      } catch (err) {
        return { success: false, error: err.toString(), records: [] };
      }
    case 'getRoster': {
      const rawRoster = StaffService.getInstance().getRoster(districtId);
      let stocks = [];
      let ranking = [];
      try {
        stocks = FlyerRepository.getInstance().findAllStocks("", districtId);
        ranking = DistributionRepository.getInstance().fetchRankingData("", districtId, rawRoster);
      } catch (eAgg) {}
      const aggregatedRoster = rawRoster.map(r => {
        const staffStocks = stocks.filter(st => st.staffId === r.id);
        const stockTotal = staffStocks.reduce((acc, st) => acc + (Number(st.count) || 0), 0);
        const staffRank = ranking.find(rk => rk.staffId === r.id);
        const deliveredTotal = staffRank ? Number(staffRank.count || 0) : 0;
        return {
          id: r.id,
          name: r.name,
          registeredAt: r.registeredAt,
          stockTotal: stockTotal,
          deliveredTotal: deliveredTotal
        };
      });
      return { success: true, roster: aggregatedRoster };
    }
    case 'resetDeviceManagement':
      return {
        success: false,
        code: "FORBIDDEN",
        message: "resetDeviceManagement is disabled on Web App endpoint."
      };
    case 'getAreaDetails':
      return AreaService.getInstance().getAreaDetails(postData.name || (e && e.parameter ? e.parameter.name : ""), districtId);
    case 'submitDistribution':
      return DistributionService.getInstance().submitDistribution(postData);
    case 'updateRecordWithGPSPhoto':
      return GPSService.getInstance().updateRecordWithGPSPhoto(postData, districtId);
    case 'registerStaff':
      let rLastName = postData.lastName || postData.displayName || (e && e.parameter ? e.parameter.lastName : "");
      let rFirstName = postData.firstName || (e && e.parameter ? e.parameter.firstName : "LINE");
      let rLineUserId = (postData && postData.user && postData.user.lineUserId) ? postData.user.lineUserId : "";
      if (!rLastName && e && e.parameter && e.parameter.json) {
        try {
          const pj = typeof e.parameter.json === 'string' ? JSON.parse(e.parameter.json) : e.parameter.json;
          if (pj.lastName) rLastName = pj.lastName;
          if (pj.displayName && !rLastName) rLastName = pj.displayName;
          if (pj.firstName) rFirstName = pj.firstName;
        } catch (errPj) {}
      }
      return StaffService.getInstance().registerStaff(rLastName, rFirstName, rLineUserId, districtId);
    case 'requestFlyerTransfer':
      return TransferService.getInstance().requestFlyerTransfer(postData, districtId);
    case 'resolveTransferRequest':
      return TransferService.getInstance().resolveTransferRequest(postData, districtId);
    case 'getFlyerStock': {
      const stockPayload = FlyerService.getInstance().getFlyerStock(reqLineUserId, districtId);
      return { success: true, myStock: stockPayload.myStock, stocks: stockPayload.stocks };
    }
    case 'getTransferRequests':
      return { success: true, requests: TransferService.getInstance().getTransferRequests(reqLineUserId, districtId) };
    case 'updateFlyerStock':
      return FlyerService.getInstance().updateFlyerStock(
        postData.location,
        parseInt(postData.count, 10) || 0,
        postData.staffName,
        postData.staffId,
        postData.resolvedLineUserId || reqLineUserId,
        districtId
      );
    case 'getGlobalPinStatus':
      return PinStatusService.getInstance().getStatus(districtId);
    case 'getBulletinPosts':
      return typeof BulletinService !== 'undefined' && BulletinService.getInstance
        ? BulletinService.getInstance().getPosts(reqLineUserId, districtId)
        : { success: false, message: 'BulletinService not available' };
    case 'createBulletinPost':
      return typeof BulletinService !== 'undefined' && BulletinService.getInstance
        ? BulletinService.getInstance().createPost(postData, districtId)
        : { success: false, message: 'BulletinService not available' };
    case 'sendBulletinContact':
      return typeof BulletinService !== 'undefined' && BulletinService.getInstance
        ? BulletinService.getInstance().sendContact(postData, districtId)
        : { success: false, message: 'BulletinService not available' };
    case 'setPinInProgress':
      return PinStatusService.getInstance().setInProgress(postData, districtId);
    case 'provisionDistrict':
      const pToken = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)));
      const pCheck = verifyProvisioningToken(pToken);
      if (!pCheck.success) return pCheck;
      if (postData && postData.options) {
        if (postData.options.spreadsheet) delete postData.options.spreadsheet;
        postData.options.provisioningToken = pToken;
      }
      const pDistId = String(districtId || (postData && (postData.districtId || (postData.options && postData.options.districtId))) || "").trim().toUpperCase();
      const pSsId = String((postData && (postData.targetSpreadsheetId || postData.spreadsheetId || (postData.options && (postData.options.targetSpreadsheetId || postData.options.spreadsheetId)))) || "").trim();
      if (pSsId && postData && postData.options) postData.options.targetSpreadsheetId = pSsId;
      return typeof DistrictProvisioner !== 'undefined' && DistrictProvisioner.getInstance
        ? DistrictProvisioner.getInstance().provisionNewDistrict(postData && postData.addresses, postData && postData.options, pDistId)
        : { success: false, message: 'DistrictProvisioner not available' };
    case 'syncSystemInfo':
      const sToken = (postData && (postData.provisioningToken || (postData.options && postData.options.provisioningToken)));
      const sCheck = verifyProvisioningToken(sToken);
      if (!sCheck.success) return sCheck;
      if (postData && postData.options) {
        if (postData.options.spreadsheet) delete postData.options.spreadsheet;
        postData.options.provisioningToken = sToken;
      }
      const sDistId = String(districtId || (postData && (postData.districtId || (postData.options && postData.options.districtId))) || "").trim().toUpperCase();
      const sSsId = String((postData && (postData.targetSpreadsheetId || postData.spreadsheetId || (postData.options && (postData.options.targetSpreadsheetId || postData.options.spreadsheetId)))) || "").trim();
      if (sSsId && postData && postData.options) postData.options.targetSpreadsheetId = sSsId;
      return typeof SystemInfoService !== 'undefined' && SystemInfoService.getInstance
        ? SystemInfoService.getInstance().syncSystemInfo(postData && postData.options, sDistId)
        : { success: false, message: 'SystemInfoService not available' };
    case 'switchDistrictSpreadsheet':
      return handleSwitchDistrictSpreadsheet(postData, e && e.parameter);
    case 'repairDistrictDriveBinding':
      return handleRepairDistrictDriveBinding(postData, e && e.parameter);
    case 'migrateDistrictPhotos':
      return handleMigrateDistrictPhotos(postData, e && e.parameter);
    case 'verifyManagerPassword':
      const postPwd = (postData && postData.password) || (e && e.parameter ? e.parameter.password : "");
      return typeof SystemInfoService !== 'undefined' && SystemInfoService.getInstance
        ? SystemInfoService.getInstance().verifyManagerPassword(postPwd, districtId)
        : { success: false, message: 'SystemInfoService not available' };
    case 'logoutManager': {
      const dashToken = (postData && (postData.dashboardSessionToken || postData.managerSessionToken))
                     || (params && (params.dashboardSessionToken || params.managerSessionToken)) || "";
      const result = typeof revokeDashboardSession === 'function'
        ? revokeDashboardSession(dashToken)
        : { success: true, message: "Logged out." };
      return result;
    }
    default:
      return { success: false, message: 'Invalid POST action' };
  }
}
