import type { PositionsMsg, Role } from '@null-protocol/shared';

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
}

export const remotes: Partial<Record<Role, RemotePose>> = {};

export function applyPositions(msg: PositionsMsg, me: Role | null): void {
  for (const role of Object.keys(msg) as Role[]) {
    if (role === me) continue;
    const p = msg[role];
    if (!p) continue;
    const r = remotes[role];
    if (!r) {
      remotes[role] = { x: p.x, z: p.z, yaw: p.yaw, tx: p.x, tz: p.z, tyaw: p.yaw, movedAt: 0, stride: 0, seen: true };
    } else {
      if (Math.hypot(p.x - r.tx, p.z - r.tz) > 0.02) r.movedAt = performance.now();
      r.tx = p.x;
      r.tz = p.z;
      r.tyaw = p.yaw;
    }
  }
}

export function clearRemotes(): void {
  for (const k of Object.keys(remotes) as Role[]) delete remotes[k];
}

const angleLerp = (a: number, b: number, t: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** 平滑插值；回傳這一幀每位隊友是否跨出腳步（用來播放空間腳步聲） */
export function smooth(dt: number, onStep: (role: Role, x: number, z: number) => void): void {
  const k = 1 - Math.exp(-dt * 12);
  for (const role of Object.keys(remotes) as Role[]) {
    const r = remotes[role];
    if (!r) continue;
    const ox = r.x;
    const oz = r.z;
    r.x += (r.tx - r.x) * k;
    r.z += (r.tz - r.z) * k;
    r.yaw = angleLerp(r.yaw, r.tyaw, k);
    const moved = Math.hypot(r.x - ox, r.z - oz);
    if (performance.now() - r.movedAt < 400) {
      r.stride += moved;
      if (r.stride >= 1.0) {
        r.stride = 0;
        onStep(role, r.x, r.z);
      }
    }
  }
}
