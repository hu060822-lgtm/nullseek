import type { Role } from './roles';

/**
 * 第一章「失聯設施」的關卡幾何（十個房間的線性設施）。
 *
 * 座標：x 向右、z 向前（+z 是前進方向）、y 向上，單位為公尺。
 * 每個房間內部寬 12 m（x ∈ [-6, 6]）、深 10 m；房間之間以 0.4 m 厚的牆分隔，牆上有門。
 *
 *   [R1 入口訊號室] → [R2 四門走廊] → [R3 檔案室] → [R4 無窗迷宮] → [R5 協定室]
 *   → [R6 訊號分析室] → [R7 中央控制室] → [R8 校準實驗室] → [R9 循環走廊]
 *   → [R10 設施核心] → [出口走廊]
 *
 * 伺服器與客戶端共用同一份碰撞資料：
 *   - 客戶端用它做移動預測與牆面滑動
 *   - 伺服器用它驗證玩家位置（不可穿牆、不可穿過未開啟的門、速度合理）與互動距離
 */

export const ROOM_COUNT = 10;
/** 房間節距（房間深度 10 m＋牆厚 0.4 m） */
export const ROOM_PITCH = 10.4;
export const ROOM_HALF_W = 6;

export type DoorId = 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8' | 'd9' | 'd10';
export const DOOR_IDS: readonly DoorId[] = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10'];

export type ZoneId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'EXIT';

export const WALL_HEIGHT = 3.2;
export const EYE_HEIGHT = 1.6;
export const PLAYER_RADIUS = 0.35;
/** 步行速度（m/s）：配合角色動畫的步幅與恐怖遊戲的節奏，比原本的 3.4 慢 */
export const WALK_SPEED = 2.3;
/** 客戶端互動距離（公尺） */
export const INTERACT_RANGE = 2.6;
/** 伺服器接受的互動距離（含網路延遲容忍） */
export const SERVER_INTERACT_RANGE = 3.6;
/** 伺服器接受的最大移動速度（m/s，含容忍） */
export const MAX_SPEED = 7;

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Box extends Rect {
  id: string;
  kind: 'wall' | 'door' | 'prop';
  doorId?: DoorId;
}

export interface ZoneDef extends Rect {
  id: ZoneId;
  label: string;
  /** 房間編號（1–10）；出口走廊為 11 */
  index: number;
}

/** 房間 i（1–10）的內部範圍 */
export function roomRect(i: number): Rect {
  return { minX: -ROOM_HALF_W, maxX: ROOM_HALF_W, minZ: (i - 1) * ROOM_PITCH + 0.4, maxZ: i * ROOM_PITCH };
}

const ROOM_LABELS = ['入口訊號室', '四門走廊', '檔案室', '無窗迷宮', '協定室', '訊號分析室', '中央控制室', '校準實驗室', '循環走廊', '設施核心'];

export const EXIT_RECT: Rect = { minX: -2.5, maxX: 2.5, minZ: ROOM_COUNT * ROOM_PITCH + 0.4, maxZ: ROOM_COUNT * ROOM_PITCH + 8 };

export const ZONES: readonly ZoneDef[] = [
  ...ROOM_LABELS.map((label, k) => ({ id: `R${k + 1}` as ZoneId, label, index: k + 1, ...roomRect(k + 1) })),
  { id: 'EXIT', label: '出口走廊', index: 11, ...EXIT_RECT },
];

export const ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z])) as Record<ZoneId, ZoneDef>;

export function zoneAt(x: number, z: number): ZoneDef | null {
  for (const zone of ZONES) {
    if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ) return zone;
  }
  return null;
}

/** 地圖邊界（伺服器拒絕超出範圍的位置） */
export const LEVEL_BOUNDS: Rect = { minX: -7, maxX: 7, minZ: -1, maxZ: EXIT_RECT.maxZ + 1 };

/* ------------------------------------------------------------------ */
/* 設備                                                                */
/* ------------------------------------------------------------------ */

