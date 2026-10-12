import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  CHAPTER1_ACOUSTICS,
  EYE_HEIGHT,
  LEVEL_BOUNDS,
  MAX_SPEED,
  DEVICE_BY_ID,
  ROLE_INFO,
  closedDoors,
  PLAYER_RADIUS,
  ROLES,
  SPAWNS,
  buildColliders,
  moveWithCollision,
  zoneAt,
  type Box,
  type ClientToServerEvents,
  type FullSync,
  type LogEntry,
  type MovePayload,
  type PlayerActivity,
  type PlayerPose,
  type PlayerPublic,
  type PositionsMsg,
  type Role,
  type RoomPhase,
  type RoomPublic,
  type SceneClues,
  type ServerToClientEvents,
  type ZoneId,
} from '@null-protocol/shared';
import { Chapter } from '../game/chapter';
import { EchoRiskTracker } from '../game/echoRisk';
import type { ChapterHooks } from '../game/types';

export type IO = Server<ClientToServerEvents, ServerToClientEvents>;

export interface PlayerRec {
  id: string;
  /** 重連憑證。只回給玩家本人，絕不放進任何廣播 */
  token: string;
  name: string;
  role: Role | null;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  pose: PlayerPose;
  lastMoveAt: number;
  lastMoveRecvAt: number;
  /** 移動預算（公尺）：以 MAX_SPEED 的速率累積，每次移動扣除實際位移，避免用大量小封包加速 */
  moveBudget: number;
  budgetAt: number;
  lastSeq: number;
  lastCorrectAt: number;
  /** 最近一次被謎題傳送的時間 */
  teleportAt: number;
  log: Map<string, LogEntry>;
  lastSignalAt: number;
  voiceReady: boolean;
  micEnabled: boolean;
  /** 上一次送給這位玩家的授權線索（沒變就不重送） */
  lastClues: string;
  /** 身體姿態（只給隊友的角色動畫用；不影響碰撞、權限、謎題） */
  body: BodyRec;
}

export interface BodyRec {
  crouch: boolean;
  act: PlayerActivity | null;
  /** 開始操作／觀察時的位置：離開超過 1.2 m 就結束 */
  actAt: { x: number; z: number } | null;
  /** 短暫動作（例如推門）的結束時間；0＝持續到面板關閉 */
  actUntil: number;
  hurt: number;
}

const newBody = (): BodyRec => ({ crouch: false, act: null, actAt: null, actUntil: 0, hurt: 0 });

/** 依設備種類決定隊友看到的動作：文件與顯示器是「觀察」，其餘是「操作」 */
const INSPECT_KINDS = new Set(['document', 'monitor', 'light_panel', 'symbol_panel']);

export interface RoomOptions {
  syncWindowMs: number;
  hintCooldownMs?: number;
  /** 僅供測試：放大伺服器接受的移動速度，讓自動化測試不必真的走完整張地圖 */
  moveSpeedMultiplier?: number;
  debugTools?: boolean;
  lockBaseMs?: number;
}

const BUDGET_CAP = 2.5;
const TELEPORT_GRACE_MS = 250;

const rid = (bytes: number) => randomBytes(bytes).toString('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // 移除控制字元與零寬字元
  const cleaned = [...raw]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      const control = c <= 0x1f || c === 0x7f;
      const invisible = (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || c === 0x2060 || c === 0xfeff;
      return !control && !invisible;
    })
    .join('')
    .trim();
  const chars = [...cleaned];
  if (chars.length < 1) return null;
  return chars.slice(0, 16).join('');
}

export class Room {
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  phase: RoomPhase = 'LOBBY';
  readonly players = new Map<string, PlayerRec>();
  hostId = '';
  chapter: Chapter | null = null;
  /** 回聲風險區（聲學感測器）；遊戲開始時建立 */
  risk: EchoRiskTracker | null = null;

  private colliderCache: { key: string; boxes: Box[] } | null = null;
  private posTimer: ReturnType<typeof setInterval> | null = null;
  private dirtyPositions = false;

