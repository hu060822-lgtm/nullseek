import type {
  ActionBtn,
  ActionResult,
  Block,
  Control,
  PanelView,
  TapPattern,
  Tone,
} from '@null-protocol/shared';
import type { Tap } from './chapter01/data';

/* ------------------------------------------------------------------ */
/* 輸入驗證：客戶端送來的 values 全部視為不可信                          */
/* ------------------------------------------------------------------ */

export type Values = Record<string, unknown>;

export function parseDigits(
  values: Values,
  id: string,
  opts: { min: number; max: number; minLength: number; maxLength: number },
): number[] | null {
  const raw = values[id];
  if (!Array.isArray(raw)) return null;
  if (raw.length < opts.minLength || raw.length > opts.maxLength) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < opts.min || v > opts.max) return null;
    out.push(v);
  }
  return out;
}

export function parseSelects<T extends string>(
  values: Values,
  id: string,
  count: number,
  allowed: readonly T[],
): T[] | null {
  const raw = values[id];
  if (!Array.isArray(raw) || raw.length !== count) return null;
  const out: T[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return null;
    out.push(v as T);
  }
  return out;
}

export function parseSelect<T extends string>(values: Values, id: string, allowed: readonly T[]): T | null {
  const raw = values[id];
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) return null;
  return raw as T;
}

export function parseKnobs(values: Values, id: string, count: number, positions: number): number[] | null {
  return parseDigits(values, id, { min: 1, max: positions, minLength: count, maxLength: count });
}

/* ------------------------------------------------------------------ */
/* 結果／面板建構                                                       */
/* ------------------------------------------------------------------ */

export const res = (ok: boolean, tone: Tone, message: string, extra: Partial<ActionResult> = {}): ActionResult => ({
  ok,
  tone,
  message,
  ...extra,
});

export const okRes = (message: string, extra: Partial<ActionResult> = {}): ActionResult =>
  res(true, 'ok', message, extra);
export const failRes = (message: string, extra: Partial<ActionResult> = {}): ActionResult =>
  res(false, 'error', message, extra);
export const warnRes = (message: string, extra: Partial<ActionResult> = {}): ActionResult =>
  res(false, 'warn', message, extra);

export interface ViewInit {
  deviceId: string;
  title: string;
  subtitle?: string;
  blocks?: Block[];
  controls?: Control[];
  actions?: ActionBtn[];
  tap?: TapPattern;
  clue?: boolean;
}

export const makeView = (v: ViewInit): PanelView => ({
  deviceId: v.deviceId,
  title: v.title,
  subtitle: v.subtitle,
  blocks: v.blocks ?? [],
  controls: v.controls ?? [],
  actions: v.actions ?? [],
  tap: v.tap,
  clue: v.clue,
});

export const statusBlock = (tone: 'info' | 'ok' | 'warn' | 'error', text: string): Block => ({
  type: 'status',
  tone,
  text,
});

/* ------------------------------------------------------------------ */
/* 機械敲擊資料                                                         */
/* ------------------------------------------------------------------ */

/** 短敲／長敲序列（短 130ms 高音、長 430ms 低音） */
export function tapSequence(seq: readonly Tap[]): TapPattern {
  const events = [];
  let t = 200;
  for (const s of seq) {
    const len = s === 'S' ? 130 : 430;
    events.push({ at: t, len, tone: s === 'S' ? 280 : 130 });
    t += len + 340;
  }
  return { events, durationMs: t };
}

/** 分組敲擊：每組 n 下（每下 110ms、間隔 230ms），組與組之間停頓較長 */
export function tapGroups(groups: readonly number[]): TapPattern {
  const events = [];
  let t = 200;
  for (const n of groups) {
    for (let i = 0; i < n; i++) {
      events.push({ at: t, len: 110, tone: 200 });
      t += 230;
    }
    t += 900;
  }
  return { events, durationMs: t };
}

/** 依序播放的音（每個音可指定長度、音高與左右聲道），音與音之間有固定間隔 */
export function toneSequence(
  tones: ReadonlyArray<{ len: number; tone: number; pan?: number; gapAfter?: number }>,
  gap = 420,
): TapPattern {
  const events = [];
  let t = 200;
  for (const x of tones) {
    events.push({ at: t, len: x.len, tone: x.tone, pan: x.pan });
    t += x.len + (x.gapAfter ?? gap);
  }
  return { events, durationMs: t };
}

/** 短／長節奏（短 130ms、長 430ms） */
export function rhythm(seq: readonly Tap[], tone = 240): TapPattern {
  return toneSequence(seq.map((s) => ({ len: s === 'S' ? 130 : 430, tone })), 300);
}
