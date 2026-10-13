/**
 * POSTING MAP - Ranking Feature Module (modules/ranking.js)
 * 
 * 責務:
 * - ランキングデータ・本人サマリ・取得状態・通信中Promiseの非公開カプセル化管理
 * - API通信（getRanking）の実行とIn-flight重複防止
 * - 応答形式不正時のエラー送出と通信失敗時のPromise解放（次回再試行保証）
 * - 公開APIは fetchRanking と getSnapshot の2つに厳格限定（テスト用裏口なし）
 */
const RankingModule = (function() {
  let _rankingData = [];
  let _mySummary = null;
  let _fetched = false;
  let _inFlightPromise = null;

  function fetchRanking() {
    if (_fetched) {
      return Promise.resolve(getSnapshot());
    }
    if (_inFlightPromise) {
      return _inFlightPromise;
    }

    const promise = (async () => {
      try {
        const data = await callApiPost('getRanking');
        if (data && data.success === true && Array.isArray(data.ranking)) {
          _rankingData = data.ranking.map(r => ({ ...r }));
          _mySummary = (data.mySummary && typeof data.mySummary === 'object') ? { ...data.mySummary } : null;
          _fetched = true;
          return getSnapshot();
        } else {
          const errMsg = (data && data.message) ? data.message : 'ランキングの応答形式が不正です';
          const err = new Error(errMsg);
          err.response = data;
          throw err;
        }
      } catch (err) {
        console.warn('[RankingModule] fetchRanking failed:', err);
        throw err;
      }
    })();

    _inFlightPromise = promise.finally(() => {
      _inFlightPromise = null;
    });

    return _inFlightPromise;
  }

  function getSnapshot() {
    return {
      ranking: Array.isArray(_rankingData) ? _rankingData.map(r => ({ ...r })) : [],
      mySummary: (_mySummary && typeof _mySummary === 'object') ? { ..._mySummary } : null,
      fetched: _fetched
    };
  }

  return {
    fetchRanking,
    getSnapshot
  };
})();
