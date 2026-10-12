import { io, type Socket } from 'socket.io-client';
import {
  DEVICE_BY_ID,
  DOOR_SLOTS,
  PORTAL_BY_ID,
  PUZZLE_IDS,
  ROLES,
  SPAWNS,
  ZONE_BY_ID,
  moveWithCollision,
  portalFront,
  wallZ,
  zoneAt,
  type ActionResult,
  type PanelView,
  type PuzzleId,
  type Role,
  type SceneClues,
  type WorldPublic,
} from '@null-protocol/shared';
import type { GameServer } from '../src/app';
import { createGameServer } from '../src/app';
import type { Driver } from './solver';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Captured {
  event: string;
  payload: unknown;
}

let reqSeq = 0;

export class TestClient {
  readonly socket: Socket;
  readonly events: Captured[] = [];
  role: Role | null = null;
  token = '';
  code = '';
  playerId = '';
  x = 0;
  z = 0;
  seq = 0;
  clues: SceneClues = {};
  world: WorldPublic | null = null;

  constructor(url: string, readonly label: string) {
    this.socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    this.socket.onAny((event, payload) => {
      this.events.push({ event, payload });
      if (event === 'player:correct') {
        this.x = payload.x;
        this.z = payload.z;
      } else if (event === 'puzzle:clues') this.clues = payload;
      else if (event === 'puzzle:state') this.world = payload;
    });
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.connected) return resolve();
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }

  call<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<T> {
    return new Promise((resolve) => {
      const ack = (r: T) => resolve(r);
      if (payload === undefined) this.socket.emit(event, ack);
      else this.socket.emit(event, payload, ack);
    });
  }

  fire(event: string, payload?: unknown): void {
    this.socket.emit(event, payload);
  }

  of<T = unknown>(event: string): T[] {
    return this.events.filter((e) => e.event === event).map((e) => e.payload as T);
  }

  /** 目前事件序號；搭配 waitFor 的 from，只看這之後收到的事件 */
  mark(): number {
    return this.events.length;
  }

  async waitFor<T = unknown>(event: string, pred: (p: T) => boolean = () => true, timeout = 3000, from = 0): Promise<T> {
    const start = Date.now();
    let seen = this.events.slice(0, from).filter((e) => e.event === event).length;
    for (;;) {
      const all = this.events.filter((e) => e.event === event);
      for (; seen < all.length; seen++) if (pred(all[seen].payload as T)) return all[seen].payload as T;
      if (Date.now() - start > timeout) throw new Error(`[${this.label}] 等不到事件 ${event}`);
      await sleep(10);
    }
  }

  /** 在 ms 毫秒內「不應」收到符合條件的事件（從現在開始算） */
  async expectNone(event: string, pred: (p: unknown) => boolean = () => true, ms = 250): Promise<void> {
    const from = this.events.length;
    await sleep(ms);
    const hit = this.events.slice(from).find((e) => e.event === event && pred(e.payload));
    if (hit) throw new Error(`[${this.label}] 不該收到 ${event}：${JSON.stringify(hit.payload).slice(0, 200)}`);
  }

  /** 送出 puzzle:action（規格 1.3 的統一格式；requestId 由客戶端產生） */
  action(targetId: string, actionType: string, payload: Record<string, unknown> = {}, requestId = `t-${++reqSeq}`): Promise<ActionResult> {
    return this.call<ActionResult>('puzzle:action', { puzzleId: puzzleOf(targetId), actionType, targetId, payload, requestId });
  }

  close(): void {
    this.socket.close();
  }
}

/** 設備／門洞所屬的謎題（以房間決定） */
export function puzzleOf(targetId: string): PuzzleId {
  const zone = DEVICE_BY_ID[targetId]?.zone ?? PORTAL_BY_ID[targetId]?.zone ?? 'R1';
  return PUZZLE_IDS[ZONE_BY_ID[zone].index - 1] ?? PUZZLE_IDS[0];
}

/* ------------------------------ 走路 ------------------------------ */

type Pt = [number, number];