  constructor(
    readonly code: string,
    private readonly io: IO,
    private readonly opts: RoomOptions,
  ) {}

  get channel(): string {
    return `room:${this.code}`;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  /* ---------------------------- 玩家 ---------------------------- */

  addPlayer(name: string): PlayerRec {
    const spawn = SPAWNS.BLIND;
    const p: PlayerRec = {
      id: rid(4),
      token: rid(24),
      name,
      role: null,
      socketId: null,
      connected: false,
      disconnectedAt: null,
      pose: { x: spawn.pos[0], y: EYE_HEIGHT, z: spawn.pos[2], yaw: spawn.yaw },
      lastMoveAt: Date.now(),
      lastMoveRecvAt: 0,
      moveBudget: BUDGET_CAP,
      budgetAt: Date.now(),
      lastSeq: 0,
      lastCorrectAt: 0,
      teleportAt: 0,
      log: new Map(),
      lastSignalAt: 0,
      voiceReady: false,
      micEnabled: false,
      lastClues: '',
      body: newBody(),
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    if (this.hostId === id) this.reassignHost();
  }

  byToken(token: string): PlayerRec | null {
    for (const p of this.players.values()) if (safeEqual(p.token, token)) return p;
    return null;
  }

  byRole(role: Role): PlayerRec | null {
    for (const p of this.players.values()) if (p.role === role) return p;
    return null;
  }

  bySocket(socketId: string): PlayerRec | null {
    for (const p of this.players.values()) if (p.socketId === socketId) return p;
    return null;
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  reassignHost(): void {
    const connected = [...this.players.values()].find((p) => p.connected);
    const any = connected ?? [...this.players.values()][0];
    this.hostId = any?.id ?? '';
  }

  /* ---------------------------- 公開狀態 ---------------------------- */

  canStart(): boolean {
    if (this.players.size !== 3) return false;
    const roles = new Set<Role>();
    for (const p of this.players.values()) {
      if (!p.role || !p.connected) return false;
      roles.add(p.role);
    }
    return roles.size === 3;
  }

  publicState(): RoomPublic {
    const players: PlayerPublic[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      connected: p.connected,
      isHost: p.id === this.hostId,
    }));
    return { code: this.code, phase: this.phase, players, canStart: this.phase === 'LOBBY' && this.canStart() };
  }

  emitRoomState(): void {
    this.io.to(this.channel).emit('room:state', this.publicState());
  }

  emitWorld(): void {
    if (!this.chapter) return;
    this.io.to(this.channel).emit('puzzle:state', this.chapter.world());
    this.emitClues(false);
  }

  /** 授權線索：每位玩家只會收到自己角色的部分 */
  emitClues(force: boolean): void {
    if (!this.chapter) return;
    for (const p of this.players.values()) {
      if (!p.role) continue;
      const clues = this.chapter.cluesFor(p.role);
      const json = JSON.stringify(clues);
      if (!force && json === p.lastClues) continue;
      p.lastClues = json;
      this.emitTo(p, 'puzzle:clues', clues);
    }
  }

  cluesFor(p: PlayerRec): SceneClues {
    return this.chapter && p.role ? this.chapter.cluesFor(p.role) : {};
  }

  fullSync(p: PlayerRec): FullSync {
    const clues = this.cluesFor(p);
    p.lastClues = JSON.stringify(clues);
    return {
      room: this.publicState(),
      world: this.chapter ? this.chapter.world() : null,
      me: { id: p.id, role: p.role, isHost: p.id === this.hostId },
      log: [...p.log.values()].sort((a, b) => a.at - b.at),
      pos: this.phase === 'LOBBY' ? null : { ...p.pose },
      clues,
      debug: !!this.opts.debugTools,
      risks: this.risk?.statuses() ?? [],
      ...(p.role === 'BLIND' && this.risk?.jamLeft() ? { echoJamMs: this.risk.jamLeft() } : {}),
    };
  }

  emitTo<E extends keyof ServerToClientEvents>(
    p: PlayerRec,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    if (!p.socketId) return;
    // socket.io 的泛型 emit 無法直接接受泛型事件名，這裡明確轉型
    (this.io.to(p.socketId) as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
  }

  /* ---------------------------- 遊戲流程 ---------------------------- */

  start(): void {
    this.disposeChapter();
    this.phase = 'PLAYING';
    for (const p of this.players.values()) {
      if (!p.role) continue;
      const s = SPAWNS[p.role];
      p.pose = { x: s.pos[0], y: EYE_HEIGHT, z: s.pos[2], yaw: s.yaw };
      p.lastMoveAt = Date.now();
      p.budgetAt = Date.now();
      p.moveBudget = BUDGET_CAP;
      p.lastSeq = 0;
      p.log.clear();
      p.lastClues = '';
      p.body = newBody();
    }
    this.colliderCache = null;
    this.risk = new EchoRiskTracker(CHAPTER1_ACOUSTICS.risks);
    this.chapter = new Chapter(this.makeHooks(), {
      syncWindowMs: this.opts.syncWindowMs,
      hintCooldownMs: this.opts.hintCooldownMs,
      lockBaseMs: this.opts.lockBaseMs,
    });
    this.startPositionLoop();
    this.emitRoomState();
    this.emitWorld(); // lastClues 已清空，每個人都會收到一次自己的授權線索
    // 重新開始（含開發者「重新初始化房間」）時，讓客戶端立即回到出生點
    for (const p of this.players.values()) if (p.role) this.emitTo(p, 'player:correct', { ...p.pose });
    this.broadcastPositions(true);
  }

  restart(): void {
    this.disposeChapter();
    this.phase = 'LOBBY';
    for (const p of this.players.values()) p.log.clear();
    this.io.to(this.channel).emit('game:restarted');
    this.emitRoomState();
  }

  private disposeChapter(): void {
    this.chapter?.dispose();
    this.chapter = null;
    this.risk = null;
    this.stopPositionLoop();
  }

  dispose(): void {
    this.disposeChapter();
  }

  private makeHooks(): ChapterHooks {
    return {
      onChange: () => this.emitWorld(),
      notify: (role, n) => {
        const p = this.byRole(role);
        if (p?.socketId) this.io.to(p.socketId).emit('notice', n);
      },
      broadcast: (n) => this.io.to(this.channel).emit('notice', n),
      log: (role, entry) => {
        const p = this.byRole(role);
        if (!p) return;
        const prev = p.log.get(entry.key);
        const same =
          prev &&
          prev.title === entry.title &&
          prev.audioOnly === entry.audioOnly &&
          JSON.stringify(prev.blocks) === JSON.stringify(entry.blocks);
        if (same) return;
        p.log.set(entry.key, entry);
        if (p.socketId) {
          this.io.to(p.socketId).emit('player:log', [...p.log.values()].sort((a, b) => a.at - b.at));
        }
      },
      feedback: (f) => {
        for (const p of this.players.values()) {
          if (!p.role || !p.socketId) continue;
          const info = ROLE_INFO[p.role];
          // 依接收者感官過濾：聲音只給聽得見的人、視覺只給看得見的人
          const sound = info.canHear ? f.sound : undefined;
          const visual = info.canSee ? f.visual : undefined;
          if (!sound && !visual) continue;
          this.emitTo(p, 'puzzle:feedback', { puzzleId: f.puzzleId, targetId: f.targetId, sound, visual, windowMs: f.windowMs });
        }
      },
      completed: (id, title) => this.io.to(this.channel).emit('puzzle:completed', { puzzleId: id, title }),
      reset: (id, scope) => this.io.to(this.channel).emit('puzzle:reset', { puzzleId: id, scope }),
      hint: (id, tier, text) => this.io.to(this.channel).emit('puzzle:hint', { puzzleId: id, tier, text }),
      refreshDevices: () => this.io.to(this.channel).emit('device:refresh', {}),
      chapterComplete: () => {
        this.phase = 'COMPLETE';
        this.io.to(this.channel).emit('chapter:complete');
        this.emitRoomState();
      },
      teleport: (zone, spots) => this.teleport(zone, spots),
      penalized: (role) => {
        const p = this.byRole(role);
        if (!p) return;
        p.body.hurt += 1;
        this.dirtyPositions = true;
      },
      isConnected: (role) => this.byRole(role)?.connected ?? false,
    };
  }

  /** 把目前位於 zone 內的玩家傳送到指定位置（伺服器權威，客戶端以 player:correct 同步） */
  teleport(zone: ZoneId, spots: Record<Role, { x: number; z: number; yaw: number }>): void {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.role) continue;
      if (zoneAt(p.pose.x, p.pose.z)?.id !== zone) continue;
      const s = spots[p.role];
      p.pose = { x: s.x, y: EYE_HEIGHT, z: s.z, yaw: s.yaw };
      p.moveBudget = BUDGET_CAP;
      p.budgetAt = now;
      p.lastCorrectAt = now;
      p.teleportAt = now;
      this.emitTo(p, 'player:correct', { ...p.pose, teleport: true });
    }
    this.dirtyPositions = true;
  }

