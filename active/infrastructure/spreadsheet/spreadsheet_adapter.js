/**
 * Infrastructure Layer - Spreadsheet Adapter Module
 * 
 * Section: SEC-004 getSS(), SEC-034 Batch Reader/Writer, SEC-035 SpreadsheetRepository
 * Owner Layer: Infrastructure Layer
 * Responsibility: SpreadsheetApp へのアクセス、シート読み書き、データリポジトリの抽象化とカプセル化
 */

/**
 * SpreadsheetResolver - Centralized Spreadsheet Connection & Resolution SSOT
 *
 * 優先順位:
 * 1. TARGET_SPREADSHEET_ID (Script Properties) - 新標準
 * 2. SPREADSHEET_ID (Script Properties) - 後方互換
 * 3. SpreadsheetApp.getActiveSpreadsheet() - 既存バウンド環境互換
 */
class SpreadsheetResolver {
  constructor() {
    this.spreadsheetCacheByDistrict = {};
  }

  static getInstance() {
    if (!SpreadsheetResolver.instance) {
      SpreadsheetResolver.instance = new SpreadsheetResolver();
    }
    return SpreadsheetResolver.instance;
  }

  getSpreadsheetId(districtId) {
    const cleanDistrictId = String(districtId || "").trim().toUpperCase();
    try {
      const props = PropertiesService.getScriptProperties();
      const registryRaw = props.getProperty("DISTRICT_REGISTRY");

      if (registryRaw !== null) {
        if (typeof registryRaw === "string" && registryRaw.trim() === "") {
          throw new Error("[SpreadsheetResolver] DISTRICT_REGISTRY is configured but empty (corrupted).");
        }

        let registry = {};
        try {
          registry = JSON.parse(registryRaw);
        } catch (errP) {
          console.error("[SpreadsheetResolver] Failed to parse DISTRICT_REGISTRY JSON:", errP);
          throw new Error("[SpreadsheetResolver] DISTRICT_REGISTRY is corrupted.");
        }

        if (!cleanDistrictId) {
          throw new Error("[SpreadsheetResolver] districtId is required for multi-district routing. No fallback allowed.");
        }

        const normalizedKey = Object.keys(registry).find(k => k.trim().toUpperCase() === cleanDistrictId);
        if (normalizedKey && registry[normalizedKey]) {
          const entry = registry[normalizedKey];
          if (typeof entry === "object" && entry !== null) {
            if (entry.enabled === false) {
              throw new Error(`[SpreadsheetResolver] District "${cleanDistrictId}" not found in DISTRICT_REGISTRY.`);
            }
            if (entry.spreadsheetId) {
              return String(entry.spreadsheetId).trim();
            }
          } else {
            return String(entry).trim();
          }
        }

        throw new Error(`[SpreadsheetResolver] District "${cleanDistrictId}" not found in DISTRICT_REGISTRY.`);
      }

      // レジストリ未設定 (null) の完全単一旧環境に対する後方互換のみ
      const legacyId = props.getProperty("TARGET_SPREADSHEET_ID") || props.getProperty("SPREADSHEET_ID") || "";
      if (legacyId) {
        return legacyId;
      }
      return "";
    } catch (e) {
      throw e;
    }
  }

  getEnabledDistricts() {
    try {
      const props = PropertiesService.getScriptProperties();
      const registryRaw = props.getProperty("DISTRICT_REGISTRY");

      if (registryRaw === null) {
        return null; // Legacy 未設定
      }

      if (typeof registryRaw === "string" && registryRaw.trim() === "") {
        throw new Error("[SpreadsheetResolver] DISTRICT_REGISTRY is configured but empty (corrupted).");
      }

      let registry = {};
      try {
        registry = JSON.parse(registryRaw);
      } catch (errP) {
        console.error("[SpreadsheetResolver] Failed to parse DISTRICT_REGISTRY JSON:", errP);
        throw new Error("[SpreadsheetResolver] DISTRICT_REGISTRY is corrupted.");
      }

      const enabledDistricts = [];
      Object.keys(registry).forEach(key => {
        const cleanKey = String(key || "").trim().toUpperCase();
        const entry = registry[key];
        if (typeof entry === "object" && entry !== null) {
          if (entry.enabled !== false) {
            enabledDistricts.push(cleanKey);
          }
        } else if (entry) {
          enabledDistricts.push(cleanKey);
        }
      });

      return enabledDistricts;
    } catch (e) {
      throw e;
    }
  }