export type DeviceKind =
  | 'tap_source'
  | 'light_panel'
  | 'symbol_panel'
  | 'console'
  | 'document'
  | 'knobs'
  | 'lamp_ctrl'
  | 'monitor'
  | 'gauge'
  | 'door_slot';

export interface DeviceDef {
  id: string;
  kind: DeviceKind;
  label: string;
  zone: ZoneId;
  /** 可以開啟這個設備介面的角色。空陣列代表所有角色。 */
  roles: Role[];
  /** 地面中心位置 [x, z] */
  pos: [number, number];
  /** 面朝方向（繞 Y 軸；本地 +z 指向 (sin f, cos f)） */
  facing: number;
  /** [寬, 高, 深] */
  size: [number, number, number];
  /** 直接互動（按 E 不開面板，直接送出這個動作），例如推門 */
  direct?: string;
}

const FACE_RIGHT = Math.PI / 2; // 面向 +x（靠左牆）
const FACE_LEFT = -Math.PI / 2; // 面向 -x（靠右牆）
const FACE_BACK = Math.PI; // 面向 -z（靠前牆）
const FACE_FWD = 0; // 面向 +z（靠後牆）

const SIZES: Record<Exclude<DeviceKind, 'door_slot'>, [number, number, number]> = {
  tap_source: [1.6, 1.8, 0.8],
  light_panel: [1.8, 1.8, 0.8],
  symbol_panel: [1.8, 1.8, 0.8],
  console: [1.8, 1.1, 0.8],
  document: [1.6, 1.8, 0.8],
  knobs: [1.8, 1.3, 0.8],
  lamp_ctrl: [1.8, 1.1, 0.8],
  monitor: [1.8, 1.4, 0.8],
  gauge: [1.0, 1.6, 0.6],
};

type Place = { wall: 'left' | 'right' | 'front' | 'back'; at: number };

function dev(
  id: string,
  kind: Exclude<DeviceKind, 'door_slot'>,
  label: string,
  room: number,
  roles: Role[],
  place: Place,
  size?: [number, number, number],
): DeviceDef {
  const r = roomRect(room);
  const s = size ?? SIZES[kind];
  const half = s[2] / 2 + 0.03;
  let pos: [number, number];
  let facing: number;
  switch (place.wall) {
    case 'left':
      pos = [r.minX + half, r.minZ + place.at];
      facing = FACE_RIGHT;
      break;
    case 'right':
      pos = [r.maxX - half, r.minZ + place.at];
      facing = FACE_LEFT;
      break;
    case 'front':
      pos = [place.at, r.maxZ - half];
      facing = FACE_BACK;
      break;
    case 'back':
      pos = [place.at, r.minZ + half];
      facing = FACE_FWD;
      break;
  }
  return { id, kind, label, zone: `R${room}` as ZoneId, roles, pos, facing, size: s };
}

const B: Role[] = ['BLIND'];
const D: Role[] = ['DEAF'];
const M: Role[] = ['MUTE'];
const ALL: Role[] = [];
const DESK: [number, number, number] = [1.6, 1.1, 0.8];

/** R2 四扇門的位置（前牆上） */
export const R2_DOORS = { A: -4.5, B: -1.5, C: 1.5, D: 4.5 } as const;
export type R2DoorKey = keyof typeof R2_DOORS;
/** R9 四個門位（前牆上，位置 1–4） */
export const R9_SLOTS = [-4.5, -1.5, 1.5, 4.5] as const;

