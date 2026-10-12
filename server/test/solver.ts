import {
  SYMBOL_GLYPH,
  type ActionResult,
  type Block,
  type Control,
  type PanelView,
  type PuzzleId,
  type Role,
  type SceneClues,
  type SymbolId,
  type TapPattern,
} from '@null-protocol/shared';

/**
 * 「玩家模擬解題器」。
 *
 * 只使用各角色實際收到的資料（面板內容、授權的 3D 線索、文件中的公開規則）解題，
 * 不讀取伺服器的答案資料。同一套流程在三個地方跑完整章：
 * 章節單元測試（直接呼叫 Chapter）、Socket 整合測試（三個客戶端真的走路）、瀏覽器 e2e（透過 UI 操作）。
 *
 * 這裡把「隊友之間傳遞資訊」簡化為直接傳變數；角色能對誰說話／傳話的限制另外在整合測試中驗證。
 */

export interface Press {
  role: Role;
  targetId: string;
  actionType: string;
}

export interface Driver {
  open(role: Role, deviceId: string): Promise<PanelView>;
  act(role: Role, targetId: string, actionType: string, payload?: Record<string, unknown>): Promise<ActionResult>;
  enter(role: Role, portalId: string): Promise<ActionResult>;
  clues(role: Role): Promise<SceneClues>;
  /** 三個人在同一個窗口內各自按下 */
  syncPress(presses: Press[]): Promise<ActionResult[]>;
  activePuzzle(): Promise<PuzzleId | null>;
}

const A: Role = 'BLIND';
const B: Role = 'DEAF';
const C: Role = 'MUTE';

export function block<T extends Block['type']>(view: PanelView, type: T, nth = 0): Extract<Block, { type: T }> {
  const found = view.blocks.filter((b) => b.type === type);
  const b = found[nth];
  if (!b) throw new Error(`面板 ${view.deviceId} 沒有第 ${nth} 個 ${type} 區塊`);
  return b as Extract<Block, { type: T }>;
}

function control<T extends Control['type']>(view: PanelView, id: string): Extract<Control, { type: T }> {
  const c = view.controls.find((x) => x.id === id);
  if (!c) throw new Error(`面板 ${view.deviceId} 沒有輸入元件 ${id}`);
  return c as Extract<Control, { type: T }>;
}

const GLYPH_TO_SYMBOL = Object.fromEntries((Object.entries(SYMBOL_GLYPH) as Array<[SymbolId, string]>).map(([k, g]) => [g, k])) as Record<string, SymbolId>;

export function expectOk(r: ActionResult, what: string): ActionResult {
  if (!r.ok) throw new Error(`${what} 失敗：${r.message}`);
  return r;
}