  /* ---------------------------- 位置 ---------------------------- */

  colliders(): Box[] {
    const doors = this.chapter?.doorState();
    const key = doors ? JSON.stringify(doors) : 'none';
    if (this.colliderCache?.key === key) return this.colliderCache.boxes;
    const boxes = buildColliders(doors ?? closedDoors());
    this.colliderCache = { key, boxes };
    return boxes;
  }

  /**
   * 驗證並套用玩家移動。位置由伺服器權威記錄：
   * 速度過快、位置在牆內／未開啟的門內、或超出地圖，都會被拒絕並把玩家拉回上一個合法位置。
   */
  handleMove(p: PlayerRec, m: MovePayload): void {
    if (this.phase === 'LOBBY' || !p.role) return;
    const nums = [m.x, m.y, m.z, m.yaw, m.seq];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const now = Date.now();
    if (now - p.lastMoveRecvAt < 25) return;
    p.lastMoveRecvAt = now;
    if (m.seq <= p.lastSeq) return;
    p.lastSeq = m.seq;
    // 傳送後短時間內抵達的移動，是客戶端在收到傳送前送出的舊位置：忽略，避免把玩家拉回原處
    if (now - p.teleportAt < TELEPORT_GRACE_MS) return;

    const mult = this.opts.moveSpeedMultiplier ?? 1;
    const elapsed = Math.min(2, Math.max(0, (now - p.budgetAt) / 1000));
    p.budgetAt = now;
    p.moveBudget = Math.min(BUDGET_CAP * mult, p.moveBudget + MAX_SPEED * mult * elapsed);

    const dist = Math.hypot(m.x - p.pose.x, m.z - p.pose.z);
    const B = LEVEL_BOUNDS;
    const outOfBounds = m.x < B.minX || m.x > B.maxX || m.z < B.minZ || m.z > B.maxZ;
    const tooFast = dist > p.moveBudget;
    // 掃掠檢查整段位移（不只終點），避免用大步長穿過薄牆。
    // 伺服器使用比客戶端小的半徑（容忍客戶端沿牆滑動時的微小誤差）。
    const sweep = moveWithCollision(p.pose.x, p.pose.z, m.x, m.z, this.colliders(), PLAYER_RADIUS - 0.1);
    const inWall = Math.hypot(sweep.x - m.x, sweep.z - m.z) > 0.02;

    if (outOfBounds || tooFast || inWall) {
      if (now - p.lastCorrectAt > 250) {
        p.lastCorrectAt = now;
        this.emitTo(p, 'player:correct', { ...p.pose });
      }
      return;
    }
    p.moveBudget -= dist;
    p.pose = { x: m.x, y: EYE_HEIGHT, z: m.z, yaw: m.yaw };
    p.lastMoveAt = now;
    this.dirtyPositions = true;
  }

