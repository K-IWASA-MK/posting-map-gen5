/**
 * POSTING MAP - Monthly Sheet Resolver (Generation 2)
 * 責務: 現在年月を基準とした当月業務シート名およびSheetオブジェクトの解決SSOT
 * 
 * 【厳格な制約】
 * 1. 責務は「現在年月取得」「当月シート名解決」「当月Sheet取得」のみ。
 * 2. シートの自動生成 (insertSheet)、削除、書き換えは絶対に行わない。
 * 3. CSVの読込、外部通信、API追加は行わない。
 * 4. SYSTEM_INFO、端末管理は月次化対象外。
 */
(function(global) {
  class MonthlySheetResolver {
    constructor() {
      // 5つの正式typeのみ定義（日本語エイリアスなし）
      this.prefixes = {
        distribution: "配布実績",
        staff: "名簿",
        flyer: "保有チラシ枚数",
        transfer: "受渡要請履歴",
        pin: "PinStatus"
      };
    }

    static getInstance() {
      if (!MonthlySheetResolver.instance) {
        MonthlySheetResolver.instance = new MonthlySheetResolver();
      }
      return MonthlySheetResolver.instance;
    }

    /**
     * 現在年月 (YYYY-MM) を取得する (JST基準)
     */
    getCurrentMonth(date = new Date()) {
      if (typeof Utilities !== 'undefined' && typeof Utilities.formatDate === 'function') {
        return Utilities.formatDate(date, "JST", "yyyy-MM");
      }
      // Node.js テスト環境向け最小フォールバック (JST: UTC+9)
      const jstDate = new Date(date.getTime() + (9 * 60 * 60 * 1000));
      const y = jstDate.getUTCFullYear();
      const m = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
      return `${y}-${m}`;
    }

    /**
     * 指定SpreadsheetのSYSTEM_INFOからDataset Keyを解決する (ELECTION / SUBSCRIPTION)
     * Mode/Spreadsheet/SYSTEM_INFO解決失敗、およびELECTION Active Dataset Key欠損時はFail-Closed (throw)
     */
    resolveDatasetKey(ss, date = new Date()) {
      if (!ss) {
        throw new Error('[MonthlySheetResolver] Target spreadsheet is required for dataset key resolution (Fail-Closed).');
      }
      const sysSheet = ss.getSheetByName('SYSTEM_INFO');
      if (!sysSheet) {
        throw new Error('[MonthlySheetResolver] SYSTEM_INFO sheet is missing (Fail-Closed).');
      }

      if (typeof SystemInfoService === 'undefined' || !SystemInfoService.getInstance) {
        throw new Error('[MonthlySheetResolver] SystemInfoService is unavailable (Fail-Closed).');
      }

      const sysService = SystemInfoService.getInstance();
      const mode = sysService.getOperationMode(sysSheet);
      if (mode === 'ELECTION') {
        const activeKey = sysService.getActiveDatasetKey(sysSheet);
        if (!activeKey) {
          throw new Error('[MonthlySheetResolver] Active Dataset Key is missing in ELECTION mode (Fail-Closed).');
        }
        return activeKey;
      } else if (mode === 'SUBSCRIPTION') {
        return this.getCurrentMonth(date);
      }
      throw new Error(`[MonthlySheetResolver] Invalid operation mode "${mode}" (Fail-Closed).`);
    }

    /**
     * 指定Spreadsheetのコンテキストを維持したままシート名を解決する
     */
    resolveSheetNameForSs(ss, type, date = new Date()) {
      const prefix = this.prefixes[type];
      if (!prefix) return null;

      const datasetKey = this.resolveDatasetKey(ss, date);
      return `${prefix}${datasetKey}`;
    }

    /**
     * 業務typeから当月シート名を解決する
     * 不正typeは null を返し明確に拒否する
     * Spreadsheet解決不能、Mode解決不能時はFail-Closed (throw)
     */
    getSheetName(type, date = new Date(), districtId = "") {
      const prefix = this.prefixes[type];
      if (!prefix) return null;

      let ss = null;
      if (typeof getSS === 'function') {
        ss = getSS(districtId);
      } else if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.getActiveSpreadsheet === 'function') {
        ss = SpreadsheetApp.getActiveSpreadsheet();
      }

      if (!ss) {
        throw new Error(`[MonthlySheetResolver] Target spreadsheet cannot be resolved for district "${districtId}" (Fail-Closed).`);
      }

      return this.resolveSheetNameForSs(ss, type, date);
    }

    /**
     * 当月Sheetオブジェクトを取得する
     * 未生成時（正常に名前解決済みだがSheet不存在）は null を返す（自動生成は絶対に行わない）
     * Mode解決不能やSpreadsheet解決不能時はFail-Closed (throw)
     */
    getCurrentSheet(type, arg2, arg3) {
      let date = new Date();
      let districtId = "";
      if (typeof arg2 === 'string') {
        districtId = arg2;
      } else if (arg2 instanceof Date) {
        date = arg2;
        if (typeof arg3 === 'string') {
          districtId = arg3;
        }
      } else if (typeof arg3 === 'string') {
        districtId = arg3;
      }

      // 1. 最初に地区コンテキストに基づいて対象 Spreadsheet を確定（コンテキスト放棄禁止）
      let ss = null;
      if (typeof getSS === 'function') {
        ss = getSS(districtId);
      } else if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.getActiveSpreadsheet === 'function') {
        ss = SpreadsheetApp.getActiveSpreadsheet();
      }
      if (!ss) {
        throw new Error(`[MonthlySheetResolver] Target spreadsheet cannot be resolved for district "${districtId}" (Fail-Closed).`);
      }

      // 2. 確定した同一 ss を渡してシート名を解決 (Fail-Closed)
      const sheetName = this.resolveSheetNameForSs(ss, type, date);
      if (!sheetName) return null;

      return ss.getSheetByName(sheetName) || null;
    }
  }

  MonthlySheetResolver.instance = null;
  global.MonthlySheetResolver = MonthlySheetResolver;
})(this);
