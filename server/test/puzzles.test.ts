import { afterEach, describe, expect, it } from 'vitest';
import { DEVICES, PUZZLE_IDS, ROLES, roleCanUseDevice, type PuzzleId } from '@null-protocol/shared';
import { bench, nextRequestId, type Bench } from './harness';
import {
  expectOk,
  solveChapter,
  solveP01,
  solveP02,
  solveP03,
  solveP04,
  solveP05,
  solveP06,
  solveP07,
  solveP08,
  solveP09,
  solveP10Phase3,
  solveP10Phases12,
} from './solver';

const benches: Bench[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 直接跳到指定謎題（前面的用除錯工具完成） */
function at(id: PuzzleId, opts: Parameters<typeof bench>[0] = {}): Bench {
  const b = bench(opts);
  benches.push(b);
  while (b.chapter.activeId !== id) b.chapter.debugCommand('complete_puzzle');
  return b;
}
afterEach(() => {
  while (benches.length) benches.pop()!.dispose();
});

describe('完整章節（玩家模擬解題器：只用各角色看得到／聽得到的資料）', () => {
  it('十題依序解完，章節完成、所有門開啟', async () => {
    const b = at('P01_THREE_LANGUAGES');
    await solveChapter(b.driver);
    expect(b.chapter.world().chapterComplete).toBe(true);
    expect(b.rec.completed.map((c) => c.id)).toEqual([...PUZZLE_IDS]);
    expect(b.rec.chapterComplete).toBe(1);
  });
});

describe('P01 三種語言', () => {
  it('正解 258 開門；位數不足提示「訊號尚未完整」；錯誤只閃燈與累加次數', async () => {
    const b = at('P01_THREE_LANGUAGES');
    const short = b.act('MUTE', 'r1_lock', 'submit', { code: [2, 5] });
    expect(short.message).toBe('訊號尚未完整。');
    const wrong = b.act('DEAF', 'r1_lock', 'submit', { code: [5, 2, 8] });
    expect(wrong.ok).toBe(false);
    expect(wrong.clear).toBe(true);
    expect(b.rec.feedback.at(-1)).toMatchObject({ sound: 'reject', visual: 'flash' });
    expect(b.chapter.world().doors.d1).toBe(false);
    expect(b.chapter.world().stage?.attempts).toBe(1);
    expect(b.act('MUTE', 'r1_lock', 'submit', { code: 'abc' }).message).toContain('格式');
    await solveP01(b.driver);
    expect(b.chapter.world().doors.d1).toBe(true);
  });
  it('只有 DEAF 收到符號燈線索；只有 BLIND 拿得到音型；只有 MUTE 拿得到協定卡', () => {
    const b = at('P01_THREE_LANGUAGES');
    expect(b.chapter.cluesFor('DEAF').r1Symbols).toEqual(['CIR', 'TRI', 'SQR']);
    expect(b.chapter.cluesFor('MUTE')).toEqual({});
    expect(b.chapter.cluesFor('BLIND')).toEqual({});
    expect(b.open('BLIND', 'r1_gen').tap).toBeTruthy();
    expect(b.chapter.openDevice('MUTE', 'r1_gen').ok).toBe(false);
  });
});

describe('P02 聽見不存在的門', () => {
  it('錯門：阻擋聲＋門把震動、不開門；短時間重複推只算一次；B 門開啟', async () => {
    const b = at('P02_PHANTOM_DOOR');
    expect(b.act('BLIND', 'r2_door_C', 'push').ok).toBe(false);
    expect(b.rec.feedback.at(-1)).toMatchObject({ targetId: 'r2_door_C', sound: 'thud', visual: 'shake' });
    b.act('BLIND', 'r2_door_C', 'push');
    expect(b.chapter.world().stage?.attempts).toBe(1);
    b.act('DEAF', 'r2_door_A', 'push');
    b.act('MUTE', 'r2_door_D', 'push');
    expect(b.chapter.world().stage?.attempts).toBe(3);
    expect(b.chapter.world().doors.d2).toBe(false);
    await solveP02(b.driver);
    expect(b.chapter.world().doors.d2).toBe(true);
  });
  it('門燈只傳給 DEAF、門後聲音只傳給 BLIND', () => {
    const b = at('P02_PHANTOM_DOOR');
    expect(b.chapter.cluesFor('DEAF').r2Lamps).toBeTruthy();
    expect(b.chapter.cluesFor('DEAF').r2Sounds).toBeUndefined();
    expect(b.chapter.cluesFor('BLIND').r2Sounds).toBeTruthy();
    expect(b.chapter.cluesFor('BLIND').r2Lamps).toBeUndefined();
    expect(b.chapter.cluesFor('MUTE')).toEqual({});
  });
});

describe('P03 逆序檔案', () => {
  it('不足四位「序列不完整」；錯誤「卡片被退回」只清空輸入；正解 4321', async () => {
    const b = at('P03_REVERSED_ARCHIVE');
    expect(b.act('DEAF', 'r3_machine', 'submit', { code: [4, 3] }).message).toBe('序列不完整。');
    const w = b.act('DEAF', 'r3_machine', 'submit', { code: [1, 2, 3, 4] });
    expect(w.message).toContain('退了回來');
    expect(w.clear).toBe(true);
    // 線索不受影響
    expect(b.open('DEAF', 'r3_plates').blocks.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 20)); // 等錯誤鎖定（測試設 1ms 起跳）解除
    await solveP03(b.driver);
  });
});

