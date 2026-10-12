import { afterEach, describe, expect, it } from 'vitest';
import { PUZZLE_IDS, type Role } from '@null-protocol/shared';
import { bench, nextRequestId, type Bench } from './harness';
import { solveP10Phases12 } from './solver';

const benches: Bench[] = [];
const mk = (...a: Parameters<typeof bench>) => {
  const b = bench(...a);
  benches.push(b);
  return b;
};
afterEach(() => {
  while (benches.length) benches.pop()!.dispose();
});

describe('共用謎題框架', () => {
  it('初始化：十道謎題、第一題 active、其餘 locked；門全關', () => {
    const { chapter } = mk();
    const w = chapter.world();
    expect(w.puzzles.map((p) => p.id)).toEqual([...PUZZLE_IDS]);
    expect(w.puzzles[0].status).toBe('active');
    expect(w.puzzles.slice(1).every((p) => p.status === 'locked')).toBe(true);
    expect(Object.values(w.doors).every((o) => !o)).toBe(true);
    expect(w.stage?.attempts).toBe(0);
  });

  it('公開狀態與授權線索不含答案', () => {
    const { chapter } = mk();
    const json = JSON.stringify(chapter.world());
    expect(json).not.toContain('258');
    for (const r of ['BLIND', 'DEAF', 'MUTE'] as Role[]) expect(JSON.stringify(chapter.cluesFor(r))).not.toContain('258');
  });

  it('操作必須帶 requestId；重送同一個 requestId 不會重複執行', () => {
    const b = mk();
    const missing = b.chapter.action('p', 'MUTE', { puzzleId: 'P01_THREE_LANGUAGES', actionType: 'submit', targetId: 'r1_lock', payload: { code: [1, 1, 1] }, requestId: '' });
    expect(missing.ok).toBe(false);
    const id = nextRequestId();
    const r1 = b.act('MUTE', 'r1_lock', 'submit', { code: [1, 1, 1] }, id);
    const r2 = b.act('MUTE', 'r1_lock', 'submit', { code: [1, 1, 1] }, id);
    expect(r1).toBe(r2);
    expect(b.chapter.world().stage?.attempts).toBe(1);
  });

  it('同一個成功請求重送：只觸發一次完成事件', () => {
    const b = mk();
    const id = nextRequestId();
    expect(b.act('BLIND', 'r1_lock', 'submit', { code: [2, 5, 8] }, id).ok).toBe(true);
    expect(b.act('BLIND', 'r1_lock', 'submit', { code: [2, 5, 8] }, id).ok).toBe(true);
    expect(b.rec.completed).toHaveLength(1);
    // 換一個新的 requestId 再送：謎題已完成，拒絕
    const again = b.chapter.action('player-BLIND', 'BLIND', { puzzleId: 'P01_THREE_LANGUAGES', actionType: 'submit', targetId: 'r1_lock', payload: { code: [2, 5, 8] }, requestId: nextRequestId() });
    expect(again.ok).toBe(false);
    expect(again.message).toContain('已經完成');
    expect(b.rec.completed).toHaveLength(1);
  });

  it('尚未開始的謎題、與目前謎題無關的設備、無權限的角色：一律拒絕且不改變狀態', () => {
    const b = mk();
    const before = JSON.stringify(b.chapter.world().puzzles);
    const locked = b.chapter.action('p', 'DEAF', { puzzleId: 'P02_PHANTOM_DOOR', actionType: 'push', targetId: 'r2_door_B', requestId: nextRequestId() });
    expect(locked.ok).toBe(false);
    expect(locked.message).toContain('還沒開始');
    expect(b.act('DEAF', 'r2_door_B', 'push').ok).toBe(false); // 屬於 P02 的設備
    expect(b.act('DEAF', 'r1_gen', 'play').message).toContain('權限');
    expect(b.act('BLIND', 'r1_card', 'x').message).toContain('權限');
    expect(b.act('MUTE', 'nope', 'x').ok).toBe(false);
    expect(JSON.stringify(b.chapter.world().puzzles)).toBe(before);
  });

  it('前端送來的 isCorrect／success／solved 一律無效', () => {
    const b = mk();
    const r = b.act('MUTE', 'r1_lock', 'submit', { code: [1, 2, 3], isCorrect: true, success: true, solved: true });
    expect(r.ok).toBe(false);
    expect(b.chapter.activeId).toBe('P01_THREE_LANGUAGES');
  });

  it('角色專屬設備的面板權限', () => {
    const b = mk();
    expect(b.chapter.openDevice('DEAF', 'r1_gen').ok).toBe(false);
    expect(b.chapter.openDevice('BLIND', 'r1_lamps').ok).toBe(false);
    expect(b.chapter.openDevice('BLIND', 'r1_card').ok).toBe(false);
    expect(b.chapter.openDevice('DEAF', 'r1_card').ok).toBe(false);
    expect(b.chapter.openDevice('MUTE', 'r1_lock').ok).toBe(true);
  });

  it('答案錯誤會暫時鎖定（只鎖這個角色的這台設備），之後可以再試', async () => {
    const b = mk({ lockBaseMs: 80 });
    expect(b.act('MUTE', 'r1_lock', 'submit', { code: [1, 1, 1] }).lockMs).toBe(80);
    const locked = b.act('MUTE', 'r1_lock', 'submit', { code: [2, 5, 8] });
    expect(locked.ok).toBe(false);
    expect(locked.message).toContain('鎖定');
    // 其他角色不受影響
    expect(b.act('DEAF', 'r1_lock', 'submit', { code: [1, 1, 2] }).lockMs).toBe(80);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.act('MUTE', 'r1_lock', 'submit', { code: [2, 5, 8] }).ok).toBe(true);
  });

  it('提示：三層、廣播、冷卻；用完後拒絕', async () => {
    const b = mk({ hintCooldownMs: 30 });
    const h1 = b.chapter.requestHint();
    expect(h1.ok && h1.tier).toBe(1);
    expect(b.chapter.requestHint().ok).toBe(false); // 冷卻中
    await new Promise((r) => setTimeout(r, 40));
    expect(b.chapter.requestHint().ok).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(b.chapter.requestHint().ok).toBe(true);
    expect(b.chapter.requestHint().ok).toBe(false);
    expect(b.rec.hints.map((h) => h.tier)).toEqual([1, 2, 3]);
    expect(b.chapter.world().hints.used).toBe(3);
  });

  it('除錯工具：查看正解、重置目前謎題、直接完成', () => {
    const b = mk();
    b.act('MUTE', 'r1_lock', 'submit', { code: [1, 1, 1] });
    const st = b.chapter.debugState({ Aki: 'BLIND' });
    expect(st.answer).toBe('258');
    expect(st.recent).toHaveLength(1);
    expect(b.chapter.debugCommand('reset_puzzle')).toBe(true);
    expect(b.chapter.world().stage?.attempts).toBe(0);
    expect(b.rec.resets).toEqual([{ id: 'P01_THREE_LANGUAGES', scope: 'full' }]);
    expect(b.chapter.debugCommand('complete_puzzle')).toBe(true);
    expect(b.chapter.activeId).toBe('P02_PHANTOM_DOOR');
    expect(b.chapter.world().doors.d1).toBe(true);
  });

  it('依序完成十題：每完成一題開一扇門；第十題完成觸發章節結束一次', () => {
    const b = mk();
    for (let i = 0; i < 10; i++) expect(b.chapter.debugCommand('complete_puzzle')).toBe(true);
    const w = b.chapter.world();
    expect(w.chapterComplete).toBe(true);
    expect(Object.values(w.doors).every(Boolean)).toBe(true);
    expect(b.rec.chapterComplete).toBe(1);
    expect(b.chapter.debugCommand('complete_puzzle')).toBe(false);
  });

  it('純查詢（試聽參考音）不會要求其他人的面板刷新；改變狀態的操作才會', () => {
    const b = mk();
    b.chapter.debugCommand('complete_puzzle');
    b.chapter.debugCommand('complete_puzzle');
    expect(b.chapter.activeId).toBe('P03_REVERSED_ARCHIVE');
    const before = b.rec.refresh;
    const r = b.act('BLIND', 'r3_taps', 'ref_1');
    expect(r.ok).toBe(true);
    expect(r.view?.tap?.events).toHaveLength(1);
    expect(b.rec.refresh).toBe(before);
    b.chapter.debugCommand('complete_puzzle');
    b.chapter.debugCommand('complete_puzzle');
    const mid = b.rec.refresh;
    expect(b.act('BLIND', 'r5_lever', 'lever_LEFT').ok).toBe(true); // 撥桿：靜默員的控制台會顯示
    expect(b.rec.refresh).toBe(mid + 1);
  });

  it('線索紀錄：看過的線索會記在該角色的紀錄裡；盲區員的紀錄只有聲音（可重聽）', () => {
    const b = mk();
    b.open('BLIND', 'r1_gen');
    b.open('DEAF', 'r1_lamps');
    expect(b.rec.logs.BLIND[0].audioOnly).toBe(true);
    expect(b.rec.logs.BLIND[0].tap?.events.length).toBeGreaterThan(0);
    expect(b.rec.logs.BLIND[0].blocks).toEqual([]);
    expect(b.rec.logs.DEAF[0].blocks.some((x) => x.type === 'symbols')).toBe(true);
    expect(b.rec.logs.MUTE).toHaveLength(0);
  });
});