  verifyIntegrityGuard(ss, districtId) {
    if (!ss || !districtId) return null;
    const cleanDistrictId = String(districtId).trim().toUpperCase();
    const sheet = ss.getSheetByName("SYSTEM_INFO");
    if (!sheet) {
      throw new Error(`[SpreadsheetResolver] SYSTEM_INFO sheet is missing in spreadsheet "${ss.getName()}".`);
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      throw new Error(`[SpreadsheetResolver] SYSTEM_INFO sheet has no data rows in spreadsheet "${ss.getName()}".`);
    }

    const data = sheet.getRange(1, 1, lastRow, 2).getValues();
    let sheetDistrictCode = "";
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0] || "").trim() === "地区コード") {
        sheetDistrictCode = String(data[i][1] || "").trim().toUpperCase();
        break;
      }
    }

    if (!sheetDistrictCode) {
      throw new Error(`[SpreadsheetResolver] "地区コード" is missing in SYSTEM_INFO for spreadsheet "${ss.getName()}".`);
    }

    if (sheetDistrictCode !== cleanDistrictId) {
      console.error(`[SpreadsheetResolver] DISTRICT_MISMATCH: requested "${cleanDistrictId}" !== sheet code "${sheetDistrictCode}"`);
      throw new Error(`[SpreadsheetResolver] DISTRICT_MISMATCH: Requested districtId "${cleanDistrictId}" does not match spreadsheet SYSTEM_INFO district code "${sheetDistrictCode}".`);
    }

    return data;
  }

  getSpreadsheet(districtId, context = null) {
    const cleanDistrictId = String(districtId || "").trim().toUpperCase();
    const cacheKey = cleanDistrictId || '__DEFAULT__';
    if (this.spreadsheetCacheByDistrict[cacheKey]) {
      // NOTE: Resolver cache hit時は context.systemInfoData を設定しない（呼び出し側は既存fallbackを使用）
      return this.spreadsheetCacheByDistrict[cacheKey];
    }

    const ssId = this.getSpreadsheetId(cleanDistrictId);
    if (ssId) {
      try {
        const ss = SpreadsheetApp.openById(ssId);
        if (cleanDistrictId) {
          const systemInfoData = this.verifyIntegrityGuard(ss, cleanDistrictId);
          if (context && typeof context === 'object') {
            context.systemInfoData = systemInfoData;
          }
        }
        this.spreadsheetCacheByDistrict[cacheKey] = ss;
        return ss;
      } catch (err) {
        console.error(`[SpreadsheetResolver] Failed to open spreadsheet by ID "${ssId}":`, err);
        throw err;
      }
    }

    if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.getActiveSpreadsheet === 'function') {
      try {
        const activeSs = SpreadsheetApp.getActiveSpreadsheet();
        if (activeSs && activeSs.getId()) {
          return activeSs;
        }
      } catch (e) {}
    }

    throw new Error('[SpreadsheetResolver] Target spreadsheet cannot be resolved.');
  }

  clearCache() {
    this.spreadsheetCacheByDistrict = {};
  }
}

SpreadsheetResolver.instance = null;

function getSS(districtId, context = null) {
  return SpreadsheetResolver.getInstance().getSpreadsheet(districtId, context);
}

class SpreadsheetBatchReader {
  constructor() {
    this.configProvider = null;
    this.cachedSpreadsheet = null;
  }
  getSpreadsheet() {
    if (this.cachedSpreadsheet) return this.cachedSpreadsheet;
    if (this.configProvider && typeof this.configProvider.getSpreadsheetId === 'function') {
      const ssId = this.configProvider.getSpreadsheetId();
      if (ssId) {
        this.cachedSpreadsheet = SpreadsheetApp.openById(ssId);
        return this.cachedSpreadsheet;
      }
    }
    this.cachedSpreadsheet = SpreadsheetResolver.getInstance().getSpreadsheet();
    return this.cachedSpreadsheet;
  }
  readAll(sheetName) {
    const ss = this.getSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return [];
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    if (lastRow === 0 || lastColumn === 0) return [];
    return sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  }
  readRange(sheetName, startRow, startCol, numRows, numCols) {
    const ss = this.getSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return [];
    return sheet.getRange(startRow, startCol, numRows, numCols).getValues();
  }
}

