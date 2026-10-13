/**
 * Auto-generated AssetRegistry
 * Static workspace locator for POSTING MAP Assets
 */
function getAssetRegistry() {
  return {
  "updatedAt": 1784371396312,
  "schemaVersion": 1,
  "templates": {
    "spreadsheetId": "",
    "scriptId": "",
    "webAppUrl": "",
    "version": "v1",
    "projectName": "地区非依存テンプレート",
    "lastUpdated": "",
    "driveFileId": ""
  },
  "masters": {
    "global": {
      "electionMaster": {
        "fileId": "",
        "name": "address_master.csv",
        "location": "01_MASTER/Reference"
      }
    },
    "districts": {}
  },
  "dashboard": {
    "assets": []
  },
  "storage": {
    "rootFolderId": ""
  }
};
}

function getTemplateSpreadsheetId() {
  return "";
}

function getTemplateScriptId() {
  return "";
}

function getTemplateWebAppUrl() {
  return "";
}

function getProductionLiffUrl(districtId) {
  // 環境変数(PropertiesService)から取得する仕様に変更
  try {
    const props = PropertiesService.getScriptProperties();
    const liffUrl = props.getProperty("PRODUCTION_LIFF_URL");
    if (liffUrl) return liffUrl;
  } catch(e) {}
  return "";
}

function getPostalMaster() {
  return getAssetRegistry().masters.global.postalMaster || null;
}

function getAddressMaster() {
  return getAssetRegistry().masters.global.addressMaster || null;
}

function getElectionMaster() {
  return getAssetRegistry().masters.global.electionMaster || null;
}

function getDistrictAssets(districtId) {
  return getAssetRegistry().masters.districts[districtId] || null;
}
