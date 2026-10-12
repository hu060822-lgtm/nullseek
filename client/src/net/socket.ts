import { io, type Socket } from 'socket.io-client';
import {
  DEVICE_BY_ID,
  PORTAL_BY_ID,
  PUZZLE_TITLES,
  ROLE_INFO,
  type ActionResult,
  type Ack,
  type ClientToServerEvents,
  type DebugCommand,
  type DebugState,
  type FullSync,
  type PanelView,
  type PuzzleId,
  type Role,
  type ServerToClientEvents,
  type SignalToken,
} from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { setSpeechEnabled, speak, stopSpeech } from '../audio/speech';
import { applyPositions, clearRemotes } from '../game/remote';
import { portalCooldown, setDoors, setYaw, snapTo, spawnFor } from '../game/controller';
import { playDoor } from '../game/doorSounds';
import { emit } from '../game/bus';
import { puzzleOf } from '../game/codes';
import { applyEchoJam } from '../game/blind/pending';
import { nextId, useStore } from '../state/store';
import { voice } from '../voice/voice';
import { clearSession, loadSession, saveSession } from './session';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? undefined;

export const socket: GameSocket = io(SERVER_URL ?? '/', {
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 600,
  reconnectionDelayMax: 4000,
});

let hadSession = false;

/** 角色一確定就套用感官限制（音訊／語音／語音播報） */
export function applyRoleSenses(role: Role | null): void {
  const hearing = role ? ROLE_INFO[role].canHear : false;
  audio.setHearing(hearing);
  setSpeechEnabled(!!role && !ROLE_INFO[role].canSee && useStore.getState().prefs.speech);
  voice.configure(socket, role);
}

function applySync(sync: FullSync): void {
  const st = useStore.getState();
  const prevRole = st.me?.role ?? null;
  st.set({ room: sync.room, world: sync.world, me: sync.me, log: sync.log, clues: sync.clues ?? {}, debug: !!sync.debug, risks: sync.risks ?? [] });
  if (sync.world) setDoors(sync.world.doors);
  if (sync.me.role !== prevRole || !prevRole) applyRoleSenses(sync.me.role);
  if (sync.pos) snapTo(sync.pos);
  else if (sync.me.role && sync.room.phase !== 'LOBBY') spawnFor(sync.me.role);
  if (sync.world?.chapterComplete) st.set({ complete: true });
  if (sync.echoJamMs) applyEchoJam(sync.echoJamMs);
}

function enterSession(r: { roomCode: string; token: string; playerId: string; sync: FullSync }): void {
  const session = { code: r.roomCode, token: r.token, playerId: r.playerId };
  saveSession(session);
  hadSession = true;
  useStore.getState().set({ session, error: null });
  applySync(r.sync);
}

export function connectSocket(): void {
  if (socket.connected || socket.active) return;
  useStore.getState().set({ connecting: true });
  socket.connect();
}

function tryRejoin(): void {
  const s = useStore.getState().session ?? loadSession();
  if (!s) return;
  useStore.getState().set({ reconnecting: true });
  socket.emit('room:rejoin', { code: s.code, token: s.token }, (r) => {
    if (r.ok) {
      useStore.getState().set({ session: s, reconnecting: false, error: null });
      hadSession = true;
      applySync(r.sync);
      const st = useStore.getState();
      if (st.room?.phase !== 'LOBBY') void voice.start();
    } else {
      clearSession();
      hadSession = false;
      voice.stop();
      useStore.getState().resetAll();
      useStore.getState().set({ reconnecting: false, error: '無法回到原本的房間（房間已關閉或憑證失效）。' });
    }
  });
}

