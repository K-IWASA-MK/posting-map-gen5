/**
 * POSTING MAP - System Summary Service (Generation 2)
 * ヘッダー専用 System Summary Service
 * 責務: 全体件数(total), 配布完了数(done), 配布率(percent), ONLINE状態(online) の計算と提供 (SSOT準拠)
 */
(function(global) {
  class SystemSummaryService {
    constructor() {}

    static getInstance() {
      if (!SystemSummaryService.instance) {
        SystemSummaryService.instance = new SystemSummaryService();
      }
      return SystemSummaryService.instance;
    }

    getSystemSummary(districtId = "") {
      try {
        let totalDone = 0;
        let totalPoints = 0;
        let districtName = "";

        let ss = null;

        const resolverContext = {};

        // SSOT: Spreadsheetファイル名および実在シートから動的に総件数・完了数を取得
        try {
          if (typeof getSS === 'function') {
            ss = getSS(districtId, resolverContext);
            if (ss) {
              districtName = ss.getName();

              const distSheet = (typeof MonthlySheetResolver !== 'undefined' && MonthlySheetResolver.getInstance)
                ? MonthlySheetResolver.getInstance().getCurrentSheet("distribution", districtId)
                : null;
              if (distSheet) {
                const lastRow = distSheet.getLastRow();
                if (lastRow > 1) {
                  // A〜E列 (ID, 市町村, 町域, 配布完了日時, 配布枚数)
                  const values = distSheet.getRange(2, 1, lastRow - 1, 4).getValues();
                  for (let i = 0; i < values.length; i++) {
                    const row = values[i];
                    const id = row[0];
                    const cityName = row[1] ? String(row[1]).trim() : "";
                    
                    // IDと市町村が存在する行を有効な配布対象としてカウント
                    if (id !== "" && id !== null && cityName !== "") {
                      totalPoints++;
                      
                      const completedAt = row[3];
                      if (completedAt !== null && completedAt !== "") {
                        totalDone++;
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          totalDone = 0;
          totalPoints = 0;
        }

        const percent = totalPoints > 0 ? Math.round((totalDone / totalPoints) * 100) : 0;

        let contract = { status: 'ACTIVE', isExpired: false, endDate: '' };
        if (typeof SystemInfoService !== 'undefined' && SystemInfoService.getInstance) {
          const sysInfo = SystemInfoService.getInstance();
          if (resolverContext && resolverContext.systemInfoData && typeof sysInfo.getContractStatusFromData === 'function') {
            contract = sysInfo.getContractStatusFromData(resolverContext.systemInfoData, new Date(), districtId);
          } else {
            contract = sysInfo.getContractStatus(ss ? ss.getSheetByName('SYSTEM_INFO') : null, new Date(), districtId);
          }
        }

        if (contract.isExpired) {
          return {
            success: false,
            code: contract.code || 'CONTRACT_EXPIRED',
            districtName: districtName,
            total: totalPoints,
            done: totalDone,
            percent: percent,
            online: false,
            contractStatus: 'EXPIRED',
            contractEndDate: contract.endDate,
            isExpired: true,
            message: contract.message || '契約期間が終了しているため利用できません。'
          };
        }

        return {
          success: true,
          districtName: districtName,
          total: totalPoints,
          done: totalDone,
          percent: percent,
          online: true,
          contractStatus: 'ACTIVE',
          contractEndDate: contract.endDate,
          isExpired: false
        };
      } catch (err) {
        return {
          success: false,
          districtName: "",
          total: 0,
          done: 0,
          percent: 0,
          online: true,
          message: err.message
        };
      }
    }
  }

  SystemSummaryService.instance = null;
  global.SystemSummaryService = SystemSummaryService;

  global.getSystemSummary = function() {
    return SystemSummaryService.getInstance().getSystemSummary();
  };
})(this);
