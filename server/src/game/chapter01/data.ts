/**
 * 第一章的謎題資料與「規則函式」（固定資料，相當於固定種子 chapter01-v1）。
 *
 * 這個檔案只存在於伺服器，客戶端永遠拿不到。
 *
 * 正確答案不是另外手寫的，而是由「線索資料」套用「文件中公開給玩家的規則」推導出來；
 * 伺服器啟動時 assertChapterData() 會把推導結果與規格中的字面答案逐一比對，
 * 測試（test/necessity.test.ts）再窮舉驗證唯一解與三人必要性。
 */

import type { DoorSoundId, LampColor, Landmark, R2DoorKey, SymbolId } from '@null-protocol/shared';

export type Tap = 'S' | 'L';
export const SEED = 'chapter01-v1';

export const eqArr = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/* =============================== P01 三種語言 =============================== */

export type P01Pattern = 'S' | 'L' | 'SL';
export const P01_PATTERN_LABEL: Record<P01Pattern, string> = { S: '短', L: '長', SL: '短接長' };
export const P01_COLS: readonly SymbolId[] = ['CIR', 'TRI', 'SQR'];
export const P01_ROWS: readonly P01Pattern[] = ['S', 'L', 'SL'];

export const P01 = {
  /** BLIND：三組音型的播放順序 */
  sounds: ['S', 'L', 'SL'] as P01Pattern[],
  /** DEAF：符號燈亮起的順序 */
  symbols: ['CIR', 'TRI', 'SQR'] as SymbolId[],
  /** MUTE：音型 × 符號 → 數字 */
  grid: {
    S: { CIR: 2, TRI: 7, SQR: 4 },
    L: { CIR: 9, TRI: 5, SQR: 1 },
    SL: { CIR: 3, TRI: 6, SQR: 8 },
  } as Record<P01Pattern, Partial<Record<SymbolId, number>>>,
};

export function p01Derive(sounds: readonly P01Pattern[], symbols: readonly SymbolId[]): number[] {
  return sounds.map((s, i) => P01.grid[s][symbols[i]] ?? -1);
}

/* =============================== P02 不存在的門 =============================== */

export const P02_DOORS: readonly R2DoorKey[] = ['A', 'B', 'C', 'D'];
export const P02 = {
  sounds: { A: 'HIGH_CONT', B: 'LOW_FALL', C: 'LOW_FALL', D: 'LOW_FIXED' } as Record<R2DoorKey, DoorSoundId>,
  lamps: { A: 'WHITE', B: 'WHITE', C: 'RED', D: 'WHITE' } as Record<R2DoorKey, LampColor>,
};
/** 維修文件：低頻震動、最後音高下降、白色指示燈 */
export const p02IsExit = (sound: DoorSoundId, lamp: LampColor): boolean => sound === 'LOW_FALL' && lamp === 'WHITE';

/* =============================== P03 逆序檔案 =============================== */

export const P03 = {
  /** DEAF：位置 1～4 上的符號 */
  plates: ['CIR', 'TRI', 'SQR', 'DIA'] as SymbolId[],
  /** BLIND：敲擊依時間先後來自哪個位置 */
  tapOrder: [2, 1, 4, 3],
  /** 敲擊的時間點（毫秒，間隔不均） */
  tapTimes: [0, 520, 1750, 2150],
  /** 位置 1～4 的參考音高 */
  refTones: [330, 440, 554, 659],
  /** MUTE：符號轉換表 */
  table: { TRI: 1, CIR: 2, DIA: 3, SQR: 4 } as Record<SymbolId, number>,
};
export function p03Derive(tapOrder: readonly number[], plates: readonly SymbolId[]): number[] {
  return tapOrder.map((pos) => P03.table[plates[pos - 1]]).reverse();
}

/* =============================== P04 沒有地圖的房間 =============================== */

export type MazeNode = 'START' | 'TRIANGLE' | 'CYLINDER' | 'SQUARE';
export type MazeTarget = MazeNode | 'EXIT';
export type Dir = 'N' | 'E' | 'S' | 'W';
export type PortalMark = 'I' | 'II' | 'III' | 'IV';
export type EchoId = 'LONG_ECHO' | 'SHORT_ECHO' | 'LOW_HUM' | 'TRIPLE_KNOCK';

export const ECHO_LABEL: Record<EchoId, string> = {
  LONG_ECHO: '長回音',
  SHORT_ECHO: '短回音',
  LOW_HUM: '連續低頻震動',
  TRIPLE_KNOCK: '三次短促敲擊',
};
export const DIR_LABEL: Record<Dir, string> = { N: '北', E: '東', S: '南', W: '西' };
export const LANDMARK_LABEL: Record<Landmark, string> = { NONE: '沒有地標', TRIANGLE: '三角形吊燈', CYLINDER: '懸吊的圓柱', SQUARE: '方形地板' };