/** 設備前方的站位 */
export function standPoint(targetId: string): Pt {
  const portal = PORTAL_BY_ID[targetId];
  if (portal) return portalFront(portal, 1.0);
  const d = DEVICE_BY_ID[targetId];
  if (!d) throw new Error(`沒有這個目標：${targetId}`);
  const off = d.kind === 'door_slot' ? 1.2 : d.size[2] / 2 + 1.0;
  return [d.pos[0] + Math.sin(d.facing) * off, d.pos[1] + Math.cos(d.facing) * off];
}

const roomIndex = (p: Pt): number => {
  const z = zoneAt(p[0], p[1]);
  if (!z) throw new Error(`位置不在任何房間內：${p.map((v) => v.toFixed(2)).join(',')}`);
  return z.index;
};

/** 第 k 道牆上真正的門（第 k 個房間的出口） */
const exitSlot = (k: number) => {
  const s = DOOR_SLOTS.find((x) => x.doorId === `d${k}`);
  if (!s) throw new Error(`沒有 d${k}`);
  return s;
};

const roomCenter = (i: number): Pt => {
  const z = Object.values(ZONE_BY_ID).find((q) => q.index === i)!;
  return [(z.minX + z.maxX) / 2, (z.minZ + z.maxZ) / 2];
};

function waypoints(from: Pt, to: Pt): Pt[] {
  let cur = roomIndex(from);
  const j = roomIndex(to);
  const pts: Pt[] = [];
  while (cur < j) {
    const s = exitSlot(cur);
    pts.push([s.x, wallZ(cur) - 1.0], [s.x, wallZ(cur) + 0.4 + 1.0]);
    cur++;
  }
  while (cur > j) {
    const s = exitSlot(cur - 1);
    pts.push([s.x, wallZ(cur - 1) + 0.4 + 1.0], [s.x, wallZ(cur - 1) - 1.0]);
    cur--;
  }
  pts.push(to);
  return pts;
}

export interface Table {
  server: GameServer;
  url: string;
  clients: Record<Role, TestClient>;
  host: TestClient;
  code: string;
  close(): Promise<void>;
}

const serverRoom = (t: Table) => t.server.manager.rooms.get(t.code)!;
export const serverPose = (t: Table, role: Role) => [...serverRoom(t).players.values()].find((p) => p.role === role)!.pose;

async function stepTo(t: Table, c: TestClient, tx: number, tz: number, stepLen = 2.4): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    const dist = Math.hypot(tx - c.x, tz - c.z);
    if (dist < 0.01) return;
    const k = Math.min(1, stepLen / dist);
    c.x += (tx - c.x) * k;
    c.z += (tz - c.z) * k;
    c.fire('player:move', { x: c.x, y: 1.6, z: c.z, yaw: 0, seq: ++c.seq });
    await sleep(30);
  }
  throw new Error(`[${c.label}] 走不到 ${tx},${tz}`);
}

/** 依合法路徑（穿過開著的門、不穿牆）走到目標旁；被擋住時先繞到房間中央 */
export async function walkTo(t: Table, c: TestClient, targetId: string): Promise<void> {
  const target = standPoint(targetId);
  if (Math.hypot(c.x - target[0], c.z - target[1]) < 0.3) return;
  const boxes = serverRoom(t).colliders();
  const clear = (a: Pt, b: Pt) => {
    const r = moveWithCollision(a[0], a[1], b[0], b[1], boxes);
    return !r.blocked && Math.hypot(r.x - b[0], r.z - b[1]) < 0.02;
  };
  for (const wp of waypoints([c.x, c.z], target)) {
    const from: Pt = [c.x, c.z];
    if (!clear(from, wp)) {
      const mid = roomCenter(roomIndex(from));
      if (!clear(from, mid) || !clear(mid, wp)) throw new Error(`[${c.label}] 找不到路：${from} → ${wp}（${targetId}）`);
      await stepTo(t, c, mid[0], mid[1]);
    }
    await stepTo(t, c, wp[0], wp[1]);
  }
  await sleep(40);
  const pose = serverPose(t, c.role!);
  if (Math.hypot(pose.x - target[0], pose.z - target[1]) > 0.1) {
    throw new Error(`[${c.label}] 伺服器位置與客戶端不同：server ${pose.x.toFixed(2)},${pose.z.toFixed(2)} client ${c.x.toFixed(2)},${c.z.toFixed(2)}（${targetId}）`);
  }
}

/* ------------------------------ 房間 ------------------------------ */

