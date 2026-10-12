import type { Socket } from 'socket.io-client';
import {
  ROLES,
  canSendVoice,
  voiceEdgeAllowed,
  type ClientToServerEvents,
  type Role,
  type ServerToClientEvents,
  type VoiceSignalRelay,
} from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { useStore } from '../state/store';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * 語音管理（WebRTC，伺服器只做 signaling）。
 *
 * 每條「允許的語音邊 from→to」是一條獨立的單向連線：
 *   - 發話者建立 sendonly offer（只有純音訊）
 *   - 接收者回 recvonly answer
 * 伺服器在轉發之前會驗證：邊是否被角色規則允許、SDP 方向與媒體型別、寄件者身分。
 * 因此：
 *   - 失語員（MUTE）完全不會要求麥克風權限，也不會建立任何發話連線
 *   - 靜默員（DEAF）不會建立任何接收連線（並且 AudioEngine 也會拒絕接上語音）
 */
class VoiceManager {
  private socket: GameSocket | null = null;
  private me: Role | null = null;
  private iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  private mic: MediaStream | null = null;
  private out = new Map<Role, RTCPeerConnection>();
  private inc = new Map<Role, RTCPeerConnection>();
  private pending = new Map<string, RTCIceCandidateInit[]>();
  private started = false;
  private levelCtx: AudioContext | null = null;
  private levelTimer: number | null = null;
  private retry = new Map<Role, number>();

  configure(socket: GameSocket, role: Role | null): void {
    this.socket = socket;
    this.me = role;
  }

  /* ---------------------------- 麥克風 ---------------------------- */

  micAvailable(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';
  }

