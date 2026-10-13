/**
 * POSTING MAP
 * Phase 31: District Deployment Foundation Core
 */

/**
 * Verification Result Model
 */
class VerificationResult {
  constructor(name, status, message) {
    this.name = name;
    this.status = status; // 'PASS' | 'WARNING' | 'FAILED' | 'SKIPPED'
    this.message = message || '';
    this.timestamp = Date.now();
  }
}

/**
 * Base Rule class
 */
class VerificationRule {
  constructor(name) {
    this.name = name;
  }
  execute() {
    throw new Error("Method execute() must be implemented");
  }
}

/**
 * Rule to verify Spreadsheet connection and basic read access
 */
class SpreadsheetRule extends VerificationRule {
  constructor() {
    super("Spreadsheet Access");
  }
  execute() {
    try {
      const ss = getSS();
      const name = ss.getName();
      const sheets = ss.getSheets();
      if (sheets.length === 0) {
        return new VerificationResult(this.name, "FAILED", "Spreadsheet resolved but contains no sheets.");
      }
      return new VerificationResult(this.name, "PASS", `Connected successfully to spreadsheet: "${name}"`);
    } catch (e) {
      return new VerificationResult(this.name, "FAILED", `Spreadsheet check failed: ${e.toString()}`);
    }
  }
}

/**
 * Rule to verify Google Drive folder access for media storage
 */
class DriveRule extends VerificationRule {
  constructor() {
    super("Google Drive Folder");
  }
  execute() {
    try {
      const folderId = getStorageFolderId();
      if (!folderId) {
        return new VerificationResult(this.name, "WARNING", "STORAGE_PARENT_ID is not configured in properties. Media upload might fail.");
      }
      const folder = DriveApp.getFolderById(folderId);
      const folderName = folder.getName();
      return new VerificationResult(this.name, "PASS", `Drive folder "${folderName}" (${folderId}) resolved successfully.`);
    } catch (e) {
      return new VerificationResult(this.name, "FAILED", `Drive folder check failed: ${e.toString()}`);
    }
  }
}

/**
class DistrictDeploymentFoundation {
  static runDiagnostics() {
    const rules = [
      new SpreadsheetRule(),
      new DriveRule()
    ];
    
    const results = [];
    let ready = true;
    
    for (const rule of rules) {
      const result = rule.execute();
      results.push(result);
      if (result.status === "FAILED") {
        ready = false;
      }
    }
    
    const status = ready ? "READY" : "NOT READY";
    
    if (ready) {
      try {
        this.recordDeploymentHistory(status);
      } catch (err) {
        results.push(new VerificationResult("Deployment History", "WARNING", `Failed to record deployment history: ${err.toString()}`));
      }
    }
    
    return {
      status: status,
      timestamp: Date.now(),
      results: results
    };
  }

  static recordDeploymentHistory(status) {
    const ss = getSS();
    let historySheet = ss.getSheetByName("DeploymentHistory");
    if (!historySheet) {
      historySheet = ss.insertSheet("DeploymentHistory");
      historySheet.appendRow(["Date", "Status", "Version", "Operator", "Details"]);
      historySheet.getRange("A1:E1").setFontWeight("bold").setBackground("#e5e7eb");
      historySheet.setFrozenRows(1);
    }
    
    const operator = Session.getActiveUser().getEmail() || "system";
    const version = CONFIG.get("VERSION") || "unknown";
    historySheet.appendRow([
      Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm:ss"),
      status,
      version,
      operator,
      "Automated verification completed successfully."
    ]);
  }
}

/**
 * SEC-002: Check if the action requires admin privileges
 */
function isProtectedDeploymentAction(params) {
  return (
    params.cleanupResources === "true" || params.cleanupResources === true ||
    params.bootstrapProperties === "true" || params.bootstrapProperties === true ||
    params.executeFullBatch === "true" || params.executeFullBatch === true ||
    params.rebuildCache === "true" || params.rebuildCache === true
  );
}

/**
 * SEC-002: Fetch admin LINE user IDs from the admin sheet
 */
function getDeploymentAdmins() {
  try {
    const ss = typeof getSS === 'function' ? getSS() : SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = (typeof CONFIG !== 'undefined' && CONFIG.get) ? CONFIG.get("SHEET_ADMIN") : "管理者ID";
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return [];
    
    const data = sheet.getDataRange().getValues();
    const admins = [];
    for (let i = 0; i < data.length; i++) {
      const id = String(data[i][0] || "").trim();
      if (id && id.startsWith("U") && id.length > 20) {
        admins.push(id);
      }
    }
    return admins;
  } catch (e) {
    return [];
  }
}

