import { create } from 'zustand';
import type {
  ActionResult,
  LogEntry,
  Notice,
  PanelView,
  PuzzleId,
  Role,
  RoomPublic,
  SceneClues,
  SignalReceived,
  SignalToken,
  WorldPublic,
} from '@null-protocol/shared';

export interface Session {
  code: string;
  token: string;
  playerId: string;
}

export type Overlay = 'none' | 'log' | 'signals' | 'help';
export type MicState = 'off' | 'requesting' | 'on' | 'denied' | 'unavailable' | 'forbidden';

export interface ToastNotice extends Notice {
  id: number;
}
export interface ReceivedSignal extends SignalReceived {
  id: number;
}
/** 失語員的標記（指向一個設備，可附一個符號） */
export interface Marker {
  id: number;
  from: Role;
  targetId: string;
  token?: SignalToken;
  at: number;
}

/** 三人同步的倒數（由 puzzle:feedback 的 countdown 觸發，以本機收到時間起算） */
export interface Countdown {
  id: number;
  until: number;
  windowMs: number;
}

export interface OpenPanel {
  deviceId: string;
  view: PanelView;
  /** 最近一次操作的回饋 */
  result: (Pick<ActionResult, 'message' | 'tone' | 'ok'> & { id: number }) | null;
  /** 伺服器要求清空輸入（錯誤答案只清空未送出的輸入） */
  clearKey: number;
}

export interface Prefs {
  volume: number; // 0–1
  sensitivity: number; // 弧度／像素的倍率（0.5–2）
  speech: boolean; // 盲區員的語音播報
}

const PREFS_KEY = 'null-protocol.prefs';
function loadPrefs(): Prefs {
  const def: Prefs = { volume: 0.8, sensitivity: 1, speech: true };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* 瀏覽器可能封鎖儲存空間 */
  }
  return def;
}

let uid = 1;
export const nextId = (): number => uid++;

export interface Store {
  connected: boolean;
  connecting: boolean;
  /** 重新連線中（曾經進入房間） */
  reconnecting: boolean;
  session: Session | null;
  room: RoomPublic | null;
  world: WorldPublic | null;
  /** 只屬於我這個角色的場景線索（伺服器依角色授權） */
  clues: SceneClues;
  /** 伺服器是否開啟開發者工具 */
  debug: boolean;
  debugOpen: boolean;
  markers: Marker[];
  countdown: Countdown | null;
  me: { id: string; role: Role | null; isHost: boolean } | null;
  log: LogEntry[];
  notices: ToastNotice[];
  signals: ReceivedSignal[];
  solved: { id: PuzzleId; title: string; key: number } | null;
  complete: boolean;
  closedReason: string | null;
  panel: OpenPanel | null;
  overlay: Overlay;
  /** 已看過角色說明（每局一次） */
  briefed: boolean;
  /** 指標鎖定中（遊戲進行中） */
  locked: boolean;
  micState: MicState;
  micMuted: boolean;
  micLevel: number;
  speaking: boolean;
  /** 我可以聽見的、正在說話的隊友 */
  talking: Partial<Record<Role, boolean>>;
  voiceLinks: Partial<Record<string, 'connecting' | 'connected' | 'failed'>>;
  prefs: Prefs;
  error: string | null;

  set: (p: Partial<Store>) => void;
  pushNotice: (n: Notice, ttl?: number) => void;
  dismissNotice: (id: number) => void;
  pushSignal: (s: SignalReceived) => void;
  pushMarker: (m: Omit<Marker, 'id' | 'at'>) => void;
  setPrefs: (p: Partial<Prefs>) => void;
  resetGame: () => void;
  resetAll: () => void;
}

export const useStore = create<Store>((set, get) => ({
  connected: false,
  connecting: false,
  reconnecting: false,
  session: null,
  room: null,
  world: null,
  clues: {},
  debug: false,
  debugOpen: false,
  markers: [],
  countdown: null,
  me: null,
  log: [],
  notices: [],
  signals: [],
  solved: null,
  complete: false,
  closedReason: null,
  panel: null,
  overlay: 'none',
  briefed: false,
  locked: false,
  micState: 'off',
  micMuted: false,
  micLevel: 0,
  speaking: false,
  talking: {},
  voiceLinks: {},
  prefs: loadPrefs(),
  error: null,

  set: (p) => set(p),

  pushNotice: (n, ttl = 7000) => {
    const id = nextId();
    set((s) => ({ notices: [...s.notices.slice(-4), { ...n, id }] }));
    setTimeout(() => get().dismissNotice(id), ttl);
  },
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  pushSignal: (sig) => {
    const id = nextId();
    set((s) => ({ signals: [...s.signals.slice(-7), { ...sig, id }] }));
    setTimeout(() => set((s) => ({ signals: s.signals.filter((x) => x.id !== id) })), 9000);
  },

  pushMarker: (m) => {
    const id = nextId();
    set((s) => ({ markers: [...s.markers.filter((x) => x.from !== m.from || x.targetId !== m.targetId).slice(-5), { ...m, id, at: Date.now() }] }));
    setTimeout(() => set((s) => ({ markers: s.markers.filter((x) => x.id !== id) })), 12000);
  },

  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    set({ prefs });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  },

  resetGame: () =>
    set({
      world: null,
      clues: {},
      markers: [],
      countdown: null,
      debugOpen: false,
      log: [],
      signals: [],
      solved: null,
      complete: false,
      panel: null,
      overlay: 'none',
      briefed: false,
    }),

  resetAll: () =>
    set({
      session: null,
      room: null,
      world: null,
      clues: {},
      markers: [],
      countdown: null,
      debug: false,
      debugOpen: false,
      me: null,
      log: [],
      signals: [],
      solved: null,
      complete: false,
      panel: null,
      overlay: 'none',
      briefed: false,
      reconnecting: false,
      talking: {},
      voiceLinks: {},
    }),
}));

export const myRole = (): Role | null => useStore.getState().me?.role ?? null;