export const DEVICES: readonly DeviceDef[] = [
  // R1 入口訊號室（P01）
  dev('r1_gen', 'tap_source', '訊號發生器組', 1, B, { wall: 'left', at: 5 }),
  dev('r1_lamps', 'light_panel', '符號燈', 1, D, { wall: 'right', at: 5 }),
  dev('r1_card', 'document', '協定卡', 1, M, { wall: 'front', at: -3.5 }),
  dev('r1_lock', 'console', '密碼輸入器', 1, ALL, { wall: 'front', at: 3 }),

  // R2 四門走廊（P02）：四扇門本身就是互動目標
  ...(Object.keys(R2_DOORS) as R2DoorKey[]).map(
    (k): DeviceDef => ({
      id: `r2_door_${k}`,
      kind: 'door_slot',
      label: `${k} 門`,
      zone: 'R2',
      roles: ALL,
      pos: [R2_DOORS[k], roomRect(2).maxZ - 0.1],
      facing: FACE_BACK,
      size: [1.6, 2.4, 0.2],
      direct: 'push',
    }),
  ),
  dev('r2_manual', 'document', '維修文件', 2, M, { wall: 'left', at: 3 }),

  // R3 檔案室（P03）
  dev('r3_taps', 'tap_source', '機械敲擊器', 3, B, { wall: 'left', at: 5 }),
  dev('r3_plates', 'symbol_panel', '符號排列板', 3, D, { wall: 'right', at: 5 }),
  dev('r3_rules', 'document', '檔案規則', 3, M, { wall: 'front', at: 1 }),
  dev('r3_machine', 'console', '檔案機器', 3, ALL, { wall: 'front', at: 4 }),

  // R4 無窗迷宮（P04）
  dev('r4_echo', 'tap_source', '回音探測器', 4, B, { wall: 'left', at: 2 }),
  dev('r4_compass', 'monitor', '方位儀', 4, D, { wall: 'right', at: 2 }),
  dev('r4_route', 'document', '路線規則', 4, M, { wall: 'left', at: 8 }, DESK),

  // R5 協定室（P05）
  dev('r5_console', 'console', '指令控制台', 5, D, { wall: 'front', at: -3.2 }),
  dev('r5_lever', 'knobs', '側向撥桿', 5, B, { wall: 'left', at: 8.3 }),
  dev('r5_doc', 'document', '協定文件', 5, M, { wall: 'right', at: 5 }),

  // R6 訊號分析室（P06）
  dev('r6_pulse', 'tap_source', '脈衝監聽器', 6, B, { wall: 'left', at: 5 }),
  dev('r6_slots', 'light_panel', '時間槽顯示器', 6, D, { wall: 'right', at: 5 }),
  dev('r6_parity', 'document', '校驗文件', 6, M, { wall: 'front', at: -3.5 }),
  dev('r6_analyzer', 'console', '訊號分析儀', 6, ALL, { wall: 'front', at: 3 }),

  // R7 中央控制室（P07）
  dev('r7_resonator', 'knobs', '聲學共振器', 7, B, { wall: 'front', at: -3.5 }),
  dev('r7_lights', 'lamp_ctrl', '燈光控制台', 7, D, { wall: 'front', at: 3.5 }),
  dev('r7_protocol', 'console', '中央協定盤', 7, M, { wall: 'back', at: 3.5 }),
  dev('r7_speaker', 'tap_source', '定位音箱', 7, B, { wall: 'left', at: 5 }),
  dev('r7_strobe', 'light_panel', '節奏閃光器', 7, D, { wall: 'right', at: 5 }),
  dev('r7_manual', 'document', '模式手冊', 7, M, { wall: 'back', at: -3.5 }, DESK),

  // R8 校準實驗室（P08）
  dev('r8_pressure', 'gauge', '壓力計', 8, ALL, { wall: 'left', at: 3 }),
  dev('r8_temp', 'gauge', '溫度計', 8, ALL, { wall: 'left', at: 7 }),
  dev('r8_flow', 'gauge', '流量計', 8, ALL, { wall: 'right', at: 3 }),
  dev('r8_volt', 'gauge', '電壓計', 8, ALL, { wall: 'right', at: 7 }),
  dev('r8_rules', 'document', '診斷規則', 8, M, { wall: 'front', at: -3.5 }),

  // R9 循環走廊（P09）
  dev('r9_speaker', 'tap_source', '迴響喇叭', 9, B, { wall: 'left', at: 3.5 }),
  dev('r9_switches', 'knobs', '機械開關組', 9, B, { wall: 'left', at: 7 }),
  dev('r9_monitor', 'monitor', '循環監視器', 9, D, { wall: 'right', at: 3.5 }),
  dev('r9_rules', 'document', '循環規則', 9, M, { wall: 'right', at: 7 }),

  // R10 設施核心（P10）
  dev('r10_signal', 'tap_source', '訊號重建器', 10, B, { wall: 'left', at: 3 }),
  dev('r10_groups', 'light_panel', '燈號組', 10, D, { wall: 'right', at: 3 }),
  dev('r10_rules', 'document', '協定總則', 10, M, { wall: 'back', at: -1.5 }, DESK),
  dev('r10_analyzer', 'console', '核心分析儀', 10, ALL, { wall: 'back', at: 2.5 }),
  dev('r10_core_a', 'console', '核心控制台 A', 10, B, { wall: 'left', at: 7.5 }),
  dev('r10_core_b', 'console', '核心控制台 B', 10, D, { wall: 'right', at: 7.5 }),
  dev('r10_core_c', 'console', '核心協定盤', 10, M, { wall: 'front', at: -3.5 }),
];