/** 依停頓把敲擊分組（停頓＝上一下結束到下一下開始的空白） */
export function groupTaps(tap: TapPattern | undefined, gapMs: number): number[][] {
  if (!tap) throw new Error('這個面板沒有聲音');
  const groups: number[][] = [];
  let cur: number[] = [];
  tap.events.forEach((e, i) => {
    if (i > 0) {
      const prev = tap.events[i - 1];
      if (e.at - (prev.at + prev.len) > gapMs) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(e.len);
  });
  if (cur.length) groups.push(cur);
  return groups;
}

const isLong = (len: number) => len >= 300;
const signature = (tap: TapPattern | undefined) => (tap ? tap.events.map((e) => (isLong(e.len) ? 'L' : 'S')).join('') : '');

async function waitCompleted(d: Driver, id: PuzzleId): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await d.activePuzzle()) !== id) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${id} 沒有完成`);
}

/* --------------------------------- P01 --------------------------------- */

export async function solveP01(d: Driver): Promise<void> {
  const sounds = groupTaps((await d.open(A, 'r1_gen')).tap, 800).map((g) => (g.length === 2 ? 'SL' : isLong(g[0]) ? 'L' : 'S'));
  const symbols = block(await d.open(B, 'r1_lamps'), 'symbols').seq;
  const card = block(await d.open(C, 'r1_card'), 'table');
  const cols = card.header!.slice(1).map((g) => GLYPH_TO_SYMBOL[g]);
  const rowOf: Record<string, string> = { 短: 'S', 長: 'L', 短接長: 'SL' };
  const grid: Record<string, Record<string, number>> = {};
  for (const row of card.rows) grid[rowOf[row[0]]] = Object.fromEntries(cols.map((c, i) => [c, Number(row[i + 1])]));
  const code = sounds.map((s, i) => grid[s][symbols[i]]);
  expectOk(await d.act(C, 'r1_lock', 'submit', { code }), 'P01 密碼');
  await waitCompleted(d, 'P01_THREE_LANGUAGES');
}

/* --------------------------------- P02 --------------------------------- */

export async function solveP02(d: Driver): Promise<void> {
  const sounds = (await d.clues(A)).r2Sounds!;
  const lamps = (await d.clues(B)).r2Lamps!;
  const rules = block(await d.open(C, 'r2_manual'), 'list').items.join('');
  // 失語員把三個條件翻譯給兩人：低頻震動、音高下降、白色指示燈
  if (!rules.includes('低頻') || !rules.includes('下降') || !rules.includes('白色')) throw new Error('P02 規則讀不懂');
  const door = (['A', 'B', 'C', 'D'] as const).filter((k) => sounds[k] === 'LOW_FALL' && lamps[k] === 'WHITE');
  if (door.length !== 1) throw new Error(`P02 候選不唯一：${door.join(',')}`);
  expectOk(await d.act(B, `r2_door_${door[0]}`, 'push'), 'P02 推門');
  await waitCompleted(d, 'P02_PHANTOM_DOOR');
}

/* --------------------------------- P03 --------------------------------- */

export async function solveP03(d: Driver): Promise<void> {
  await d.open(A, 'r3_taps');
  const toneOfPos: number[] = [];
  for (let n = 1; n <= 4; n++) toneOfPos[n] = (await d.act(A, 'r3_taps', `ref_${n}`)).view!.tap!.events[0].tone;
  const full = (await d.act(A, 'r3_taps', 'full')).view!.tap!;
  const order = full.events.map((e) => toneOfPos.indexOf(e.tone));
  const plates = block(await d.open(B, 'r3_plates'), 'symbols').seq;
  const table = block(await d.open(C, 'r3_rules'), 'table');
  const num = Object.fromEntries(table.rows.map(([g, n]) => [GLYPH_TO_SYMBOL[g], Number(n)])) as Record<SymbolId, number>;
  const code = order.map((pos) => num[plates[pos - 1]]).reverse();
  expectOk(await d.act(B, 'r3_machine', 'submit', { code }), 'P03 檔案序列');
  await waitCompleted(d, 'P03_REVERSED_ARCHIVE');
}

/* --------------------------------- P04 --------------------------------- */

const LANDMARK_TEXT: Record<string, string> = { NONE: '沒有地標', TRIANGLE: '三角形吊燈', CYLINDER: '懸吊的圓柱', SQUARE: '方形地板' };

export async function solveP04(d: Driver, opts: { onStep?: () => Promise<void> } = {}): Promise<void> {
  const routeRows = block(await d.open(C, 'r4_route'), 'table').rows;
  for (let step = 0; step < 8; step++) {
    if ((await d.activePuzzle()) !== 'P04_MAPLESS_ROOM') return;
    // 盲區員聽回音並確認節點
    const echoView = await d.open(A, 'r4_echo');
    const n = echoView.tap!.events.length;
    const echo = n === 4 ? 'LONG_ECHO' : n === 2 ? 'SHORT_ECHO' : n === 1 ? 'LOW_HUM' : 'TRIPLE_KNOCK';
    expectOk(await d.act(A, 'r4_echo', 'confirm', { echo }), 'P04 確認節點');
    // 看得見的人辨認地標，失語員查路線，靜默員看方位儀
    const landmark = (await d.clues(C)).r4Landmark!;
    const row = routeRows.find((r) => r[0].startsWith(LANDMARK_TEXT[landmark]));
    if (!row) throw new Error(`P04 找不到地標 ${landmark} 的路線`);
    const compass = block(await d.open(B, 'r4_compass'), 'table').rows;
    const mark = compass.find((r) => r[0] === row[1])![1];
    expectOk(await d.enter(C, `r4_${mark}`), 'P04 穿過門洞');
    await opts.onStep?.();
  }
  await waitCompleted(d, 'P04_MAPLESS_ROOM');
}

/* --------------------------------- P05 --------------------------------- */

export async function solveP05(d: Driver): Promise<void> {
  const doc = await d.open(C, 'r5_doc');
  const steps = block(doc, 'list').items;
  const symTable = block(doc, 'table').rows;
  const verbSym = Object.fromEntries(symTable.filter((r) => GLYPH_TO_SYMBOL[r[0]]).map(([g, v]) => [v, GLYPH_TO_SYMBOL[g]])) as Record<string, SymbolId>;
  for (const step of steps) {
    const side = step.startsWith('左側') ? 'LEFT' : step.startsWith('右側') ? 'RIGHT' : 'NONE';
    const verb = Object.keys(verbSym).find((v) => step.endsWith(v))!;
    expectOk(await d.act(A, 'r5_lever', `lever_${side}`), 'P05 撥桿');
    expectOk(await d.act(B, 'r5_console', 'commit', { dial: verbSym[verb] }), 'P05 送出本槽');
  }
  expectOk(await d.act(B, 'r5_console', 'final'), 'P05 提交最終序列');
  await waitCompleted(d, 'P05_MUTE_PROTOCOL');
}

/* --------------------------------- P06 --------------------------------- */

export async function solveP06(d: Driver): Promise<void> {
  const heard = (await d.open(A, 'r6_pulse')).tap!.events.map((e) => (isLong(e.len) ? 1 : 0));
  const slots = block(await d.open(B, 'r6_slots'), 'slots').seq;
  const rules = block(await d.open(C, 'r6_parity'), 'list').items.join('');
  if (!rules.includes('偶數')) throw new Error('P06 規則讀不懂');
  const missing = slots.indexOf('MISSING');
  const ones = heard.reduce<number>((a, b) => a + b, 0);
  const bits: number[] = [...heard];
  bits.splice(missing, 0, ones % 2);
  expectOk(await d.act(A, 'r6_analyzer', 'submit', { bits }), 'P06 序列');
  await waitCompleted(d, 'P06_MISSING_PULSE');
}

/* --------------------------------- P07 --------------------------------- */

export async function solveP07(d: Driver): Promise<ActionResult[]> {
  const rhythm = block(await d.open(B, 'r7_strobe'), 'pulses').seq; // 靜默員看
  const order = (await d.open(A, 'r7_speaker')).tap!.events.map((e) => ((e.pan ?? 0) < -0.5 ? 'LEFT' : (e.pan ?? 0) > 0.5 ? 'RIGHT' : 'CENTER'));
  const manual = block(await d.open(C, 'r7_manual'), 'table').rows;
  const last = rhythm[rhythm.length - 1] === 'L' ? '長' : '短';
  const dir = order[0] === 'LEFT' ? '由左至右' : '由右至左';
  const modeLabel = manual.find((r) => r[0] === last && r[1] === dir)![2];
  const protocol = await d.open(C, 'r7_protocol');
  const mode = control<'select'>(protocol, 'mode').options.find((o) => o.label === modeLabel)!.value;

  expectOk(await d.act(A, 'r7_resonator', 'set', { beats: rhythm }), 'P07 共振器');
  expectOk(await d.act(B, 'r7_lights', 'set', { order }), 'P07 燈光');
  expectOk(await d.act(C, 'r7_protocol', 'set', { mode }), 'P07 協定盤');
  expectOk(await d.act(A, 'r7_resonator', 'ready'), 'P07 A 準備');
  expectOk(await d.act(B, 'r7_lights', 'ready'), 'P07 B 準備');
  expectOk(await d.act(C, 'r7_protocol', 'ready'), 'P07 C 準備');
  expectOk(await d.act(C, 'r7_protocol', 'start'), 'P07 啟動同步');
  return d.syncPress([
    { role: A, targetId: 'r7_resonator', actionType: 'execute' },
    { role: B, targetId: 'r7_lights', actionType: 'execute' },
    { role: C, targetId: 'r7_protocol', actionType: 'execute' },
  ]);
}

/* --------------------------------- P08 --------------------------------- */

export async function solveP08(d: Driver): Promise<void> {
  const ids = ['r8_pressure', 'r8_temp', 'r8_flow', 'r8_volt'];
  const rules = block(await d.open(C, 'r8_rules'), 'list').items.join('');
  if (!rules.includes('間歇震動')) throw new Error('P08 規則讀不懂');
  let target = '';
  for (const id of ids) {
    const tap = (await d.open(A, id)).tap!;
    const gaps = tap.events.slice(1).map((e, i) => e.at - tap.events[i].at);
    const intermittent = tap.events.length > 1 && Math.max(...gaps) - Math.min(...gaps) > 200;
    const reading = block(await d.open(B, id), 'status').text;
    if (intermittent && reading.includes('正常')) target = id;
  }
  expectOk(await d.act(C, target, 'calibrate'), 'P08 校準');
  await waitCompleted(d, 'P08_LYING_INSTRUMENTS');
}

/* --------------------------------- P09 --------------------------------- */

export async function solveP09(d: Driver, opts: { onStep?: () => Promise<void> } = {}): Promise<void> {
  const played: string[] = [];
  for (let step = 0; step < 10; step++) {
    if ((await d.activePuzzle()) !== 'P09_NONEXISTENT_LOOP') return;
    played.push(signature((await d.open(A, 'r9_speaker')).tap));
    const monitor = await d.open(B, 'r9_monitor');
    const order = block(monitor, 'table').rows[0].slice(1);
    const lights = block(monitor, 'slots').seq.map((s) => (s === 'ON' ? 1 : 0));
    const cur = played.length - 1;
    // 本輪的真實音型＝下一輪播放的音型。已確認的真實音型＝played[1..cur]。
    const confirmedReals = played.slice(1, cur + 1);
    const everPlayed = new Set(played);
    // 每輪真實音型都不同：本輪真實音型不在已確認的集合中；若已確認集合涵蓋所有播放過的音型，本輪真實音型就從未播放過
    const exitRound = cur >= 3 && confirmedReals.length >= 3 && [...everPlayed].every((p) => confirmedReals.includes(p));
    if (exitRound) {
      const k = lights.indexOf(1) + 1;
      expectOk(await d.act(A, 'r9_switches', `flip_${k}`), 'P09 扳開關');
      const slot = 1; // 門序排第一位的門
      if (!order[0]) throw new Error('P09 看不到門序');
      expectOk(await d.enter(B, `r9_${slot}`), 'P09 走進出口');
    } else {
      expectOk(await d.enter(B, 'r9_2'), 'P09 走進下一輪');
    }
    await opts.onStep?.();
  }
  await waitCompleted(d, 'P09_NONEXISTENT_LOOP');
}

/* --------------------------------- P10 --------------------------------- */

export async function solveP10Phases12(d: Driver): Promise<void> {
  // 第一階段
  const heard = groupTaps((await d.open(A, 'r10_signal')).tap, 1000).map((g) => g.map((len) => (isLong(len) ? 1 : 0)));
  const slots = block(await d.open(B, 'r10_groups'), 'slots');
  const rules = await d.open(C, 'r10_rules');
  if (!block(rules, 'list').items.join('').includes('偶數')) throw new Error('P10 規則讀不懂');
  const bits: Array<number | null> = [];
  let start = 0;
  slots.groups!.forEach((size, gi) => {
    const marks = slots.seq.slice(start, start + size);
    const values = [...heard[gi]];
    for (const m of marks) bits.push(m === 'MISSING' ? null : (values.shift() ?? null));
    start += size;
  });
  const ones = bits.reduce<number>((a, b) => a + (b ?? 0), 0);
  const full = bits.map((b) => (b === null ? ones % 2 : b));
  expectOk(await d.act(B, 'r10_analyzer', 'submit_bits', { bits: full }), 'P10 第一階段');

  // 第二階段
  await d.open(A, 'r10_signal');
  const toneOf: number[] = [];
  for (let n = 1; n <= 4; n++) toneOf[n] = (await d.act(A, 'r10_signal', `ref_${n}`)).view!.tap!.events[0].tone;
  const order = (await d.act(A, 'r10_signal', 'full')).view!.tap!.events.map((e) => toneOf.indexOf(e.tone));
  const symOfTone = Object.fromEntries(block(await d.open(B, 'r10_groups'), 'table').rows.map(([t, g]) => [Number(t.replace(/\D/g, '')), GLYPH_TO_SYMBOL[g]]));
  const opTable = block(await d.open(C, 'r10_rules'), 'table').rows;
  const analyzer = await d.open(C, 'r10_analyzer');
  const opValue = Object.fromEntries(control<'selects'>(analyzer, 'ops').options.map((o) => [o.label, o.value]));
  const ops = order.map((n) => opValue[opTable.find((r) => GLYPH_TO_SYMBOL[r[0]] === symOfTone[n])![1]]);
  expectOk(await d.act(C, 'r10_analyzer', 'submit_ops', { ops }), 'P10 第二階段');
}

export async function solveP10Phase3(d: Driver): Promise<ActionResult[]> {
  expectOk(await d.act(A, 'r10_core_a', 'verify'), 'P10 A 驗證');
  expectOk(await d.act(B, 'r10_core_b', 'verify'), 'P10 B 驗證');
  expectOk(await d.act(C, 'r10_core_c', 'verify'), 'P10 C 驗證');
  expectOk(await d.act(C, 'r10_core_c', 'choose', { mode: 'CONSENSUS' }), 'P10 CONSENSUS');
  return d.syncPress([
    { role: A, targetId: 'r10_core_a', actionType: 'final' },
    { role: B, targetId: 'r10_core_b', actionType: 'final' },
    { role: C, targetId: 'r10_core_c', actionType: 'final' },
  ]);
}

/** 依序解完整章 */
export async function solveChapter(d: Driver, hooks: { between?: (id: PuzzleId) => Promise<void> } = {}): Promise<void> {
  const steps: Array<[PuzzleId, () => Promise<unknown>]> = [
    ['P01_THREE_LANGUAGES', () => solveP01(d)],
    ['P02_PHANTOM_DOOR', () => solveP02(d)],
    ['P03_REVERSED_ARCHIVE', () => solveP03(d)],
    ['P04_MAPLESS_ROOM', () => solveP04(d)],
    ['P05_MUTE_PROTOCOL', () => solveP05(d)],
    ['P06_MISSING_PULSE', () => solveP06(d)],
    ['P07_THREE_SECOND_TRUTH', () => solveP07(d)],
    ['P08_LYING_INSTRUMENTS', () => solveP08(d)],
    ['P09_NONEXISTENT_LOOP', () => solveP09(d)],
    ['P10_NULL_PROTOCOL', async () => {
      await solveP10Phases12(d);
      return solveP10Phase3(d);
    }],
  ];
  for (const [id, run] of steps) {
    await hooks.between?.(id);
    await run();
    await waitCompleted(d, id);
  }
}
