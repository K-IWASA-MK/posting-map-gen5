/**
 * Infrastructure Layer - Drive Adapter Module
 * 
 * Section: SEC-004 Drive Utilities
 * Owner Layer: Infrastructure Layer
 * Responsibility: DriveApp へのアクセス、ストレージフォルダ ID 取得、書き込み認証テストのカプセル化
 */

function getStorageFolderId(districtId = "") {
  const props = PropertiesService.getScriptProperties();
  const id = props ? props.getProperty("STORAGE_PARENT_ID") : null;
  return (id && String(id).trim()) ? String(id).trim() : (typeof CONFIG !== 'undefined' ? CONFIG.STORAGE_PARENT_ID : null);
}

function authorizeAndTestDriveWrite() {
  try {
    const folderId = getStorageFolderId();
    const folder = DriveApp.getFolderById(folderId);
    const blob = Utilities.newBlob("DRIVE_AUTH_TEST", "text/plain", "_auth_test.txt");
    const file = folder.createFile(blob);
    file.setTrashed(true);
    Logger.log("✅ Drive write: SUCCESS. Folder: " + folder.getName());
  } catch (e) {
    Logger.log("❌ Drive write FAILED: " + e.toString());
  }
}
