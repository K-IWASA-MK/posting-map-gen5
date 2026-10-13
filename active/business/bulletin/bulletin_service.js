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

  class BulletinService {
    constructor() {}

    static getInstance() {
      if (!BulletinService.instance) {
        BulletinService.instance = new BulletinService();
      }
      return BulletinService.instance;
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

    getBulletinSheet(districtId = "") {
      const ss = this.getSS(districtId);
      let sheet = ss.getSheetByName("掲示板");
      if (!sheet) {
        sheet = ss.insertSheet("掲示板");
        sheet.getRange(1, 1, 1, 5).setValues([["日時", "投稿者ID", "投稿者名", "メッセージ", "lineUserId"]]);
        sheet.getRange("A1:E1").setBackground("#1e293b").setFontColor("#ffffff").setFontWeight("bold");
        sheet.setFrozenRows(1);
      }
      return sheet;
    }

    getContactSheet(districtId = "") {
      const ss = this.getSS(districtId);
      let sheet = ss.getSheetByName("掲示板連絡履歴");
      const expectedHeaders = [["日時", "送信者ID", "送信者名", "相手ID", "連絡方法", "連絡先", "requestId", "LINE送信状態", "LINE HTTP status", "LINE送信日時"]];
      if (!sheet) {
        sheet = ss.insertSheet("掲示板連絡履歴");
        sheet.getRange(1, 1, 1, 10).setValues(expectedHeaders);
      } else {
        const lastRow = sheet.getLastRow();
        if (lastRow === 0) {
          sheet.getRange(1, 1, 1, 10).setValues(expectedHeaders);
        } else {
          const headerValues = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 10)).getValues()[0];
          if (!headerValues[6] || headerValues[6] !== "requestId") {
            sheet.getRange(1, 1, 1, 10).setValues(expectedHeaders);
          }
        }
      }
      return sheet;
    }

    getPosts(requestLineUserId = "", districtId = "") {
      try {
        const sheet = this.getBulletinSheet(districtId);
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return { success: true, posts: [] };

        const numCols = Math.max(sheet.getLastColumn(), 5);
        const values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
        const cleanReqLineId = String(requestLineUserId || "").trim();

        const posts = values.map((r, idx) => {
          const rowLineId = String(r[4] || "").trim();
          const isMe = !!(cleanReqLineId && rowLineId === cleanReqLineId);
          return {
            id: `BP_${idx + 2}`,
            updatedAt: (r[0] && typeof r[0].getMonth === 'function')
              ? Utilities.formatDate(r[0], "JST", "yyyy/MM/dd HH:mm")
              : (r[0] ? String(r[0]).trim() : ""),
            staffId: String(r[1] || '').trim(),
            staffName: String(r[2] || '').trim(),
            message: String(r[3] || '').trim(),
            isMe: isMe
          };
        }).filter(p => p.message !== "");

        posts.reverse();
        return { success: true, posts: posts };
      } catch (err) {
        return { success: false, message: err.toString(), posts: [] };
      }
    }

    createPost(data, districtId = "") {
      const staffId = data && data.staffId ? String(data.staffId).trim() : '';
      const staffName = data && data.staffName ? String(data.staffName).trim() : '';
      const message = data && data.message ? String(data.message).trim() : '';
      const cleanLineUserId = String((data && (data.resolvedLineUserId || data.lineUserId || (data.user && data.user.lineUserId))) || "").trim();

      if (!staffId || !message) {
        return { success: false, message: "IDまたはメッセージが不足しています。" };
      }
      if (message.length > 150) {
        return { success: false, message: "メッセージは150文字以内で入力してください。" };
      }

      const lock = LockService.getScriptLock();
      try {
        lock.waitLock(10000);
      } catch (e) {
        return { success: false, message: "システムが混雑しています。時間をおいて再度お試しください。" };
      }

      try {
        const sheet = this.getBulletinSheet(districtId);
        const now = new Date();
        const formattedDate = Utilities.formatDate(now, "JST", "yyyy/MM/dd HH:mm:ss");

        sheet.appendRow([
          formattedDate,
          sanitizeFormula(staffId),
          sanitizeFormula(staffName),
          sanitizeFormula(message),
          cleanLineUserId
        ]);

        return {
          success: true,
          post: {
            updatedAt: Utilities.formatDate(now, "JST", "yyyy/MM/dd HH:mm"),
            staffId: staffId,
            staffName: staffName,
            message: message
          }
        };
      } catch (err) {
        return { success: false, message: err.toString() };
      } finally {
        lock.releaseLock();
      }
    }

    sendContact(data, districtId = "") {
      const requestId = data && data.requestId ? String(data.requestId).trim() : '';
      const requestUserId = data && data.requestUserId ? String(data.requestUserId).trim() : '';
      const targetStaffId = data && data.targetStaffId ? String(data.targetStaffId).trim() : '';
      const contactMethod = data && data.contactMethod ? String(data.contactMethod).trim() : 'LINE';
      const contactValue = data && data.contactValue ? String(data.contactValue).trim() : '';

      if (!requestUserId || !targetStaffId || !contactValue) {
        return { success: false, message: "必須パラメータが不足しています。" };
      }

      if (!requestId) {
        Logger.log("[WARN] sendContact received without requestId. Legacy client fallback.");
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

        const rosterSheet = this.getMonthlySheet('staff', districtId);
        let requestUserName = requestUserId;
        let targetName = targetStaffId;
        let targetLineUserId = "";

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
              if (rowId === targetStaffId) {
                targetName = rowName || targetStaffId;
                targetLineUserId = rowLineId;
              }
            }
          }
        }

        const contactSheet = this.getContactSheet(districtId);

        let existingRow = 0;
        let existingStatus = "";
        const lastRow = contactSheet.getLastRow();
        if (requestId && lastRow >= 2) {
          const reqIdValues = contactSheet.getRange(2, 7, lastRow - 1, 2).getValues();
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
          contactSheet.appendRow([
            requestTime,
            requestUserId,
            sanitizeFormula(requestUserName),
            targetStaffId,
            contactMethod,
            sanitizeFormula(contactValue),
            requestId,
            "PROCESSING",
            "",
            ""
          ]);
          targetRow = contactSheet.getLastRow();
        } else {
          contactSheet.getRange(targetRow, 8).setValue("PROCESSING");
        }

        if (targetLineUserId) {
          const postingMapUrl = typeof getProductionLiffUrl === 'function' ? getProductionLiffUrl() : '';
          const messageText =
            "💬 掲示板の投稿への連絡が届きました\n\n\n" +
            requestUserName + "（" + requestUserId + "）さんから、あなたの掲示板投稿に関して連絡が届いています。\n\n\n" +
            "【連絡先】\n" +
            contactMethod + "：" + contactValue + "\n\n\n" +
            "この連絡先へ直接ご連絡ください。\n\n\n" +
            "↓\n" +
            "POSTING MAPを開く\n" +
            postingMapUrl;

          const lineRes = this.sendLinePushMessage(targetLineUserId, messageText);
          const lineTime = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm:ss");

          contactSheet.getRange(targetRow, 8, 1, 3).setValues([[
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
          contactSheet.getRange(targetRow, 8, 1, 3).setValues([[
            "SKIPPED_NO_LINE_ID",
            "NONE",
            lineTime
          ]]);
          if (requestId) cache.put("IDEMPOTENCY_LINE_" + requestId, "SKIPPED_NO_LINE_ID", 600);
          return { success: true, status: "SKIPPED_NO_LINE_ID", message: "相手のLINE未登録のため通知はスキップされました。" };
        }
      } catch (err) {
        return { success: false, message: err.toString() };
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
  }

  global.BulletinService = BulletinService;
})(this);
