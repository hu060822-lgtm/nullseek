/**
 * 伺服器傳給客戶端的「設備面板」描述。
 *
 * 重要：這裡只有型別。任何謎題答案、轉換表與驗證規則都只存在伺服器，
 * 客戶端只會收到「該角色目前有權看到的內容」。
 */

import type { R2DoorKey } from './level';

export const PUZZLE_IDS = [
  'P01_THREE_LANGUAGES',
  'P02_PHANTOM_DOOR',
  'P03_REVERSED_ARCHIVE',
  'P04_MAPLESS_ROOM',
  'P05_MUTE_PROTOCOL',
  'P06_MISSING_PULSE',
  'P07_THREE_SECOND_TRUTH',
  'P08_LYING_INSTRUMENTS',
  'P09_NONEXISTENT_LOOP',
  'P10_NULL_PROTOCOL',
] as const;
export type PuzzleId = (typeof PUZZLE_IDS)[number];

export const PUZZLE_TITLES: Record<PuzzleId, string> = {
  P01_THREE_LANGUAGES: '三種語言',
  P02_PHANTOM_DOOR: '聽見不存在的門',
  P03_REVERSED_ARCHIVE: '逆序檔案',
  P04_MAPLESS_ROOM: '沒有地圖的房間',
  P05_MUTE_PROTOCOL: '失語協定',
  P06_MISSING_PULSE: '缺失的第七次脈衝',
  P07_THREE_SECOND_TRUTH: '三秒鐘的真相',
  P08_LYING_INSTRUMENTS: '會說謊的儀器',
  P09_NONEXISTENT_LOOP: '不曾發生的循環',
  P10_NULL_PROTOCOL: 'NULL：最後的協定',
};

export const isPuzzleId = (v: unknown): v is PuzzleId => typeof v === 'string' && (PUZZLE_IDS as readonly string[]).includes(v);

/** 謎題狀態（規格 2.0）：locked → active →（ready）→ completed；failed 是暫時狀態 */
export type PuzzleStatus = 'locked' | 'ready' | 'active' | 'failed' | 'completed';

export type LampColor = 'RED' | 'BLUE' | 'GREEN' | 'WHITE' | 'OFF';
export const LAMP_LABEL: Record<LampColor, string> = {
  RED: '紅',
  BLUE: '藍',
  GREEN: '綠',
  WHITE: '白',
  OFF: '熄',
};
/**
 * 燈號顏色是謎題資料本身（功能色），所以保留可辨識的四色；
 * 色調壓低到與設施的骨白／炭黑／朱紅調性一致，避免高飽和霓虹感。
 */
export const LAMP_HEX: Record<LampColor, string> = {
  RED: '#C64B3C',
  BLUE: '#4F7A99',
  GREEN: '#6E9466',
  WHITE: '#E8E5DC',
  OFF: '#3A3E41',
};

export type SymbolId = 'TRI' | 'CIR' | 'SQR' | 'DIA';
export const SYMBOL_GLYPH: Record<SymbolId, string> = {
  TRI: '△',
  CIR: '○',
  SQR: '□',
  DIA: '◇',
};
export const SYMBOL_IDS: readonly SymbolId[] = ['TRI', 'CIR', 'SQR', 'DIA'];

/** 面板上的展示區塊（唯讀內容） */
export type Block =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; header?: string[]; rows: string[][] }
  | { type: 'lights'; seq: LampColor[]; animate?: boolean; caption?: string }
  | { type: 'symbols'; seq: SymbolId[]; caption?: string }
  | { type: 'digits'; seq: number[]; caption?: string }
  | { type: 'status'; tone: 'info' | 'ok' | 'warn' | 'error'; text: string }
  /** 節奏（短／長），以閃光呈現；只會給看得見的人 */
  | { type: 'pulses'; seq: Array<'S' | 'L'>; animate?: boolean; caption?: string }
  /** 時間槽／燈號組：groups 是每組的格數 */
  | { type: 'slots'; seq: SlotMark[]; groups?: number[]; caption?: string };

/** ON／OFF＝燈亮／燈滅；RECEIVED＝有收到（不顯示值）；MASKED＝被遮蔽；MISSING＝無訊號 */
export type SlotMark = 'ON' | 'OFF' | 'RECEIVED' | 'MASKED' | 'MISSING';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/** 面板上的輸入元件 */
export type Control =
  | {
      type: 'digits';
      id: string;
      label: string;
      /** 允許的最短／最長長度，兩者相同代表固定長度 */
      minLength: number;
      maxLength: number;
      /** 每一位數字的合法範圍 */
      min: number;
      max: number;
    }
  | { type: 'selects'; id: string; label: string; count: number; options: SelectOption[] }
  | { type: 'select'; id: string; label: string; options: SelectOption[] }
  | { type: 'knobs'; id: string; label: string; count: number; positions: number };

