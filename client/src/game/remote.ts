import type { PlayerActivity, PositionsMsg, Role } from '@null-protocol/shared';

export interface RemotePose {
  x: number;
  z: number;
  yaw: number;
  tx: number;
  tz: number;
  tyaw: number;
  /** 上次位置明顯移動的時間（用於腳步聲） */
  movedAt: number;
  stride: number;
  seen: boolean;
  /** 由伺服器位置推算的水平速度（m/s）與轉身角速度（rad/s），已平滑 */
  speed: number;
  turnRate: number;
  /** 上一次收到位置的時間 */
  at: number;
  crouch: boolean;
  act: PlayerActivity | null;
  hurt: number;
}

export const remotes: Partial<Record<Role, RemotePose>> = {};

const wrap = (d: number): number => {
  let x = d % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
};

export function applyPositions(msg: PositionsMsg, me: Role | null): void {
  const now = performance.now();
  for (const role of Object.keys(msg) as Role[]) {
    if (role === me) continue;
    const p = msg[role];
    if (!p) continue;
    const r = remotes[role];
    if (!r) {
      remotes[role] = {
        x: p.x, z: p.z, yaw: p.yaw, tx: p.x, tz: p.z, tyaw: p.yaw, movedAt: 0, stride: 0, seen: true,
        speed: 0, turnRate: 0, at: now, crouch: !!p.crouch, act: p.act ?? null, hurt: p.hurt ?? 0,
      };
      continue;
    }
    const dt = Math.max(0.05, (now - r.at) / 1000);
    const dist = Math.hypot(p.x - r.tx, p.z - r.tz);
    if (dist > 0.02) r.movedAt = now;
    // 傳送（一次跳很遠）不算速度
    const v = dist > 3 ? 0 : Math.min(8, dist / dt);
    r.speed += (v - r.speed) * 0.6;
    r.turnRate += (wrap(p.yaw - r.tyaw) / dt - r.turnRate) * 0.6;
    if (dist > 3) {
      r.x = p.x;
      r.z = p.z;
    }
    r.at = now;
    r.tx = p.x;
    r.tz = p.z;
    r.tyaw = p.yaw;
    r.crouch = !!p.crouch;
    r.act = p.act ?? null;
    r.hurt = p.hurt ?? 0;
  }
}

export function clearRemotes(): void {
  for (const k of Object.keys(remotes) as Role[]) delete remotes[k];
}

const angleLerp = (a: number, b: number, t: number): number => a + wrap(b - a) * t;

/** 平滑插值；回傳這一幀每位隊友是否跨出腳步（用來播放空間腳步聲） */
export function smooth(dt: number, onStep: (role: Role, x: number, z: number) => void): void {
  const k = 1 - Math.exp(-dt * 12);
  const now = performance.now();
  for (const role of Object.keys(remotes) as Role[]) {
    const r = remotes[role];
    if (!r) continue;
    // 伺服器只在有人移動時才廣播；一段時間沒有新位置＝停下來了
    if (now - r.at > 260) {
      r.speed *= Math.exp(-dt * 10);
      r.turnRate *= Math.exp(-dt * 10);
    }
    const ox = r.x;
    const oz = r.z;
    r.x += (r.tx - r.x) * k;
    r.z += (r.tz - r.z) * k;
    r.yaw = angleLerp(r.yaw, r.tyaw, k);
    const moved = Math.hypot(r.x - ox, r.z - oz);
    if (now - r.movedAt < 400) {
      r.stride += moved;
      if (r.stride >= (r.crouch ? 0.7 : 1.0)) {
        r.stride = 0;
        onStep(role, r.x, r.z);
      }
    }
  }
}
