import type { DoorId, DoorState } from './level';
import type { PuzzleId, PuzzleStatus, StagePublic } from './puzzle-types';
import type { Role } from './roles';
import type { SignalToken } from './signals';

export type RoomPhase = 'LOBBY' | 'PLAYING' | 'COMPLETE';

/** 大廳／房間中對所有玩家公開的玩家資訊（絕不包含 token） */
export interface PlayerPublic {
  /** 房內短 ID（不是 socket.id，重連後不變） */
  id: string;
  name: string;
  role: Role | null;
  connected: boolean;
  isHost: boolean;
}

export interface RoomPublic {
  code: string;
  phase: RoomPhase;
  players: PlayerPublic[];
  /** 可以開始遊戲：三人齊、三種角色各一 */
  canStart: boolean;
}

export interface PuzzlePublic {
  id: PuzzleId;
  title: string;
  status: PuzzleStatus;
}

/** 對全體玩家公開的世界狀態（不含任何答案或角色專屬線索） */
export interface WorldPublic {
  version: number;
  puzzles: PuzzlePublic[];
  /** 目前進行中的謎題；全部完成則為 null */
  activePuzzle: PuzzleId | null;
  doors: DoorState;
  /** 目前謎題的公開進度 */
  stage: StagePublic | null;
  chapterComplete: boolean;
  hints: { used: number; tier: 0 | 1 | 2 | 3; nextAt: number };
}

export interface PlayerPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** 隊友正在做的事（由伺服器依「開啟了哪一類設備」判定，不含設備名稱或內容） */
export type PlayerActivity = 'interact' | 'inspect';

/**
 * 角色身體的外觀姿態（只影響隊友看到的動畫；不影響碰撞、權限或謎題）。
 * crouch：蹲下（玩家按 C）；act：操作機關／觀察物件；hurt：被設備鎖定（觸電反應）的累計次數。
 */
export interface BodyState {
  crouch?: boolean;
  act?: PlayerActivity;
  hurt?: number;
}

export type PositionsMsg = Partial<Record<Role, PlayerPose & BodyState>>;

export interface SignalReceived {
  from: Role;
  /** 已依接收者感官過濾的 token */
  tokens: SignalToken[];
  /**
   * 接收者實際收到的 token 數。
   * 刻意「不」回傳原始長度：否則接收者會知道「有自己感知不到的訊號」，
   * 等於多了一個繞過感官限制的旁路（例如靜默員可藉此得知有人敲擊）。
   */
  originalLength: number;
  at: number;
}

export interface Notice {
  tone: 'ok' | 'warn' | 'error' | 'info';
  text: string;
}

export interface IceServerInfo {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type { DoorId };