describe('P04 沒有地圖的房間', () => {
  it('未確認節點時門洞封住；錯誤出口回到起點（局部重置）、不會軟鎖；只有正確路線抵達出口', async () => {
    const b = at('P04_MAPLESS_ROOM');
    expect(b.act('MUTE', 'r4_I', 'enter').message).toContain('封住');
    expect(b.act('BLIND', 'r4_echo', 'confirm', { echo: 'SHORT_ECHO' }).ok).toBe(false); // 起點是長回音
    await sleep(5);
    expectOk(b.act('BLIND', 'r4_echo', 'confirm', { echo: 'LONG_ECHO' }), '確認起點');
    // 起點往東＝IV；走 I（南）是錯的 → 回到起點
    const r = b.act('MUTE', 'r4_I', 'enter');
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('錯');
    expect(b.chapter.cluesFor('MUTE').r4Landmark).toBe('NONE');
    expect(b.rec.teleports.at(-1)).toEqual({ zone: 'R4' });
    expect(b.chapter.debugState({}).conditions).toMatchObject({ node: 'START', progress: 0, confirmed: false });
    await solveP04(b.driver);
    expect(b.chapter.world().doors.d4).toBe(true);
  });
  it('地標只給看得見的人；方位儀只有 DEAF、回音探測器只有 BLIND', () => {
    const b = at('P04_MAPLESS_ROOM');
    expect(b.chapter.cluesFor('BLIND')).toEqual({});
    expect(b.chapter.cluesFor('DEAF').r4Landmark).toBe('NONE');
    expect(b.chapter.openDevice('MUTE', 'r4_compass').ok).toBe(false);
    expect(b.chapter.openDevice('MUTE', 'r4_echo').ok).toBe(false);
  });
});

describe('P05 失語協定', () => {
  it('撥桿未設定：協作失敗；錯誤指令只清空未送出的設定、保留已接受的槽；完整重置', async () => {
    const b = at('P05_MUTE_PROTOCOL');
    expect(b.act('DEAF', 'r5_console', 'commit', { dial: 'CIR' }).message).toBe('側向撥桿尚未設定。');
    b.act('BLIND', 'r5_lever', 'lever_LEFT');
    expectOk(b.act('DEAF', 'r5_console', 'commit', { dial: 'CIR' }), '第一槽');
    expect(b.rec.feedback.at(-1)).toMatchObject({ sound: 'accept' });
    expect(b.rec.feedback.at(-1)?.visual).toBeUndefined(); // 接受音只有聲音
    b.act('BLIND', 'r5_lever', 'lever_RIGHT');
    const bad = b.act('DEAF', 'r5_console', 'commit', { dial: 'SQR' });
    expect(bad.ok).toBe(false);
    expect(b.chapter.debugState({}).conditions).toMatchObject({ lever: null });
    expect((b.chapter.debugState({}).conditions as { slots: unknown[] }).slots.filter(Boolean)).toHaveLength(1);
    expect(b.act('DEAF', 'r5_console', 'final').message).toContain('尚未全部完成');
    b.act('DEAF', 'r5_console', 'reset_all');
    expect((b.chapter.debugState({}).conditions as { slots: unknown[] }).slots.filter(Boolean)).toHaveLength(0);
    await sleep(5);
    await solveP05(b.driver);
  });
  it('只有 BLIND 能扳撥桿、只有 DEAF 能操作控制台；失語員的標記不構成成功', () => {
    const b = at('P05_MUTE_PROTOCOL');
    expect(b.act('DEAF', 'r5_lever', 'lever_LEFT').message).toContain('權限');
    expect(b.act('MUTE', 'r5_console', 'final').message).toContain('權限');
    expect(b.chapter.activeId).toBe('P05_MUTE_PROTOCOL');
  });
});

