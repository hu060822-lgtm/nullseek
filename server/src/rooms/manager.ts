import { randomInt } from 'node:crypto';
import type { Socket } from 'socket.io';
import {
  DEVICE_BY_ID,
  MAX_SIGNAL_LEN,
  PORTAL_BY_ID,
  SERVER_INTERACT_RANGE,
  SERVER_PORTAL_RANGE,
  portalFront,
  canPerceive,
  SIGNAL_COOLDOWN_MS,
  distanceXZ,
  filterForRole,
  isRole,
  isSignalToken,
  voiceEdgeAllowed,
  type Ack,
  type ActionResult,
  type ClientToServerEvents,
  type DebugCommand,
  type PuzzleActionPayload,
  type FullSync,
  type MovePayload,
  type Role,
  type ServerToClientEvents,
  type SignalToken,
  type VoiceSignalPayload,
} from '@null-protocol/shared';
import { FailureLimiter, TokenBucket } from '../rateLimit';
import { validateAudioSdp, validateCandidate } from '../voice/sdp';
import { Room, sanitizeName, type IO, type PlayerRec } from './room';

export interface ManagerConfig {
  syncWindowMs: number;
  hintCooldownMs?: number;
  /** 僅供測試 */
  moveSpeedMultiplier?: number;
  /** 開發者工具 */
  debugTools?: boolean;
  lockBaseMs?: number;
  maxRooms: number;
  /** 房間內無人連線超過這段時間就回收 */
  roomIdleMs: number;
  /** 大廳中玩家斷線後保留位置的時間 */
  lobbyGraceMs: number;
  /** 房主離線超過這段時間，房主身分轉移給仍在線的玩家 */
  hostGraceMs: number;
}

