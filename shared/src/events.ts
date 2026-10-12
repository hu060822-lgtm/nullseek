import type {
  ActionResult,
  LogEntry,
  PanelView,
  PuzzleFeedback,
  PuzzleId,
  SceneClues,
} from './puzzle-types';
import type { RiskStatus } from './acoustics';
import type { Role } from './roles';
import type { SignalToken } from './signals';
import type {
  IceServerInfo,
  Notice,
  PositionsMsg,
  RoomPublic,
  SignalReceived,
  WorldPublic,
} from './types';

/** 通用 ack 回應 */
export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface SessionInfo {
  roomCode: string;
  /** 重連憑證：只回給該玩家本人，不得公開 */
  token: string;
  playerId: string;
}

export interface JoinPayload {
  name: string;
  code: string;
}
export interface RejoinPayload {
  code: string;
  token: string;
}

export interface MovePayload {
  x: number;
  y: number;
  z: number;
  yaw: number;
  seq: number;
}

/** 規格 1.3 的統一操作格式 */
export interface PuzzleActionPayload {
  puzzleId: PuzzleId;
  /** 動作類型（例如 submit、push、take_exit） */
  actionType: string;
  /** 操作目標（設備 ID 或門洞 ID） */
  targetId: string;
  payload?: Record<string, unknown>;
  /** 每次操作唯一；網路重送時伺服器會回傳上一次的結果，不會重複執行 */
  requestId: string;
}

export type DebugCommand = 'reset_puzzle' | 'complete_puzzle' | 'reinit_room';

export interface DebugState {
  puzzleId: PuzzleId | null;
  status: string;
  answer: unknown;
  conditions: Record<string, unknown>;
  syncRemainingMs: number | null;
  recent: Array<{ at: number; role: Role; puzzleId: string; actionType: string; targetId: string; ok: boolean; message: string }>;
  roles: Record<string, Role | null>;
}

export type VoiceSignalKind = 'offer' | 'answer' | 'ice';

export interface VoiceSignalPayload {
  /** 對方角色 */
  to: Role;
  /** 這條語音邊的方向：sender → receiver */
  edge: { from: Role; to: Role };
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: unknown;
}

export interface VoiceSignalRelay extends VoiceSignalPayload {
  from: Role;
}

export interface FullSync {
  room: RoomPublic;
  world: WorldPublic | null;
  me: { id: string; role: Role | null; isHost: boolean };
  log: LogEntry[];
  pos: { x: number; y: number; z: number; yaw: number } | null;
  /** 只屬於這位玩家角色的 3D 線索 */
  clues: SceneClues;
  /** 伺服器是否開放開發者工具 */
  debug: boolean;
  /** 回聲風險區（聲學感測器）目前的狀態 */
  risks: RiskStatus[];
  /** 只給盲區員：回聲還會被干擾多久（毫秒） */
  echoJamMs?: number;
}

/** 客戶端 → 伺服器 */
export interface ClientToServerEvents {
  'room:create': (p: { name: string }, ack: (r: Ack<SessionInfo & { sync: FullSync }>) => void) => void;
  'room:join': (p: JoinPayload, ack: (r: Ack<SessionInfo & { sync: FullSync }>) => void) => void;
  'room:rejoin': (p: RejoinPayload, ack: (r: Ack<{ sync: FullSync; playerId: string }>) => void) => void;
  'room:leave': (ack?: (r: Ack) => void) => void;
  'room:selectRole': (p: { role: Role | null }, ack: (r: Ack) => void) => void;
  'room:start': (ack: (r: Ack) => void) => void;
  'room:restart': (ack: (r: Ack) => void) => void;

  'player:move': (p: MovePayload) => void;
  /** 身體姿態：蹲下、面板是否開著（關掉面板時結束「操作／觀察」動作） */
  'player:stance': (p: { crouch: boolean; panel: boolean }) => void;
  /**
   * 盲區員發出回聲脈衝。只用來判定回聲風險區（伺服器用自己記錄的位置與時間）；
   * 不帶任何資料、也沒有回覆內容，所以不會成為取得隱藏資訊的管道。
   */
  'echo:pulse': () => void;

  'device:open': (p: { deviceId: string }, ack: (r: Ack<{ view: PanelView | null; message?: string }>) => void) => void;
  'puzzle:action': (p: PuzzleActionPayload, ack: (r: ActionResult) => void) => void;

  'signal:emit': (p: { tokens: SignalToken[] }, ack: (r: Ack) => void) => void;
  /** 標記工具：指向一個設備（可附一個符號）。只有失語員能用 */
  'signal:mark': (p: { targetId: string; token?: SignalToken }, ack: (r: Ack) => void) => void;
  'debug:state': (ack: (r: Ack<{ state: DebugState }>) => void) => void;
  'debug:command': (p: { cmd: DebugCommand }, ack: (r: Ack) => void) => void;
  'hint:request': (ack: (r: Ack<{ tier: number; text: string; puzzle: PuzzleId }>) => void) => void;

  'voice:signal': (p: VoiceSignalPayload) => void;
  'voice:ready': (p: { micEnabled: boolean }) => void;
}

/** 伺服器 → 客戶端 */
export interface ServerToClientEvents {
  'room:state': (room: RoomPublic) => void;
  'puzzle:state': (world: WorldPublic) => void;
  'puzzle:clues': (clues: SceneClues) => void;
  'puzzle:feedback': (f: PuzzleFeedback) => void;
  'puzzle:completed': (p: { puzzleId: PuzzleId; title: string }) => void;
  'puzzle:reset': (p: { puzzleId: PuzzleId; scope: string }) => void;
  'puzzle:hint': (p: { puzzleId: PuzzleId; tier: number; text: string }) => void;
  'signal:marker': (p: { from: Role; targetId: string; token?: SignalToken }) => void;
  'world:positions': (p: PositionsMsg) => void;
  /** 聲學感測器的狀態改變（休息／預警／警戒） */
  'risk:state': (p: RiskStatus[]) => void;
  /** 聲學感測器偵測到回聲：所有人收到警報；盲區員的回聲被干擾 jamMs 毫秒 */
  'risk:tripped': (p: { id: string; jamMs: number }) => void;
  /** 伺服器校正位置；teleport＝謎題造成的傳送（客戶端同時套用朝向並播放空間轉換效果） */
  'player:correct': (p: { x: number; y: number; z: number; yaw: number; teleport?: boolean }) => void;
  'player:log': (log: LogEntry[]) => void;
  'signal:received': (s: SignalReceived) => void;
  'notice': (n: Notice) => void;
  'chapter:complete': () => void;
  'device:refresh': (p: { deviceId?: string }) => void;
  'room:closed': (p: { reason: string }) => void;
  'game:restarted': () => void;

  'voice:signal': (p: VoiceSignalRelay) => void;
  /** 某位隊友的語音狀態改變（上線／離線／麥克風）— 發話端據此（重新）建立連線 */
  'voice:peer': (p: { role: Role; connected: boolean; micEnabled: boolean }) => void;
}

export const VOICE_LIMITS = {
  /** SDP 最大長度 */
  maxSdpLength: 20_000,
} as const;

export type { IceServerInfo };
