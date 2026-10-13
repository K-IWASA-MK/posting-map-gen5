/**
 * POSTING MAP - Tier 1 Service (Generation 2)
 * エリア Tier 1 (市町村一覧) 専用サービス
 * 責務: 実在スプレッドシート(SSOT)からの Tier 1 市町村サマリー取得
 */
(function(global) {
  class Tier1Service {
    constructor() {}

    static getInstance() {
      if (!Tier1Service.instance) {
        Tier1Service.instance = new Tier1Service();
      }
      return Tier1Service.instance;
    }

    getTier1() {
      try {
        const cityTotals = {};
        const cityDoneMap = {};

        // 1. 新アーキテクチャ: 月次単一データシートから実データを集計
        let distSheet = null;
        if (typeof MonthlySheetResolver !== 'undefined' && MonthlySheetResolver.getInstance) {
          distSheet = MonthlySheetResolver.getInstance().getCurrentSheet("distribution");
        }

        if (distSheet) {
          const lastRow = distSheet.getLastRow();
          if (lastRow >= 2) {
            // A〜E列 (ID, 市町村, 町域, 配布完了日時, 配布枚数)
            const values = distSheet.getRange(2, 1, lastRow - 1, 5).getValues();
            
            for (let i = 0; i < values.length; i++) {
              const row = values[i];
              const cityName = row[1] ? String(row[1]).trim() : "";
              if (!cityName) continue;

              const completedAt = row[3];
              // 新アーキテクチャでは 配布完了日時(インデックス3)の有無でdone判定
              const isDone = (completedAt !== null && completedAt !== "");

              cityTotals[cityName] = (cityTotals[cityName] || 0) + 1;
              if (isDone) {
                cityDoneMap[cityName] = (cityDoneMap[cityName] || 0) + 1;
              }
            }
          }
        }

        // 2. 表示順序SSOT (getMunicipalityOrder) に基づき自治体リストを動的生成
        let orderedCities = [];
        if (typeof getMunicipalityOrder === 'function') {
          orderedCities = getMunicipalityOrder();
        } else {
          orderedCities = [];
        }

        // 順序リストに含まれない自治体がもしあれば末尾に追加
        Object.keys(cityTotals).forEach(cName => {
          if (!orderedCities.includes(cName)) {
            orderedCities.push(cName);
          }
        });

        const cities = orderedCities.map(cityName => ({
          name: cityName,
          total: cityTotals[cityName] || 0,
          done: cityDoneMap[cityName] || 0
        })).filter(city => city.total > 0); // 存在する自治体のみ返却

        return {
          success: true,
          cities: cities
        };
      } catch (err) {
        return {
          success: false,
          cities: [],
          message: err.message
        };
      }
    }
  }

  Tier1Service.instance = null;
  global.Tier1Service = Tier1Service;

  global.getTier1 = function() {
    return Tier1Service.getInstance().getTier1();
  };
})(this);
