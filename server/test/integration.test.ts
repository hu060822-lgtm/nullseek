import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAPTER1_ACOUSTICS,
  DEVICE_BY_ID,
  PUZZLE_IDS,
  roleCanUseDevice,
  ROLES,
  wallZ,
  type ActionResult,
  type PuzzleFeedback,
  type RiskStatus,
  type Role,
  type RoomPublic,
  type SceneClues,
  type WorldPublic,
} from '@null-protocol/shared';
import { loadConfig } from '../src/config';
import { EchoRiskTracker } from '../src/game/echoRisk';
import { TestClient, lobbyOfThree, serverPose, serverRoom, sleep, socketDriver, startServer, startedTable, walkTo, type Table } from './net';
import { solveChapter, solveP01, solveP10Phases12 } from './solver';

const tables: Table[] = [];
const extras: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  while (tables.length) await tables.pop()!.close();
  while (extras.length) await extras.pop()!.close();
});

const track = async (t: Promise<Table>) => {
  const table = await t;
  tables.push(table);
  return table;
};

const roomOf = (c: TestClient): RoomPublic => c.of<RoomPublic>('room:state').at(-1)!;
const worldOf = (c: TestClient): WorldPublic => c.of<WorldPublic>('puzzle:state').at(-1)!;

/** 開發者工具：直接完成 n 題（開門），用來把測試快轉到後面的房間 */
async function skip(t: Table, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await t.host.call<{ ok: boolean; error?: string }>('debug:command', { cmd: 'complete_puzzle' });
    if (!r.ok) throw new Error(`快轉失敗：${r.error}`);
  }
  await sleep(40);
}

/* ------------------------------------------------------------------ */