export const P04 = {
  nodes: ['START', 'TRIANGLE', 'CYLINDER', 'SQUARE'] as MazeNode[],
  landmark: { START: 'NONE', TRIANGLE: 'TRIANGLE', CYLINDER: 'CYLINDER', SQUARE: 'SQUARE' } as Record<MazeNode, Landmark>,
  echo: { START: 'LONG_ECHO', TRIANGLE: 'SHORT_ECHO', CYLINDER: 'LOW_HUM', SQUARE: 'TRIPLE_KNOCK' } as Record<MazeNode, EchoId>,
  /** DEAF 方位儀：每個節點的方位對應到哪個門洞 */
  compass: {
    START: { N: 'III', E: 'IV', S: 'I', W: 'II' },
    TRIANGLE: { N: 'II', E: 'III', S: 'IV', W: 'I' },
    CYLINDER: { N: 'IV', E: 'I', S: 'II', W: 'III' },
    SQUARE: { N: 'I', E: 'II', S: 'III', W: 'IV' },
  } as Record<MazeNode, Record<Dir, PortalMark>>,
  /** MUTE 路線規則：在這個節點要往哪個方位走 */
  route: { START: 'E', TRIANGLE: 'N', CYLINDER: 'W', SQUARE: 'N' } as Record<MazeNode, Dir>,
  /** 路線的下一個節點（伺服器節點圖） */
  chain: { START: 'TRIANGLE', TRIANGLE: 'CYLINDER', CYLINDER: 'SQUARE', SQUARE: 'EXIT' } as Record<MazeNode, MazeTarget>,
};
export const PORTAL_MARKS: readonly PortalMark[] = ['I', 'II', 'III', 'IV'];

/** 節點圖：從 node 走進 portal 會到哪裡（錯誤一律回到起點） */
export function p04Transition(node: MazeNode, portal: PortalMark): MazeTarget {
  const dir = (Object.keys(P04.compass[node]) as Dir[]).find((d) => P04.compass[node][d] === portal)!;
  return dir === P04.route[node] ? P04.chain[node] : 'START';
}

/* =============================== P05 失語協定 =============================== */

export type Side = 'LEFT' | 'NONE' | 'RIGHT';
export type Verb = 'OPEN' | 'CLOSE' | 'WAIT' | 'REPEAT';
export const SIDE_LABEL: Record<Side, string> = { LEFT: '左側', NONE: '中（無側向）', RIGHT: '右側' };
export const VERB_LABEL: Record<Verb, string> = { OPEN: '開啟', CLOSE: '關閉', WAIT: '等待', REPEAT: '重複' };
/** 控制台轉盤上只有符號：○開啟 △關閉 □等待 ◇重複 */
export const VERB_SYMBOL: Record<Verb, SymbolId> = { OPEN: 'CIR', CLOSE: 'TRI', WAIT: 'SQR', REPEAT: 'DIA' };
export const SYMBOL_VERB: Record<SymbolId, Verb> = { CIR: 'OPEN', TRI: 'CLOSE', SQR: 'WAIT', DIA: 'REPEAT' };

export const P05 = {
  expected: [
    { side: 'LEFT', verb: 'OPEN' },
    { side: 'NONE', verb: 'WAIT' },
    { side: 'RIGHT', verb: 'REPEAT' },
  ] as Array<{ side: Side; verb: Verb }>,
};

/* =============================== P06 第七次脈衝 =============================== */

export const P06 = {
  bits: [1, 0, 1, 1, 0, 1, 0] as Array<0 | 1>,
  /** 缺失的槽位（0 起算） */
  missing: 3,
};
/** 校驗：1 的總數為偶數 */
export const evenParity = (bits: readonly number[]): boolean => bits.reduce((a, b) => a + b, 0) % 2 === 0;
/** 從已知位元與缺失位置推出缺失值（玩家要做的事） */
export function p06Derive(known: ReadonlyArray<0 | 1>, missing: number): Array<0 | 1> {
  const ones = known.reduce<number>((a, b) => a + b, 0);
  const fill: 0 | 1 = ones % 2 === 0 ? 0 : 1;
  const out = [...known];
  out.splice(missing, 0, fill);
  return out;
}

/* =============================== P07 三秒鐘的真相 =============================== */

export type Pos3 = 'LEFT' | 'CENTER' | 'RIGHT';
export type Mode = 'SYNC' | 'REVERSE' | 'ALTERNATE' | 'SINGLE';
export const MODE_LABEL: Record<Mode, string> = { SYNC: '同步模式', REVERSE: '反向模式', ALTERNATE: '交替模式', SINGLE: '單點模式' };
export const POS_LABEL: Record<Pos3, string> = { LEFT: '左', CENTER: '中', RIGHT: '右' };