export const DEVICE_BY_ID: Readonly<Record<string, DeviceDef>> = Object.fromEntries(DEVICES.map((d) => [d.id, d]));

/** 玩家是否可以開啟此設備（僅檢查角色） */
export const roleCanUseDevice = (role: Role, device: DeviceDef): boolean =>
  device.roles.length === 0 || device.roles.includes(role);

/* ------------------------------------------------------------------ */
/* 門洞（P04 迷宮、P09 循環走廊）：走進去就觸發，伺服器驗證                */
/* ------------------------------------------------------------------ */

export interface PortalDef {
  id: string;
  zone: ZoneId;
  /** 門洞在牆面上的中心點 [x, z] */
  pos: [number, number];
  /** 門洞面朝房間內的方向 */
  facing: number;
  /** 顯示在楣上的標示 */
  mark: string;
}

const r4 = roomRect(4);
const r9 = roomRect(9);
export const PORTALS: readonly PortalDef[] = [
  { id: 'r4_I', zone: 'R4', pos: [0, r4.maxZ], facing: FACE_BACK, mark: 'I' },
  { id: 'r4_II', zone: 'R4', pos: [r4.maxX, (r4.minZ + r4.maxZ) / 2], facing: FACE_LEFT, mark: 'II' },
  { id: 'r4_III', zone: 'R4', pos: [2.5, r4.minZ], facing: FACE_FWD, mark: 'III' },
  { id: 'r4_IV', zone: 'R4', pos: [r4.minX, (r4.minZ + r4.maxZ) / 2], facing: FACE_RIGHT, mark: 'IV' },
  ...R9_SLOTS.map((x, i) => ({ id: `r9_${i + 1}`, zone: 'R9' as ZoneId, pos: [x, r9.maxZ] as [number, number], facing: FACE_BACK, mark: String(i + 1) })),
];
export const PORTAL_BY_ID: Readonly<Record<string, PortalDef>> = Object.fromEntries(PORTALS.map((p) => [p.id, p]));
/** 走到門洞前多近會觸發（客戶端）；伺服器接受的距離較寬 */
export const PORTAL_TRIGGER = 0.95;
export const SERVER_PORTAL_RANGE = 2.0;

/** 門洞前方的觸發點（距牆 0.5 m） */
export function portalFront(p: PortalDef, d = 0.5): [number, number] {
  return [p.pos[0] + Math.sin(p.facing) * d, p.pos[1] + Math.cos(p.facing) * d];
}

/* ------------------------------------------------------------------ */
/* 牆與門                                                              */
/* ------------------------------------------------------------------ */

const T = 0.4; // 牆厚

export interface DoorSlot {
  id: string;
  /** 所在的橫牆編號（第 k 道牆位於房間 k 與 k+1 之間） */
  wall: number;
  x: number;
  width: number;
  /** 真正會開的門；沒有 doorId 的是永遠關閉的門（R2 的 A／C／D） */
  doorId?: DoorId;
}