describe('房間流程', () => {
  it('建立、加入、選角、開始；角色不能重複；人數固定三人', async () => {
    const t = await track(lobbyOfThree());
    const room = roomOf(t.clients.MUTE);
    expect(room.players).toHaveLength(3);
    expect(room.players.map((p) => p.role).sort()).toEqual([...ROLES].sort());
    expect(room.canStart).toBe(true);
    expect(room.code).toBe(t.code);
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    const extra = new TestClient(t.url, 'Dan');
    extras.push({ close: () => extra.close() });
    await extra.connect();
    const j = await extra.call<{ ok: boolean; error?: string }>('room:join', { name: 'Dan', code: t.code });
    expect(j.ok).toBe(false);
    expect(j.error).toContain('已滿');
  });

  it('不能搶別人的角色；不能在人數不足時開始；只有房主能開始', async () => {
    const t = await track(lobbyOfThree());
    const steal = await t.clients.DEAF.call<{ ok: boolean }>('room:selectRole', { role: 'BLIND' });
    expect(steal.ok).toBe(false);
    expect((await t.clients.DEAF.call<{ ok: boolean }>('room:start')).ok).toBe(false);
    await t.clients.MUTE.call('room:selectRole', { role: null });
    expect((await t.host.call<{ ok: boolean }>('room:start')).ok).toBe(false);
    await t.clients.MUTE.call('room:selectRole', { role: 'MUTE' });
    expect((await t.host.call<{ ok: boolean }>('room:start')).ok).toBe(true);
  });

  it('遊戲開始後不能換角色、不能新加入', async () => {
    const t = await track(startedTable());
    expect((await t.clients.DEAF.call<{ ok: boolean }>('room:selectRole', { role: null })).ok).toBe(false);
    const late = new TestClient(t.url, 'Late');
    extras.push({ close: () => late.close() });
    await late.connect();
    expect((await late.call<{ ok: boolean }>('room:join', { name: 'Late', code: t.code })).ok).toBe(false);
  });

  it('開始時：十道謎題、第一題進行中；每個人只收到自己的授權線索', async () => {
    const t = await track(startedTable());
    const w = worldOf(t.clients.BLIND);
    expect(w.puzzles.map((p) => p.id)).toEqual([...PUZZLE_IDS]);
    expect(w.activePuzzle).toBe('P01_THREE_LANGUAGES');
    expect(t.clients.DEAF.clues.r1Symbols).toHaveLength(3);
    expect(t.clients.BLIND.clues).toEqual({});
    expect(t.clients.MUTE.clues).toEqual({});
  });

  it('房間代碼與重連憑證不會出現在任何廣播裡', async () => {
    const t = await track(startedTable());
    for (const role of ROLES) {
      for (const other of ROLES) {
        if (other === role) continue;
        const tok = t.clients[other].token;
        const leaked = t.clients[role].events.some((e) => JSON.stringify(e.payload ?? null).includes(tok));
        expect(leaked, `${role} 不該看到 ${other} 的 token`).toBe(false);
      }
    }
  });

  it('加入不存在的房間／錯誤代碼：失敗；連續失敗會被暫時封鎖', async () => {
    const { server, url } = await startServer();
    extras.push(server);
    const c = new TestClient(url, 'brute');
    extras.push({ close: () => c.close() });
    await c.connect();
    for (let i = 0; i < 8; i++) expect((await c.call<{ ok: boolean }>('room:join', { name: 'x', code: `ZZZZ${i}Z` })).ok).toBe(false);
    const blocked = await c.call<{ ok: boolean; error?: string }>('room:join', { name: 'x', code: 'ABCDEF' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('過多');
  });

  it('不合法的暱稱與 payload 被拒絕，伺服器不會當掉', async () => {
    const { server, url } = await startServer();
    extras.push(server);
    const c = new TestClient(url, 'junk');
    extras.push({ close: () => c.close() });
    await c.connect();
    for (const bad of [undefined, null, {}, { name: '' }, { name: '   ' }, { name: 42 }, { name: '\u0000​' }]) {
      expect((await c.call<{ ok: boolean }>('room:create', bad)).ok).toBe(false);
    }
    const c2 = new TestClient(url, 'ok');
    extras.push({ close: () => c2.close() });
    await c2.connect();
    expect((await c2.call<{ ok: boolean }>('room:create', { name: '  很長的暱稱很長的暱稱很長的暱稱很長的暱稱  ' })).ok).toBe(true);
    expect((await c.call<{ ok: boolean }>('room:selectRole', { role: 'NOPE' })).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('位置與互動距離（伺服器權威）', () => {
  it('不能瞬間移動、不能穿過尚未開啟的門', async () => {
    const t = await track(startedTable({ moveSpeedMultiplier: 1 }));
    const a = t.clients.DEAF; // 出生在 (0, 2.4)，正前方是關閉的 d1
    let seq = 0;
    const send = (x: number, z: number) => a.fire('player:move', { x, y: 1.6, z, yaw: 0, seq: ++seq });

    const mark = a.mark();
    send(0, 30);
    const corr = await a.waitFor<{ x: number; z: number }>('player:correct', () => true, 3000, mark);
    expect(corr.z).toBeCloseTo(2.4, 1);

    await sleep(300);
    let z = 2.4;
    for (let i = 0; i < 50; i++) {
      z += 0.2;
      send(0, z);
      await sleep(60);
    }
    await sleep(100);
    expect(serverPose(t, 'DEAF').z).toBeLessThan(wallZ(1)); // 停在門的這一側
  });

  it('大步長也不能穿過薄牆（掃掠檢查）', async () => {
    const t = await track(startedTable({ moveSpeedMultiplier: 100 }));
    const b = t.clients.DEAF;
    let seq = 0;
    for (let z = 2.4; z <= 9.5; z += 1) {
      b.fire('player:move', { x: 0, y: 1.6, z, yaw: 0, seq: ++seq });
      await sleep(30);
    }
    b.fire('player:move', { x: 0, y: 1.6, z: 11.5, yaw: 0, seq: ++seq }); // 一步跨過 0.4 公尺厚的門
    await sleep(80);
    expect(serverPose(t, 'DEAF').z).toBeLessThan(wallZ(1));
  });

  it('距離太遠不能開啟設備、不能操作；角色不符的設備即使站在旁邊也不行', async () => {
    const t = await track(startedTable());
    const r = await t.clients.BLIND.call<{ ok: boolean; error?: string }>('device:open', { deviceId: 'r1_gen' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('太遠');
    const act = await t.clients.BLIND.action('r1_lock', 'submit', { code: [2, 5, 8] });
    expect(act.ok).toBe(false);
    expect(worldOf(t.clients.BLIND).activePuzzle).toBe('P01_THREE_LANGUAGES');

    const d = socketDriver(t);
    expect((await d.open('BLIND', 'r1_gen')).tap?.events.length).toBeGreaterThan(0);
    await walkTo(t, t.clients.MUTE, 'r1_gen');
    const m = await t.clients.MUTE.call<{ ok: boolean; error?: string }>('device:open', { deviceId: 'r1_gen' });
    expect(m.ok).toBe(false);
    expect(m.error).toContain('權限');
  });

  it('門洞：距離太遠不能進入；必須站在門洞前', async () => {
    const t = await track(startedTable({ debugTools: true }));
    await skip(t, 3);
    const far = await t.clients.MUTE.action('r4_I', 'enter');
    expect(far.ok).toBe(false);
    expect(far.message).toContain('太遠');
    const d = socketDriver(t);
    const near = await d.enter('MUTE', 'r4_I');
    expect(near.message).toContain('封住'); // 盲區員尚未確認節點
  });
});

/* ------------------------------------------------------------------ */

describe('puzzle:action 協定', () => {
  it('requestId 必填；重送同一個 requestId 只執行一次', async () => {
    const t = await track(startedTable());
    const d = socketDriver(t);
    await d.open('MUTE', 'r1_lock');
    const m = t.clients.MUTE;
    const missing = await m.call<ActionResult>('puzzle:action', { puzzleId: 'P01_THREE_LANGUAGES', actionType: 'submit', targetId: 'r1_lock', payload: { code: [1, 1, 1] } });
    expect(missing.ok).toBe(false);
    const r1 = await m.action('r1_lock', 'submit', { code: [1, 1, 1] }, 'dup-1');
    const r2 = await m.action('r1_lock', 'submit', { code: [1, 1, 1] }, 'dup-1');
    expect(r2).toEqual(r1);
    await sleep(40);
    expect(worldOf(m).stage?.attempts).toBe(1);
  });

  it('回饋依接收者感官過濾：聲音只給聽得見的人、視覺只給看得見的人', async () => {
    const t = await track(startedTable());
    const d = socketDriver(t);
    const marks = Object.fromEntries(ROLES.map((r) => [r, t.clients[r].mark()])) as Record<Role, number>;
    expect((await d.act('MUTE', 'r1_lock', 'submit', { code: [1, 1, 1] })).ok).toBe(false);
    const fb = (r: Role) => t.clients[r].waitFor<PuzzleFeedback>('puzzle:feedback', () => true, 2000, marks[r]);
    const fa = await fb('BLIND');
    expect(fa.sound).toBe('reject');
    expect(fa.visual).toBeUndefined();
    const fd = await fb('DEAF');
    expect(fd.visual).toBe('flash');
    expect(fd.sound).toBeUndefined();
    expect(await fb('MUTE')).toMatchObject({ sound: 'reject', visual: 'flash' });
  });

  it('完成事件只廣播一次；下一題的授權線索只送給對應角色', async () => {
    const t = await track(startedTable());
    const d = socketDriver(t);
    await solveP01(d);
    await sleep(60);
    for (const r of ROLES) {
      expect(t.clients[r].of<{ puzzleId: string }>('puzzle:completed').map((p) => p.puzzleId)).toEqual(['P01_THREE_LANGUAGES']);
    }
    expect(worldOf(t.clients.BLIND).doors.d1).toBe(true);
    expect(t.clients.BLIND.clues.r2Sounds).toBeTruthy();
    expect(t.clients.BLIND.clues.r2Lamps).toBeUndefined();
    expect(t.clients.DEAF.clues.r2Lamps).toBeTruthy();
    expect(t.clients.DEAF.clues.r2Sounds).toBeUndefined();
    expect(t.clients.MUTE.clues).toEqual({});
  });
});

/* ------------------------------------------------------------------ */

describe('信號器與標記：依接收者感官過濾', () => {
  it('敲擊只有聽得到的人收到；燈號／符號／手勢只有看得到的人收到', async () => {
    const t = await track(startedTable());
    const { BLIND: a, DEAF: b, MUTE: c } = t.clients;
    await a.call('signal:emit', { tokens: ['TAP_S', 'LIGHT_R', 'TAP_L', 'SYM_TRI'] });
    const toMute = await c.waitFor<{ from: Role; tokens: string[] }>('signal:received');
    expect(toMute.from).toBe('BLIND');
    expect(toMute.tokens).toEqual(['TAP_S', 'LIGHT_R', 'TAP_L', 'SYM_TRI']);
    const toDeaf = await b.waitFor<{ tokens: string[] }>('signal:received');
    expect(toDeaf.tokens).toEqual(['LIGHT_R', 'SYM_TRI']);
  });

  it('只有敲擊的訊號：靜默員完全收不到；只有燈號的訊號：盲區員完全收不到', async () => {
    const t = await track(startedTable());
    await t.clients.MUTE.call('signal:emit', { tokens: ['TAP_S', 'TAP_L'] });
    await t.clients.BLIND.waitFor('signal:received');
    await t.clients.DEAF.expectNone('signal:received');
    await sleep(1600); // 信號器冷卻
    await t.clients.MUTE.call('signal:emit', { tokens: ['LIGHT_G', 'GEST_YES'] });
    await t.clients.DEAF.waitFor('signal:received');
    await t.clients.BLIND.expectNone('signal:received');
  });

  it('信號器沒有自由文字：不在詞彙內、過長、過於頻繁都被拒絕', async () => {
    const t = await track(startedTable());
    const m = t.clients.MUTE;
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['HELLO'] })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['<script>'] })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: Array(7).fill('TAP_S') })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: [] })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: 'TAP_S' })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['TAP_S'] })).ok).toBe(true);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['TAP_S'] })).ok).toBe(false);
  });

  it('標記工具只有失語員能用；附帶的符號只給感知得到的人；不會推進謎題', async () => {
    const t = await track(startedTable());
    const { BLIND: a, DEAF: b, MUTE: c } = t.clients;
    expect((await a.call<{ ok: boolean }>('signal:mark', { targetId: 'r1_lock' })).ok).toBe(false);
    expect((await c.call<{ ok: boolean }>('signal:mark', { targetId: 'nope' })).ok).toBe(false);
    expect((await c.call<{ ok: boolean }>('signal:mark', { targetId: 'r1_lock', token: 'SYM_TRI' })).ok).toBe(true);
    const toDeaf = await b.waitFor<{ from: Role; targetId: string; token?: string }>('signal:marker');
    expect(toDeaf).toMatchObject({ from: 'MUTE', targetId: 'r1_lock', token: 'SYM_TRI' });
    const toBlind = await a.waitFor<{ targetId: string; token?: string }>('signal:marker');
    expect(toBlind.targetId).toBe('r1_lock');
    expect(toBlind.token).toBeUndefined(); // 盲區員看不到符號
    expect(worldOf(a).stage?.attempts).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('開發者工具', () => {
  it('正式設定下預設關閉；開發環境預設開啟；DEBUG_TOOLS 可覆寫', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).debugTools).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', DEBUG_TOOLS: '1' }).debugTools).toBe(true);
    expect(loadConfig({ NODE_ENV: 'development' }).debugTools).toBe(true);
    expect(loadConfig({ NODE_ENV: 'development', DEBUG_TOOLS: '0' }).debugTools).toBe(false);
  });

  it('關閉時：查看狀態與指令一律拒絕，也不會出現在同步資料裡', async () => {
    const t = await track(startedTable({ debugTools: false }));
    expect((await t.host.call<{ ok: boolean }>('debug:state')).ok).toBe(false);
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'complete_puzzle' })).ok).toBe(false);
    expect(worldOf(t.host).activePuzzle).toBe('P01_THREE_LANGUAGES');
    const rejoin = new TestClient(t.url, 'tab');
    extras.push({ close: () => rejoin.close() });
    await rejoin.connect();
    const r = await rejoin.call<{ ok: boolean; sync: { debug: boolean } }>('room:rejoin', { code: t.code, token: t.clients.DEAF.token });
    expect(r.sync.debug).toBe(false);
    for (const role of ROLES) expect(JSON.stringify(t.clients[role].events)).not.toContain('"answer"');
  });

  it('開啟時：查看正解與條件、重置目前謎題、直接完成、重新初始化房間', async () => {
    const t = await track(startedTable({ debugTools: true }));
    const st = await t.host.call<{ ok: boolean; state: { answer: string; activePuzzle: string } }>('debug:state');
    expect(st.ok).toBe(true);
    expect(st.state.answer).toBe('258');
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'reset_puzzle' })).ok).toBe(true);
    await t.clients.DEAF.waitFor('puzzle:reset');
    await skip(t, 2);
    expect(worldOf(t.clients.MUTE).activePuzzle).toBe('P03_REVERSED_ARCHIVE');
    const mark = t.clients.MUTE.mark();
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'reinit_room' })).ok).toBe(true);
    await t.clients.MUTE.waitFor<WorldPublic>('puzzle:state', (w) => w.activePuzzle === 'P01_THREE_LANGUAGES', 2000, mark);
    await t.clients.MUTE.waitFor('player:correct', () => true, 2000, mark);
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'bogus' })).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('身體姿態（角色動畫用；不影響碰撞與權限）', () => {
  type Pos = Record<string, { x: number; z: number; crouch?: boolean; act?: string; hurt?: number }>;
  const lastPos = (c: TestClient, role: Role) => c.of<Pos>('world:positions').at(-1)?.[role];

  it('蹲下會同步給隊友；客戶端不能自稱「正在操作」', async () => {
    const t = await track(startedTable());
    const { BLIND: a, DEAF: b } = t.clients;
    a.fire('player:stance', { crouch: true, panel: true });
    await b.waitFor<Pos>('world:positions', (m) => !!m.BLIND?.crouch);
    await sleep(150);
    expect(lastPos(b, 'BLIND')?.act).toBeUndefined(); // panel:true 不會讓伺服器認定在操作
    a.fire('player:stance', { crouch: false, panel: false });
    await b.waitFor<Pos>('world:positions', (m) => !!m.BLIND && !m.BLIND.crouch);
    // 不合法的資料：忽略，伺服器不會當掉
    a.fire('player:stance', { crouch: 'yes', panel: 1 });
    a.fire('player:stance', null);
    await sleep(150);
    expect(lastPos(b, 'BLIND')?.crouch).toBeFalsy();
  });

  it('開啟設備成功 → 隊友看到「觀察／操作」；關閉面板或走開 → 結束；資料不含設備名稱', async () => {
    const t = await track(startedTable());
    const d = socketDriver(t);
    const { BLIND: a, DEAF: b, MUTE: c } = t.clients;
    await d.open('DEAF', 'r1_lamps'); // 燈號面板：觀察
    const seen = await c.waitFor<Pos>('world:positions', (m) => m.DEAF?.act === 'inspect');
    expect(JSON.stringify(seen)).not.toContain('r1_lamps');
    b.fire('player:stance', { crouch: false, panel: false });
    await c.waitFor<Pos>('world:positions', (m) => !!m.DEAF && !m.DEAF.act);
    await d.open('BLIND', 'r1_gen'); // 機械設備：操作
    await c.waitFor<Pos>('world:positions', (m) => m.BLIND?.act === 'interact');
    await walkTo(t, a, 'r1_lock'); // 走開超過 1.2 m
    await c.waitFor<Pos>('world:positions', (m) => !!m.BLIND && !m.BLIND.act);
  });

  it('答錯被設備鎖定 → 該角色的受傷次數增加（隊友看到觸電反應）', async () => {
    const t = await track(startedTable());
    const d = socketDriver(t);
    const r = await d.act('MUTE', 'r1_lock', 'submit', { code: [1, 1, 1] });
    expect(r.ok).toBe(false);
    const m = await t.clients.DEAF.waitFor<Pos>('world:positions', (x) => (x.MUTE?.hurt ?? 0) >= 1);
    expect(m.MUTE?.hurt).toBe(1);
    expect(m.BLIND?.hurt).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe('回聲風險區（聲學感測器；伺服器權威）', () => {
  const def = CHAPTER1_ACOUSTICS.risks[0];

  /** 讓感測器使用可控制的時鐘，並把盲區員的伺服器位置放到感測器下方（只在測試中直接設定） */
  function rig(t: Table): { setT: (ms: number) => void } {
    let now = 0;
    const room = serverRoom(t);
    room.risk = new EchoRiskTracker(CHAPTER1_ACOUSTICS.risks, () => now);
    const pose = serverPose(t, 'BLIND');
    pose.x = def.pos[0];
    pose.z = def.pos[1];
    return { setT: (ms) => void (now = ms) };
  }

  it('開始時的同步資料含有感測器狀態；狀態改變時廣播給全隊', async () => {
    const t = await track(startedTable());
    const r = await t.clients.MUTE.call<{ ok: boolean; sync: { risks: RiskStatus[] } }>('room:rejoin', { code: t.code, token: t.clients.MUTE.token });
    expect(r.ok).toBe(true);
    expect(r.sync.risks.map((x) => x.id)).toEqual([def.id]);
    const clock = rig(t);
    clock.setT(def.idleMs + 10);
    const st = await t.clients.DEAF.waitFor<RiskStatus[]>('risk:state', (l) => l[0]?.state === 'armed');
    expect(Object.keys(st[0]).sort()).toEqual(['id', 'msLeft', 'state']);
  });

  it('警戒中、在範圍內發出回聲 → 全隊收到警報與通知；休息中不會；其他角色的脈衝被忽略', async () => {
    const t = await track(startedTable());
    const { BLIND: a, DEAF: b, MUTE: c } = t.clients;
    const clock = rig(t);
    clock.setT(100); // 休息中
    a.fire('echo:pulse');
    await b.expectNone('risk:tripped');
    clock.setT(def.idleMs + 100); // 警戒中
    b.fire('echo:pulse'); // 靜默員、失語員沒有回聲能力：伺服器直接忽略
    c.fire('echo:pulse');
    await a.expectNone('risk:tripped');
    clock.setT(def.idleMs + 2000);
    a.fire('echo:pulse');
    for (const x of [a, b, c]) {
      const hit = await x.waitFor<{ id: string; jamMs: number }>('risk:tripped');
      expect(hit).toEqual({ id: def.id, jamMs: def.jamMs });
    }
    await b.waitFor<{ text: string }>('notice', (n) => n.text.includes('聲學感測器'));
    // 後果可以挽回：謎題狀態沒有改變
    expect(worldOf(b).activePuzzle).toBe(PUZZLE_IDS[0]);
    // 重新整理頁面（重連）不會解除干擾；干擾時間只給盲區員
    const ra = await a.call<{ ok: boolean; sync: { echoJamMs?: number } }>('room:rejoin', { code: t.code, token: a.token });
    expect(ra.sync.echoJamMs).toBeGreaterThan(0);
    const rb = await b.call<{ ok: boolean; sync: { echoJamMs?: number } }>('room:rejoin', { code: t.code, token: b.token });
    expect(rb.sync.echoJamMs).toBeUndefined();
  });

  it('客戶端不能謊報位置：伺服器只看自己記錄的位置（盲區員實際在 R1 時發出回聲不會觸發）', async () => {
    const t = await track(startedTable());
    let now = 0;
    serverRoom(t).risk = new EchoRiskTracker(CHAPTER1_ACOUSTICS.risks, () => now);
    now = def.idleMs + 100;
    t.clients.BLIND.fire('echo:pulse', { x: def.pos[0], z: def.pos[1] }); // 夾帶的資料一律忽略
    await t.clients.DEAF.expectNone('risk:tripped', () => true, 300);
  });
});

describe('語音 signaling：由伺服器驗證角色路由', () => {
  const sdp = (dir: string, extra = '') =>
    ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', `a=${dir}`, 'a=rtpmap:111 opus/48000/2', extra]
      .filter(Boolean)
      .join('\r\n') + '\r\n';
  const offer = (from: Role, to: Role, s: string) => ({ to, edge: { from, to }, kind: 'offer', sdp: s });
  const answer = (from: Role, to: Role, s: string) => ({ to: from, edge: { from, to }, kind: 'answer', sdp: s });

  it('語音路由規則恰為三條邊：盲區員→失語員、靜默員→盲區員、靜默員→失語員', async () => {
    const { VOICE_EDGES, voiceEdgeAllowed } = await import('@null-protocol/shared');
    expect(VOICE_EDGES.map(([f, to]) => `${f}>${to}`).sort()).toEqual(['BLIND>MUTE', 'DEAF>BLIND', 'DEAF>MUTE']);
    for (const r of ROLES) {
      expect(voiceEdgeAllowed('MUTE', r)).toBe(false);
      expect(voiceEdgeAllowed(r, 'DEAF')).toBe(false);
    }
  });

  it('允許的邊：offer 與 answer 會被轉發', async () => {
    const t = await track(lobbyOfThree());
    const { BLIND: a, DEAF: b, MUTE: c } = t.clients;
    b.fire('voice:signal', offer('DEAF', 'BLIND', sdp('sendonly')));
    const got = await a.waitFor<{ from: Role; kind: string }>('voice:signal');
    expect(got).toMatchObject({ from: 'DEAF', kind: 'offer' });
    a.fire('voice:signal', answer('DEAF', 'BLIND', sdp('recvonly')));
    expect((await b.waitFor<{ from: Role; kind: string }>('voice:signal', (p) => p.kind === 'answer')).from).toBe('BLIND');
    a.fire('voice:signal', offer('BLIND', 'MUTE', sdp('sendonly')));
    await c.waitFor<{ from: Role; kind: string }>('voice:signal', (p) => p.from === 'BLIND' && p.kind === 'offer');
  });

  it('不允許的邊、SDP 方向不對、含視訊或 DataChannel、冒充：全部被丟棄', async () => {
    const t = await track(lobbyOfThree());
    const { BLIND: a, DEAF: b, MUTE: c } = t.clients;
    c.fire('voice:signal', offer('MUTE', 'BLIND', sdp('sendonly')));
    c.fire('voice:signal', offer('MUTE', 'DEAF', sdp('sendonly')));
    a.fire('voice:signal', offer('BLIND', 'DEAF', sdp('sendonly')));
    b.fire('voice:signal', answer('BLIND', 'DEAF', sdp('recvonly')));
    b.fire('voice:signal', offer('DEAF', 'BLIND', sdp('sendrecv')));
    b.fire('voice:signal', offer('DEAF', 'BLIND', sdp('sendonly') + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sendonly\r\n'));
    b.fire('voice:signal', offer('DEAF', 'MUTE', sdp('sendonly') + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n'));
    a.fire('voice:signal', answer('DEAF', 'BLIND', sdp('sendonly')));
    b.fire('voice:signal', offer('BLIND', 'MUTE', sdp('sendonly')));
    b.fire('voice:signal', { to: 'BLIND', edge: { from: 'DEAF', to: 'BLIND' }, kind: 'offer' });
    b.fire('voice:signal', offer('DEAF', 'BLIND', sdp('sendonly', 'a=x:' + 'y'.repeat(25_000))));
    await a.expectNone('voice:signal');
    await b.expectNone('voice:signal');
    await c.expectNone('voice:signal');
  });

  it('語音上線通知：準備好的隊友會互相收到 voice:peer', async () => {
    const t = await track(lobbyOfThree());
    const { BLIND: a, DEAF: b } = t.clients;
    b.fire('voice:ready', { micEnabled: true });
    expect(await a.waitFor<{ role: Role }>('voice:peer', (x) => x.role === 'DEAF')).toMatchObject({ role: 'DEAF', connected: true, micEnabled: true });
    a.fire('voice:ready', { micEnabled: false });
    expect((await b.waitFor<{ role: Role }>('voice:peer', (x) => x.role === 'BLIND')).role).toBe('BLIND');
  });
});

/* ------------------------------------------------------------------ */

describe('斷線與重連', () => {
  it('重連後恢復原本角色、位置、線索紀錄與「只屬於自己」的授權線索；錯誤憑證被拒', async () => {
    const t = await track(startedTable());
    const d = socketDriver(t);
    await d.open('BLIND', 'r1_gen');
    await d.open('DEAF', 'r1_lamps');
    const deaf = t.clients.DEAF;
    const before = { x: deaf.x, z: deaf.z };

    deaf.socket.disconnect();
    await t.clients.BLIND.waitFor<RoomPublic>('room:state', (r) => r.players.some((p) => p.role === 'DEAF' && !p.connected));

    const again = new TestClient(t.url, 'Bao2');
    extras.push({ close: () => again.close() });
    await again.connect();
    expect((await again.call<{ ok: boolean }>('room:rejoin', { code: t.code, token: 'x'.repeat(48) })).ok).toBe(false);
    expect((await again.call<{ ok: boolean }>('room:rejoin', { code: 'AAAAAA', token: deaf.token })).ok).toBe(false);

    const ok = await again.call<{ ok: boolean; sync: { me: { role: Role }; room: RoomPublic; pos: { x: number; z: number }; log: Array<{ deviceId: string }>; world: WorldPublic; clues: SceneClues } }>(
      'room:rejoin',
      { code: t.code, token: deaf.token },
    );
    expect(ok.ok).toBe(true);
    expect(ok.sync.me.role).toBe('DEAF');
    expect(ok.sync.room.phase).toBe('PLAYING');
    expect(ok.sync.pos.x).toBeCloseTo(before.x, 1);
    expect(ok.sync.pos.z).toBeCloseTo(before.z, 1);
    expect(ok.sync.log.map((l) => l.deviceId)).toEqual(['r1_lamps']);
    expect(ok.sync.world.activePuzzle).toBe('P01_THREE_LANGUAGES');
    expect(ok.sync.clues.r1Symbols).toHaveLength(3);
    await t.clients.BLIND.waitFor<RoomPublic>('room:state', (r) => r.players.every((p) => p.connected));
  });

  it('同一個憑證在另一個分頁重連，舊連線會被取代', async () => {
    const t = await track(startedTable());
    const tab2 = new TestClient(t.url, 'tab2');
    extras.push({ close: () => tab2.close() });
    await tab2.connect();
    expect((await tab2.call<{ ok: boolean }>('room:rejoin', { code: t.code, token: t.clients.MUTE.token })).ok).toBe(true);
    await sleep(100);
    expect(t.clients.MUTE.socket.connected).toBe(false);
    const open = await tab2.call<{ ok: boolean; error?: string }>('device:open', { deviceId: 'r1_card' });
    expect(open.ok).toBe(false);
    expect(open.error).toContain('太遠'); // 已被識別為 MUTE（錯誤是距離而不是未加入）
  });

  it('隊友離線時，三人同步操作暫停', async () => {
    const t = await track(startedTable({ debugTools: true }));
    await skip(t, 9);
    const d = socketDriver(t);
    await solveP10Phases12(d);
    for (const [role, id] of [['BLIND', 'r10_core_a'], ['DEAF', 'r10_core_b'], ['MUTE', 'r10_core_c']] as const) {
      expect((await d.act(role, id, 'verify')).ok).toBe(true);
    }
    t.clients.BLIND.socket.disconnect();
    await t.clients.MUTE.waitFor<RoomPublic>('room:state', (r) => r.players.some((p) => p.role === 'BLIND' && !p.connected));
    const r = await t.clients.MUTE.action('r10_core_c', 'choose', { mode: 'CONSENSUS' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('離線');
  });
});

/* ------------------------------------------------------------------ */

describe('完整通關（三個 socket 客戶端，真的走路、開面板、走門洞、解謎）', () => {
  it('十個謎題 → 第一章完成；全程沒有任何角色收到不屬於自己感官的資料或答案', async () => {
    const t = await track(startedTable());
    const d = socketDriver(t);
    const { BLIND: a, DEAF: b, MUTE: c } = t.clients;

    await solveChapter(d);
    for (const cl of [a, b, c]) await cl.waitFor('chapter:complete');
    const w = worldOf(a);
    expect(w.chapterComplete).toBe(true);
    expect(Object.values(w.doors).every(Boolean)).toBe(true);
    expect(w.puzzles.every((p) => p.status === 'completed')).toBe(true);
    expect(roomOf(a).phase).toBe('COMPLETE');
    expect(c.of<{ puzzleId: string }>('puzzle:completed').map((p) => p.puzzleId)).toEqual([...PUZZLE_IDS]);

    // —— 洩漏檢查 ——
    const dump = (cl: TestClient) => cl.events.map((e) => JSON.stringify(e.payload ?? null)).join('\n');
    const blind = dump(a);
    const deaf = dump(b);
    // 靜默員：從頭到尾沒有收過任何聲音資料（敲擊、聲音回饋、門後聲音、回音）
    expect(deaf).not.toContain('"tap"');
    expect(deaf).not.toContain('"sound":"');
    expect(deaf).not.toContain('r2Sounds');
    // 盲區員：從頭到尾沒有收過任何視覺資料
    for (const k of ['"type":"symbols"', '"type":"lights"', '"type":"slots"', '"type":"pulses"', '"type":"table"', '"visual":"', 'r1Symbols', 'r2Lamps', 'r4Landmark', 'r9Labels', 'r9Lights']) {
      expect(blind, k).not.toContain(k);
    }
    // 每個人的線索紀錄只來自自己角色能使用的設備（文件只在失語員手上、敲擊源只在盲區員手上…）
    for (const role of ROLES) {
      const entries = t.clients[role].of<Array<{ deviceId: string }>>('player:log').flat();
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expect(roleCanUseDevice(role, DEVICE_BY_ID[e.deviceId]), `${role} 收到 ${e.deviceId}`).toBe(true);
    }
    // 任何人都沒有收過答案或除錯資料
    for (const cl of [a, b, c]) {
      const s = dump(cl);
      expect(s).not.toContain('"answer"');
      expect(s).not.toContain('"conditions"');
    }
  }, 240_000);
});

/* ------------------------------------------------------------------ */

describe('提示與重新開始', () => {
  it('提示廣播給全員（puzzle:hint）；房主可以重新開始並回到大廳（保留角色）', async () => {
    const t = await track(startedTable());
    const r = await t.clients.DEAF.call<{ ok: boolean; tier: number; puzzle: string }>('hint:request');
    expect(r).toMatchObject({ ok: true, tier: 1, puzzle: 'P01_THREE_LANGUAGES' });
    for (const role of ROLES) {
      const h = await t.clients[role].waitFor<{ puzzleId: string; tier: number; text: string }>('puzzle:hint');
      expect(h).toMatchObject({ puzzleId: 'P01_THREE_LANGUAGES', tier: 1 });
    }
    expect((await t.clients.DEAF.call<{ ok: boolean }>('room:restart')).ok).toBe(false);
    const mark = t.clients.MUTE.mark();
    expect((await t.host.call<{ ok: boolean }>('room:restart')).ok).toBe(true);
    const room = await t.clients.MUTE.waitFor<RoomPublic>('room:state', (x) => x.phase === 'LOBBY', 3000, mark);
    expect(room.players.map((p) => p.role).sort()).toEqual([...ROLES].sort());
    expect((await t.host.call<{ ok: boolean }>('room:start')).ok).toBe(true);
    const w = await t.clients.BLIND.waitFor<WorldPublic>('puzzle:state', (x) => x.puzzles[0].status === 'active', 3000, mark);
    expect(w.activePuzzle).toBe('P01_THREE_LANGUAGES');
  });
});
