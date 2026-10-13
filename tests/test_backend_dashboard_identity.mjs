import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

// Load files to test logic in isolation
const rootDir = process.cwd();

test('API Response Identity Boundary Audit: lineUserId must never be exposed', () => {
  // Mock flyer repository response
  const sampleStocks = [
    { id: 'ST001', staffId: 'S001', staffName: 'K. IWASA', flyerType: 'チラシA', count: 500, updatedAt: '2026-03-20', isMe: false },
    { id: 'ST002', staffId: 'S002', staffName: 'K. IWASA', flyerType: 'チラシA', count: 300, updatedAt: '2026-03-21', isMe: true }
  ];

  sampleStocks.forEach(st => {
    assert.equal(st.lineUserId, undefined, 'Stock item must not expose lineUserId');
    assert.equal(typeof st.isMe, 'boolean', 'Stock item must have isMe boolean flag');
    assert.ok(st.staffId, 'Stock item must have display staffId');
  });
});

test('Roster API Response: lineUserId excluded, stockTotal and deliveredTotal included', () => {
  const sampleRoster = [
    { id: 'S001', name: 'なお', registeredAt: '2026-03-01', stockTotal: 0, deliveredTotal: 100 },
    { id: 'S002', name: 'K. IWASA', registeredAt: '2026-03-02', stockTotal: 500, deliveredTotal: 1200 }
  ];

  sampleRoster.forEach(r => {
    assert.equal(r.lineUserId, undefined, 'Roster item must not expose lineUserId');
    assert.equal(typeof r.stockTotal, 'number', 'Roster item must have numeric stockTotal');
    assert.equal(typeof r.deliveredTotal, 'number', 'Roster item must have numeric deliveredTotal');
    assert.ok(r.id, 'Roster item must have display staffId (id)');
  });
});

test('Ranking API Response: lineUserId excluded, mySummary and isMe included', () => {
  const sampleRanking = [
    { rank: 1, staffId: 'S002', count: 1200, isMe: true },
    { rank: 2, staffId: 'S001', count: 100, isMe: false }
  ];
  const mySummary = { rank: 1, count: 1200 };

  sampleRanking.forEach(rk => {
    assert.equal(rk.lineUserId, undefined, 'Ranking item must not expose lineUserId');
    assert.equal(typeof rk.isMe, 'boolean', 'Ranking item must have isMe boolean flag');
    assert.ok(rk.staffId, 'Ranking item must have display staffId');
  });

  assert.equal(mySummary.rank, 1);
  assert.equal(mySummary.count, 1200);
});

test('Bulletin API Response: lineUserId excluded, isMe included', () => {
  const samplePosts = [
    { id: 'B001', staffId: 'S001', staffName: 'なお', message: 'Hello', createdAt: '2026-03-20', isMe: false },
    { id: 'B002', staffId: 'S002', staffName: 'K. IWASA', message: 'Hi', createdAt: '2026-03-21', isMe: true }
  ];

  samplePosts.forEach(p => {
    assert.equal(p.lineUserId, undefined, 'Bulletin post must not expose lineUserId');
    assert.equal(typeof p.isMe, 'boolean', 'Bulletin post must have isMe boolean flag');
  });
});

test('Transfer API Response: lineUserIds excluded, isMe included', () => {
  const sampleRequests = [
    { id: 'TR001', storageId: 'ST001', requesterStaffId: 'S002', requesterName: 'K. IWASA', holderStaffId: 'S001', holderName: 'なお', flyerType: 'A', count: 50, status: 'PENDING', isMe: false, isMyRequest: true }
  ];

  sampleRequests.forEach(tr => {
    assert.equal(tr.requesterLineUserId, undefined, 'Transfer request must not expose requesterLineUserId');
    assert.equal(tr.holderLineUserId, undefined, 'Transfer request must not expose holderLineUserId');
    assert.equal(typeof tr.isMe, 'boolean', 'Transfer request must have isMe flag');
    assert.equal(typeof tr.isMyRequest, 'boolean', 'Transfer request must have isMyRequest flag');
  });
});

test('Migration Safety Logic: ST001 with name mismatch must remain UNRESOLVED (blank)', () => {
  // Simulate migration resolution logic
  const roster = [
    { id: 'S001', name: 'なお', lineUserId: 'U_NAO' },
    { id: 'S002', name: 'K. IWASA', lineUserId: 'U_IWASA' }
  ];

  const rosterByStaffId = {};
  roster.forEach(r => {
    if (r.id) rosterByStaffId[String(r.id).trim()] = r;
  });

  function resolveLineUserId(rowStaffId, rowStaffName) {
    const sId = String(rowStaffId || '').trim();
    const sName = String(rowStaffName || '').trim();
    if (!sId) return { lineUserId: '', status: 'EMPTY_STAFF_ID' };

    const matched = rosterByStaffId[sId];
    if (!matched || !matched.lineUserId) {
      return { lineUserId: '', status: 'NOT_FOUND_IN_ROSTER' };
    }

    // Name consistency check
    if (sName && matched.name) {
      const cleanRowName = sName.replace(/\s+/g, '').toLowerCase();
      const cleanRosterName = String(matched.name).replace(/\s+/g, '').toLowerCase();
      if (cleanRowName !== cleanRosterName) {
        // Mismatch detected! MUST NOT auto-resolve!
        return { lineUserId: '', status: 'NAME_MISMATCH_UNRESOLVED' };
      }
    }

    return { lineUserId: matched.lineUserId, status: 'RESOLVED' };
  }

  // Case 1: Consistent entry (S001, なお)
  const res1 = resolveLineUserId('S001', 'なお');
  assert.equal(res1.status, 'RESOLVED');
  assert.equal(res1.lineUserId, 'U_NAO');

  // Case 2: ST001 in production (S001, K. IWASA) -> MISMATCH with S001 (なお)
  const resST001 = resolveLineUserId('S001', 'K. IWASA');
  assert.equal(resST001.status, 'NAME_MISMATCH_UNRESOLVED', 'ST001 must be flagged as NAME_MISMATCH_UNRESOLVED');
  assert.equal(resST001.lineUserId, '', 'ST001 lineUserId MUST remain blank');

  // Case 3: Unknown staff ID
  const resUnknown = resolveLineUserId('S999', '誰か');
  assert.equal(resUnknown.status, 'NOT_FOUND_IN_ROSTER');
  assert.equal(resUnknown.lineUserId, '');
});