export const DOOR_SLOTS: readonly DoorSlot[] = [
  { id: 'd1', wall: 1, x: 0, width: 2, doorId: 'd1' },
  { id: 'r2A', wall: 2, x: R2_DOORS.A, width: 1.6 },
  { id: 'd2', wall: 2, x: R2_DOORS.B, width: 1.6, doorId: 'd2' },
  { id: 'r2C', wall: 2, x: R2_DOORS.C, width: 1.6 },
  { id: 'r2D', wall: 2, x: R2_DOORS.D, width: 1.6 },
  { id: 'd3', wall: 3, x: -4, width: 2, doorId: 'd3' },
  { id: 'd4', wall: 4, x: 4, width: 2, doorId: 'd4' },
  { id: 'd5', wall: 5, x: 0, width: 2, doorId: 'd5' },
  { id: 'd6', wall: 6, x: 0, width: 2, doorId: 'd6' },
  { id: 'd7', wall: 7, x: 0, width: 2, doorId: 'd7' },
  { id: 'd8', wall: 8, x: 0, width: 2, doorId: 'd8' },
  { id: 'd9', wall: 9, x: R9_SLOTS[0], width: 1.6, doorId: 'd9' },
  { id: 'd10', wall: 10, x: 0, width: 2, doorId: 'd10' },
];

function wall(id: string, minX: number, maxX: number, minZ: number, maxZ: number): Box {
  return { id, kind: 'wall', minX, maxX, minZ, maxZ };
}

export const wallZ = (k: number): number => k * ROOM_PITCH;

function buildWalls(): Box[] {
  const w: Box[] = [];
  const W = ROOM_HALF_W;
  // 橫牆（含門洞）
  for (let k = 0; k <= ROOM_COUNT; k++) {
    const z0 = wallZ(k);
    const slots = DOOR_SLOTS.filter((s) => s.wall === k).sort((a, b) => a.x - b.x);
    let x = -W - T;
    let n = 0;
    for (const s of slots) {
      const a = s.x - s.width / 2;
      if (a > x) w.push(wall(`W${k}_${n++}`, x, a, z0, z0 + T));
      x = s.x + s.width / 2;
    }
    if (x < W + T) w.push(wall(`W${k}_${n++}`, x, W + T, z0, z0 + T));
  }
  // 側牆
  w.push(wall('side_L', -W - T, -W, 0, wallZ(ROOM_COUNT) + T));
  w.push(wall('side_R', W, W + T, 0, wallZ(ROOM_COUNT) + T));
  // 出口走廊
  w.push(wall('X_L', EXIT_RECT.minX - T, EXIT_RECT.minX, EXIT_RECT.minZ - 0.01, EXIT_RECT.maxZ + T));
  w.push(wall('X_R', EXIT_RECT.maxX, EXIT_RECT.maxX + T, EXIT_RECT.minZ - 0.01, EXIT_RECT.maxZ + T));
  w.push(wall('X_end', EXIT_RECT.minX - T, EXIT_RECT.maxX + T, EXIT_RECT.maxZ, EXIT_RECT.maxZ + T));
  return w;
}

export const WALL_BOXES: readonly Box[] = buildWalls();

function slotBox(s: DoorSlot): Box {
  const z0 = wallZ(s.wall);
  return {
    id: s.id,
    kind: 'door',
    doorId: s.doorId,
    minX: s.x - s.width / 2,
    maxX: s.x + s.width / 2,
    minZ: z0,
    maxZ: z0 + T,
  };
}

const DOOR_BOXES: Record<string, Box> = Object.fromEntries(DOOR_SLOTS.map((s) => [s.id, slotBox(s)]));
export const DOOR_BOX_BY_ID: Readonly<Record<string, Box>> = DOOR_BOXES;

function deviceBox(d: DeviceDef): Box {
  const [w, , depth] = d.size;
  const sideways = Math.abs(Math.sin(d.facing)) > 0.5; // 面向左右時，寬度沿 z 軸
  const hx = (sideways ? depth : w) / 2;
  const hz = (sideways ? w : depth) / 2;
  return { id: `prop_${d.id}`, kind: 'prop', minX: d.pos[0] - hx, maxX: d.pos[0] + hx, minZ: d.pos[1] - hz, maxZ: d.pos[1] + hz };
}