export function initNetwork(): void {
  socket.on('connect', () => {
    resetStance();
    useStore.getState().set({ connected: true, connecting: false });
    if (hadSession || loadSession()) tryRejoin();
  });
  socket.on('disconnect', () => {
    useStore.getState().set({ connected: false, reconnecting: hadSession });
  });
  socket.on('connect_error', () => {
    useStore.getState().set({ connecting: false, connected: false });
  });

  socket.on('room:state', (room) => {
    const st = useStore.getState();
    const mine = room.players.find((p) => p.id === st.session?.playerId || p.id === st.me?.id);
    const prev = st.me?.role ?? null;
    st.set({
      room,
      me: mine ? { id: mine.id, role: mine.role, isHost: mine.isHost } : st.me,
    });
    const role = mine?.role ?? null;
    if (role !== prev) applyRoleSenses(role);
    // 大廳 → 遊戲開始：站到自己角色的出生點、面向正確方向
    if (st.room?.phase === 'LOBBY' && room.phase === 'PLAYING' && role) {
      clearRemotes();
      spawnFor(role);
      resetStance();
    }
    if (room.phase === 'LOBBY') {
      stopSpeech();
    }
  });

  socket.on('puzzle:state', (world) => {
    const st = useStore.getState();
    const prev = st.world;
    st.set({ world });
    setDoors(world.doors);
    if (world.chapterComplete && !st.complete) st.set({ complete: true });
    // 門的聲音（只有聽得見的角色會播）
    if (prev) {
      for (const id of Object.keys(world.doors) as Array<keyof typeof world.doors>) {
        if (world.doors[id] !== prev.doors[id]) playDoor(id, world.doors[id]);
      }
    }
  });

  // 只屬於我這個角色的場景線索（例如靜默員看得到的門燈、盲區員聽得到的門後聲音）
  socket.on('puzzle:clues', (clues) => useStore.getState().set({ clues }));

  // 謎題回饋：伺服器已依我的感官過濾（聽不見的人不會收到 sound、看不見的人不會收到 visual）
  socket.on('puzzle:feedback', (f) => {
    const pos = targetPos(f.targetId);
    if (f.sound) audio.feedback(f.sound, pos, f.windowMs);
    if (f.visual) {
      // 故障效果只與事件綁定：錯誤回饋才出現
      if (f.visual === 'error') emit('fault', undefined);
      emit('fx', { visual: f.visual, targetId: f.targetId });
    }
    if (f.visual === 'countdown' || f.sound === 'countdown') {
      const windowMs = f.windowMs ?? 3000;
      useStore.getState().set({ countdown: { id: nextId(), until: Date.now() + windowMs, windowMs } });
    }
  });

  socket.on('puzzle:reset', (p) => {
    const st = useStore.getState();
    st.set({ countdown: null });
    const scope = p.scope === 'full' ? '' : '（部分）';
    st.pushNotice({ tone: 'warn', text: `「${PUZZLE_TITLES[p.puzzleId]}」已重置${scope}。` }, 4500);
    speak(`${PUZZLE_TITLES[p.puzzleId]}已重置`);
  });

  socket.on('puzzle:hint', (h) => {
    const st = useStore.getState();
    st.pushNotice({ tone: 'info', text: `提示 ${h.tier}／3：${h.text}` }, 16000);
    audio.notice();
    speak(`提示 ${h.tier}。${h.text}`);
  });

  socket.on('signal:marker', (m) => {
    const st = useStore.getState();
    st.pushMarker({ from: m.from, targetId: m.targetId, token: m.token });
    audio.marker(targetPos(m.targetId));
    const dev = DEVICE_BY_ID[m.targetId];
    const role = st.me?.role;
    if (dev && role && !ROLE_INFO[role].canSee) speak(`${ROLE_INFO[m.from].name}標記了${dev.label}`);
  });

  socket.on('world:positions', (msg) => applyPositions(msg, useStore.getState().me?.role ?? null));
  socket.on('player:correct', (p) => {
    snapTo(p);
    if (p.teleport) {
      // 謎題造成的傳送：套用朝向，並播放空間轉換效果
      setYaw(p.yaw);
      portalCooldown();
      emit('fx', { visual: 'shift' });
    }
  });
  socket.on('player:log', (log) => useStore.getState().set({ log }));

  socket.on('signal:received', (s) => {
    useStore.getState().pushSignal(s);
    audio.signalTokens(s.tokens);
    const role = useStore.getState().me?.role;
    if (role && !ROLE_INFO[role].canSee) {
      const taps = s.tokens.filter((t) => t === 'TAP_S' || t === 'TAP_L');
      if (taps.length) speak(`${ROLE_INFO[s.from].name}發來訊號`);
    }
  });

  // 回聲風險區：狀態給介面（燈號）與盲區員的預警聲；被偵測時通知遊戲迴圈（警報＋干擾）
  socket.on('risk:state', (risks) => useStore.getState().set({ risks }));
  socket.on('risk:tripped', (p) => emit('riskTripped', p));

  socket.on('notice', (n) => {
    useStore.getState().pushNotice(n);
    if (n.tone === 'error') audio.uiError();
    else if (n.tone === 'warn') audio.uiWarn();
    else audio.notice();
    speak(n.text);
  });

  socket.on('puzzle:completed', (p) => {
    useStore.getState().set({ solved: { id: p.puzzleId, title: p.title, key: nextId() }, countdown: null });
    audio.solved();
    speak(`謎題完成：${p.title}`);
    setTimeout(() => {
      const s = useStore.getState().solved;
      if (s && s.id === p.puzzleId) useStore.getState().set({ solved: null });
    }, 5000);
  });

  socket.on('chapter:complete', () => {
    useStore.getState().set({ complete: true, panel: null });
    audio.ending();
    speak('第一章完成。三個人，一起走出了失聯設施。', { interrupt: true });
  });

  socket.on('device:refresh', (p) => {
    const panel = useStore.getState().panel;
    if (!panel) return;
    if (p.deviceId && p.deviceId !== panel.deviceId) return;
    void openDevice(panel.deviceId, true);
  });

  socket.on('room:closed', (p) => {
    clearSession();
    hadSession = false;
    voice.stop();
    useStore.getState().resetAll();
    useStore.getState().set({ error: p.reason });
    if (document.pointerLockElement) document.exitPointerLock();
  });

  socket.on('game:restarted', () => {
    clearRemotes();
    voice.stop(true);
    audio.stopAmbient();
    stopSpeech();
    useStore.getState().resetGame();
    if (document.pointerLockElement) document.exitPointerLock();
  });

  socket.on('voice:signal', (m) => void voice.onSignal(m));
  socket.on('voice:peer', (p) => voice.onPeer(p));

  // 重新整理頁面後自動回到原本的房間
  if (loadSession()) {
    useStore.getState().set({ reconnecting: true });
    connectSocket();
  }
}

