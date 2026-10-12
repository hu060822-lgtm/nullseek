import { forwardOf, type DoorSoundId, type PuzzleFeedback, type Role, type TapPattern, type SignalToken } from '@null-protocol/shared';

/**
 * 程序化音訊引擎（Web Audio，不使用任何外部音檔或生成式 AI）。
 *
 * 角色限制在這裡「真的」執行：
 *   - 靜默員（聽不見）：hearing=false → 不會建立 AudioContext、不會播放任何東西、
 *     也不會接上任何遠端語音串流。master gain 另外強制為 0 作為第二道防線。
 *   - 盲區員／失語員：可聽見，並使用 HRTF 空間音訊。
 */

type Pos = readonly [number, number] | null;

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  at?: number;
  attack?: number;
  slideTo?: number;
  pos?: Pos;
  pan?: number;
  filter?: number;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private hearing = false;
  private volume = 0.8;
  private ambientNodes: AudioNode[] = [];
  private voices = new Map<Role, { src: MediaStreamAudioSourceNode; panner: PannerNode; analyser: AnalyserNode; el: HTMLAudioElement; buf: Uint8Array<ArrayBuffer> }>();
  private activeTaps: Array<() => void> = [];
  /** 音訊尚未啟動（還沒有使用者手勢）時先收到的語音串流 */
  private pendingVoices = new Map<Role, MediaStream>();

  setHearing(hearing: boolean): void {
    this.hearing = hearing;
    if (!hearing) this.shutdown();
  }
  canHear(): boolean {
    return this.hearing;
  }

  /** 必須由使用者操作（點擊／按鍵）觸發 */
  async init(): Promise<void> {
    if (!this.hearing) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    for (const [role, stream] of this.pendingVoices) this.attachVoice(role, stream);
    this.pendingVoices.clear();
  }

  private shutdown(): void {
    this.stopTaps();
    for (const role of [...this.voices.keys()]) this.detachVoice(role);
    this.stopAmbient();
    if (this.master) this.master.gain.value = 0;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.hearing) this.master.gain.value = this.volume;
  }

  private get live(): boolean {
    return this.hearing && !!this.ctx && !!this.master && this.ctx.state === 'running';
  }

  setListener(x: number, z: number, yaw: number): void {
    if (!this.live || !this.ctx) return;
    const l = this.ctx.listener;
    const [fx, fz] = forwardOf(yaw);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(x, t);
      l.positionY.setValueAtTime(1.6, t);
      l.positionZ.setValueAtTime(z, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(0, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    }
  }

  /* ----------------------------- 基本音源 ----------------------------- */

  private route(pos: Pos, pan?: number): AudioNode {
    const ctx = this.ctx!;
    if (pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 2;
      p.rolloffFactor = 0.9;
      p.maxDistance = 40;
      p.positionX.value = pos[0];
      p.positionY.value = 1.4;
      p.positionZ.value = pos[1];
      p.connect(this.master!);
      return p;
    }
    if (pan !== undefined && ctx.createStereoPanner) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = Math.max(-1, Math.min(1, pan));
      sp.connect(this.master!);
      return sp;
    }
    return this.master!;
  }

  private tone(freq: number, dur: number, o: ToneOpts = {}): void {
    if (!this.live || !this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t0 + dur);
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    const attack = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    let tail: AudioNode = g;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.filter;
      g.connect(f);
      tail = f;
    }
    tail.connect(this.route(o.pos ?? null, o.pan));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, o: { freq: number; q?: number; gain?: number; at?: number; pos?: Pos; pan?: number; type?: BiquadFilterType }): void {
    if (!this.live || !this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.frequency.value = o.freq;
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.route(o.pos ?? null, o.pan));
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  /* ----------------------------- 遊戲音效 ----------------------------- */

  footstep(pos: Pos = null, running = false): void {
    const j = 0.85 + Math.random() * 0.3;
    this.noise(0.07, { freq: 900 * j, q: 0.8, gain: pos ? 0.22 : 0.1, pos });
    this.tone(95 * j, 0.09, { type: 'sine', gain: pos ? 0.18 : 0.1, pos });
    if (running) this.noise(0.05, { freq: 2200, q: 1.2, gain: 0.05, pos, at: 0.02 });
  }

  bump(): void {
    this.tone(110, 0.16, { type: 'sine', gain: 0.35, slideTo: 45 });
    this.noise(0.1, { freq: 300, q: 0.7, gain: 0.2 });
  }

  door(pos: Pos, opening: boolean): void {
    this.noise(0.7, { freq: opening ? 500 : 800, q: 0.6, gain: 0.25, pos, type: 'bandpass' });
    this.tone(opening ? 140 : 180, 0.6, { type: 'sawtooth', gain: 0.1, slideTo: opening ? 260 : 90, pos, filter: 800 });
    this.tone(opening ? 520 : 300, 0.12, { type: 'square', gain: 0.07, at: 0.62, pos });
  }

  uiOk(): void {
    this.tone(660, 0.12, { type: 'triangle', gain: 0.18 });
    this.tone(990, 0.18, { type: 'triangle', gain: 0.16, at: 0.09 });
  }
  uiError(): void {
    this.tone(180, 0.22, { type: 'sawtooth', gain: 0.16, filter: 900 });
    this.tone(150, 0.26, { type: 'sawtooth', gain: 0.14, at: 0.16, filter: 900 });
  }
  uiWarn(): void {
    this.tone(420, 0.14, { type: 'triangle', gain: 0.16 });
    this.tone(420, 0.14, { type: 'triangle', gain: 0.16, at: 0.2 });
  }
  uiOpen(): void {
    this.tone(480, 0.07, { type: 'triangle', gain: 0.12 });
    this.tone(720, 0.09, { type: 'triangle', gain: 0.12, at: 0.06 });
  }
  uiClose(): void {
    this.tone(720, 0.07, { type: 'triangle', gain: 0.1 });
    this.tone(440, 0.09, { type: 'triangle', gain: 0.1, at: 0.06 });
  }
  uiKey(): void {
    this.tone(900, 0.03, { type: 'square', gain: 0.05 });
  }
  notice(): void {
    this.tone(540, 0.1, { type: 'sine', gain: 0.14 });
  }
  solved(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.45, { type: 'triangle', gain: 0.17, at: i * 0.11 }));
  }
  /** 終章：低音上升的和弦 */
  ending(): void {
    [110, 165, 220, 277, 330, 440].forEach((f, i) => this.tone(f, 3.2, { type: 'sine', gain: 0.1, at: i * 0.55, attack: 0.4 }));
  }
  lockout(): void {
    this.tone(120, 0.5, { type: 'square', gain: 0.1, filter: 500 });
  }

  /** 盲區員的指引：設備方位的短促「滴」聲；音高隨設備種類不同 */
  beacon(dx: number, dz: number, yaw: number, dist: number, kindPitch: number): void {
    const [fx, fz] = forwardOf(yaw);
    const rx = -fz;
    const rz = fx;
    const len = Math.hypot(dx, dz) || 1;
    const front = (dx * fx + dz * fz) / len;
    const side = (dx * rx + dz * rz) / len;
    const near = dist < 2.6;
    const gain = Math.max(0.05, 0.28 - dist * 0.02) * (front < -0.2 ? 0.7 : 1);
    this.tone(kindPitch * (front < -0.2 ? 0.7 : 1), near ? 0.14 : 0.08, { type: near ? 'triangle' : 'sine', gain, pan: side });
    if (near && front > 0.5) this.tone(kindPitch * 1.5, 0.1, { type: 'triangle', gain: gain * 0.7, pan: side, at: 0.07 });
  }

  /** 回聲定位：往前／左／右／後各發出一道回聲，延遲與音高代表距離 */
  sonar(d: { front: number; left: number; right: number; back: number }, max = 12): void {
    this.tone(1400, 0.04, { type: 'square', gain: 0.1, filter: 4000 });
    const echo = (dist: number, pan: number, tag: number) => {
      const delay = 0.12 + dist * 0.045;
      const near = 1 - Math.min(dist, max) / max;
      this.tone(900 - dist * 45 + tag, 0.11, { type: 'triangle', gain: 0.06 + near * 0.2, at: delay, pan, filter: 3000 });
    };
    echo(d.front, 0, 80);
    echo(d.left, -0.9, 0);
    echo(d.right, 0.9, 0);
    echo(d.back, 0, -160);
  }

  /** 機械敲擊（Puzzle 的線索）。events 的 at/len/tone 全部來自伺服器。 */
  playTaps(p: TapPattern, onEnd?: () => void): () => void {
    if (!this.live || !this.ctx) {
      onEnd?.();
      return () => undefined;
    }
    this.stopTaps();
    for (const e of p.events) {
      const dur = Math.max(0.05, e.len / 1000);
      // pan：伺服器指定的左右位置（例如 P07 定位音箱的左／中／右）
      this.tone(e.tone, dur, { type: 'triangle', gain: 0.32, at: e.at / 1000 + 0.05, attack: 0.004, filter: 2400, pan: e.pan });
      this.noise(0.04, { freq: e.tone * 2, q: 1.5, gain: 0.12, at: e.at / 1000 + 0.05, pan: e.pan });
    }
    const timer = window.setTimeout(() => onEnd?.(), p.durationMs + 200);
    const cancel = (): void => {
      clearTimeout(timer);
    };
    this.activeTaps.push(cancel);
    return cancel;
  }
  stopTaps(): void {
    for (const c of this.activeTaps) c();
    this.activeTaps = [];
  }

  /** 謎題回饋音（伺服器只會把 sound 送給聽得見的角色）；pos 為設備位置時使用空間音訊 */
  feedback(sound: NonNullable<PuzzleFeedback['sound']>, pos: Pos = null, windowMs = 3000): void {
    switch (sound) {
      case 'accept':
        this.tone(560, 0.1, { type: 'triangle', gain: 0.2, pos });
        this.tone(840, 0.16, { type: 'triangle', gain: 0.18, at: 0.08, pos });
        return;
      case 'reject':
        this.tone(140, 0.18, { type: 'square', gain: 0.12, filter: 700, pos });
        this.tone(118, 0.24, { type: 'square', gain: 0.12, filter: 700, at: 0.14, pos });
        return;
      case 'thud':
        // 推不開的門：沉悶的撞擊與門把晃動
        this.tone(70, 0.3, { type: 'sine', gain: 0.4, slideTo: 40, pos });
        this.noise(0.18, { freq: 220, q: 0.8, gain: 0.3, pos });
        for (let i = 0; i < 3; i++) this.noise(0.05, { freq: 2600, q: 4, gain: 0.08, at: 0.1 + i * 0.07, pos });
        return;
      case 'unlock':
        this.noise(0.12, { freq: 1800, q: 3, gain: 0.14, pos });
        this.tone(330, 0.5, { type: 'triangle', gain: 0.16, at: 0.08, slideTo: 660, pos });
        return;
      case 'countdown': {
        // 每秒一聲滴答，最後一秒升高
        const n = Math.max(1, Math.round(windowMs / 1000));
        for (let i = 0; i < n; i++) this.tone(i === n - 1 ? 1180 : 880, 0.07, { type: 'square', gain: 0.1, at: i, filter: 3000 });
        return;
      }
      case 'selftest':
        this.tone(220, 0.9, { type: 'sawtooth', gain: 0.07, slideTo: 440, filter: 1200, pos });
        this.tone(440, 0.6, { type: 'sawtooth', gain: 0.06, at: 0.9, slideTo: 220, filter: 1200, pos });
        return;
      case 'shift':
        // 空間重新排列：低沉的掃頻與遠處的回響
        this.noise(1.2, { freq: 160, q: 0.6, gain: 0.25, type: 'lowpass' });
        this.tone(55, 1.3, { type: 'sine', gain: 0.3, slideTo: 38, attack: 0.2 });
        this.tone(660, 0.5, { type: 'sine', gain: 0.05, at: 0.6, slideTo: 330 });
        return;
    }
  }

  /** P02：門後的聲音（只有盲區員拿到這項線索）。以門的位置做空間定位 */
  doorTone(kind: DoorSoundId, pos: Pos, at = 0): void {
    if (kind === 'HIGH_CONT') this.tone(1240, 0.7, { type: 'sine', gain: 0.1, at, attack: 0.05, pos });
    else if (kind === 'LOW_FALL') this.tone(190, 0.7, { type: 'sawtooth', gain: 0.1, at, attack: 0.04, slideTo: 95, filter: 600, pos });
    else this.tone(150, 0.7, { type: 'sawtooth', gain: 0.1, at, attack: 0.04, filter: 600, pos });
  }

  /** 標記提示音（失語員指向某台設備；聽得見的人聽到位置） */
  marker(pos: Pos): void {
    this.tone(1320, 0.06, { type: 'triangle', gain: 0.14, pos });
    this.tone(1760, 0.08, { type: 'triangle', gain: 0.12, at: 0.08, pos });
  }

  /** 信號器的聽覺 token */
  signalTokens(tokens: readonly SignalToken[]): void {
    let at = 0;
    for (const t of tokens) {
      if (t === 'TAP_S') {
        this.tone(520, 0.1, { type: 'triangle', gain: 0.3, at, filter: 2200 });
        at += 0.3;
      } else if (t === 'TAP_L') {
        this.tone(520, 0.38, { type: 'triangle', gain: 0.3, at, attack: 0.01, filter: 2200 });
        at += 0.6;
      }
    }
  }

  /* ----------------------------- 環境音 ----------------------------- */

  startAmbient(): void {
    if (!this.live || !this.ctx || this.ambientNodes.length) return;
    const ctx = this.ctx;
    const mk = (f: number, g: number, type: OscillatorType): void => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.value = g;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      o.connect(lp).connect(gn).connect(this.master!);
      o.start();
      this.ambientNodes.push(o, gn, lp);
    };
    mk(54, 0.05, 'sawtooth');
    mk(54.7, 0.04, 'sawtooth');
    mk(108.3, 0.015, 'sine');
    if (this.noiseBuf) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 400;
      const g = ctx.createGain();
      g.gain.value = 0.02;
      src.connect(f).connect(g).connect(this.master!);
      src.start();
      this.ambientNodes.push(src, f, g);
    }
  }
  stopAmbient(): void {
    for (const n of this.ambientNodes) {
      try {
        (n as OscillatorNode).stop?.();
      } catch {
        /* 已停止 */
      }
      n.disconnect();
    }
    this.ambientNodes = [];
  }

  /* ----------------------------- 隊友語音 ----------------------------- */

  /**
   * 接上隊友的語音。靜默員（聽不見）會直接拒絕——即使伺服器因為 bug 路由了語音，
   * 客戶端也不會把它放出來。
   */
  attachVoice(role: Role, stream: MediaStream): boolean {
    if (!this.hearing) return false;
    if (!this.ctx || !this.master) {
      this.pendingVoices.set(role, stream);
      return true;
    }
    this.detachVoice(role);
    // Chrome 需要把遠端串流先接到一個（靜音的）媒體元素，Web Audio 才會真的有資料
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => undefined);
    const src = this.ctx.createMediaStreamSource(stream);
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 4;
    panner.rolloffFactor = 0.3;
    panner.maxDistance = 60;
    panner.positionY.value = 1.6;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(panner).connect(this.master);
    src.connect(analyser);
    this.voices.set(role, { src, panner, analyser, el, buf: new Uint8Array(analyser.fftSize) });
    return true;
  }
  detachVoice(role: Role): void {
    this.pendingVoices.delete(role);
    const v = this.voices.get(role);
    if (!v) return;
    try {
      v.src.disconnect();
      v.panner.disconnect();
      v.analyser.disconnect();
    } catch {
      /* ignore */
    }
    v.el.srcObject = null;
    this.voices.delete(role);
  }
  updateVoicePos(role: Role, x: number, z: number): void {
    const v = this.voices.get(role);
    if (!v || !this.ctx) return;
    v.panner.positionX.setValueAtTime(x, this.ctx.currentTime);
    v.panner.positionZ.setValueAtTime(z, this.ctx.currentTime);
  }
  voiceLevel(role: Role): number {
    const v = this.voices.get(role);
    if (!v) return 0;
    v.analyser.getByteTimeDomainData(v.buf);
    let peak = 0;
    for (let i = 0; i < v.buf.length; i++) peak = Math.max(peak, Math.abs(v.buf[i] - 128));
    return peak / 128;
  }
  hasVoice(role: Role): boolean {
    return this.voices.has(role);
  }
}

export const audio = new AudioEngine();
