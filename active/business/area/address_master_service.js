/**
 * POSTING MAP - Address Master Service (SSOT CSV Data Provider)
 * 責任: 住所マスター CSV (address_master.csv) の読込、パース、各種クエリ API 提供
 * ガバナンス: UI変更なし、既存GAS変更なし、スプレッドシート変更なし
 */
(function(global) {
  const DEFAULT_CSV_PATH = '../../data/address_master.csv';

  class AddressMasterService {
    constructor() {
      this.cache = null;
    }

    static getInstance() {
      if (!AddressMasterService.instance) {
        AddressMasterService.instance = new AddressMasterService();
      }
      return AddressMasterService.instance;
    }

    /**
     * CSVテキストを構造化オブジェクト配列にパースする
     */
    parseCsv(csvText) {
      const lines = csvText.trim().split(/\r?\n/);
      if (lines.length < 2) return [];

      const data = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim());
        if (cols.length >= 5) {
          data.push({
            rowId: Number(cols[0]),
            city_name: cols[1],
            town_name: cols[2],
            latitude: Number(cols[3]),
            longitude: Number(cols[4]),
            households: cols[5] !== undefined && cols[5] !== '' ? Number(cols[5]) : null,
            population: cols[6] !== undefined && cols[6] !== '' ? Number(cols[6]) : null,
            e_stat_code: cols[7] || null
          });
        }
      }
      return data;
    }

    /**
     * CSVデータを非同期取得してメモリに展開する
     */
    async loadMaster(csvUrl = DEFAULT_CSV_PATH) {
      if (this.cache) return this.cache;

      const res = await fetch(csvUrl);
      if (!res.ok) {
        throw new Error(`Failed to load CSV: ${res.status}`);
      }

      const text = await res.text();
      this.cache = this.parseCsv(text);

      return this.cache;
    }

    /**
     * 1. 全件のメモリキャッシュ配列をそのまま返す
     */
    async getAll(csvUrl = DEFAULT_CSV_PATH) {
      return await this.loadMaster(csvUrl);
    }

    /**
     * 2. CSVの出現順を保持して自治体一覧 (city_name) と total 件数を集計・抽出する
     */
    async getCities(csvUrl = DEFAULT_CSV_PATH) {
      const master = await this.loadMaster(csvUrl);
      const map = new Map();

      for (const item of master) {
        if (!item.city_name) continue;
        if (!map.has(item.city_name)) {
          map.set(item.city_name, {
            name: item.city_name,
            done: 0,
            total: 0
          });
        }
        map.get(item.city_name).total++;
      }

      return [...map.values()];
    }

    /**
     * 3. 指定された市町村配下の町名一覧 (town_name) と total 件数を集計・一括抽出する
     */
    async getTowns(cityName, csvUrl = DEFAULT_CSV_PATH) {
      const master = await this.loadMaster(csvUrl);
      const map = new Map();

      for (const item of master) {
        if (item.city_name !== cityName || !item.town_name) continue;
        if (!map.has(item.town_name)) {
          map.set(item.town_name, {
            rowId: item.rowId,
            city_name: item.city_name,
            town_name: item.town_name,
            latitude: item.latitude,
            longitude: item.longitude,
            done: 0,
            total: 0
          });
        }
        map.get(item.town_name).total++;
      }

      return [...map.values()];
    }

    /**
     * 4. rowId による単一ヒット直引き検索 API
     */
    async findByRowId(rowId, csvUrl = DEFAULT_CSV_PATH) {
      const master = await this.loadMaster(csvUrl);
      const targetId = Number(rowId);
      return master.find(item => item.rowId === targetId) || null;
    }

    /**
     * 5. キーワード部分一致検索 API (city_name または town_name)
     */
    async search(keyword, csvUrl = DEFAULT_CSV_PATH) {
      if (!keyword || typeof keyword !== 'string') return [];
      const master = await this.loadMaster(csvUrl);
      const q = keyword.trim().toLowerCase();

      return master.filter(item => 
        (item.city_name && item.city_name.toLowerCase().includes(q)) ||
        (item.town_name && item.town_name.toLowerCase().includes(q))
      );
    }
  }

  AddressMasterService.instance = null;
  global.AddressMasterService = AddressMasterService;
  global.DEFAULT_CSV_PATH = DEFAULT_CSV_PATH;
})(typeof window !== 'undefined' ? window : globalThis);