/* ---------------------------- 請求 ---------------------------- */

const call = <T>(fn: (cb: (r: T) => void) => void, timeoutMs = 8000): Promise<T | { ok: false; error: string }> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: '伺服器沒有回應。' }), timeoutMs);
    fn((r) => {
      clearTimeout(t);
      resolve(r);
    });
  });

async function ensureConnected(): Promise<boolean> {
  if (socket.connected) return true;
  connectSocket();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export async function createRoom(name: string): Promise<string | null> {
  if (!(await ensureConnected())) return '無法連上伺服器。';
  const r = await call<Ack<{ roomCode: string; token: string; playerId: string; sync: FullSync }>>((cb) => socket.emit('room:create', { name }, cb));
  if (!r.ok) return r.error;
  enterSession(r);
  return null;
}

export async function joinRoom(name: string, code: string): Promise<string | null> {
  if (!(await ensureConnected())) return '無法連上伺服器。';
  const r = await call<Ack<{ roomCode: string; token: string; playerId: string; sync: FullSync }>>((cb) =>
    socket.emit('room:join', { name, code: code.trim().toUpperCase() }, cb),
  );
  if (!r.ok) return r.error;
  enterSession(r);
  return null;
}

export function leaveRoom(): void {
  socket.emit('room:leave', () => undefined);
  clearSession();
  hadSession = false;
  voice.stop();
  audio.stopAmbient();
  stopSpeech();
  clearRemotes();
  useStore.getState().resetAll();
  if (document.pointerLockElement) document.exitPointerLock();
}

export async function selectRole(role: Role | null): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:selectRole', { role }, cb));
  return r.ok ? null : r.error;
}
export async function startGame(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:start', cb));
  return r.ok ? null : r.error;
}
export async function restartGame(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:restart', cb));
  return r.ok ? null : r.error;
}

export async function requestHint(): Promise<void> {
  const r = await call<Ack<{ tier: number; text: string; puzzle: PuzzleId }>>((cb) => socket.emit('hint:request', cb));
  if (!r.ok) useStore.getState().pushNotice({ tone: 'warn', text: r.error });
}

export async function emitSignal(tokens: SignalToken[]): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('signal:emit', { tokens }, cb));
  return r.ok ? null : r.error;
}

export async function openDevice(deviceId: string, refresh = false): Promise<void> {
  const r = await call<Ack<{ view: PanelView | null; message?: string }>>((cb) => socket.emit('device:open', { deviceId }, cb));
  const st = useStore.getState();
  if (!r.ok) {
    if (!refresh) {
      st.pushNotice({ tone: 'warn', text: r.error }, 3500);
      audio.uiWarn();
      speak(r.error);
    }
    return;
  }
  if (!r.view) {
    if (r.message) {
      st.pushNotice({ tone: 'info', text: r.message }, 5000);
      speak(r.message);
    }
    return;
  }
  const prev = useStore.getState().panel;
  // 背景刷新：如果玩家在等待回應期間已經關掉（或換了）面板，就不要再把它打開
  if (refresh && prev?.deviceId !== deviceId) return;
  const same = refresh && prev?.deviceId === deviceId;
  st.set({ panel: { deviceId, view: r.view, result: same ? prev.result : null, clearKey: same ? prev.clearKey : 0 } });
  if (!refresh) {
    audio.uiOpen();
    speakPanel(r.view);
  }
}

export function closePanel(): void {
  const st = useStore.getState();
  if (!st.panel) return;
  st.set({ panel: null });
  audio.stopTaps();
  audio.uiClose();
  stopSpeech();
}

/** 每一次操作都有唯一的 requestId；逾時重送時沿用同一個，伺服器據此去重 */
function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* 非安全環境（http）沒有 randomUUID */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

