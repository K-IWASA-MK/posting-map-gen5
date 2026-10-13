// POSTING MAP Component: ranking.js (Stateless, API-free rendering)
window.renderRankingCard = function(rankingData, myStaffId, mySummary = null) {
  if (!rankingData || !Array.isArray(rankingData)) return '';

  let myRank = -1;
  let myCount = 0;

  // 引数 mySummary を優先参照（グローバル暗黙参照 window._myRankingSummary を完全排除）
  if (mySummary && typeof mySummary === 'object') {
    myRank = mySummary.rank || -1;
    myCount = mySummary.count || 0;
  } else {
    const meItem = rankingData.find(r => r.isMe === true) || (myStaffId ? rankingData.find(r => r.staffId === myStaffId) : null);
    if (meItem) {
      const idx = rankingData.indexOf(meItem);
      myRank = meItem.rank || (idx + 1);
      myCount = meItem.count || 0;
    }
  }

  const rowsHtml = rankingData.map((item, index) => {
    const rank = item.rank || (index + 1);
    const isMe = item.isMe === true || (myStaffId && item.staffId === myStaffId);
    const meBg = isMe ? 'style="border-color: rgba(0, 183, 255, 0.45); background: rgba(0, 183, 255, 0.08); box-shadow: 0 0 15px rgba(0,183,255,0.06);"' : '';
    const nameColor = isMe ? 'text-[#00B7FF]' : 'text-white/80';

    let rankBadgeHtml = '';
    if (rank === 1) {
      rankBadgeHtml = `<span class="w-6 h-6 flex items-center justify-center text-base select-none">🥇</span>`;
    } else if (rank === 2) {
      rankBadgeHtml = `<span class="w-6 h-6 flex items-center justify-center text-base select-none">🥈</span>`;
    } else if (rank === 3) {
      rankBadgeHtml = `<span class="w-6 h-6 flex items-center justify-center text-base select-none">🥉</span>`;
    } else {
      rankBadgeHtml = `<span class="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black font-mono bg-white/5 text-white/50">${rank}</span>`;
    }

    return `
      <div ${meBg} class="flex items-center justify-between p-4 rounded-2xl border border-white/5 bg-[#1C1C1E]/50">
        <div class="flex items-center gap-3">
          ${rankBadgeHtml}
          <span class="text-sm font-black font-mono truncate max-w-[140px] ${nameColor}">${(item.staffId || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>
        </div>
        <span class="text-sm font-black text-white/90 font-mono">${(item.count || 0).toLocaleString()}枚</span>
      </div>
    `;
  }).join('');

  const myRankSummaryHtml = myRank !== -1 ? `
    <div style="border: 1px solid #EA5F08; box-shadow: 0 0 6px rgba(234,95,8,.35), 0 0 12px rgba(234,95,8,.18); background: linear-gradient(180deg, rgba(234,95,8,0.12), rgba(234,95,8,0.04));" class="premium-glass py-5 px-6 flex justify-around items-center rounded-2xl">
      <div class="text-center">
        <span class="text-[9px] font-bold text-white/40 tracking-wider block">現在の順位</span>
        <span class="text-2xl font-black text-white font-mono">${myRank}位</span>
      </div>
      <div class="w-[1px] h-8 bg-white/10"></div>
      <div class="text-center">
        <span class="text-[9px] font-bold text-white/40 tracking-wider block">配布実績枚数</span>
        <span class="text-2xl font-black text-white font-mono">${myCount.toLocaleString()}枚</span>
      </div>
    </div>
  ` : '';

  return `
    <div class="space-y-6">
      ${myRankSummaryHtml}
      <div class="space-y-2">
        <div class="text-[10px] font-black text-white/30 tracking-widest uppercase mb-1">ランキング一覧</div>
        ${rowsHtml}
      </div>
    </div>
  `;
};