export const P07 = {
  rhythm: ['S', 'S', 'L'] as Tap[],
  order: ['LEFT', 'CENTER', 'RIGHT'] as Pos3[],
  /** 模式手冊：（最後一拍, 燈序方向）→ 模式 */
  modeTable: [
    { last: 'L', dir: 'LTR', mode: 'SYNC' },
    { last: 'L', dir: 'RTL', mode: 'REVERSE' },
    { last: 'S', dir: 'LTR', mode: 'ALTERNATE' },
    { last: 'S', dir: 'RTL', mode: 'SINGLE' },
  ] as Array<{ last: Tap; dir: 'LTR' | 'RTL'; mode: Mode }>,
};
export function p07Mode(rhythm: readonly Tap[], order: readonly Pos3[]): Mode | null {
  const last = rhythm[rhythm.length - 1];
  const ltr = order[0] === 'LEFT' && order[order.length - 1] === 'RIGHT';
  const rtl = order[0] === 'RIGHT' && order[order.length - 1] === 'LEFT';
  const dir = ltr ? 'LTR' : rtl ? 'RTL' : null;
  return P07.modeTable.find((r) => r.last === last && r.dir === dir)?.mode ?? null;
}

/* =============================== P08 會說謊的儀器 =============================== */

export type Instrument = 'pressure' | 'temp' | 'flow' | 'volt';
export type Display = 'NORMAL' | 'HIGH' | 'MAX';
export type Sound = 'INTERMITTENT' | 'RUNNING' | 'HUM';
export const INSTRUMENTS: readonly Instrument[] = ['pressure', 'temp', 'flow', 'volt'];
export const INSTRUMENT_LABEL: Record<Instrument, string> = { pressure: '壓力計', temp: '溫度計', flow: '流量計', volt: '電壓計' };
export const DISPLAY_LABEL: Record<Display, string> = { NORMAL: '正常範圍', HIGH: '過高', MAX: '最大值' };

export const P08 = {
  display: { pressure: 'NORMAL', temp: 'HIGH', flow: 'MAX', volt: 'NORMAL' } as Record<Instrument, Display>,
  sound: { pressure: 'INTERMITTENT', temp: 'RUNNING', flow: 'INTERMITTENT', volt: 'HUM' } as Record<Instrument, Sound>,
};
/** 診斷規則：顯示正常卻出現間歇震動＝故障；其他異常都有正常解釋 */
export const p08Faulty = (d: Display, s: Sound): boolean => d === 'NORMAL' && s === 'INTERMITTENT';

/* =============================== P09 不曾發生的循環 =============================== */

export type LoopPattern = 'A' | 'B' | 'C' | 'D';
export interface LoopRound {
  order: string[];
  lights: number[];
  played: LoopPattern;
  real: LoopPattern;
}
export const P09 = {
  rounds: [
    { order: ['A', 'B', 'C', 'D'], lights: [1, 0, 0, 0], played: 'A', real: 'A' },
    { order: ['C', 'A', 'D', 'B'], lights: [0, 1, 0, 0], played: 'A', real: 'B' },
    { order: ['B', 'D', 'A', 'C'], lights: [0, 0, 1, 0], played: 'B', real: 'C' },
    { order: ['D', 'C', 'B', 'A'], lights: [0, 0, 0, 1], played: 'C', real: 'D' },
  ] as LoopRound[],
  /** 各音型的節奏 */
  rhythm: { A: ['S', 'S', 'L'], B: ['L', 'S', 'S'], C: ['S', 'L', 'S', 'L'], D: ['L', 'L', 'S'] } as Record<LoopPattern, Tap[]>,
};

/**
 * 依循環規則找出口輪：本輪的真實音型＝下一輪喇叭播放的音型；
 * 出口輪＝前三輪的真實音型都已確認、而本輪的真實音型從未被播放過。
 */
export function p09ExitRound(rounds: readonly LoopRound[]): number {
  for (let i = 0; i < rounds.length; i++) {
    const confirmed = rounds.slice(0, i).every((_, k) => k + 1 < rounds.length && rounds[k + 1].played === rounds[k].real);
    const everPlayed = rounds.some((r) => r.played === rounds[i].real);
    if (i >= 3 && confirmed && !everPlayed) return i + 1;
  }
  return -1;
}
/** 出口輪要扳的開關（燈號亮起的位置）與要走的門位（門序第一位） */
export function p09Target(round: LoopRound): { switch: number; slot: number; label: string } {
  return { switch: round.lights.indexOf(1) + 1, slot: 1, label: round.order[0] };
}

/* =============================== P10 NULL 最後的協定 =============================== */

