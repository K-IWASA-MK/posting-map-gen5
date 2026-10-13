/**
 * Business Layer - Flyer Service Module
 * 
 * Domain: Flyer Domain
 * Layer: Business Layer
 * Responsibility: チラシ保管業務の集計・保有枚数更新サービス
 */

if (typeof FlyerService === 'undefined') {
  FlyerService = class FlyerService {
    constructor() {
      this.repository = FlyerRepository.getInstance();
    }

    static getInstance() {
      if (!FlyerService.instance) {
        FlyerService.instance = new FlyerService();
      }
      return FlyerService.instance;
    }

    getFlyerStock(requestLineUserId = "", districtId = "") {
      return this.repository.findStockPayload(requestLineUserId, districtId);
    }

    updateFlyerStock(location, count, staffName, staffId, lineUserId = "", districtId = "") {
      return this.repository.updateStock(location, count, staffName, staffId, lineUserId, districtId);
    }
  };
  FlyerService.instance = null;
}