export interface ActionBtn {
  id: string;
  label: string;
  kind?: 'primary' | 'danger' | 'neutral';
  /** 這個按鈕會一併送出哪些輸入元件的值（預設全部） */
  uses?: string[];
  disabled?: boolean;
}

export interface TapEvent {
  /** 相對於播放起點的毫秒 */
  at: number;
  /** 敲擊長度（毫秒） */
  len: number;
  /** 音高（Hz） */
  tone: number;
  /** 左右聲道（-1 最左、0 中央、1 最右） */
  pan?: number;
}

/** 只會傳給盲區員的機械敲擊資料（以聲音播放，不提供波形文字） */
export interface TapPattern {
  events: TapEvent[];
  durationMs: number;
}

export interface PanelView {
  deviceId: string;
  title: string;
  subtitle?: string;
  blocks: Block[];
  controls: Control[];
  actions: ActionBtn[];
  tap?: TapPattern;
  /** 此面板內容是線索（會被記錄到該玩家的私人線索紀錄） */
  clue?: boolean;
  /** 設備暫時鎖定 */
  lockedUntil?: number;
}

export type Tone = 'ok' | 'warn' | 'error' | 'info';

export interface ActionResult {
  ok: boolean;
  message: string;
  tone: Tone;
  view?: PanelView | null;
  lockMs?: number;
  /** 客戶端應清空目前輸入（例如錯誤後「只清空輸入欄位」） */
  clear?: boolean;
}

/** 每位玩家私人的線索紀錄條目 */
export interface LogEntry {
  key: string;
  puzzle: PuzzleId | 'LORE';
  /** 循環類謎題：紀錄屬於第幾輪 */
  round?: number;
  /** 聲音線索的錄音（只會存在於聽得見的角色的紀錄中），可以重聽 */
  tap?: TapPattern;
  deviceId: string;
  title: string;
  at: number;
  /** 盲區員的線索只能重聽，不會有文字內容 */
  audioOnly?: boolean;
  blocks: Block[];
}

/* ------------------------------------------------------------------ */
/* 3D 場景中的授權線索（伺服器只把角色有權取得的部分傳給該角色）            */
/* ------------------------------------------------------------------ */

export type DoorSoundId = 'HIGH_CONT' | 'LOW_FALL' | 'LOW_FIXED';
export type Landmark = 'NONE' | 'TRIANGLE' | 'CYLINDER' | 'SQUARE';

export interface SceneClues {
  /** P01 符號燈依序亮起（DEAF） */
  r1Symbols?: SymbolId[];
  /** P02 門上的指示燈（DEAF） */
  r2Lamps?: Record<R2DoorKey, LampColor>;
  /** P02 門後的聲音（BLIND，空間音訊） */
  r2Sounds?: Record<R2DoorKey, DoorSoundId>;
  /** P04 目前節點的地標（看得見的人） */
  r4Landmark?: Landmark;
  /** P09 門上的標籤（位置 1→4，DEAF） */
  r9Labels?: string[];
  /** P09 燈號（DEAF） */
  r9Lights?: number[];
}

/** 機關回饋（伺服器依接收者感官過濾：sound 只給聽得見的人、visual 只給看得見的人） */
export interface PuzzleFeedback {
  puzzleId: PuzzleId;
  targetId?: string;
  sound?: 'accept' | 'reject' | 'thud' | 'unlock' | 'countdown' | 'selftest' | 'shift';
  visual?: 'flash' | 'shake' | 'countdown' | 'error' | 'selftest' | 'shift';
  /** 倒數長度（毫秒），以客戶端收到的時間起算 */
  windowMs?: number;
}

/** 公開的謎題進度（不含任何答案或專屬線索） */
export interface StagePublic {
  attempts: number;
  /** 多階段謎題目前的階段（P10） */
  phase?: number;
  /** 同步輪次剩餘時間（毫秒，伺服器送出時） */
  syncRemainingMs?: number | null;
  /** 迷宮／循環：換場次數（客戶端用來重新整理場景） */
  visit?: number;
}