export type Op = 'OPEN' | 'WAIT' | 'REPEAT' | 'CLOSE';
export const OP_LABEL: Record<Op, string> = { OPEN: '開啟', WAIT: '等待', REPEAT: '重複', CLOSE: '關閉' };
export const OPS: readonly Op[] = ['OPEN', 'WAIT', 'REPEAT', 'CLOSE'];

export const P10 = {
  bits: [1, 1, 0, 1, 0, 0, 1] as Array<0 | 1>,
  groups: [3, 2, 2],
  /** DEAF 看到被遮蔽的槽（0 起算） */
  masked: 3,
  /** 兩人都感知不到的缺失槽 */
  missing: 4,
  /** 第二階段：BLIND 聽到的音序 */
  toneOrder: [3, 1, 4, 2],
  toneRef: [262, 330, 392, 494],
  /** DEAF：音 n 對應的符號 */
  toneSymbol: { 1: 'SQR', 2: 'TRI', 3: 'CIR', 4: 'DIA' } as Record<number, SymbolId>,
  /** MUTE：符號 → 操作 */
  symbolOp: { CIR: 'OPEN', SQR: 'WAIT', DIA: 'REPEAT', TRI: 'CLOSE' } as Record<SymbolId, Op>,
};
export function p10DeriveOps(order: readonly number[]): Op[] {
  return order.map((n) => P10.symbolOp[P10.toneSymbol[n]]);
}

/* =============================== 答案與自我檢查 =============================== */

export const ANSWERS = {
  p01: p01Derive(P01.sounds, P01.symbols),
  p02: P02_DOORS.filter((d) => p02IsExit(P02.sounds[d], P02.lamps[d])),
  p03: p03Derive(P03.tapOrder, P03.plates),
  p05: P05.expected,
  p06: p06Derive(P06.bits.filter((_, i) => i !== P06.missing), P06.missing),
  p07: { rhythm: P07.rhythm, order: P07.order, mode: p07Mode(P07.rhythm, P07.order) },
  p08: INSTRUMENTS.filter((i) => p08Faulty(P08.display[i], P08.sound[i])),
  p09: (() => {
    const round = p09ExitRound(P09.rounds);
    return { round, ...p09Target(P09.rounds[round - 1]) };
  })(),
  p10: {
    bits: p06Derive(P10.bits.filter((_, i) => i !== P10.missing), P10.missing),
    ops: p10DeriveOps(P10.toneOrder),
  },
};

/** 伺服器啟動時檢查：推導出的答案必須與規格中的字面答案一致、且唯一 */
export function assertChapterData(): void {
  const fail = (m: string): never => {
    throw new Error(`第一章謎題資料錯誤：${m}`);
  };
  if (!eqArr(ANSWERS.p01, [2, 5, 8])) fail(`P01 應為 258，得到 ${ANSWERS.p01.join('')}`);
  if (!eqArr(ANSWERS.p02, ['B'])) fail(`P02 應唯一為 B，得到 ${ANSWERS.p02.join(',')}`);
  if (!eqArr(ANSWERS.p03, [4, 3, 2, 1])) fail(`P03 應為 4321，得到 ${ANSWERS.p03.join('')}`);
  let node: MazeTarget = 'START';
  for (let i = 0; i < 4 && node !== 'EXIT'; i++) node = p04Transition(node, P04.compass[node][P04.route[node]]);
  if (node !== 'EXIT') fail('P04 路線無法抵達出口');
  if (!eqArr(ANSWERS.p06, [1, 0, 1, 1, 0, 1, 0])) fail(`P06 應為 1011010，得到 ${ANSWERS.p06.join('')}`);
  if (!eqArr(ANSWERS.p06, P06.bits)) fail('P06 推導結果與原始序列不符');
  if (ANSWERS.p07.mode !== 'SYNC') fail('P07 模式應為同步模式');
  if (!eqArr(ANSWERS.p08, ['pressure'])) fail(`P08 應唯一為壓力計，得到 ${ANSWERS.p08.join(',')}`);
  if (ANSWERS.p09.round !== 4 || ANSWERS.p09.switch !== 4 || ANSWERS.p09.label !== 'D') fail('P09 應為第 4 輪、S4、D 門');
  for (let k = 1; k < P09.rounds.length; k++) if (P09.rounds[k].played !== P09.rounds[k - 1].real) fail('P09 喇叭必須播放上一輪的音型');
  if (!eqArr(ANSWERS.p10.bits, P10.bits) || !evenParity(P10.bits)) fail('P10 第一階段資料不一致');
  if (eqArr(P10.bits, P06.bits)) fail('P10 第一階段不可與 P06 相同');
  if (!eqArr(ANSWERS.p10.ops, ['OPEN', 'WAIT', 'REPEAT', 'CLOSE'])) fail('P10 第二階段應為 開啟→等待→重複→關閉');
}