  private startPositionLoop(): void {
    if (this.posTimer) return;
    this.posTimer = setInterval(() => {
      this.tickBodies();
      this.broadcastPositions(false);
      const risks = this.risk?.tick();
      if (risks) this.io.to(this.channel).emit('risk:state', risks);
    }, 100);
  }

  private stopPositionLoop(): void {
    if (this.posTimer) clearInterval(this.posTimer);
    this.posTimer = null;
  }

  broadcastPositions(force: boolean): void {
    if (!force && !this.dirtyPositions) return;
    this.dirtyPositions = false;
    const msg: PositionsMsg = {};
    for (const p of this.players.values()) {
      if (!p.role) continue;
      const b = p.body;
      msg[p.role] = { ...p.pose, ...(b.crouch ? { crouch: true } : {}), ...(b.act ? { act: b.act } : {}), ...(b.hurt ? { hurt: b.hurt } : {}) };
    }
    this.io.to(this.channel).emit('world:positions', msg);
  }

  /* ---------------------------- 身體姿態（純外觀） ---------------------------- */

  setStance(p: PlayerRec, crouch: boolean, panel: boolean): void {
    let changed = false;
    if (p.body.crouch !== crouch) {
      p.body.crouch = crouch;
      changed = true;
    }
    // 客戶端只能「結束」動作；開始操作／觀察一律由伺服器在開啟設備成功時判定
    if (!panel && p.body.act && p.body.actUntil === 0) {
      p.body.act = null;
      p.body.actAt = null;
      changed = true;
    }
    if (changed) this.dirtyPositions = true;
  }