/** 門板本身就是碰撞物（door_slot 不另外加道具碰撞） */
export const PROP_BOXES: readonly Box[] = DEVICES.filter((d) => d.kind !== 'door_slot').map(deviceBox);

export type DoorState = Record<DoorId, boolean>;

export const closedDoors = (): DoorState => Object.fromEntries(DOOR_IDS.map((d) => [d, false])) as DoorState;

/** 目前有效的碰撞盒：牆、道具、尚未開啟的門，以及永遠關閉的假門 */
export function buildColliders(doorsOpen: Readonly<DoorState>): Box[] {
  const boxes: Box[] = [...WALL_BOXES, ...PROP_BOXES];
  for (const s of DOOR_SLOTS) {
    if (!s.doorId || !doorsOpen[s.doorId]) boxes.push(DOOR_BOXES[s.id]);
  }
  return boxes;
}

/** 圓形（玩家）是否與某個方塊相交 */
export function circleHitsBox(x: number, z: number, r: number, b: Box): boolean {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

export function hitsAny(x: number, z: number, r: number, boxes: readonly Box[]): boolean {
  for (const b of boxes) if (circleHitsBox(x, z, r, b)) return true;
  return false;
}

/**
 * 從 (fx, fz) 移動到 (tx, tz)，遇到牆時沿牆滑動（分軸解算）。
 * 回傳最終位置與是否被擋住。
 */
export function moveWithCollision(
  fx: number,
  fz: number,
  tx: number,
  tz: number,
  boxes: readonly Box[],
  r: number = PLAYER_RADIUS,
): { x: number; z: number; blocked: boolean } {
  let x = fx;
  let z = fz;
  let blocked = false;
  const dist = Math.hypot(tx - fx, tz - fz);
  const steps = Math.max(1, Math.ceil(dist / 0.15));
  const sx = (tx - fx) / steps;
  const sz = (tz - fz) / steps;
  for (let i = 0; i < steps; i++) {
    if (!hitsAny(x + sx, z, r, boxes)) x += sx;
    else if (sx !== 0) blocked = true;
    if (!hitsAny(x, z + sz, r, boxes)) z += sz;
    else if (sz !== 0) blocked = true;
  }
  return { x, z, blocked };
}

/** 沿射線方向到最近牆面的距離（用於盲區員的回聲／聲納），最大 maxDist */
export function rayDistance(ox: number, oz: number, dx: number, dz: number, boxes: readonly Box[], maxDist = 12): number {
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const step = 0.1;
  for (let d = step; d <= maxDist; d += step) {
    const px = ox + ux * d;
    const pz = oz + uz * d;
    for (const b of boxes) {
      if (px >= b.minX && px <= b.maxX && pz >= b.minZ && pz <= b.maxZ) return d;
    }
  }
  return maxDist;
}

export interface SpawnPoint {
  pos: [number, number, number];
  yaw: number;
}

/** yaw=π 面向 +z（前進方向） */
const r1 = roomRect(1);
export const SPAWNS: Record<Role, SpawnPoint> = {
  BLIND: { pos: [-2.5, EYE_HEIGHT, r1.minZ + 2], yaw: Math.PI },
  DEAF: { pos: [0, EYE_HEIGHT, r1.minZ + 2], yaw: Math.PI },
  MUTE: { pos: [2.5, EYE_HEIGHT, r1.minZ + 2], yaw: Math.PI },
};

export const distanceXZ = (a: readonly [number, number, number], d: DeviceDef): number =>
  Math.hypot(a[0] - d.pos[0], a[2] - d.pos[1]);

/** 水平朝向向量：yaw=0 → (0,-1) */
export const forwardOf = (yaw: number): [number, number] => [-Math.sin(yaw), -Math.cos(yaw)];