export async function startServer(
  overrides: Parameters<typeof createGameServer>[0] = {},
): Promise<{ server: GameServer; url: string }> {
  const server = createGameServer({
    corsOrigins: true,
    moveSpeedMultiplier: 100,
    syncWindowMs: 700,
    hintCooldownMs: 100,
    lockBaseMs: 30,
    debugTools: false,
    ...overrides,
  });
  const port = await server.listen(0);
  return { server, url: `http://127.0.0.1:${port}` };
}

/** 建立房間、三人加入並選好角色（BLIND／DEAF／MUTE），尚未開始 */
export async function lobbyOfThree(overrides: Parameters<typeof createGameServer>[0] = {}): Promise<Table> {
  const { server, url } = await startServer(overrides);
  const names: Array<[Role, string]> = [
    ['BLIND', 'Aki'],
    ['DEAF', 'Bao'],
    ['MUTE', 'Cleo'],
  ];
  const clients = {} as Record<Role, TestClient>;
  const host = new TestClient(url, 'Aki');
  await host.connect();
  const created = await host.call<{ ok: true; roomCode: string; token: string; playerId: string }>('room:create', { name: 'Aki' });
  if (!created.ok) throw new Error('建立房間失敗');
  host.code = created.roomCode;
  host.token = created.token;
  host.playerId = created.playerId;
  clients.BLIND = host;

  for (const [role, name] of names.slice(1)) {
    const c = new TestClient(url, name);
    await c.connect();
    const j = await c.call<{ ok: boolean; roomCode: string; token: string; playerId: string }>('room:join', { name, code: host.code });
    if (!j.ok) throw new Error(`加入失敗 ${name}`);
    c.code = j.roomCode;
    c.token = j.token;
    c.playerId = j.playerId;
    clients[role] = c;
  }
  for (const [role] of names) {
    clients[role].role = role;
    const r = await clients[role].call<{ ok: boolean }>('room:selectRole', { role });
    if (!r.ok) throw new Error(`選角失敗 ${role}`);
  }
  return {
    server,
    url,
    clients,
    host,
    code: host.code,
    close: async () => {
      for (const r of ROLES) clients[r].close();
      await server.close();
    },
  };
}

export async function startedTable(overrides: Parameters<typeof createGameServer>[0] = {}): Promise<Table> {
  const t = await lobbyOfThree(overrides);
  const r = await t.host.call<{ ok: boolean; error?: string }>('room:start');
  if (!r.ok) throw new Error(`開始失敗：${r.error}`);
  for (const role of ROLES) {
    const c = t.clients[role];
    await c.waitFor('puzzle:state');
    await c.waitFor('player:correct');
    c.x = SPAWNS[role].pos[0];
    c.z = SPAWNS[role].pos[2];
  }
  return t;
}

/* ------------------------------ Driver ------------------------------ */

export function socketDriver(t: Table): Driver {
  const settle = () => sleep(30); // 讓其他 socket 上的事件（線索、狀態）抵達
  return {
    async open(role, deviceId): Promise<PanelView> {
      const c = t.clients[role];
      await walkTo(t, c, deviceId);
      const r = await c.call<{ ok: boolean; view?: PanelView; error?: string }>('device:open', { deviceId });
      if (!r.ok || !r.view) throw new Error(`[${role}] 開啟 ${deviceId} 失敗：${r.error}`);
      return r.view;
    },
    async act(role, targetId, actionType, payload = {}): Promise<ActionResult> {
      const c = t.clients[role];
      await walkTo(t, c, targetId);
      return c.action(targetId, actionType, payload);
    },
    async enter(role, portalId): Promise<ActionResult> {
      const c = t.clients[role];
      await walkTo(t, c, portalId);
      const r = await c.action(portalId, 'enter');
      await sleep(300); // 傳送（player:correct）送達所有在房間裡的人，並等伺服器的傳送保護時間結束
      return r;
    },
    async clues(role): Promise<SceneClues> {
      await settle();
      return t.clients[role].clues;
    },
    async syncPress(presses) {
      for (const p of presses) await walkTo(t, t.clients[p.role], p.targetId);
      return Promise.all(presses.map((p) => t.clients[p.role].action(p.targetId, p.actionType)));
    },
    async activePuzzle() {
      await settle();
      return t.clients.MUTE.world?.activePuzzle ?? null;
    },
  };
}