export const DEFAULT_CONFIG: ManagerConfig = {
  syncWindowMs: 3000,
  maxRooms: 200,
  roomIdleMs: 15 * 60_000,
  lobbyGraceMs: 20_000,
  hostGraceMs: 30_000,
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除容易混淆的 I O 0 1

interface SocketData {
  session?: { code: string; playerId: string };
  bucketGeneric: TokenBucket;
  bucketMove: TokenBucket;
  bucketVoice: TokenBucket;
  bucketCreate: TokenBucket;
  joinFailures: FailureLimiter;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

function reply<T>(ack: unknown, payload: T): void {
  if (typeof ack === 'function') (ack as (p: T) => void)(payload);
}
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly io: IO,
    private readonly cfg: ManagerConfig = DEFAULT_CONFIG,
  ) {}

  attach(): void {
    this.io.on('connection', (raw) => this.onConnection(raw as unknown as GameSocket));
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
  }

  /* ---------------------------- 連線 ---------------------------- */

  private onConnection(socket: GameSocket): void {
    socket.data.bucketGeneric = new TokenBucket(30, 15);
    socket.data.bucketMove = new TokenBucket(60, 40);
    socket.data.bucketVoice = new TokenBucket(200, 100);
    socket.data.bucketCreate = new TokenBucket(5, 5 / 60);
    socket.data.joinFailures = new FailureLimiter(8, 60_000, 60_000);

    const guard = <A extends unknown[]>(fn: (...a: A) => void) => {
      return (...args: A) => {
        try {
          fn(...args);
        } catch (err) {
          console.error('[socket handler error]', err);
        }
      };
    };

    socket.on('room:create', guard((p, ack) => typeof p === 'function' ? this.onCreate(socket, undefined as never, p) : this.onCreate(socket, p, ack)));
    socket.on('room:join', guard((p, ack) => typeof p === 'function' ? this.onJoin(socket, undefined as never, p) : this.onJoin(socket, p, ack)));
    socket.on('room:rejoin', guard((p, ack) => typeof p === 'function' ? this.onRejoin(socket, undefined as never, p) : this.onRejoin(socket, p, ack)));
    socket.on('room:leave', guard((ack) => this.onLeave(socket, ack)));
    socket.on('room:selectRole', guard((p, ack) => typeof p === 'function' ? this.onSelectRole(socket, undefined as never, p) : this.onSelectRole(socket, p, ack)));
    socket.on('room:start', guard((ack) => this.onStart(socket, ack)));
    socket.on('room:restart', guard((ack) => this.onRestart(socket, ack)));
    socket.on('player:move', guard((p) => this.onMove(socket, p)));
    socket.on('device:open', guard((p, ack) => typeof p === 'function' ? this.onDeviceOpen(socket, undefined as never, p) : this.onDeviceOpen(socket, p, ack)));
    socket.on('puzzle:action', guard((p, ack) => typeof p === 'function' ? this.onPuzzleAction(socket, undefined as never, p) : this.onPuzzleAction(socket, p, ack)));
    socket.on('signal:mark', guard((p, ack) => typeof p === 'function' ? this.onMark(socket, undefined as never, p) : this.onMark(socket, p, ack)));
    socket.on('debug:state', guard((ack) => this.onDebugState(socket, ack)));
    socket.on('debug:command', guard((p, ack) => typeof p === 'function' ? this.onDebugCommand(socket, undefined as never, p) : this.onDebugCommand(socket, p, ack)));
    socket.on('signal:emit', guard((p, ack) => typeof p === 'function' ? this.onSignal(socket, undefined as never, p) : this.onSignal(socket, p, ack)));
    socket.on('hint:request', guard((ack) => this.onHint(socket, ack)));
    socket.on('voice:ready', guard((p) => this.onVoiceReady(socket, p)));
    socket.on('voice:signal', guard((p) => this.onVoiceSignal(socket, p)));
    socket.on('disconnect', guard(() => this.onDisconnect(socket)));
  }

  /** 取得 socket 對應的房間與玩家（並確認這個 socket 仍是該玩家目前的連線） */
  private ctx(socket: GameSocket): { room: Room; player: PlayerRec } | null {
    const s = socket.data.session;
    if (!s) return null;
    const room = this.rooms.get(s.code);
    const player = room?.players.get(s.playerId);
    if (!room || !player || player.socketId !== socket.id) return null;
    room.touch();
    return { room, player };
  }

  private allow(socket: GameSocket): boolean {
    return socket.data.bucketGeneric.take();
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('無法產生房間代碼');
  }

  private bind(socket: GameSocket, room: Room, player: PlayerRec): void {
    const timer = this.graceTimers.get(player.id);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(player.id);

    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAt = null;
    void socket.join(room.channel);
    socket.data.session = { code: room.code, playerId: player.id };
    room.touch();
  }

  /** 這個 socket 目前如果綁著別的玩家，先放掉 */
  private unbind(socket: GameSocket): void {
    const s = socket.data.session;
    if (!s) return;
    const room = this.rooms.get(s.code);
    const player = room?.players.get(s.playerId);
    socket.data.session = undefined;
    if (!room || !player || player.socketId !== socket.id) return;
    void socket.leave(room.channel);
    if (room.phase === 'LOBBY') {
      this.removeFromLobby(room, player);
    } else {
      this.markDisconnected(room, player);
    }
  }

  /* ---------------------------- 房間 ---------------------------- */

  private onCreate(socket: GameSocket, p: { name: string }, ack: unknown): void {
    if (!socket.data.bucketCreate.take()) return reply(ack, fail('建立房間太頻繁，請稍後再試。'));
    const name = sanitizeName(p?.name);
    if (!name) return reply(ack, fail('請輸入暱稱（1–16 字）。'));
    if (this.rooms.size >= this.cfg.maxRooms) return reply(ack, fail('伺服器上的房間已滿，請稍後再試。'));

    this.unbind(socket);
    const room = new Room(this.newCode(), this.io, {
      syncWindowMs: this.cfg.syncWindowMs,
      hintCooldownMs: this.cfg.hintCooldownMs,
      moveSpeedMultiplier: this.cfg.moveSpeedMultiplier,
      debugTools: this.cfg.debugTools,
      lockBaseMs: this.cfg.lockBaseMs,
    });
    this.rooms.set(room.code, room);
    const player = room.addPlayer(name);
    this.bind(socket, room, player);
    reply(ack, {
      ok: true,
      roomCode: room.code,
      token: player.token,
      playerId: player.id,
      sync: room.fullSync(player),
    });
    room.emitRoomState();
  }

  private onJoin(socket: GameSocket, p: { name: string; code: string }, ack: unknown): void {
    if (socket.data.joinFailures.isBlocked()) return reply(ack, fail('嘗試次數過多，請稍後再試。'));
    const name = sanitizeName(p?.name);
    if (!name) return reply(ack, fail('請輸入暱稱（1–16 字）。'));
    const code = typeof p?.code === 'string' ? p.code.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) {
      socket.data.joinFailures.fail();
      return reply(ack, fail('找不到這個房間。'));
    }
    if (room.phase !== 'LOBBY') {
      socket.data.joinFailures.fail();
      return reply(ack, fail('遊戲已經開始。若你是房內的玩家，請從原本的瀏覽器重新連線。'));
    }
    if (room.players.size >= 3) return reply(ack, fail('房間已滿（固定三人）。'));

    this.unbind(socket);
    socket.data.joinFailures.reset();
    const player = room.addPlayer(name);
    this.bind(socket, room, player);
    reply(ack, {
      ok: true,
      roomCode: room.code,
      token: player.token,
      playerId: player.id,
      sync: room.fullSync(player),
    });
    room.emitRoomState();
  }

  private onRejoin(socket: GameSocket, p: { code: string; token: string }, ack: unknown): void {
    if (socket.data.joinFailures.isBlocked()) return reply(ack, fail('嘗試次數過多，請稍後再試。'));
    const code = typeof p?.code === 'string' ? p.code.trim().toUpperCase() : '';
    const token = typeof p?.token === 'string' ? p.token : '';
    const room = this.rooms.get(code);
    const player = room && token ? room.byToken(token) : null;
    if (!room || !player) {
      socket.data.joinFailures.fail();
      return reply(ack, fail('房間已失效或憑證不正確。'));
    }
    socket.data.joinFailures.reset();

    const previous = player.socketId;
    this.unbind(socket);
    this.bind(socket, room, player);
    if (previous && previous !== socket.id) {
      const old = this.io.sockets.sockets.get(previous);
      if (old) {
        (old as unknown as GameSocket).data.session = undefined;
        old.disconnect(true);
      }
    }
    reply(ack, { ok: true, playerId: player.id, sync: room.fullSync(player) });
    room.emitRoomState();
    room.chapter?.onPresenceChange();
  }

  private onLeave(socket: GameSocket, ack: unknown): void {
    this.unbind(socket);
    reply(ack, { ok: true });
  }

  private removeFromLobby(room: Room, player: PlayerRec): void {
    this.announceVoice(room, player, false);
    room.removePlayer(player.id);
    if (room.players.size === 0) {
      room.dispose();
      this.rooms.delete(room.code);
      return;
    }
    room.emitRoomState();
  }

  private markDisconnected(room: Room, player: PlayerRec): void {
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    player.voiceReady = false;
    player.micEnabled = false;
    this.announceVoice(room, player, false);
    room.emitRoomState();
    room.chapter?.onPresenceChange();

    // 房主離線太久就轉移房主
    if (room.hostId === player.id) {
      const t = setTimeout(() => {
        if (!player.connected && room.hostId === player.id) {
          room.reassignHost();
          room.emitRoomState();
        }
      }, this.cfg.hostGraceMs);
      t.unref?.();
    }
  }

  private onDisconnect(socket: GameSocket): void {
    const s = socket.data.session;
    if (!s) return;
    const room = this.rooms.get(s.code);
    const player = room?.players.get(s.playerId);
    if (!room || !player || player.socketId !== socket.id) return;

    this.markDisconnected(room, player);
    if (room.phase === 'LOBBY') {
      // 大廳：寬限時間內沒回來就釋放位置
      const t = setTimeout(() => {
        this.graceTimers.delete(player.id);
        if (!player.connected && room.players.has(player.id) && room.phase === 'LOBBY') {
          this.removeFromLobby(room, player);
        }
      }, this.cfg.lobbyGraceMs);
      t.unref?.();
      this.graceTimers.set(player.id, t);
    }
  }

  private onSelectRole(socket: GameSocket, p: { role: Role | null }, ack: unknown): void {
    if (!this.allow(socket)) return reply(ack, fail('操作太頻繁。'));
    const c = this.ctx(socket);
    if (!c) return reply(ack, fail('尚未加入房間。'));
    const { room, player } = c;
    if (room.phase !== 'LOBBY') return reply(ack, fail('遊戲開始後不能更換角色。'));
    const role = p?.role ?? null;
    if (role !== null && !isRole(role)) return reply(ack, fail('無效的角色。'));
    if (role !== null) {
      const holder = room.byRole(role);
      if (holder && holder.id !== player.id) return reply(ack, fail('這個角色已經被其他玩家選走了。'));
    }
    if (player.role !== role) {
      this.announceVoice(room, player, false); // 角色變了，語音路由要重新建立
      player.role = role;
      player.voiceReady = false;
    }
    reply(ack, { ok: true });
    room.emitRoomState();
  }

  private onStart(socket: GameSocket, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c) return reply(ack, fail('尚未加入房間。'));
    const { room, player } = c;
    if (room.hostId !== player.id) return reply(ack, fail('只有房主可以開始遊戲。'));
    if (room.phase !== 'LOBBY') return reply(ack, fail('遊戲已經開始。'));
    if (!room.canStart()) return reply(ack, fail('需要三位在線玩家，且三種角色各一位，才能開始。'));
    room.start();
    reply(ack, { ok: true });
  }

  private onRestart(socket: GameSocket, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c) return reply(ack, fail('尚未加入房間。'));
    const { room, player } = c;
    if (room.hostId !== player.id) return reply(ack, fail('只有房主可以重新開始。'));
    if (room.phase === 'LOBBY') return reply(ack, fail('已經在大廳。'));
    room.restart();
    reply(ack, { ok: true });
  }

  /* ---------------------------- 遊玩 ---------------------------- */

  private onMove(socket: GameSocket, p: MovePayload): void {
    if (!socket.data.bucketMove.take()) return;
    const c = this.ctx(socket);
    if (!c || !p || typeof p !== 'object') return;
    c.room.handleMove(c.player, p);
  }

  private playing(c: { room: Room; player: PlayerRec }): c is { room: Room & { chapter: NonNullable<Room['chapter']> }; player: PlayerRec & { role: Role } } {
    return c.room.phase === 'PLAYING' && !!c.room.chapter && !!c.player.role;
  }

  private inRange(c: { room: Room; player: PlayerRec }, deviceId: string): string | null {
    const dev = DEVICE_BY_ID[deviceId];
    if (!dev) return '找不到這個設備。';
    const { x, y, z } = c.player.pose;
    if (distanceXZ([x, y, z], dev) > SERVER_INTERACT_RANGE) return '距離設備太遠。';
    return null;
  }

  private onDeviceOpen(socket: GameSocket, p: { deviceId: string }, ack: unknown): void {
    if (!this.allow(socket)) return reply(ack, fail('操作太頻繁。'));
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, fail('目前無法操作設備。'));
    if (typeof p?.deviceId !== 'string') return reply(ack, fail('無效的設備。'));
    const far = this.inRange(c, p.deviceId);
    if (far) return reply(ack, fail(far));
    const r = c.room.chapter.openDevice(c.player.role, p.deviceId);
    if (!r.ok) return reply(ack, fail(r.error));
    reply(ack, { ok: true, view: r.view });
  }

  /** 規格 1.3：統一的謎題操作入口。驗證房間、身分、距離後交給章節引擎（再驗證謎題狀態、權限與去重） */
  private onPuzzleAction(socket: GameSocket, p: PuzzleActionPayload, ack: unknown): void {
    const bad = (message: string): ActionResult => ({ ok: false, tone: 'error', message });
    if (!this.allow(socket)) return reply(ack, bad('操作太頻繁。'));
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, bad('目前無法操作設備。'));
    if (!p || typeof p !== 'object' || typeof p.targetId !== 'string') return reply(ack, bad('無效的操作。'));
    const portal = PORTAL_BY_ID[p.targetId];
    if (portal) {
      const [fx, fz] = portalFront(portal);
      if (Math.hypot(c.player.pose.x - fx, c.player.pose.z - fz) > SERVER_PORTAL_RANGE) return reply(ack, bad('距離門洞太遠。'));
    } else {
      const far = this.inRange(c, p.targetId);
      if (far) return reply(ack, bad(far));
    }
    reply(ack, c.room.chapter.action(c.player.id, c.player.role, p));
  }

  /** 失語員的標記工具：指向一個設備（可附一個符號）。不會推進任何謎題狀態 */
  private onMark(socket: GameSocket, p: { targetId: string; token?: SignalToken }, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, fail('目前無法使用標記工具。'));
    if (c.player.role !== 'MUTE') return reply(ack, fail('只有失語員能使用標記工具。'));
    const target = typeof p?.targetId === 'string' ? DEVICE_BY_ID[p.targetId] : undefined;
    if (!target) return reply(ack, fail('無效的標記目標。'));
    if (p.token !== undefined && !isSignalToken(p.token)) return reply(ack, fail('無效的符號。'));
    const now = Date.now();
    if (now - c.player.lastSignalAt < SIGNAL_COOLDOWN_MS) return reply(ack, fail('信號器冷卻中。'));
    c.player.lastSignalAt = now;
    for (const other of c.room.players.values()) {
      if (other.id === c.player.id || !other.connected || !other.role) continue;
      // 標記本身：看得見的人看到標記、聽得見的人聽到定位提示音；附帶的符號只給感知得到的人
      const token = p.token && canPerceive(other.role, p.token) ? p.token : undefined;
      c.room.emitTo(other, 'signal:marker', { from: c.player.role, targetId: target.id, token });
    }
    reply(ack, { ok: true });
  }

  private debugAllowed(socket: GameSocket): ReturnType<RoomManager['ctx']> {
    if (!this.cfg.debugTools) return null;
    const c = this.ctx(socket);
    return c && this.playing(c) ? c : null;
  }

  private onDebugState(socket: GameSocket, ack: unknown): void {
    const c = this.debugAllowed(socket);
    if (!c || !c.room.chapter) return reply(ack, fail('開發者工具未啟用。'));
    const roles: Record<string, Role | null> = {};
    for (const pl of c.room.players.values()) roles[pl.name] = pl.role;
    reply(ack, { ok: true, state: c.room.chapter.debugState(roles) });
  }

  private onDebugCommand(socket: GameSocket, p: { cmd: DebugCommand }, ack: unknown): void {
    const c = this.debugAllowed(socket);
    if (!c || !c.room.chapter) return reply(ack, fail('開發者工具未啟用。'));
    const cmd = p?.cmd;
    if (cmd === 'reinit_room') {
      c.room.start();
      return reply(ack, { ok: true });
    }
    if (cmd !== 'reset_puzzle' && cmd !== 'complete_puzzle') return reply(ack, fail('未知的指令。'));
    const ok = c.room.chapter.debugCommand(cmd);
    reply(ack, ok ? { ok: true } : fail('目前沒有進行中的謎題。'));
  }

  private onSignal(socket: GameSocket, p: { tokens: SignalToken[] }, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, fail('目前無法使用信號器。'));
    const raw = p?.tokens;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SIGNAL_LEN || !raw.every(isSignalToken)) {
      return reply(ack, fail('無效的訊號。'));
    }
    const now = Date.now();
    if (now - c.player.lastSignalAt < SIGNAL_COOLDOWN_MS) return reply(ack, fail('信號器冷卻中。'));
    c.player.lastSignalAt = now;

    const tokens = raw as SignalToken[];
    for (const other of c.room.players.values()) {
      if (other.id === c.player.id || !other.connected || !other.role) continue;
      // 依接收者的感官過濾；完全感知不到就不送（避免洩漏「有人發了你感知不到的訊號」）
      const filtered = filterForRole(other.role, tokens);
      if (filtered.length === 0) continue;
      c.room.emitTo(other, 'signal:received', {
        from: c.player.role,
        tokens: filtered,
        originalLength: filtered.length,
        at: now,
      });
    }
    reply(ack, { ok: true });
  }

  private onHint(socket: GameSocket, ack: unknown): void {
    if (!this.allow(socket)) return reply(ack, fail('操作太頻繁。'));
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, fail('目前無法取得提示。'));
    const r = c.room.chapter.requestHint();
    reply(ack, r.ok ? { ok: true, tier: r.tier, text: r.text, puzzle: r.puzzle } : fail(r.error));
  }

  /* ---------------------------- 語音 signaling ---------------------------- */

  /** 通知房內其他人：某位玩家的語音上線／離線 */
  private announceVoice(room: Room, player: PlayerRec, connected: boolean): void {
    if (!player.role) return;
    for (const other of room.players.values()) {
      if (other.id === player.id || !other.connected) continue;
      room.emitTo(other, 'voice:peer', { role: player.role, connected, micEnabled: connected && player.micEnabled });
    }
  }

  private onVoiceReady(socket: GameSocket, p: { micEnabled: boolean }): void {
    if (!socket.data.bucketVoice.take()) return;
    const c = this.ctx(socket);
    if (!c || !c.player.role) return;
    const { room, player } = c;
    player.voiceReady = true;
    player.micEnabled = !!p?.micEnabled;
    // 告訴別人我上線了；也告訴我誰已經在線
    this.announceVoice(room, player, true);
    for (const other of room.voicePeers(player)) {
      if (!other.role) continue;
      room.emitTo(player, 'voice:peer', { role: other.role, connected: true, micEnabled: other.micEnabled });
    }
  }

  /**
   * 語音 signaling 由伺服器驗證：
   *   - 雙方必須在同一房間、都有角色
   *   - 這條邊（發話者→接收者）必須符合角色語音規則，否則直接丟棄
   *   - SDP 必須是單向、純音訊，方向正確
   */
  private onVoiceSignal(socket: GameSocket, p: VoiceSignalPayload): void {
    if (!socket.data.bucketVoice.take()) return;
    const c = this.ctx(socket);
    if (!c || !c.player.role) return;
    const me = c.player.role;
    if (!p || typeof p !== 'object' || !p.edge || !isRole(p.to) || !isRole(p.edge.from) || !isRole(p.edge.to)) return;
    const { from, to } = p.edge;
    if (!voiceEdgeAllowed(from, to)) return;

    let target: Role;
    if (p.kind === 'offer') {
      if (me !== from || p.to !== to) return;
      if (!validateAudioSdp(p.sdp, 'offer').ok) return;
      target = to;
    } else if (p.kind === 'answer') {
      if (me !== to || p.to !== from) return;
      if (!validateAudioSdp(p.sdp, 'answer').ok) return;
      target = from;
    } else if (p.kind === 'ice') {
      if (me !== from && me !== to) return;
      const other = me === from ? to : from;
      if (p.to !== other) return;
      if (!validateCandidate(p.candidate)) return;
      target = other;
    } else {
      return;
    }

    const peer = c.room.byRole(target);
    if (!peer || !peer.connected) return;
    c.room.emitTo(peer, 'voice:signal', {
      from: me,
      to: target,
      edge: { from, to },
      kind: p.kind,
      sdp: p.kind === 'ice' ? undefined : p.sdp,
      candidate: p.kind === 'ice' ? p.candidate : undefined,
    });
  }

  /* ---------------------------- 回收 ---------------------------- */

  sweep(now: number = Date.now()): void {
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      if (room.connectedCount() === 0 && idle > this.cfg.roomIdleMs) {
        room.dispose();
        this.rooms.delete(code);
      } else if (now - room.createdAt > 8 * 3600_000) {
        this.io.to(room.channel).emit('room:closed', { reason: '房間已超過使用時限。' });
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  /** 供測試取得完整同步資料 */
  syncFor(code: string, playerId: string): FullSync | null {
    const room = this.rooms.get(code);
    const p = room?.players.get(playerId);
    return room && p ? room.fullSync(p) : null;
  }
}

export type { Ack };