class SpreadsheetBatchWriter {
  constructor() {
    this.configProvider = null;
    this.cachedSpreadsheet = null;
  }
  getSpreadsheet() {
    if (this.cachedSpreadsheet) return this.cachedSpreadsheet;
    if (this.configProvider && typeof this.configProvider.getSpreadsheetId === 'function') {
      const ssId = this.configProvider.getSpreadsheetId();
      if (ssId) {
        this.cachedSpreadsheet = SpreadsheetApp.openById(ssId);
        return this.cachedSpreadsheet;
      }
    }
    this.cachedSpreadsheet = SpreadsheetResolver.getInstance().getSpreadsheet();
    return this.cachedSpreadsheet;
  }
  appendRows(sheetName, rows) {
    if (rows.length === 0) return;
    const ss = this.getSpreadsheet();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  updateRange(sheetName, startRow, startCol, rows) {
    if (rows.length === 0) return;
    const ss = this.getSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error("Sheet not found: " + sheetName);
    sheet.getRange(startRow, startCol, rows.length, rows[0].length).setValues(rows);
  }
}

class SpreadsheetRepository {
  constructor() {
    this.reader = new SpreadsheetBatchReader();
    this.writer = new SpreadsheetBatchWriter();
  }
  getAreas(tenantId, branchId) {
    const rawRows = this.reader.readAll('Areas');
    if (rawRows.length <= 1) return [];
    const records = [];
    const headers = rawRows[0];
    const areaIdIdx = headers.indexOf('Area ID');
    const nameIdx = headers.indexOf('Name');
    const cityIdx = headers.indexOf('City');
    const statusIdx = headers.indexOf('Status');
    const doneIdx = headers.indexOf('Done Count');
    const totalIdx = headers.indexOf('Total Count');
    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i];
      records.push({
        areaId: areaIdIdx !== -1 ? String(row[areaIdIdx]) : '',
        name: nameIdx !== -1 ? String(row[nameIdx]) : '',
        cityName: cityIdx !== -1 ? String(row[cityIdx]) : '',
        status: statusIdx !== -1 ? String(row[statusIdx]) : 'NOT_STARTED',
        doneCount: doneIdx !== -1 ? Number(row[doneIdx]) : 0,
        totalCount: totalIdx !== -1 ? Number(row[totalIdx]) : 0
      });
    }
    return records;
  }
  getStaffs() {
    const rawRows = this.reader.readAll('Staffs');
    if (rawRows.length <= 1) return [];
    const headers = rawRows[0];
    const lastIdx = headers.indexOf('Last Name');
    const firstIdx = headers.indexOf('First Name');
    const statusIdx = headers.indexOf('Status');
    const records = [];
    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i];
      records.push({
        lastName: lastIdx !== -1 ? String(row[lastIdx]) : '',
        firstName: firstIdx !== -1 ? String(row[firstIdx]) : '',
        status: statusIdx !== -1 ? String(row[statusIdx]) : 'ACTIVE'
      });
    }
    return records;
  }
  updateAreaStatus(areaId, status) {
    const rawRows = this.reader.readAll('Areas');
    if (rawRows.length <= 1) return;
    const headers = rawRows[0];
    const areaIdIdx = headers.indexOf('Area ID');
    const statusIdx = headers.indexOf('Status');
    if (areaIdIdx === -1 || statusIdx === -1) return;
    for (let i = 1; i < rawRows.length; i++) {
      const row = rawRows[i];
      if (String(row[areaIdIdx]) === areaId) {
        this.writer.updateRange('Areas', i + 1, statusIdx + 1, [[status]]);
        break;
      }
    }
  }
}