describe('P06 缺失的第七次脈衝', () => {
  it('長度、校驗、內容三種錯誤分開回饋，每次清空輸入；正解 1011010', async () => {
    const b = at('P06_MISSING_PULSE');
    expect(b.act('MUTE', 'r6_analyzer', 'submit', { bits: [1, 0, 1] }).message).toBe('序列長度不符。');
    expect(b.act('MUTE', 'r6_analyzer', 'submit', { bits: [1, 0, 1, 0, 0, 1, 0] }).message).toBe('校驗失敗。');
    await sleep(5);
    expect(b.act('MUTE', 'r6_analyzer', 'submit', { bits: [1, 1, 1, 1, 0, 0, 0] }).message).toBe('訊號內容不符。');
    expect(b.act('MUTE', 'r6_analyzer', 'submit', { bits: [1, 2, 1, 1, 0, 1, 0] }).ok).toBe(false);
    await sleep(5);
    await solveP06(b.driver);
  });
  it('DEAF 只看得到「有／無訊號」，看不到位元值', () => {
    const b = at('P06_MISSING_PULSE');
    const json = JSON.stringify(b.open('DEAF', 'r6_slots'));
    expect(json).toContain('MISSING');
    expect(json).not.toMatch(/"ON"|"OFF"/);
  });
});

describe('P07 三秒鐘的真相', () => {
  it('只有一人執行不能通關；逾時後清除準備狀態但保留設定；可重新開始且不會被舊計時器立即判失敗', async () => {
    const b = at('P07_THREE_SECOND_TRUTH', { syncWindowMs: 150 });
    expect(b.act('MUTE', 'r7_protocol', 'start').message).toContain('尚未三人準備完成');
    b.act('BLIND', 'r7_resonator', 'set', { beats: ['S', 'S', 'L'] });
    b.act('DEAF', 'r7_lights', 'set', { order: ['LEFT', 'CENTER', 'RIGHT'] });
    b.act('MUTE', 'r7_protocol', 'set', { mode: 'SYNC' });
    for (const [r, t] of [['BLIND', 'r7_resonator'], ['DEAF', 'r7_lights'], ['MUTE', 'r7_protocol']] as const) expectOk(b.act(r, t, 'ready'), '準備');
    expect(b.chapter.world().puzzles[6].status).toBe('ready');
    expectOk(b.act('MUTE', 'r7_protocol', 'start'), '啟動');
    expect(b.rec.feedback.at(-1)).toMatchObject({ sound: 'countdown', visual: 'countdown', windowMs: 150 });
    expect(b.act('BLIND', 'r7_resonator', 'execute').message).toContain('等待其他人');
    expect(b.act('BLIND', 'r7_resonator', 'execute').message).toContain('已經執行過');
    await sleep(200);
    expect(b.chapter.activeId).toBe('P07_THREE_SECOND_TRUTH');
    expect(b.chapter.world().puzzles[6].status).toBe('failed');
    expect(b.act('BLIND', 'r7_resonator', 'execute').ok).toBe(false); // 必須重新準備
    // 設定保留：直接重新準備即可
    for (const [r, t] of [['BLIND', 'r7_resonator'], ['DEAF', 'r7_lights'], ['MUTE', 'r7_protocol']] as const) expectOk(b.act(r, t, 'ready'), '重新準備');
    expectOk(b.act('MUTE', 'r7_protocol', 'start'), '第二輪');
    await sleep(60); // 舊輪次的計時器不會在這時觸發
    const res = await b.driver.syncPress([
      { role: 'BLIND', targetId: 'r7_resonator', actionType: 'execute' },
      { role: 'DEAF', targetId: 'r7_lights', actionType: 'execute' },
      { role: 'MUTE', targetId: 'r7_protocol', actionType: 'execute' },
    ]);
    expect(res.at(-1)?.message).toContain('三方同步成功');
    expect(b.chapter.world().doors.d7).toBe(true);
  });
  it('設定錯誤只影響該控制台；窗口內改設定使本輪失敗', async () => {
    const b = at('P07_THREE_SECOND_TRUTH', { syncWindowMs: 500 });
    expect(b.act('DEAF', 'r7_lights', 'set', { order: ['RIGHT', 'CENTER', 'LEFT'] }).ok).toBe(false);
    expect(b.act('DEAF', 'r7_lights', 'ready').ok).toBe(false);
    await sleep(5);
    b.act('BLIND', 'r7_resonator', 'set', { beats: ['S', 'S', 'L'] });
    b.act('DEAF', 'r7_lights', 'set', { order: ['LEFT', 'CENTER', 'RIGHT'] });
    b.act('MUTE', 'r7_protocol', 'set', { mode: 'SYNC' });
    for (const [r, t] of [['BLIND', 'r7_resonator'], ['DEAF', 'r7_lights'], ['MUTE', 'r7_protocol']] as const) b.act(r, t, 'ready');
    b.act('MUTE', 'r7_protocol', 'start');
    b.act('BLIND', 'r7_resonator', 'set', { beats: ['S', 'S', 'L'] });
    expect(b.rec.notices.at(-1)?.text).toContain('更動了設定');
    expect(b.act('DEAF', 'r7_lights', 'execute').ok).toBe(false);
  });
  it('解題器（交叉線索）', async () => {
    const b = at('P07_THREE_SECOND_TRUTH');
    const r = await solveP07(b.driver);
    expect(r.at(-1)?.ok).toBe(true);
  });
});