describe('離線與同步', () => {
  it('有人離線時不能啟動同步；同步窗口進行中有人離線會取消這一輪（不算失敗）', async () => {
    const b = mk({ syncWindowMs: 5000 });
    for (let i = 0; i < 9; i++) b.chapter.debugCommand('complete_puzzle');
    await solveP10Phases12(b.driver);
    for (const [role, id] of [['BLIND', 'r10_core_a'], ['DEAF', 'r10_core_b'], ['MUTE', 'r10_core_c']] as const) b.act(role, id, 'verify');
    b.rec.connected.BLIND = false;
    const r = b.act('MUTE', 'r10_core_c', 'choose', { mode: 'CONSENSUS' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('離線');
    b.rec.connected.BLIND = true;
    expect(b.act('MUTE', 'r10_core_c', 'choose', { mode: 'CONSENSUS' }).ok).toBe(true);
    expect(b.chapter.debugState({}).syncRemainingMs).toBeGreaterThan(0);
    const attempts = b.chapter.world().stage?.attempts;
    b.rec.connected.DEAF = false;
    b.chapter.onPresenceChange();
    expect(b.chapter.debugState({}).syncRemainingMs).toBeNull();
    expect(b.chapter.world().stage?.attempts).toBe(attempts);
    expect(b.rec.notices.at(-1)?.text).toContain('離線');
  });
});
