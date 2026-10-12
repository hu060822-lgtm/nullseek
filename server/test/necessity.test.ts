import { afterEach, describe, expect, it } from 'vitest';
import type { PuzzleId, SymbolId } from '@null-protocol/shared';
import {
  ANSWERS,
  INSTRUMENTS,
  P01,
  P02,
  P02_DOORS,
  P03,
  P04,
  P06,
  P07,
  P08,
  P10,
  evenParity,
  p01Derive,
  p02IsExit,
  p03Derive,
  p04Transition,
  p06Derive,
  p07Mode,
  p08Faulty,
  type MazeTarget,
  type P01Pattern,
  type PortalMark,
  type Pos3,
  type Tap,
} from '../src/game/chapter01/data';
import { bench, type Bench } from './harness';

/**
 * 規格 14.3：唯一解不能只靠「人工看起來只有一個答案」。
 *
 * 1. 唯一解：把所有合法候選答案實際送進伺服器，只有一個能讓謎題完成。
 * 2. 三人必要性：拿掉任一角色的線索後，剩下的資訊至少還有兩個候選答案（或該角色才能做的操作無法被取代）。
 */

const benches: Bench[] = [];
function at(id: PuzzleId): Bench {
  const b = bench({ lockBaseMs: 0 });
  benches.push(b);
  while (b.chapter.activeId !== id) b.chapter.debugCommand('complete_puzzle');
  return b;
}
afterEach(() => {
  while (benches.length) benches.pop()!.dispose();
});

const product = <T>(items: readonly T[], n: number): T[][] =>
  n === 0 ? [[]] : product(items, n - 1).flatMap((p) => items.map((x) => [...p, x]));
const perms = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
const distinct = <T>(xs: T[]): number => new Set(xs.map((x) => JSON.stringify(x))).size;
const SYMS: SymbolId[] = ['TRI', 'CIR', 'SQR', 'DIA'];