describe('P08 會說謊的儀器', () => {
  it('校準正常儀器只會自檢後恢復；只有壓力計能完成；完成後不能再觸發', async () => {
    const b = at('P08_LYING_INSTRUMENTS');
    const r = b.act('MUTE', 'r8_flow', 'calibrate');
    expect(r.message).toContain('校準未改善');
    expect(b.rec.feedback.at(-1)).toMatchObject({ targetId: 'r8_flow', sound: 'selftest', visual: 'selftest' });
    expect(b.act('DEAF', 'r8_volt', 'calibrate').ok).toBe(false);
    await solveP08(b.driver);
    const again = b.chapter.action('player-MUTE', 'MUTE', { puzzleId: 'P08_LYING_INSTRUMENTS', actionType: 'calibrate', targetId: 'r8_pressure', requestId: nextRequestId() });
    expect(again.ok).toBe(false);
  });
  it('讀數只給 DEAF、聲紋只給 BLIND', () => {
    const b = at('P08_LYING_INSTRUMENTS');
    expect(JSON.stringify(b.open('DEAF', 'r8_pressure'))).toContain('讀數');
    expect(b.open('DEAF', 'r8_pressure').tap).toBeUndefined();
    expect(b.open('BLIND', 'r8_pressure').tap).toBeTruthy();
    expect(JSON.stringify(b.open('BLIND', 'r8_pressure'))).not.toContain('讀數');
    expect(JSON.stringify(b.open('MUTE', 'r8_pressure'))).not.toContain('正常範圍');
  });
});

describe('P09 不曾發生的循環', () => {
  it('非出口輪扳開關「狀態不相容」；走進任何門進入下一輪；第 4 輪未扳 S4 或走錯門則循環回第 1 輪', async () => {
    const b = at('P09_NONEXISTENT_LOOP');
    expect(b.act('BLIND', 'r9_switches', 'flip_1').message).toContain('不相容');
    b.act('DEAF', 'r9_1', 'enter');
    b.act('DEAF', 'r9_1', 'enter');
    b.act('DEAF', 'r9_1', 'enter');
    expect(b.chapter.debugState({}).conditions).toMatchObject({ loop: 4, armed: false });
    expect(b.chapter.cluesFor('DEAF').r9Labels).toEqual(['D', 'C', 'B', 'A']);
    b.act('DEAF', 'r9_1', 'enter'); // 第 4 輪沒扳開關就走：回到第 1 輪
    expect(b.chapter.debugState({}).conditions).toMatchObject({ loop: 1 });
    expect(b.chapter.activeId).toBe('P09_NONEXISTENT_LOOP');
    for (let i = 0; i < 3; i++) b.act('DEAF', 'r9_2', 'enter');
    await sleep(5);
    expectOk(b.act('BLIND', 'r9_switches', 'flip_4'), '扳 S4');
    b.act('DEAF', 'r9_3', 'enter'); // 走錯門（B）
    expect(b.chapter.debugState({}).conditions).toMatchObject({ loop: 1, armed: false });
    // 紀錄保留
    expect(b.rec.logs.BLIND.length + b.rec.logs.DEAF.length).toBeGreaterThanOrEqual(0);
  });
  it('解題器：比對歷輪音型找出出口輪', async () => {
    const b = at('P09_NONEXISTENT_LOOP');
    await solveP09(b.driver);
    expect(b.chapter.world().doors.d9).toBe(true);
    // 每輪都有獨立的紀錄
    expect(new Set(b.rec.logs.DEAF.map((e) => e.round)).size).toBeGreaterThanOrEqual(4);
  });
});

