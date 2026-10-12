import {
  DEVICES,
  EYE_HEIGHT,
  INTERACT_RANGE,
  PLAYER_RADIUS,
  PORTALS,
  PORTAL_TRIGGER,
  SPAWNS,
  WALK_SPEED,
  buildColliders,
  closedDoors,
  forwardOf,
  moveWithCollision,
  portalFront,
  roleCanUseDevice,
  zoneAt,
  type Box,
  type DeviceDef,
  type DoorState,
  type PlayerPose,
  type PortalDef,
  type Role,
  type ZoneId,
} from '@null-protocol/shared';

/**
 * 第一人稱控制器（與渲染無關）。
 * 盲區員沒有 3D 場景，但同樣使用這份移動／碰撞邏輯；伺服器用同一份碰撞資料再驗證一次。
 */

export const RUN_SPEED = 5.0;

export const pose = { x: 0, y: EYE_HEIGHT, z: 0, yaw: 0, pitch: 0 };

const keys = new Set<string>();
let colliders: Box[] = buildColliders(closedDoors());
let seq = 0;
let lastSentAt = 0;
let lastSent = { x: NaN, z: NaN, yaw: NaN };
let stride = 0;

export interface StepResult {
  moved: boolean;
  blocked: boolean;
  speed: number;
  /** 這一步跨出了一次腳步 */
  footstep: boolean;
  running: boolean;
}

export function setDoors(doors: DoorState): void {
  colliders = buildColliders(doors);
}

export function getColliders(): readonly Box[] {
  return colliders;
}

export function spawnFor(role: Role): void {
  const s = SPAWNS[role];
  pose.x = s.pos[0];
  pose.z = s.pos[2];
  pose.y = EYE_HEIGHT;
  pose.yaw = s.yaw;
  pose.pitch = 0;
  lastSent = { x: NaN, z: NaN, yaw: NaN };
}

export function snapTo(p: PlayerPose): void {
  pose.x = p.x;
  pose.z = p.z;
  pose.y = EYE_HEIGHT;
}

export function setYaw(yaw: number): void {
  pose.yaw = yaw;
  pose.pitch = 0;
}

/* ---------------------------- 門洞（走進去就觸發） ---------------------------- */

let portalBlockedUntil = 0;
let lastPortal: string | null = null;

/** 剛被傳送或剛觸發過：短時間內不再觸發，並要求先離開原本的門洞 */
export function portalCooldown(ms = 900): void {
  portalBlockedUntil = performance.now() + ms;
}

/**
 * 玩家走到門洞前（觸發距離內）時回傳該門洞；每次離開觸發範圍之前只回傳一次。
 * zoneOk 由呼叫端決定（只有目前進行中的謎題的門洞才會觸發）。
 */
export function portalToEnter(now: number, zoneOk: (p: PortalDef) => boolean): PortalDef | null {
  let inside: PortalDef | null = null;
  for (const p of PORTALS) {
    const [fx, fz] = portalFront(p, 0.5);
    if (Math.hypot(pose.x - fx, pose.z - fz) < PORTAL_TRIGGER) {
      inside = p;
      break;
    }
  }
  if (!inside) {
    lastPortal = null;
    return null;
  }
  if (now < portalBlockedUntil || lastPortal === inside.id || !zoneOk(inside)) return null;
  lastPortal = inside.id;
  return inside;
}

export function setKey(code: string, down: boolean): void {
  if (down) keys.add(code);
  else keys.delete(code);
}
export function clearKeys(): void {
  keys.clear();
}

export function look(dx: number, dy: number, sensitivity: number): void {
  const k = 0.0022 * sensitivity;
  pose.yaw -= dx * k;
  pose.pitch = Math.max(-1.25, Math.min(1.25, pose.pitch - dy * k));
}

export function step(dt: number, enabled: boolean): StepResult {
  const none: StepResult = { moved: false, blocked: false, speed: 0, footstep: false, running: false };
  if (!enabled) return none;
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (f === 0 && r === 0) return none;

  const [fx, fz] = forwardOf(pose.yaw);
  const rx = -fz;
  const rz = fx;
  let dx = fx * f + rx * r;
  let dz = fz * f + rz * r;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;

  const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = running ? RUN_SPEED : WALK_SPEED;
  const dist = Math.min(dt, 0.1) * speed;
  const res = moveWithCollision(pose.x, pose.z, pose.x + dx * dist, pose.z + dz * dist, colliders, PLAYER_RADIUS);
  const actual = Math.hypot(res.x - pose.x, res.z - pose.z);
  pose.x = res.x;
  pose.z = res.z;

  stride += actual;
  let footstep = false;
  const strideLen = running ? 1.35 : 1.0;
  if (stride >= strideLen) {
    stride = 0;
    footstep = true;
  }
  return { moved: actual > 1e-4, blocked: res.blocked && actual < dist * 0.5, speed: actual / Math.max(dt, 1e-3), footstep, running };
}

/** 是否需要送出位置（約 15 Hz；有變化才送） */
export function nextMove(now: number): { x: number; y: number; z: number; yaw: number; seq: number } | null {
  if (now - lastSentAt < 66) return null;
  const changed =
    Math.abs(pose.x - lastSent.x) > 0.005 || Math.abs(pose.z - lastSent.z) > 0.005 || Math.abs(pose.yaw - lastSent.yaw) > 0.01 || Number.isNaN(lastSent.x);
  if (!changed) return null;
  lastSentAt = now;
  lastSent = { x: pose.x, z: pose.z, yaw: pose.yaw };
  return { x: pose.x, y: EYE_HEIGHT, z: pose.z, yaw: pose.yaw, seq: ++seq };
}

export interface Target {
  device: DeviceDef;
  dist: number;
  usable: boolean;
}

/** 面前（約 ±60°）互動距離內最近的設備 */
export function currentTarget(role: Role): Target | null {
  const [fx, fz] = forwardOf(pose.yaw);
  let best: Target | null = null;
  for (const d of DEVICES) {
    const vx = d.pos[0] - pose.x;
    const vz = d.pos[1] - pose.z;
    const dist = Math.hypot(vx, vz);
    if (dist > INTERACT_RANGE) continue;
    const dot = (vx * fx + vz * fz) / (dist || 1);
    if (dot < 0.5) continue;
    if (!best || dist < best.dist) best = { device: d, dist, usable: roleCanUseDevice(role, d) };
  }
  return best;
}

/** 角色可使用、且距離最近的設備（用於盲區員的聲音指引） */
export function nearestUsable(role: Role, maxDist: number): { device: DeviceDef; dist: number; dx: number; dz: number } | null {
  let best: { device: DeviceDef; dist: number; dx: number; dz: number } | null = null;
  for (const d of DEVICES) {
    if (!roleCanUseDevice(role, d)) continue;
    const dx = d.pos[0] - pose.x;
    const dz = d.pos[1] - pose.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxDist) continue;
    if (!best || dist < best.dist) best = { device: d, dist, dx, dz };
  }
  return best;
}

export function currentZone(): ZoneId | null {
  return zoneAt(pose.x, pose.z)?.id ?? null;
}