/**
 * SEC-002: Verify if the user is an admin
 */
function verifyDeploymentAdminGate(params) {
  const userId = params.liffUserId;
  
  if (!userId) {
    throw new Error("ADMIN_AUTH_REQUIRED");
  }
  
  const admins = getDeploymentAdmins();
  if (!admins.includes(userId)) {
    throw new Error("ADMIN_PERMISSION_DENIED");
  }
  
  return true;
}

/**
 * Global function entry point
 */
function verifyDistrictDeployment(e) {
  const params = e && e.parameter ? e.parameter : (e || {});

  // Structure Guard Validation (Required + Forbidden sheets checks)
  if (params.structureGuard === "true" || params.structureGuard === true) {
    try {
      const ssId = params.spreadsheetId;
      const ss = ssId ? SpreadsheetApp.openById(ssId) : getSS();
      const sheetNames = ss.getSheets().map(s => s.getName());
      
      const REQUIRED_SHEETS = ["名簿", "保有チラシ枚数", "原本"];
      const FORBIDDEN_SHEETS = ["temp", "test", "debug", "unknown_generated"];
      
      const missing = REQUIRED_SHEETS.filter(name => !sheetNames.includes(name));
      const violated = FORBIDDEN_SHEETS.filter(name => sheetNames.includes(name));
      
      if (missing.length > 0) {
        return {
          success: false,
          error: "STRUCTURE_MISMATCH",
          message: "Required sheets missing from spreadsheet: " + missing.join(", "),
          status: "DENIED"
        };
      }
      
      if (violated.length > 0) {
        return {
          success: false,
          error: "STRUCTURE_MISMATCH",
          message: "Forbidden sheets found in spreadsheet: " + violated.join(", "),
          status: "DENIED"
        };
      }
      
      return {
        success: true,
        message: "Spreadsheet structure guard validation passed."
      };
    } catch (err) {
      return {
        success: false,
        error: "STRUCTURE_GUARD_ERROR",
        message: err.toString(),
        status: "DENIED"
      };
    }
  }
  
  // SEC-002: Admin Authentication Gate for Protected Actions
  if (isProtectedDeploymentAction(params)) {
    try {
      verifyDeploymentAdminGate(params);
    } catch (err) {
      return {
        success: false,
        error: err.message,
        message: "Access Denied: " + err.message,
        status: "DENIED"
      };
    }
  }

  // Cleanup/Rollback Action (deletes spreadsheet and folder under native user credentials)
  if (params.cleanupResources === "true" || params.cleanupResources === true) {
    try {
      const details = [];
      if (params.spreadsheetId) {
        try {
          DriveApp.getFileById(params.spreadsheetId).setTrashed(true);
          details.push(`Spreadsheet trashed: ${params.spreadsheetId}`);
        } catch (e) {
          details.push(`Failed to trash spreadsheet: ${e.toString()}`);
        }
      }
      if (params.storageFolderId) {
        try {
          DriveApp.getFolderById(params.storageFolderId).setTrashed(true);
          details.push(`Folder trashed: ${params.storageFolderId}`);
        } catch (e) {
          details.push(`Failed to trash folder: ${e.toString()}`);
        }
      }
      return {
        success: true,
        message: "Resources cleanup completed.",
        details: details
      };
    } catch (err) {
      return {
        success: false,
        message: "Failed to cleanup resources: " + err.toString()
      };
    }
  }
  
  // Create Backup Snapshot Action (PM-002 Rollback support)
  if (params.backupSpreadsheet === "true" || params.backupSpreadsheet === true) {
    try {
      const targetSs = getSS();
      const file = DriveApp.getFileById(targetSs.getId());
      const backupFolderId = "18SZgoZBw-lWMMvuWwlnah5tFM2RYgsnY"; // 05_BACKUP
      let backupFolder;
      try {
        backupFolder = DriveApp.getFolderById(backupFolderId);
      } catch (fErr) {
        backupFolder = DriveApp.getRootFolder();
      }
      const timestamp = Utilities.formatDate(new Date(), "JST", "yyyyMMdd_HHmmss");
      const backupName = `BACKUP_${targetSs.getName()}_${timestamp}`;
      const copyFile = file.makeCopy(backupName, backupFolder);
      return {
        success: true,
        backupName: backupName,
        backupFileId: copyFile.getId(),
        message: `Successfully created spreadsheet backup copy: ${backupName}`
      };
    } catch (err) {
      return {
        success: false,
        message: "Failed backupSpreadsheet: " + err.toString()
      };
    }
  }

  return DistrictDeploymentFoundation.runDiagnostics();
}