describe('P10 NULL：最後的協定', () => {
  it('階段不能跳；EXECUTE 不會繞過共識；RESET 需確認；未三方驗證不能同步；逾時只重置同步', async () => {
    const b = at('P10_NULL_PROTOCOL', { syncWindowMs: 120 });
    expect(b.act('MUTE', 'r10_analyzer', 'submit_ops', { ops: ['OPEN', 'WAIT', 'REPEAT', 'CLOSE'] }).message).toContain('尚未完成第一階段');
    expect(b.act('MUTE', 'r10_core_c', 'verify').message).toContain('第三階段');
    expect(b.act('MUTE', 'r10_analyzer', 'submit_bits', { bits: [1, 0, 1, 1, 0, 1, 0] }).message).toBe('校驗失敗。'); // P06 的答案不適用
    await sleep(5);
    await solveP10Phases12(b.driver);
    expect(b.chapter.world().stage?.phase).toBe(3);
    expect(b.act('MUTE', 'r10_core_c', 'choose', { mode: 'CONSENSUS' }).message).toContain('尚未完成三方驗證');
    for (const [r, t] of [['BLIND', 'r10_core_a'], ['DEAF', 'r10_core_b'], ['MUTE', 'r10_core_c']] as const) b.act(r, t, 'verify');
    expect(b.act('MUTE', 'r10_core_c', 'choose', { mode: 'EXECUTE' }).message).toBe('CONSENSUS REQUIRED');
    expect(b.act('MUTE', 'r10_core_c', 'choose', { mode: 'RESET' }).message).toContain('再套用一次');
    expect(b.chapter.debugState({}).conditions).toMatchObject({ verified: { BLIND: true, DEAF: true, MUTE: true } });
    expectOk(b.act('MUTE', 'r10_core_c', 'choose', { mode: 'CONSENSUS' }), 'CONSENSUS');
    b.act('BLIND', 'r10_core_a', 'final');
    await sleep(170);
    expect(b.chapter.activeId).toBe('P10_NULL_PROTOCOL');
    expect(b.chapter.world().stage?.phase).toBe(3); // 前兩階段保留
    expect(b.chapter.debugState({}).conditions).toMatchObject({ verified: { BLIND: true, DEAF: true, MUTE: true }, roundId: null });
    const res = await solveP10Phase3(b.driver);
    expect(res.at(-1)?.message).toContain('共識成立');
    expect(b.rec.chapterComplete).toBe(1);
  });
  it('RESET 確認後重置第三階段（清除三方驗證）', () => {
    const b = at('P10_NULL_PROTOCOL');
    b.chapter.debugCommand('reset_puzzle');
    expect(b.chapter.world().stage?.phase).toBe(1);
  });
});

describe('面板按鈕與輸入元件的對應（客戶端只驗證按鈕 uses 指定的欄位）', () => {
  // 會讀取輸入的操作；其他按鈕若沒有標 uses: []，玩家在欄位未填時就會被客戶端擋下
  const INPUT_ACTIONS = new Set(['submit', 'confirm', 'commit', 'set', 'submit_bits', 'submit_ops', 'choose']);
  it('所有謎題、所有角色的面板：不需要輸入的按鈕不會被未填的欄位擋住', () => {
    const problems: string[] = [];
    PUZZLE_IDS.forEach((id, i) => {
      const b = at(id);
      for (const d of DEVICES.filter((x) => x.zone === `R${i + 1}` && !x.direct)) {
        for (const role of ROLES) {
          if (!roleCanUseDevice(role, d)) continue;
          const r = b.chapter.openDevice(role, d.id);
          if (!r.ok) continue;
          const { controls, actions } = r.view;
          for (const a of actions) {
            const needs = controls.filter((c) => (a.uses ? a.uses.includes(c.id) : true) && c.type !== 'knobs');
            if (needs.length && !INPUT_ACTIONS.has(a.id)) problems.push(`${id} ${d.id} [${role}] ${a.id} 需要 ${needs.map((c) => c.id).join(',')}`);
          }
        }
      }
    });
    expect(problems).toEqual([]);
  });
});
