/**
 * Business Layer - Flyer Repository Module
 * 
 * Domain: Flyer Domain
 * Layer: Business Layer
 * Responsibility: 「保有チラシ枚数」Spreadsheet への読込・書き込みカプセル化
 */

if (typeof sanitizeFormula === 'undefined') {
  sanitizeFormula = function(val) {
    if (typeof val !== 'string') return val;
    if (/^[=\+\-@\t\r]/.test(val)) {
      return "'" + val;
    }
    return val;
  };
}

if (typeof FlyerRepository === 'undefined') {
  FlyerRepository = class FlyerRepository {
    constructor() {
      this.spreadsheetAdapter = (typeof SpreadsheetAdapter !== 'undefined') ? new SpreadsheetAdapter() : null;
    }

    static getInstance() {
      if (!FlyerRepository.instance) {
        FlyerRepository.instance = new FlyerRepository();
      }
      return FlyerRepository.instance;
    }

    getStorageSheet(districtId = "") {
      if (typeof MonthlySheetResolver !== 'undefined' && MonthlySheetResolver.getInstance) {
        return MonthlySheetResolver.getInstance().getCurrentSheet("flyer", districtId);
      }
      return null;
    }

    findAllStocks(requestLineUserId = "", districtId = "") {
      const s = this.getStorageSheet(districtId);
      if (!s) return [];

      const lastRow = s.getLastRow();
      if (lastRow < 2) return [];

      const numCols = Math.max(s.getLastColumn(), 7);
      const values = s.getRange(2, 1, lastRow - 1, numCols).getValues();
      const cleanReqLineId = String(requestLineUserId || "").trim();

      return values.map(r => {
        const rowLineId = String(r[6] || "").trim();
        const isMe = !!(cleanReqLineId && rowLineId === cleanReqLineId);
        return {
          id: r[0],
          staffId: r[1],
          staffName: r[2],
          location: r[3],
          count: parseFloat(r[4]) || 0,
          updatedAt: (r[5] && typeof r[5].getMonth === 'function') ? Utilities.formatDate(r[5], "JST", "MM/dd HH:mm") : (r[5] ? String(r[5]).trim() : ""),
          isMe: isMe
        };
      });
    }

    findStockPayload(requestLineUserId = "", districtId = "") {
      const stocks = this.findAllStocks(requestLineUserId, districtId);
      let myStock = null;
      for (let i = 0; i < stocks.length; i++) {
        if (stocks[i].isMe) {
          myStock = {
            count: stocks[i].count,
            location: stocks[i].location,
            updatedAt: stocks[i].updatedAt
          };
          break;
        }
      }
      return {
        myStock: myStock,
        stocks: stocks
      };
    }

    updateStock(location, count, staffName, staffId, lineUserId = "", districtId = "") {
      const cleanStaffId = String(staffId || "").trim();
      const cleanStaffName = String(staffName || "").trim();
      const cleanLineUserId = String(lineUserId || "").trim();
      if (!cleanStaffId || !cleanStaffName) {
        return { success: false, code: "INVALID_ARGUMENT", message: "Staff info required" };
      }
      
      const lock = LockService.getScriptLock();
      try {
        lock.waitLock(10000);
      } catch (e) {
        throw new Error("Lock timeout");
      }

      try {
        const s = this.getStorageSheet(districtId);
        if (!s) return { success: false, message: "Storage sheet unavailable" };

        const lastRow = s.getLastRow();
        const now = new Date();
        const updatedAt = Utilities.formatDate(now, "JST", "MM/dd HH:mm");

        const numCols = Math.max(s.getLastColumn(), 7);
        let values = [];
        if (lastRow >= 2) {
          values = s.getRange(2, 1, lastRow - 1, numCols).getValues();
        }

        let targetRow = 0;
        // 所有者の判定は lineUserId を唯一の判定キーとする（staffId では照合しない）
        if (cleanLineUserId) {
          for (let i = 0; i < values.length; i++) {
            const rowLineId = String(values[i][6] || "").trim();
            if (rowLineId === cleanLineUserId) {
              targetRow = i + 2;
              break;
            }
          }
        }

        const safeStaffName = sanitizeFormula(cleanStaffName);
        const safeLocation = sanitizeFormula(location);
        if (targetRow > 0) {
          // updateStock() は現在保有しているチラシ枚数および保管場所を最新の入力値で保存する。
          const finalCount = count;
          s.getRange(targetRow, 3, 1, 5).setValues([[safeStaffName, safeLocation, finalCount, updatedAt, cleanLineUserId]]);
        } else {
          const newRow = lastRow + 1;
          const newId = "ST" + String(newRow - 1).padStart(3, '0');
          s.getRange(newRow, 1, 1, 7).setValues([[newId, cleanStaffId, safeStaffName, safeLocation, count, updatedAt, cleanLineUserId]]);
        }
        return { success: true };
      } finally {
        lock.releaseLock();
      }
    }
  };
  FlyerRepository.instance = null;
}
