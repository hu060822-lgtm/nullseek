import type {
  ActionResult,
  DebugState,
  LogEntry,
  Notice,
  PanelView,
  PuzzleFeedback,
  PuzzleId,
  Role,
  SceneClues,
  StagePublic,
  ZoneId,
} from '@null-protocol/shared';
import type { Values } from './util';

/** 房間層提供給章節引擎的回呼（章節引擎本身不碰網路） */
export interface ChapterHooks {
  /** 公開狀態或授權線索改變，需要重新廣播 */
  onChange(): void;
  notify(role: Role, n: Notice): void;
  broadcast(n: Notice): void;
  log(role: Role, entry: LogEntry): void;
  /** 機關回饋（房間層依接收者的感官過濾） */
  feedback(f: PuzzleFeedback): void;
  completed(id: PuzzleId, title: string): void;
  reset(id: PuzzleId, scope: string): void;
  hint(id: PuzzleId, tier: number, text: string): void;
  /** 通知已開啟面板的客戶端重新取得面板內容 */
  refreshDevices(): void;
  chapterComplete(): void;
  isConnected(role: Role): boolean;
  /** 把目前位於 zone 內的玩家傳送到指定位置（迷宮、循環走廊換場用） */
  teleport(zone: ZoneId, spots: Record<Role, { x: number; z: number; yaw: number }>): void;
}

/** 謎題模組可以使用的章節服務 */
export interface ChapterApi {
  now(): number;
  readonly syncWindowMs: number;
  hooks: ChapterHooks;
  /** 答案錯誤：記錄嘗試次數並暫時鎖定這個角色的這台設備，回傳鎖定毫秒數 */
  wrong(role: Role, deviceId: string): number;
  lockRemaining(role: Role, deviceId: string): number;
  lockClear(role: Role, deviceId: string): void;
  /** 只累加嘗試次數（不鎖定） */
  attempt(): void;
  /** 暫時進入 failed 狀態 */
  transientFail(ms: number): void;
  /** 謎題完成（單一狀態轉換；重複呼叫無效） */
  complete(id: PuzzleId): boolean;
  /** 公開狀態改變 */
  changed(): void;
}

/** 動作輸入（已經過房間、身分、角色、距離與格式的初步驗證） */
export interface ActionInput {
  actionType: string;
  targetId: string;
  payload: Values;
}

/**
 * 統一的謎題模組介面（規格第二節）。
 * 章節引擎負責：身分與權限、requestId 去重、鎖定、提示、完成與開門；
 * 模組只負責自己的資料、線索授權、操作驗證與重置。
 */
export interface PuzzleModule {
  readonly id: PuzzleId;
  /** 謎題所在的房間（1–10） */
  readonly room: number;
  readonly hints: readonly [string, string, string];
  /** 啟用時初始化（固定資料；資料無法保證唯一解時會丟出錯誤） */
  initialize(): void;
  /** 不含暫時 failed 的進度 */
  status(): 'active' | 'ready';
  stage(): Omit<StagePublic, 'attempts'>;
  /** 只屬於該角色的 3D 線索 */
  clues(role: Role): SceneClues;
  /** 角色在這台設備上看到的面板；不屬於本題的設備回傳 null */
  view(role: Role, deviceId: string): PanelView | null;
  /** 處理操作；不認得的操作回傳 null（由章節回覆「操作無效」） */
  act(role: Role, input: ActionInput): ActionResult | null;
  /** 走進門洞（迷宮、循環走廊） */
  portal?(role: Role, portalId: string): ActionResult | null;
  /** 這次面板屬於第幾輪（線索紀錄依輪次分開） */
  logRound?(): number | undefined;
  /** 管理員完整重置 */
  reset(): void;
  debug(): Pick<DebugState, 'answer' | 'conditions'>;
  onPresenceChange?(): void;
  dispose(): void;
}

export type { LogEntry };
