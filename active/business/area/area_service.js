/**
 * Business Layer - Area Service Module
 * 
 * Domain: Area Domain
 * Layer: Business Layer
 * Responsibility: Area トランザクション管理、エリア・都市別データ集計サービス
 */

if (typeof AreaService === 'undefined') {
  AreaService = class AreaService {
    constructor() {
      this.repository = AreaRepository.getInstance();
    }

    static getInstance() {
      if (!AreaService.instance) {
        AreaService.instance = new AreaService();
      }
      return AreaService.instance;
    }

    getCityName(areaName) {
      if (!areaName) return 'その他';
      const match = areaName.match(/^[^市町\(\d]+(?:市|町)/);
      if (match) return match[0];
      return areaName;
    }



    getAreaDetails(areaName, districtId = "") {
      return this.repository.findAreaPoints(areaName, districtId);
    }
  };
  AreaService.instance = null;
}