  async enableMic(): Promise<void> {
    const st = useStore.getState();
    if (!this.me || !canSendVoice(this.me)) {
      st.set({ micState: 'forbidden' });
      return;
    }
    if (!this.micAvailable()) {
      st.set({ micState: 'unavailable' });
      return;
    }
    if (this.mic) return;
    st.set({ micState: 'requesting' });
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      st.set({ micState: 'denied' });
      return;
    }
    const track = this.mic.getAudioTracks()[0];
    if (track) track.enabled = !useStore.getState().micMuted;
    st.set({ micState: 'on' });
    this.startLevelMeter();
    // 已建立的發話連線補上音軌
    for (const pc of this.out.values()) {
      const sender = pc.getSenders()[0];
      if (sender && track) void sender.replaceTrack(track);
    }
    if (this.started) this.announce();
  }

  disableMic(): void {
    this.stopLevelMeter();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    for (const pc of this.out.values()) void pc.getSenders()[0]?.replaceTrack(null);
    useStore.getState().set({ micState: 'off', micLevel: 0, speaking: false });
    if (this.started) this.announce();
  }

  setMuted(muted: boolean): void {
    useStore.getState().set({ micMuted: muted });
    const t = this.mic?.getAudioTracks()[0];
    if (t) t.enabled = !muted;
  }

  private startLevelMeter(): void {
    if (!this.mic) return;
    this.stopLevelMeter();
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // 僅用於量測音量：不接到 destination，不會播放任何聲音
    this.levelCtx = new Ctx();
    const src = this.levelCtx.createMediaStreamSource(this.mic);
    const an = this.levelCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    this.levelTimer = window.setInterval(() => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      const level = peak / 128;
      const muted = useStore.getState().micMuted;
      const st = useStore.getState();
      const speaking = !muted && level > 0.06;
      if (Math.abs(st.micLevel - level) > 0.03 || st.speaking !== speaking) st.set({ micLevel: muted ? 0 : level, speaking });
    }, 100);
  }
  private stopLevelMeter(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    void this.levelCtx?.close().catch(() => undefined);
    this.levelCtx = null;
  }

  /* ---------------------------- 連線 ---------------------------- */

  async start(): Promise<void> {
    if (!this.socket || !this.me) return;
    try {
      const r = await fetch('/api/ice-servers', { cache: 'no-store' });
      if (r.ok) {
        const j = (await r.json()) as { iceServers?: RTCIceServer[] };
        if (Array.isArray(j.iceServers) && j.iceServers.length) this.iceServers = j.iceServers;
      }
    } catch {
      /* 使用預設 STUN */
    }
    this.started = true;
    this.announce();
  }

  private announce(): void {
    this.socket?.emit('voice:ready', { micEnabled: !!this.mic });
  }

  /** keepMic：重新開始（回到大廳）時保留麥克風，離開房間時才關閉 */
  stop(keepMic = false): void {
    this.started = false;
    for (const pc of [...this.out.values(), ...this.inc.values()]) pc.close();
    this.out.clear();
    this.inc.clear();
    this.pending.clear();
    for (const r of ROLES) audio.detachVoice(r);
    for (const t of this.retry.values()) clearTimeout(t);
    this.retry.clear();
    if (!keepMic) this.disableMic();
    useStore.getState().set({ talking: {}, voiceLinks: {} });
  }

  /** 伺服器通知：某位隊友的語音上線／離線 */
  onPeer(p: { role: Role; connected: boolean; micEnabled: boolean }): void {
    if (!this.me || p.role === this.me) return;
    // 我→對方 是被允許的邊：由我建立連線
    if (voiceEdgeAllowed(this.me, p.role)) {
      if (!p.connected) {
        this.closeOut(p.role);
      } else {
        const existing = this.out.get(p.role);
        const healthy = existing && ['new', 'connecting', 'connected'].includes(existing.connectionState);
        if (!healthy) void this.connectOut(p.role);
      }
    }
    // 對方→我 的邊：等對方 offer；對方離線時清掉
    if (voiceEdgeAllowed(p.role, this.me) && !p.connected) this.closeIn(p.role);
  }

  private key(from: Role, to: Role): string {
    return `${from}>${to}`;
  }

  private setLink(from: Role, to: Role, state: 'connecting' | 'connected' | 'failed' | null): void {
    const links = { ...useStore.getState().voiceLinks };
    if (state) links[this.key(from, to)] = state;
    else delete links[this.key(from, to)];
    useStore.getState().set({ voiceLinks: links });
  }

  private emitSignal(to: Role, edge: { from: Role; to: Role }, kind: 'offer' | 'answer' | 'ice', extra: { sdp?: string; candidate?: unknown }): void {
    this.socket?.emit('voice:signal', { to, edge, kind, ...extra });
  }

  private async connectOut(to: Role): Promise<void> {
    const me = this.me;
    if (!me || !voiceEdgeAllowed(me, to)) return;
    this.closeOut(to);
    const edge = { from: me, to };
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.out.set(to, pc);
    this.setLink(me, to, 'connecting');
    const tr = pc.addTransceiver('audio', { direction: 'sendonly' });
    const track = this.mic?.getAudioTracks()[0] ?? null;
    if (track) await tr.sender.replaceTrack(track);
    pc.onicecandidate = (e) => this.emitSignal(to, edge, 'ice', { candidate: e.candidate ? e.candidate.toJSON() : null });
    pc.onconnectionstatechange = () => {
      if (this.out.get(to) !== pc) return;
      if (pc.connectionState === 'connected') this.setLink(me, to, 'connected');
      if (pc.connectionState === 'failed') {
        this.setLink(me, to, 'failed');
        this.scheduleRetry(to);
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pc.localDescription?.sdp) this.emitSignal(to, edge, 'offer', { sdp: pc.localDescription.sdp });
    } catch {
      this.setLink(me, to, 'failed');
    }
  }

  private scheduleRetry(to: Role): void {
    if (this.retry.has(to)) return;
    const t = window.setTimeout(() => {
      this.retry.delete(to);
      if (this.started) void this.connectOut(to);
    }, 2500);
    this.retry.set(to, t);
  }

  private closeOut(to: Role): void {
    const pc = this.out.get(to);
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.onicecandidate = null;
      pc.close();
    }
    this.out.delete(to);
    if (this.me) this.setLink(this.me, to, null);
    this.pending.delete(this.key(this.me ?? to, to));
  }

  private closeIn(from: Role): void {
    const pc = this.inc.get(from);
    if (pc) pc.close();
    this.inc.delete(from);
    audio.detachVoice(from);
    if (this.me) this.setLink(from, this.me, null);
    const talking = { ...useStore.getState().talking };
    delete talking[from];
    useStore.getState().set({ talking });
  }

  /** 伺服器轉發的 signaling */
  async onSignal(m: VoiceSignalRelay): Promise<void> {
    const me = this.me;
    if (!me) return;
    const { from, to } = m.edge;
    // 再檢查一次：不符合角色規則的邊一律忽略（即使是伺服器轉來的）
    if (!voiceEdgeAllowed(from, to)) return;
    const k = this.key(from, to);

    if (m.kind === 'offer') {
      if (to !== me || m.from !== from || !m.sdp) return;
      this.closeIn(from);
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.inc.set(from, pc);
      this.setLink(from, me, 'connecting');
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        if (!audio.attachVoice(from, stream)) {
          // 這個角色不該聽到語音（或音訊尚未啟動）：直接丟棄
          if (!audio.canHear()) this.closeIn(from);
        }
      };
      pc.onicecandidate = (e) => this.emitSignal(from, m.edge, 'ice', { candidate: e.candidate ? e.candidate.toJSON() : null });
      pc.onconnectionstatechange = () => {
        if (this.inc.get(from) !== pc) return;
        if (pc.connectionState === 'connected') this.setLink(from, me, 'connected');
        if (pc.connectionState === 'failed') this.setLink(from, me, 'failed');
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await this.flushIce(k, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (pc.localDescription?.sdp) this.emitSignal(from, m.edge, 'answer', { sdp: pc.localDescription.sdp });
      } catch {
        this.setLink(from, me, 'failed');
      }
      return;
    }

    if (m.kind === 'answer') {
      if (from !== me || m.from !== to || !m.sdp) return;
      const pc = this.out.get(to);
      if (!pc) return;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        await this.flushIce(k, pc);
      } catch {
        this.setLink(me, to, 'failed');
      }
      return;
    }

    if (m.kind === 'ice') {
      const pc = from === me ? this.out.get(to) : this.inc.get(from);
      const cand = (m.candidate ?? null) as RTCIceCandidateInit | null;
      if (!pc || cand === null) return;
      if (!pc.remoteDescription) {
        const q = this.pending.get(k) ?? [];
        q.push(cand);
        this.pending.set(k, q);
        return;
      }
      try {
        await pc.addIceCandidate(cand);
      } catch {
        /* 過期的 candidate */
      }
    }
  }

  private async flushIce(k: string, pc: RTCPeerConnection): Promise<void> {
    const q = this.pending.get(k);
    if (!q) return;
    this.pending.delete(k);
    for (const c of q) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }
}

export const voice = new VoiceManager();