type ActionReply = ActionResult | { ok: false; error: string };

async function sendAction(targetId: string, actionType: string, payload: Record<string, unknown>): Promise<ActionReply> {
  const requestId = newRequestId();
  const msg = { puzzleId: puzzleOf(targetId), actionType, targetId, payload, requestId };
  const once = () => call<ActionResult>((cb) => socket.emit('puzzle:action', msg, cb), 5000);
  let r: ActionReply = await once();
  // 沒有回應（網路抖動）：用同一個 requestId 再送一次；若第一次其實已執行，伺服器會回傳同一個結果
  if ('error' in r && socket.connected) r = await once();
  return r;
}

/** 對設備送出操作（面板按鈕、直接互動的設備） */
export async function doAction(deviceId: string, action: string, values: Record<string, unknown>): Promise<ActionResult | null> {
  const r = await sendAction(deviceId, action, values);
  if ('error' in r) {
    useStore.getState().pushNotice({ tone: 'error', text: r.error });
    return null;
  }
  const st = useStore.getState();
  const panel = st.panel;
  if (panel && panel.deviceId === deviceId) {
    st.set({
      panel: {
        deviceId,
        view: r.view ?? panel.view,
        result: { ok: r.ok, tone: r.tone, message: r.message, id: nextId() },
        clearKey: r.clear ? nextId() : panel.clearKey,
      },
    });
  } else if (!panel) {
    // 直接互動（例如推門）沒有面板：用通知顯示結果
    st.pushNotice({ tone: r.tone === 'ok' ? 'info' : r.tone, text: r.message }, 4000);
  }
  if (r.tone === 'ok') audio.uiOk();
  else if (r.tone === 'warn') audio.uiWarn();
  else if (r.tone === 'error') (r.lockMs ? audio.lockout() : audio.uiError());
  if (r.lockMs) emit('fx', { visual: 'shake' });
  speak(r.message, { interrupt: true });
  return r;
}

/** 走進門洞（P04 迷宮、P09 循環走廊）。伺服器驗證距離與狀態後才會傳送 */
export async function enterPortal(portalId: string): Promise<void> {
  const r = await sendAction(portalId, 'enter', {});
  const st = useStore.getState();
  if ('error' in r) return;
  if (!r.ok) {
    st.pushNotice({ tone: r.tone, text: r.message }, 3500);
    if (r.tone === 'error') audio.uiError();
    else audio.uiWarn();
  }
  speak(r.message, { interrupt: true });
}

/** 失語員的標記工具：指向目前注視的設備（可附一個符號） */
export async function emitMark(targetId: string, token?: SignalToken): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('signal:mark', { targetId, token }, cb));
  if (r.ok) audio.marker(targetPos(targetId));
  return r.ok ? null : r.error;
}

/* ---------------------------- 開發者工具（僅開發環境） ---------------------------- */

export async function fetchDebugState(): Promise<DebugState | string> {
  const r = await call<Ack<{ state: DebugState }>>((cb) => socket.emit('debug:state', cb));
  return r.ok ? r.state : r.error;
}
export async function debugCommand(cmd: DebugCommand): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('debug:command', { cmd }, cb));
  return r.ok ? null : r.error;
}

function targetPos(id: string | undefined): readonly [number, number] | null {
  if (!id) return null;
  const d = DEVICE_BY_ID[id];
  if (d) return d.pos;
  const p = PORTAL_BY_ID[id];
  return p ? p.pos : null;
}

/** 盲區員：把面板內容用語音唸出來（伺服器只會給盲區員「可聽」的內容） */
function speakPanel(view: PanelView): void {
  const parts: string[] = [view.title];
  for (const b of view.blocks) {
    if (b.type === 'text' || b.type === 'heading' || b.type === 'status') parts.push(b.text);
    else if (b.type === 'list') parts.push(...b.items);
    else if (b.type === 'table') parts.push(...b.rows.map((r) => r.join('，')));
  }
  speak(parts.join('。'), { interrupt: true });
}

export function sendMove(m: { x: number; y: number; z: number; yaw: number; seq: number }): void {
  if (socket.connected) socket.volatile.emit('player:move', m);
}

/** 身體姿態（蹲下、面板是否開著）：只影響隊友看到的動畫 */
let lastStance = '';
/** 回聲脈衝（只給伺服器判定風險區；沒有參數、沒有回覆） */
export function sendEchoPulse(): void {
  if (socket.connected) socket.emit('echo:pulse');
}

export function sendStance(crouch: boolean, panel: boolean): void {
  const key = `${crouch}|${panel}`;
  if (key === lastStance || !socket.connected) return;
  lastStance = key;
  socket.emit('player:stance', { crouch, panel });
}
export function resetStance(): void {
  lastStance = '';
}