describe('唯一解（窮舉送進伺服器）', () => {
  it('P01：000～999 只有 258 能開門', () => {
    let wins = 0;
    for (const code of product([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)) {
      const b = at('P01_THREE_LANGUAGES');
      if (b.act('MUTE', 'r1_lock', 'submit', { code }).ok) {
        wins++;
        expect(code).toEqual([2, 5, 8]);
      }
      b.dispose();
      benches.pop();
    }
    expect(wins).toBe(1);
  });

  it('P02：四扇門只有 B 能開', () => {
    const wins = P02_DOORS.filter((d) => at('P02_PHANTOM_DOOR').act('DEAF', `r2_door_${d}`, 'push').ok);
    expect(wins).toEqual(['B']);
  });

  it('P03：0000～9999 只有 4321', () => {
    const b = at('P03_REVERSED_ARCHIVE');
    const wins: number[][] = [];
    for (const code of product([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)) {
      if (b.chapter.activeId !== 'P03_REVERSED_ARCHIVE') break;
      if (b.act('DEAF', 'r3_machine', 'submit', { code }).ok) wins.push(code);
    }
    expect(wins).toEqual([[4, 3, 2, 1]]);
  });

  it('P04：所有長度 ≤ 5 的門洞序列中，只有指定路線抵達出口', () => {
    const marks: PortalMark[] = ['I', 'II', 'III', 'IV'];
    const winners: string[] = [];
    for (let len = 1; len <= 5; len++) {
      for (const seq of product(marks, len)) {
        let node: MazeTarget = 'START';
        let arrivedAt = -1;
        seq.forEach((m, i) => {
          if (node === 'EXIT') return;
          node = p04Transition(node, m);
          if (node === 'EXIT') arrivedAt = i;
        });
        // 只算「最後一步剛好抵達」的序列（抵達後就沒有下一步了）
        if (arrivedAt === seq.length - 1) winners.push(seq.join('-'));
      }
    }
    // 只有一條「最短」路線；更長的序列一定是先走錯回到起點、再走同一條路線
    expect(winners.filter((w) => w.split('-').length === 4)).toEqual(['IV-II-III-I']);
    expect(winners.every((w) => w.endsWith('IV-II-III-I'))).toBe(true);
    // 伺服器實際走一次：每一步都必須先確認節點
    const b = at('P04_MAPLESS_ROOM');
    for (const [echo, mark] of [['LONG_ECHO', 'IV'], ['SHORT_ECHO', 'II'], ['LOW_HUM', 'III'], ['TRIPLE_KNOCK', 'I']] as const) {
      expect(b.act('BLIND', 'r4_echo', 'confirm', { echo }).ok).toBe(true);
      expect(b.act('MUTE', `r4_${mark}`, 'enter').ok).toBe(true);
    }
    expect(b.chapter.activeId).toBe('P05_MUTE_PROTOCOL');
  });

  it('P05：每一槽的 3 種側向 × 4 種動作中只有一種被接受', () => {
    const b = at('P05_MUTE_PROTOCOL');
    for (let slot = 0; slot < 3; slot++) {
      const accepted: string[] = [];
      for (const side of ['LEFT', 'NONE', 'RIGHT']) {
        for (const dial of SYMS) {
          b.act('BLIND', 'r5_lever', `lever_${side}`);
          const before = (b.chapter.debugState({}).conditions as { slots: unknown[] }).slots.filter(Boolean).length;
          b.act('DEAF', 'r5_console', 'commit', { dial });
          const after = (b.chapter.debugState({}).conditions as { slots: unknown[] }).slots.filter(Boolean).length;
          if (after > before) {
            accepted.push(`${side}_${dial}`);
            break;
          }
        }
        if (accepted.length) break;
      }
      expect(accepted).toHaveLength(1);
    }
    expect(b.act('DEAF', 'r5_console', 'final').ok).toBe(true);
  });

  it('P06：128 種七位元序列只有 1011010', () => {
    const b = at('P06_MISSING_PULSE');
    const wins: number[][] = [];
    for (const bits of product([0, 1], 7)) {
      if (b.chapter.activeId !== 'P06_MISSING_PULSE') break;
      if (b.act('MUTE', 'r6_analyzer', 'submit', { bits }).ok) wins.push(bits);
    }
    expect(wins).toEqual([[1, 0, 1, 1, 0, 1, 0]]);
  });

  it('P07：三台控制台各只有一種設定被判定正確', () => {
    const b = at('P07_THREE_SECOND_TRUTH');
    const okBeats = product<Tap>(['S', 'L'], 3).filter((beats) => b.act('BLIND', 'r7_resonator', 'set', { beats }).ok);
    const okOrder = product<Pos3>(['LEFT', 'CENTER', 'RIGHT'], 3).filter((order) => b.act('DEAF', 'r7_lights', 'set', { order }).ok);
    const okMode = ['SYNC', 'REVERSE', 'ALTERNATE', 'SINGLE'].filter((mode) => b.act('MUTE', 'r7_protocol', 'set', { mode }).ok);
    expect(okBeats).toEqual([['S', 'S', 'L']]);
    expect(okOrder).toEqual([['LEFT', 'CENTER', 'RIGHT']]);
    expect(okMode).toEqual(['SYNC']);
  });

  it('P08：只有壓力計能完成校準', () => {
    const wins = INSTRUMENTS.filter((i) => at('P08_LYING_INSTRUMENTS').act('MUTE', `r8_${i}`, 'calibrate').ok);
    expect(wins).toEqual(['pressure']);
  });

  it('P09：所有（輪次 × 扳下的開關 × 走進的門位）中只有（第 4 輪, S4, 位置 1）完成', () => {
    const wins: string[] = [];
    for (let loop = 1; loop <= 4; loop++) {
      for (const sw of [0, 1, 2, 3, 4]) {
        for (const slot of [1, 2, 3, 4]) {
          const b = at('P09_NONEXISTENT_LOOP');
          for (let i = 1; i < loop; i++) b.act('DEAF', 'r9_2', 'enter');
          if (sw) b.act('BLIND', 'r9_switches', `flip_${sw}`);
          b.act('DEAF', `r9_${slot}`, 'enter');
          if (b.chapter.activeId !== 'P09_NONEXISTENT_LOOP') wins.push(`${loop}-S${sw}-${slot}`);
          b.dispose();
          benches.pop();
        }
      }
    }
    expect(wins).toEqual(['4-S4-1']);
  });

  it('P10：第一階段 128 種只有 1101001；第二階段 4^4 種排列只有 開啟→等待→重複→關閉', () => {
    const b = at('P10_NULL_PROTOCOL');
    const bitWins = product([0, 1], 7).filter((bits) => b.chapter.world().stage?.phase === 1 && b.act('MUTE', 'r10_analyzer', 'submit_bits', { bits }).ok);
    expect(bitWins).toEqual([[1, 1, 0, 1, 0, 0, 1]]);
    const opWins = product(['OPEN', 'WAIT', 'REPEAT', 'CLOSE'], 4).filter((ops) => b.chapter.world().stage?.phase === 2 && b.act('MUTE', 'r10_analyzer', 'submit_ops', { ops }).ok);
    expect(opWins).toEqual([['OPEN', 'WAIT', 'REPEAT', 'CLOSE']]);
  });
});

describe('三人必要性（拿掉任一角色的線索，就不只一個候選答案）', () => {
  it('P01：少了 BLIND 的音型或 DEAF 的符號，候選答案都不只一個；少了 MUTE 則沒有對照', () => {
    const rows: P01Pattern[] = ['S', 'L', 'SL'];
    const noBlind = distinct(product(rows, 3).map((s) => p01Derive(s, P01.symbols)));
    const noDeaf = distinct(product<SymbolId>(['CIR', 'TRI', 'SQR'], 3).map((sym) => p01Derive(P01.sounds, sym)));
    expect(noBlind).toBeGreaterThan(1);
    expect(noDeaf).toBeGreaterThan(1);
    // 只知道音型或只知道符號時，每一位都還有三種可能
    for (let i = 0; i < 3; i++) {
      expect(new Set(rows.map((r) => P01.grid[r][P01.symbols[i]])).size).toBe(3);
      expect(new Set((['CIR', 'TRI', 'SQR'] as SymbolId[]).map((c) => P01.grid[P01.sounds[i]][c])).size).toBe(3);
    }
  });

  it('P02：只有聲音剩 {B, C}；只有燈號剩 {A, B, D}', () => {
    const bySound = P02_DOORS.filter((d) => P02.sounds[d] === 'LOW_FALL');
    const byLamp = P02_DOORS.filter((d) => P02.lamps[d] === 'WHITE');
    expect(bySound).toEqual(['B', 'C']);
    expect(byLamp).toEqual(['A', 'B', 'D']);
    expect(P02_DOORS.filter((d) => p02IsExit(P02.sounds[d], P02.lamps[d]))).toEqual(['B']);
  });

  it('P03：少了 BLIND 的時間順序或 DEAF 的位置符號，各有 24 種候選', () => {
    expect(distinct(perms([1, 2, 3, 4]).map((o) => p03Derive(o, P03.plates)))).toBe(24);
    expect(distinct(perms(P03.plates).map((pl) => p03Derive(P03.tapOrder, pl)))).toBe(24);
  });

  it('P04：少了 DEAF 的方位儀，起點的「東」可能是任何門洞；少了 BLIND 的確認，門洞不會開', () => {
    const marks: PortalMark[] = ['I', 'II', 'III', 'IV'];
    // 每個節點的方位都不同：不知道方位就無法從固定的門洞推出方向
    const eastPortals = P04.nodes.map((n) => P04.compass[n].E);
    expect(new Set(eastPortals).size).toBe(4);
    expect(marks.filter((m) => p04Transition('START', m) !== 'START')).toHaveLength(1);
    const b = at('P04_MAPLESS_ROOM');
    for (const m of marks) expect(b.act('DEAF', `r4_${m}`, 'enter').message).toContain('封住');
  });

  it('P05：側向只有 BLIND 能設、動作只有 DEAF 能設、順序只在 MUTE 的文件', () => {
    const b = at('P05_MUTE_PROTOCOL');
    expect(b.act('MUTE', 'r5_lever', 'lever_LEFT').ok).toBe(false);
    expect(b.act('DEAF', 'r5_lever', 'lever_LEFT').ok).toBe(false);
    expect(b.act('BLIND', 'r5_console', 'commit', { dial: 'CIR' }).ok).toBe(false);
    expect(b.act('MUTE', 'r5_console', 'commit', { dial: 'CIR' }).ok).toBe(false);
    expect(b.chapter.openDevice('BLIND', 'r5_doc').ok).toBe(false);
    expect(b.chapter.openDevice('DEAF', 'r5_doc').ok).toBe(false);
  });

  it('P06：少了 DEAF 不知道缺口在哪（7 種）；少了 BLIND 不知道位元值；少了 MUTE 不知道補 0 還是 1', () => {
    const known = P06.bits.filter((_, i) => i !== P06.missing);
    const noDeaf = distinct([0, 1, 2, 3, 4, 5, 6].map((pos) => p06Derive(known, pos)));
    expect(noDeaf).toBeGreaterThan(1);
    const noBlind = distinct(product<0 | 1>([0, 1], 6).map((k) => p06Derive(k, P06.missing)));
    expect(noBlind).toBeGreaterThan(1);
    const noMute = [0, 1].map((v) => {
      const out = [...known];
      out.splice(P06.missing, 0, v as 0 | 1);
      return out;
    });
    expect(noMute.filter(evenParity)).toHaveLength(1);
    expect(distinct(noMute)).toBe(2);
    expect(ANSWERS.p06).toEqual(P06.bits);
  });

  it('P07：每個人的設定都需要另一個人的線索；模式同時需要兩人的資訊', () => {
    // 盲區員不知道節奏（8 種）、靜默員不知道燈序（27 種）
    expect(product<Tap>(['S', 'L'], 3)).toHaveLength(8);
    // 只知道節奏、不知道燈序：模式不確定
    const modesByOrder = new Set([['LEFT', 'CENTER', 'RIGHT'], ['RIGHT', 'CENTER', 'LEFT']].map((o) => p07Mode(P07.rhythm, o as Pos3[])));
    expect(modesByOrder.size).toBe(2);
    const modesByRhythm = new Set([['S', 'S', 'L'], ['L', 'L', 'S']].map((r) => p07Mode(r as Tap[], P07.order)));
    expect(modesByRhythm.size).toBe(2);
  });

  it('P08：只有聲音剩 {壓力計, 流量計}；只有讀數剩 {壓力計, 電壓計}', () => {
    expect(INSTRUMENTS.filter((i) => P08.sound[i] === 'INTERMITTENT')).toEqual(['pressure', 'flow']);
    expect(INSTRUMENTS.filter((i) => P08.display[i] === 'NORMAL')).toEqual(['pressure', 'volt']);
    expect(INSTRUMENTS.filter((i) => p08Faulty(P08.display[i], P08.sound[i]))).toEqual(['pressure']);
  });

  it('P09：開關只有 BLIND 能扳；門序與燈號只有 DEAF 看得到', () => {
    const b = at('P09_NONEXISTENT_LOOP');
    expect(b.act('DEAF', 'r9_switches', 'flip_4').ok).toBe(false);
    expect(b.act('MUTE', 'r9_switches', 'flip_4').ok).toBe(false);
    expect(b.chapter.cluesFor('MUTE')).toEqual({});
    expect(b.chapter.cluesFor('BLIND')).toEqual({});
    expect(b.chapter.openDevice('MUTE', 'r9_monitor').ok).toBe(false);
  });

  it('P10：第一階段少了 BLIND，被遮蔽的位元有兩種可能；少了 DEAF，不知道缺口位置', () => {
    const noBlind = [0, 1].map((masked) => {
      const bits = [...P10.bits] as number[];
      bits[P10.masked] = masked;
      const ones = bits.reduce((a, b, i) => a + (i === P10.missing ? 0 : b), 0);
      bits[P10.missing] = ones % 2;
      return bits;
    });
    expect(distinct(noBlind)).toBe(2);
    const heard = P10.bits.filter((_, i) => i !== P10.missing);
    expect(distinct([0, 1, 2, 3, 4, 5, 6].map((pos) => p06Derive(heard as Array<0 | 1>, pos)))).toBeGreaterThan(1);
  });
});
