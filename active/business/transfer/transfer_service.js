(function(global) {
  if (typeof sanitizeFormula === 'undefined') {
    sanitizeFormula = function(val) {
      if (typeof val !== 'string') return val;
      if (/^[=\+\-@\t\r]/.test(val)) {
        return "'" + val;
      }
      return val;
    };
  }

  class TransferService {
    constructor() {}

    static getInstance() {
      if (!TransferService.instance) {
        TransferService.instance = new TransferService();
      }
      return TransferService.instance;
    }

    getSS(districtId = "") {
      if (typeof getSS === 'function') {
        return getSS(districtId);
      }
      if (typeof SpreadsheetAdapter !== 'undefined') {
        return SpreadsheetAdapter.getInstance().getSpreadsheet(districtId);
      }
      throw new Error("Active spreadsheet unavailable");
    }

    getMonthlySheet(type, districtId = "") {
      if (typeof MonthlySheetResolver !== 'undefined' && MonthlySheetResolver.getInstance) {
        return MonthlySheetResolver.getInstance().getCurrentSheet(type, districtId);
      }
      return null;
    }

    /**
     * 受渡要請履歴シートのヘッダー検証・補完 (14列)
     * Sheet-Local Scan-before-Mutate / Collision Fail-Closed
     *
     * @param {Object} sheet - 受渡要請履歴シート
     * @return {Object} 結果 { success: boolean, updatedCount: number }
     */
    ensureHeaders(sheet) {
      if (!sheet) {
        throw new Error("Sheet is required for ensureHeaders");
      }

      const expectedHeaders = [
        "日時", "要請者", "要請者ID", "保管者", "保管者ID", "連絡方法", "連絡先",
        "状態", "requestId", "LINE送信状態", "LINE HTTP status", "LINE送信日時",
        "requesterLineUserId", "holderLineUserId"
      ];

      const maxCols = typeof sheet.getMaxColumns === 'function' ? sheet.getMaxColumns() : 14;
      const lastCol = typeof sheet.getLastColumn === 'function' ? sheet.getLastColumn() : 0;
      const lastRow = typeof sheet.getLastRow === 'function' ? sheet.getLastRow() : 0;

      // Phase 1: Scan
      const plan = [];
      const collisions = [];

      // 既存ヘッダー行の取得（maxCols内のみ安全に取得、OUT_OF_GRIDはgetRange対象外）
      const scanCols = Math.min(lastCol, maxCols);
      let existingHeaderRow = [];
      if (lastRow >= 1 && scanCols >= 1) {
        const headerRange = sheet.getRange(1, 1, 1, scanCols);
        existingHeaderRow = (headerRange && typeof headerRange.getValues === 'function')
          ? headerRange.getValues()[0]
          : [];
      }

      for (let col = 1; col <= expectedHeaders.length; col++) {
        const expected = expectedHeaders[col - 1];
        if (lastRow === 0) {
          plan.push({ col, expected });
        } else if (col > maxCols) {
          // OUT_OF_GRID: getRangeは呼ばず計画のみ
          plan.push({ col, expected, outOfGrid: true });
        } else if (col <= lastCol) {
          const val = existingHeaderRow[col - 1];
          const isBlank = (val === undefined || val === null || String(val).trim() === "");
          if (isBlank) {
            plan.push({ col, expected });
          } else {
            const strVal = String(val).trim();
            if (strVal !== expected) {
              collisions.push({ col, expected, actual: val });
            }
          }
        } else {
          // col > lastCol && col <= maxCols
          plan.push({ col, expected });
        }
      }

      if (collisions.length > 0) {
        const details = collisions.map(c => `Col ${c.col}: expected "${c.expected}", found "${c.actual}"`).join('; ');
        const err = new Error(`[TransferService.ensureHeaders] HEADER_COLLISION: Sheet "${sheet.getName()}" has conflicting headers: ${details}`);
        err.code = "HEADER_COLLISION";
        err.collisions = collisions;
        throw err;
      }

      // Phase 2: Mutate
      if (plan.length === 0) {
        return { success: true, updatedCount: 0 };
      }

      if (maxCols < expectedHeaders.length && typeof sheet.insertColumnsAfter === 'function') {
        sheet.insertColumnsAfter(maxCols, expectedHeaders.length - maxCols);
      }

      plan.forEach(item => {
        const r = sheet.getRange(1, item.col);
        if (r) {
          if (typeof r.setValue === 'function') {
            r.setValue(item.expected);
          } else if (typeof r.setValues === 'function') {
            r.setValues([[item.expected]]);
          }
          if (typeof r.setBackground === 'function') r.setBackground("#1e293b");
          if (typeof r.setFontColor === 'function') r.setFontColor("#ffffff");
          if (typeof r.setFontWeight === 'function') r.setFontWeight("bold");
        }
      });

      return { success: true, updatedCount: plan.length };
    }

    requestFlyerTransfer(data, districtId = "") {
      const requestId = data && data.requestId ? String(data.requestId).trim() : '';
      const requestUserId = data && data.requestUserId ? String(data.requestUserId).trim() : '';
      const holderUserId = data && data.holderUserId ? String(data.holderUserId).trim() : '';
      const contactMethod = data && data.contactMethod ? String(data.contactMethod).trim() : 'LINE';
      const contactValue = data && data.contactValue ? String(data.contactValue).trim() : '';

      if (!requestUserId || !holderUserId || !contactValue) {
        return { success: false, message: "必須パラメータが不足しています。" };
      }

      if (!requestId) {
        Logger.log("[WARN] requestFlyerTransfer received without requestId. Legacy client fallback.");
      }

      const lock = LockService.getScriptLock();
      try {
        lock.waitLock(10000);
      } catch (e) {
        return { success: false, message: "システムが混雑しています。時間をおいて再度お試しください。" };
      }

      try {
        const cache = CacheService.getScriptCache();
        if (requestId) {
          const cached = cache.get("IDEMPOTENCY_LINE_" + requestId);
          if (cached === "SENT") {
            Logger.log("[IDEMPOTENCY] Cache hit SENT for requestId: " + requestId);
            return { success: true, status: "SENT", duplicate: true };
          }
        }

        const ss = this.getSS(districtId);

        const rosterSheet = this.getMonthlySheet('staff', districtId);

        let requestUserName = requestUserId;
        let holderName = holderUserId;
        let holderLineUserId = "";

        if (rosterSheet) {
          const lastRosterRow = rosterSheet.getLastRow();
          if (lastRosterRow >= 2) {
            const rosterValues = rosterSheet.getRange(2, 1, lastRosterRow - 1, 4).getValues();
            for (let i = 0; i < rosterValues.length; i++) {
              const rowId = String(rosterValues[i][0] || '').trim();
              const rowName = String(rosterValues[i][1] || '').trim();
              const rowLineId = String(rosterValues[i][2] || '').trim();

              if (rowId === requestUserId) {
                requestUserName = rowName || requestUserId;
              }
              if (rowId === holderUserId) {
                holderName = rowName || holderUserId;
                holderLineUserId = rowLineId;
              }
            }
          }
        }

        let s = this.getMonthlySheet('transfer', districtId);
        if (!s) {
          return {
            success: false,
            code: "SHEET_NOT_READY",
            message: "「受渡要請履歴」シートが準備されていません。"
          };
        }

        // Sheet-Local Scan-before-Mutate でヘッダーを安全に検証・補完
        this.ensureHeaders(s);

        let existingRow = 0;
        let existingStatus = "";
        const lastRow = s.getLastRow();
        if (requestId && lastRow >= 2) {
          const reqIdValues = s.getRange(2, 9, lastRow - 1, 2).getValues();
          for (let i = 0; i < reqIdValues.length; i++) {
            if (String(reqIdValues[i][0]).trim() === requestId) {
              existingRow = i + 2;
              existingStatus = String(reqIdValues[i][1] || '').trim();
              break;
            }
          }
        }

        if (existingRow > 0) {
          if (existingStatus === "SENT") {
            cache.put("IDEMPOTENCY_LINE_" + requestId, "SENT", 600);
            return { success: true, status: "SENT", duplicate: true };
          }
          if (existingStatus === "FAILED") {
            return { success: true, status: "FAILED", message: "以前の送信で回復不能なエラーが発生しました。" };
          }
          if (existingStatus === "UNKNOWN") {
            return { success: true, status: "UNKNOWN", message: "送信結果を確認できません。二重送信を防ぐためしばらくお待ちください。" };
          }
          if (existingStatus === "PROCESSING") {
            return { success: false, status: "PROCESSING", message: "現在処理中です。少々お待ちください。" };
          }
        }

        let targetRow = existingRow;
        const now = new Date();
        const requestTime = Utilities.formatDate(now, "JST", "yyyy/MM/dd HH:mm:ss");

        if (targetRow === 0) {
          const cleanReqLineId = String((data && (data.resolvedLineUserId || data.lineUserId || (data.user && data.user.lineUserId))) || "").trim();
          const cleanHolderLineId = String(holderLineUserId || "").trim();
          s.appendRow([
            requestTime,
            sanitizeFormula(requestUserName),
            requestUserId,
            sanitizeFormula(holderName),
            holderUserId,
            contactMethod,
            sanitizeFormula(contactValue),
            "要請中",
            requestId,
            "PROCESSING",
            "",
            "",
            cleanReqLineId,
            cleanHolderLineId
          ]);
          targetRow = s.getLastRow();
        } else {
          s.getRange(targetRow, 10).setValue("PROCESSING");
        }

        if (holderLineUserId) {
          const postingMapUrl = typeof getProductionLiffUrl === 'function' ? getProductionLiffUrl() : '';

          const messageText =
            "📦 チラシの受渡要請が届きました\n\n\n" +
            requestUserName + "（" + requestUserId + "）さんがあなたの保有している\n" +
            "チラシを希望しています。\n\n\n" +
            "【連絡先】\n" +
            contactMethod + "：" + contactValue + "\n\n\n" +
            "この連絡先へ直接ご連絡ください。\n\n\n" +
            "↓\n" +
            "POSTING MAPを開く\n" +
            postingMapUrl;

          const lineRes = this.sendLinePushMessage(holderLineUserId, messageText);
          const lineTime = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss");

          s.getRange(targetRow, 10, 1, 3).setValues([[
            lineRes.status,
            String(lineRes.httpStatus),
            lineTime
          ]]);

          if (lineRes.status === "SENT") {
            if (requestId) cache.put("IDEMPOTENCY_LINE_" + requestId, "SENT", 600);
            return { success: true, status: "SENT" };
          } else if (lineRes.status === "FAILED") {
            return {
              success: true,
              status: "FAILED",
              httpStatus: lineRes.httpStatus,
              message: lineRes.message || "LINE通知の送信に失敗しました。"
            };
          } else if (lineRes.status === "UNKNOWN") {
            return {
              success: true,
              status: "UNKNOWN",
              httpStatus: lineRes.httpStatus,
              message: lineRes.message || "送信結果を確認できません。二重送信を防ぐためしばらくお待ちください。"
            };
          } else {
            // RETRYABLE: 一時障害のため api.js に自動リトライを許可
            return {
              success: false,
              status: lineRes.status,
              httpStatus: lineRes.httpStatus,
              message: lineRes.message || "一時的なエラーが発生しました。"
            };
          }
        } else {
          const lineTime = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss");
          s.getRange(targetRow, 10, 1, 3).setValues([[
            "SKIPPED_NO_LINE_ID",
            "NONE",
            lineTime
          ]]);
          if (requestId) cache.put("IDEMPOTENCY_LINE_" + requestId, "SKIPPED_NO_LINE_ID", 600);
          return { success: true, status: "SKIPPED_NO_LINE_ID", message: "保管者のLINE未登録のため通知はスキップされました。" };
        }
      } catch(e) {
        return { success: false, message: e.toString() };
      } finally {
        lock.releaseLock();
      }
    }

    sendLinePushMessage(toUserId, messageText) {
      const props = PropertiesService.getScriptProperties();
      const token = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN_ADMIN") || props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
      if (!token) {
        Logger.log('LINE Push error: access token not found');
        return { success: false, status: "FAILED", httpStatus: "NO_TOKEN", message: "LINE channel access token missing" };
      }

      const url = "https://api.line.me/v2/bot/message/push";
      const payload = {
        to: toUserId,
        messages: [{
          type: "text",
          text: messageText
        }]
      };

      const options = {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      try {
        const response = UrlFetchApp.fetch(url, options);
        const code = response.getResponseCode();
        const body = response.getContentText();
        Logger.log('LINE Push → status:' + code + ' body:' + body);

        if (code === 200) {
          return { success: true, status: "SENT", httpStatus: code, message: "OK" };
        } else if (code >= 400 && code < 500 && code !== 429) {
          return { success: false, status: "FAILED", httpStatus: code, message: body };
        } else {
          return { success: false, status: "RETRYABLE", httpStatus: code, message: body };
        }
      } catch (err) {
        Logger.log('LINE Push exception: ' + err.toString());
        return { success: false, status: "UNKNOWN", httpStatus: "TIMEOUT", message: err.toString() };
      }
    }

    getTransferRequests(requestLineUserId = "", districtId = "") {
      const s = this.getMonthlySheet('transfer', districtId);
      if (!s) return [];
      const lastRow = s.getLastRow();
      if (lastRow < 2) return [];
      const numCols = Math.max(s.getLastColumn(), 14);
      const values = s.getRange(2, 1, lastRow - 1, numCols).getValues();
      const cleanReqLineId = String(requestLineUserId || "").trim();

      return values.map((r, i) => {
        const reqLineId = String(r[12] || "").trim();
        const holdLineId = String(r[13] || "").trim();
        const isMe = !!(cleanReqLineId && (reqLineId === cleanReqLineId || holdLineId === cleanReqLineId));
        return {
          rowNumber: i + 2,
          requestTime: (r[0] && typeof r[0].getMonth === 'function') ? Utilities.formatDate(r[0], "JST", "yyyy/MM/dd HH:mm:ss") : String(r[0] || ''),
          requesterName: r[1],
          requesterId: r[2],
          holderName: r[3],
          holderId: r[4],
          contactMethod: r[5],
          contactValue: r[6],
          status: r[7] || "要請中",
          isMe: isMe
        };
      });
    }

    resolveTransferRequest(data, districtId = "") {
      const rowNumber = parseInt(data.rowNumber);
      const status = data.status || "完了";
      if (!rowNumber || rowNumber < 2) return { success: false, message: "Invalid row number" };

      const lock = LockService.getScriptLock();
      try { lock.waitLock(10000); } catch(e) { return { success: false, message: "Lock timeout" }; }

      try {
        const s = this.getMonthlySheet('transfer', districtId);
        if (!s) return { success: false, message: "Sheet not found" };

        const lastRow = s.getLastRow();
        if (rowNumber > lastRow) {
          return { success: false, message: "Invalid row number" };
        }

        const operatorLineId = String((data && (data.resolvedLineUserId || data.lineUserId || (data.user && data.user.lineUserId) || data.liffUserId)) || "").trim();
        if (!operatorLineId) {
          return { success: false, message: "Permission denied: LINE User ID required" };
        }

        const numCols = Math.max(s.getLastColumn(), 14);
        const rowVals = s.getRange(rowNumber, 1, 1, numCols).getValues()[0];
        const requesterLineId = String(rowVals[12] || "").trim();
        const holderLineId = String(rowVals[13] || "").trim();
        const legacyRequesterId = String(rowVals[2] || "").trim();
        const legacyHolderId = String(rowVals[4] || "").trim();

        const admins = typeof getDeploymentAdmins === 'function' ? getDeploymentAdmins() : [];
        const isAdmin = admins.includes(operatorLineId);

        // lineUserId による厳格な本人権限判定（未マイグレーションのレガシー行は staffId フォールバック）
        const isRequester = requesterLineId ? operatorLineId === requesterLineId : operatorLineId === legacyRequesterId;
        const isHolder = holderLineId ? operatorLineId === holderLineId : operatorLineId === legacyHolderId;

        if (!isRequester && !isHolder && !isAdmin) {
          return { success: false, message: "Permission denied" };
        }

        s.getRange(rowNumber, 8).setValue(status);
        return { success: true };
      } catch(e) {
        return { success: false, message: e.toString() };
      } finally {
        lock.releaseLock();
      }
    }
  }

  TransferService.instance = null;
  global.TransferService = TransferService;
})(this);
