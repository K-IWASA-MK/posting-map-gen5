/**
 * Business Layer - Staff Domain Model
 * 
 * Target Domain: Staff Management
 * Owner Layer: Business Layer
 * Responsibility: Staff ドメインのデータ構造とビジネス表現
 */

if (typeof Staff === 'undefined') {
  Staff = class Staff {
    constructor(params) {
      this.id = params ? params.id : "";
      this.name = params ? params.name : "";
      this.lineUserId = (params && params.lineUserId) || "";
      this.registeredAt = (params && params.registeredAt) || "";
    }

    toDict() {
      return {
        id: this.id,
        name: this.name,
        lineUserId: this.lineUserId,
        registeredAt: this.registeredAt
      };
    }
  };
}

if (typeof StaffIdentity === 'undefined') {
  StaffIdentity = class StaffIdentity {
    constructor(params) {
      this.found = params ? params.found : false;
      this.staffId = (params && params.staffId) || "";
      this.staffName = (params && params.staffName) || "";
      this.lineUserId = (params && params.lineUserId) || "";
    }

    static notFound(lineUserId) {
      return new StaffIdentity({
        found: false,
        staffId: "",
        staffName: "",
        lineUserId: lineUserId || ""
      });
    }

    static found(staffId, staffName, lineUserId) {
      return new StaffIdentity({
        found: true,
        staffId: staffId,
        staffName: staffName,
        lineUserId: lineUserId || ""
      });
    }
  };
}
