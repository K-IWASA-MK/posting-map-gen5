const StorageModule = (function() {
  let _stockData = [];
  let _stockFetched = false;
  let _activeFlyerStockPromise = null;
  let _flyerStockReqSeq = 0;
  let _storageLocationsCache = null;
  let _storageLocationsFetching = null;
  let _myStockData = null;

  async function getLocations() {
    if (_storageLocationsCache) return [..._storageLocationsCache];
    if (_storageLocationsFetching) return _storageLocationsFetching;

    _storageLocationsFetching = (async () => {
      try {
        const res = await fetch('../../data/storage_locations.json');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            _storageLocationsCache = data;
            return [..._storageLocationsCache];
          }
        }
      } catch (e) {
        console.warn('[StorageModule] Fallback to tier1Cache:', e);
      } finally {
        _storageLocationsFetching = null;
      }
      return null;
    })();

    return _storageLocationsFetching;
  }

  async function fetchStock() {
    if (_activeFlyerStockPromise) {
      return _activeFlyerStockPromise;
    }

    const currentSeq = ++_flyerStockReqSeq;

    _activeFlyerStockPromise = (async () => {
      try {
        const data = await callApiPost('getFlyerStock');
        if (currentSeq !== _flyerStockReqSeq) {
          return null;
        }
        if (data && data.success) {
          if (Array.isArray(data.stocks)) {
            _stockData = data.stocks.map(s => ({ ...s }));
            _stockFetched = true;
          }
          if (data.myStock) {
            _myStockData = { ...data.myStock };
          }
        }
        return data;
      } catch (err) {
        console.warn('[StorageModule] fetchFlyerStock failed:', err);
        throw err;
      } finally {
        _activeFlyerStockPromise = null;
      }
    })();

    return _activeFlyerStockPromise;
  }

  async function updateStock(payload) {
    const res = await callApiPost('updateFlyerStock', payload);

    if (res && res.success) {
      _myStockData = {
        location: payload.location,
        count: payload.count,
        updatedAt: "たった今"
      };

      if (!Array.isArray(_stockData)) _stockData = [];
      const idx = _stockData.findIndex(s => s.isMe === true);
      if (idx >= 0) {
        _stockData[idx] = {
          ..._stockData[idx],
          location: payload.location,
          count: payload.count,
          staffName: payload.staffName,
          isMe: true
        };
      } else {
        _stockData.unshift({
          staffId: payload.staffId,
          staffName: payload.staffName,
          location: payload.location,
          count: payload.count,
          isMe: true
        });
      }
      _stockFetched = true;
      _flyerStockReqSeq++;
    }

    return res;
  }

  function getSnapshot() {
    return {
      stocks: Array.isArray(_stockData) ? _stockData.map(s => ({ ...s })) : [],
      myStock: _myStockData ? { ..._myStockData } : null,
      fetched: _stockFetched,
      locations: Array.isArray(_storageLocationsCache) ? [..._storageLocationsCache] : null
    };
  }

  return {
    fetchStock,
    getLocations,
    updateStock,
    getSnapshot
  };
})();