  /** 開啟設備成功（持續到面板關閉或走開）；ms＞0 為短暫動作（直接互動，例如推門） */
  startActivity(p: PlayerRec, deviceId: string, ms = 0): void {
    const dev = DEVICE_BY_ID[deviceId];
    if (!dev) return;
    p.body.act = ms === 0 && INSPECT_KINDS.has(dev.kind) ? 'inspect' : 'interact';
    p.body.actAt = { x: p.pose.x, z: p.pose.z };
    p.body.actUntil = ms > 0 ? Date.now() + ms : 0;
    this.dirtyPositions = true;
  }

  private tickBodies(): void {
    const now = Date.now();
    for (const p of this.players.values()) {
      const b = p.body;
      if (!b.act) continue;
      const walked = b.actAt ? Math.hypot(p.pose.x - b.actAt.x, p.pose.z - b.actAt.z) > 1.2 : false;
      if ((b.actUntil > 0 && now > b.actUntil) || walked || !p.connected) {
        b.act = null;
        b.actAt = null;
        b.actUntil = 0;
        this.dirtyPositions = true;
      }
    }
  }

  /* ---------------------------- 回聲風險區 ---------------------------- */

  /**
   * 盲區員發出回聲。用伺服器記錄的位置判定；被偵測時全隊收到警報（聲音給聽得見的人、文字給看得見的人），
   * 盲區員的回聲被干擾一段時間。不回覆任何資料，也不改變謎題狀態。
   */
  echoPulse(p: PlayerRec): void {
    if (this.phase !== 'PLAYING' || p.role !== 'BLIND' || !this.risk) return;
    const zone = zoneAt(p.pose.x, p.pose.z)?.id ?? null;
    const hit = this.risk.pulse(p.pose.x, p.pose.z, zone);
    if (!hit) return;
    this.io.to(this.channel).emit('risk:tripped', hit);
    this.io.to(this.channel).emit('notice', {
      tone: 'warn',
      text: `聲學感測器偵測到回聲：警報響起，盲區員的回聲受到干擾 ${Math.round(hit.jamMs / 1000)} 秒。`,
    });
  }

  /* ---------------------------- 語音狀態 ---------------------------- */

  /** 房內已經準備好語音的其他玩家 */
  voicePeers(except: PlayerRec): PlayerRec[] {
    return [...this.players.values()].filter((p) => p.id !== except.id && p.voiceReady && p.connected && p.role);
  }

  roleList(): readonly Role[] {
    return ROLES;
  }
}
