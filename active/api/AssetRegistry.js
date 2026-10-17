/**
 * AssetRegistry - District LIFF URL Resolver
 */
function getProductionLiffUrl(districtId) {
  // 環境変数(PropertiesService)から取得する仕様に変更
  try {
    const props = PropertiesService.getScriptProperties();
    const liffUrl = props.getProperty("PRODUCTION_LIFF_URL");
    if (liffUrl) return liffUrl;
  } catch(e) {}
  return "";
}
