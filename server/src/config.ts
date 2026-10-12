import { resolve } from 'node:path';
import type { IceServerInfo } from '@null-protocol/shared';

export interface ServerConfig {
  port: number;
  /** true 代表允許任何來源（僅開發用）；陣列代表白名單 */
  corsOrigins: string[] | true;
  syncWindowMs: number;
  hintCooldownMs: number;
  maxRooms: number;
  roomIdleMs: number;
  /** 僅供測試 */
  moveSpeedMultiplier?: number;
  /** 開發者工具（顯示正解、重置／直接完成謎題）。正式環境預設關閉 */
  debugTools: boolean;
  /** 答案錯誤的鎖定基準（毫秒） */
  lockBaseMs?: number;
  clientDist: string | null;
  ice: IceServerInfo[];
}

const int = (v: string | undefined, def: number): number => {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const origins = list(env.CORS_ORIGIN);
  const stun = list(env.STUN_URLS);
  const turn = list(env.TURN_URLS);

  const ice: IceServerInfo[] = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (turn.length) {
    ice.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }

  return {
    port: int(env.PORT, 3001),
    corsOrigins: origins.length ? origins : env.NODE_ENV === 'production' ? [] : true,
    syncWindowMs: int(env.SYNC_WINDOW_MS, 3000),
    debugTools: env.DEBUG_TOOLS === '1' || (env.DEBUG_TOOLS !== '0' && env.NODE_ENV !== 'production'),
    hintCooldownMs: int(env.HINT_COOLDOWN_MS, 15_000),
    maxRooms: int(env.MAX_ROOMS, 200),
    roomIdleMs: int(env.ROOM_IDLE_MINUTES, 15) * 60_000,
    // 相對路徑以啟動時的工作目錄解析（express 的 sendFile 需要絕對路徑）
    clientDist: env.CLIENT_DIST ? resolve(env.CLIENT_DIST) : null,
    ice,
  };
}
