/**
 * GAS v2 - マップデータ管理モジュール
 * - 地図表示用データの集計
 * - パフォーマンス向上のためのキャッシュ管理
 */

/**
 * 戦況マップダッシュボード用：全体サマリー取得（爆速キャッシュ版）
 */
function getDashboardData() {
  const cache = CacheService.getScriptCache();
  const fastCached = cache.get("AREA_SUMMARY_FAST_CACHE");
  if (fastCached) return JSON.parse(fastCached);

  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty("AREA_SUMMARY_CACHE");

  if (cached) {
    try {
      const data = JSON.parse(cached);
      cache.put("AREA_SUMMARY_FAST_CACHE", cached, 1800);
      return data;
    } catch (e) {}
  }
  return { success: true, summary: [] };
}

/**
 * 全エリアのサマリーを再計算してキャッシュに保存する (実在Runtimeデータ集計版)
 */
function refreshAreaSummaryCache() {
  const ss = getSS();
  const orderedCities = (typeof getMunicipalityOrder === 'function')
    ? getMunicipalityOrder()
    : [];

  const cityMap = {};
  orderedCities.forEach(cName => {
    cityMap[cName] = {
      name: cName,
      total: 0,
      done: 0,
      lat: null,
      lng: null
    };
  });

  let totalDone = 0;
  let totalPoints = 0;

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
        const isDone = (completedAt !== null && completedAt !== "");

        if (!cityMap[cityName]) {
          cityMap[cityName] = { name: cityName, total: 0, done: 0, lat: null, lng: null };
        }

        cityMap[cityName].total += 1;
        totalPoints += 1;

        if (isDone) {
          cityMap[cityName].done += 1;
          totalDone += 1;
        }
      }
    }
  }

  // 2. summary 配列の構築
  const summary = Object.keys(cityMap)
    .filter(cityName => cityMap[cityName].total > 0)
    .map(cityName => {
      const info = cityMap[cityName];
      return {
        version: 1,
        name: cityName,
        done: info.done,
        total: info.total,
        lat: info.lat,
        lng: info.lng
      };
    });

  const result = {
    summary: summary,
    stats: { done: totalDone, total: totalPoints },
    updatedAt: new Date().getTime(),
  };

  const jsonResult = JSON.stringify(result);
  if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
    const cache = CacheService.getScriptCache();
    cache.put("AREA_SUMMARY_FAST_CACHE", jsonResult, 1800);
  }
  if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
    PropertiesService.getScriptProperties().setProperty("AREA_SUMMARY_CACHE", jsonResult);
  }

  return result;
}


/**
 * 特定のエリアの進捗だけをキャッシュ内で更新する（高速）
 */
function updateAreaCache(areaName, isDoneChange = 0) {
  if (isDoneChange === 0) return; // 変化なし: 更新不要
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const cached = props.getProperty("AREA_SUMMARY_CACHE");
  if (!cached) {
    // キャッシュなし: FastCacheのみクリアして次回フル再取得を促す
    cache.remove("AREA_SUMMARY_FAST_CACHE");
    return;
  }
  try {
    const data = JSON.parse(cached);
    const area = data.summary.find((s) => s.name === areaName);
    if (area) {
      area.done = Math.max(0, area.done + isDoneChange); // 負数防止
      data.stats.done = Math.max(0, data.stats.done + isDoneChange); // 負数防止
      const updatedJson = JSON.stringify(data);
      props.setProperty("AREA_SUMMARY_CACHE", updatedJson);
      cache.put("AREA_SUMMARY_FAST_CACHE", updatedJson, 1800);
    }
  } catch (e) {
    // JSONパースエラー: 破損キャッシュを全クリアして次回フル再取得を促す
    props.deleteProperty("AREA_SUMMARY_CACHE");
    cache.remove("AREA_SUMMARY_FAST_CACHE");
  }
}

/**
 * 永続座標キャッシュ付きジオコーディング
 * 同じ代表住所に対するジオコーディングをPropertiesServiceで永続化し、高速化・API制限回避を行う
 */
function getCoordsFromAddress(address) {
  if (!address) return null;
  const cleanAddr = address.replace(/\r?\n/g, ' ').trim();
  if (!cleanAddr) return null;

  const propKey = "GEO_" + cleanAddr.replace(/[\s\t]/g, '_');
  const props = PropertiesService.getScriptProperties();
  
  try {
    const cached = props.getProperty(propKey);
    if (cached) {
      const parts = cached.split(',');
      if (parts.length === 2) {
        return { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]) };
      }
    }
  } catch (err) {
    // スクリプトプロパティ取得エラー時はジオコーディングにフォールバック
  }

  try {
    const geocoder = Maps.newGeocoder().setLanguage('ja');
    const response = geocoder.geocode(cleanAddr);
    if (response.status === 'OK' && response.results.length > 0) {
      const location = response.results[0].geometry.location;
      props.setProperty(propKey, `${location.lat},${location.lng}`);
      return { lat: location.lat, lng: location.lng };
    }
  } catch (e) {
    console.error("Geocoding failed for: " + cleanAddr + " error: " + e.toString());
  }
  return null;
}

