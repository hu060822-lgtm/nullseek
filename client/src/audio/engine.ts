import { MATERIALS, forwardOf, type DoorSoundId, type EchoVoice, type PuzzleFeedback, type Role, type TapPattern, type SignalToken } from '@null-protocol/shared';

/**
 * 程序化音訊引擎（Web Audio，不使用任何外部音檔或生成式 AI）。
 *
 * 角色限制在這裡「真的」執行：
 *   - 靜默員（聽不見）：hearing=false → 不會建立 AudioContext、不會播放任何東西、
 *     也不會接上任何遠端語音串流。master gain 另外強制為 0 作為第二道防線。
 *   - 盲區員／失語員：可聽見，並使用 HRTF 空間音訊。
 *
 * 音量分成幾條匯流排，各自調整（回聲與隊友語音分開管理）：
 *   sfx＝一般音效與謎題回饋、env＝環境音與聲學地標、echo＝盲區員的回聲、
 *   nav＝方向提示與設備指引、voice＝隊友語音。全部再經過 master（總音量）。
 * 單聲道模式：在輸出端把左右聲道混成一個（給只有單一喇叭、或聽不出左右的玩家）。
 */

type Pos = readonly [number, number] | null;
export type Bus = 'sfx' | 'env' | 'echo' | 'nav' | 'voice';
export const BUSES: readonly Bus[] = ['sfx', 'env', 'echo', 'nav', 'voice'];

export interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  at?: number;
  attack?: number;
  slideTo?: number;
  pos?: Pos;
  pan?: number;
  filter?: number;
  /** 輸出到哪條匯流排（預設 sfx） */
  bus?: Bus;
  /** 直接輸出到指定節點（例如聲學地標自己的遮蔽鏈）；指定後忽略 pos／pan／bus */
  dest?: AudioNode;
  /** 空間音源的高度（預設 1.4 m） */
  y?: number;
  /** 空間音源的距離衰減係數（預設 0.9；回聲自己計算距離衰減時設為 0） */
  rolloff?: number;
}

export interface NoiseOpts {
  freq: number;
  q?: number;
  gain?: number;
  at?: number;
  pos?: Pos;
  pan?: number;
  type?: BiquadFilterType;
  bus?: Bus;
  dest?: AudioNode;
  y?: number;
  rolloff?: number;
  attack?: number;
}

/** 設定聽者位置與朝向：forward＝forwardOf(yaw)、up＝+y（與移動、鏡頭同一個座標系） */
export function applyListener(l: AudioListener, x: number, z: number, yaw: number, t: number): void {
  const [fx, fz] = forwardOf(yaw);
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
  } else {
    // 舊版 Safari
    (l as unknown as { setPosition(a: number, b: number, c: number): void }).setPosition(x, 1.6, z);
    (l as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fx, 0, fz, 0, 1, 0);
  }
}

/** 單聲道：讓節點只處理一個聲道（瀏覽器依 speakers 規則把立體聲混成單聲道） */
function setMonoNode(n: AudioNode, mono: boolean): void {
  try {
    n.channelCountMode = mono ? 'explicit' : 'clamped-max';
    n.channelCount = mono ? 1 : 2;
    n.channelInterpretation = 'speakers';
  } catch {
    /* 舊瀏覽器：維持原狀 */
  }
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private buses: Partial<Record<Bus, GainNode>> = {};
  private meters: Partial<Record<Bus, AnalyserNode>> = {};
  private busLevel: Record<Bus, number> = { sfx: 1, env: 1, echo: 1, nav: 1, voice: 1 };
  private envDuck = 1;
  private mono = false;
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
      this.comp = comp;
      this.master.connect(comp).connect(this.ctx.destination);
      for (const b of BUSES) {
        const g = this.ctx.createGain();
        g.gain.value = this.busGain(b);
        g.connect(this.master);
        this.buses[b] = g;
        const m = this.ctx.createAnalyser();
        m.fftSize = 1024;
        g.connect(m);
        this.meters[b] = m;
      }
      this.applyMono();
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
    this.comp = null;
    this.buses = {};
    this.meters = {};
    this.noiseBuf = null;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.hearing) this.master.gain.value = this.volume;
  }

  private busGain(b: Bus): number {
    return this.busLevel[b] * (b === 'env' ? this.envDuck : 1);
  }

  /** 各匯流排的音量（0–1.5）；音訊還沒啟動時先記下來 */
  setBusVolume(b: Bus, v: number): void {
    this.busLevel[b] = Math.max(0, Math.min(1.5, v));
    const g = this.buses[b];
    if (g && this.ctx) g.gain.setTargetAtTime(this.busGain(b), this.ctx.currentTime, 0.05);
  }

  /** 隊友說話時稍微壓低環境音，讓語音、回聲與環境音同時存在時仍然聽得清楚 */
  setEnvDuck(on: boolean): void {
    const v = on ? 0.55 : 1;
    if (v === this.envDuck) return;
    this.envDuck = v;
    this.setBusVolume('env', this.busLevel.env);
  }

  /** 單聲道模式：壓縮器只處理一個聲道（瀏覽器自動把立體聲混成單聲道），輸出端再送到兩邊喇叭 */
  setMono(on: boolean): void {
    this.mono = on;
    this.applyMono();
  }
  isMono(): boolean {
    return this.mono;
  }
  private applyMono(): void {
    if (this.comp) setMonoNode(this.comp, this.mono);
  }

  /**
   * 測試用：以離線音訊（OfflineAudioContext）實際算繪一個 HRTF 聲源，回傳左右聲道的能量。
   * 聽者設定與單聲道處理使用和遊戲完全相同的函式，用來驗證「聲源在右邊時右耳比較大聲」。
   */
  async probe(o: { x: number; z: number; yaw: number; sx: number; sz: number; mono?: boolean }): Promise<{ left: number; right: number }> {
    const rate = 44100;
    const ctx = new OfflineAudioContext(2, Math.round(rate * 0.4), rate);
    applyListener(ctx.listener, o.x, o.z, o.yaw, 0);
    const buf = ctx.createBuffer(1, rate, rate);
    const d = buf.getChannelData(0);
    let seed = 1;
    for (let i = 0; i < d.length; i++) d[i] = ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.positionX.value = o.sx;
    p.positionY.value = 1.6;
    p.positionZ.value = o.sz;
    const comp = ctx.createDynamicsCompressor();
    setMonoNode(comp, !!o.mono);
    src.connect(p).connect(comp).connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    const rms = (ch: Float32Array) => Math.sqrt(ch.reduce((s, v) => s + v * v, 0) / ch.length);
    return { left: rms(out.getChannelData(0)), right: rms(out.getChannelData(1)) };
  }

  /** 匯流排目前設定的增益（含說話時的環境音壓低） */
  busValue(b: Bus): number {
    return this.buses[b]?.gain.value ?? this.busGain(b);
  }

  /** 各匯流排目前的音量（RMS，測試與開發者工具用） */
  meter(b: Bus): number {
    const a = this.meters[b];
    if (!a || !this.live) return 0;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
  }

  private get live(): boolean {
    return this.hearing && !!this.ctx && !!this.master && this.ctx.state === 'running';
  }

  /** 給空間音訊模組使用：音訊正在運作時回傳 AudioContext，否則 null */
  get context(): AudioContext | null {
    return this.live ? this.ctx : null;
  }
  bus(b: Bus): AudioNode | null {
    return this.live ? (this.buses[b] ?? null) : null;
  }
  get noise1s(): AudioBuffer | null {
    return this.noiseBuf;
  }

  setListener(x: number, z: number, yaw: number): void {
    if (!this.live || !this.ctx) return;
    applyListener(this.ctx.listener, x, z, yaw, this.ctx.currentTime);
  }

  /* ----------------------------- 基本音源 ----------------------------- */

  private route(o: { pos?: Pos; pan?: number; bus?: Bus; dest?: AudioNode; y?: number; rolloff?: number }): AudioNode {
    const ctx = this.ctx!;
    if (o.dest) return o.dest;
    const out = this.buses[o.bus ?? 'sfx'] ?? this.master!;
    if (o.pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 2;
      p.rolloffFactor = o.rolloff ?? 0.9;
      p.maxDistance = 40;
      p.positionX.value = o.pos[0];
      p.positionY.value = o.y ?? 1.4;
      p.positionZ.value = o.pos[1];
      p.connect(out);
      return p;
    }
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = Math.max(-1, Math.min(1, o.pan));
      sp.connect(out);
      return sp;
    }
    return out;
  }

  tone(freq: number, dur: number, o: ToneOpts = {}): void {
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
    tail.connect(this.route(o));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noise(dur: number, o: NoiseOpts): void {
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
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.route(o));
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
    this.tone(kindPitch * (front < -0.2 ? 0.7 : 1), near ? 0.14 : 0.08, { type: near ? 'triangle' : 'sine', gain, pan: side, bus: 'nav' });
    if (near && front > 0.5) this.tone(kindPitch * 1.5, 0.1, { type: 'triangle', gain: gain * 0.7, pan: side, at: 0.07, bus: 'nav' });
  }

  /* ----------------------------- 盲區員：主動回聲 ----------------------------- */

  /** 自己發出的脈衝（短促的「嗒」，不定位） */
  echoPing(): void {
    this.noise(0.025, { freq: 3400, q: 0.9, gain: 0.16, bus: 'echo' });
    this.tone(1900, 0.03, { type: 'square', gain: 0.05, filter: 5000, bus: 'echo' });
  }

  /**
   * 一個反射：在反射點用 HRTF 定位播放；音色由材質決定，延遲、音量、明暗由 planEcho 依距離計算。
   * 距離衰減已經算在 gain 裡，所以 panner 的衰減設為 0。
   */
  echoVoice(v: EchoVoice): void {
    const pos: Pos = [v.x, v.z];
    const common = { pos, at: v.at, bus: 'echo' as const, rolloff: 0, y: 1.3 };
    if (v.kind === 'open') {
      this.noise(0.22, { freq: 420, q: 0.6, gain: v.gain, type: 'lowpass', attack: 0.06, ...common });
      return;
    }
    const m = MATERIALS[v.material ?? 'concrete'];
    const cut = Math.max(500, v.cutoff);
    switch (m.voice) {
      case 'noise':
        this.noise(m.ring, { freq: Math.min(m.freq, cut), q: 1.4, gain: v.gain * 1.2, ...common });
        return;
      case 'ring':
        this.tone(m.freq, m.ring, { type: 'triangle', gain: v.gain * 0.7, filter: cut * 1.4, ...common });
        this.tone(m.freq * 1.47, m.ring * 0.8, { type: 'sine', gain: v.gain * 0.45, filter: cut * 1.4, ...common });
        this.noise(0.03, { freq: Math.min(3000, cut), q: 2, gain: v.gain * 0.5, ...common });
        return;
      case 'buzz':
        this.tone(m.freq, m.ring, { type: 'square', gain: v.gain * 0.45, filter: Math.min(cut, 2200), ...common });
        this.tone(m.freq * 2.01, m.ring * 0.7, { type: 'sawtooth', gain: v.gain * 0.2, filter: Math.min(cut, 2200), ...common });
        return;
      case 'knock':
        this.tone(m.freq, m.ring, { type: 'sine', gain: v.gain * 1.1, slideTo: m.freq * 0.8, ...common });
        this.noise(0.02, { freq: Math.min(1400, cut), q: 2, gain: v.gain * 0.4, ...common });
        return;
    }
  }

  /** 殘響尾巴：左右兩個不相關的噪音，長度代表空間大小（開放空間較長） */
  echoTail(len: number, gain: number, at = 0.08): void {
    for (const pan of [-0.7, 0.7]) this.noise(len, { freq: 1100, q: 0.5, gain, type: 'lowpass', at, pan, attack: 0.03, bus: 'echo' });
  }

  /** 冷卻結束：很輕的上升兩音，告訴玩家可以再發 */
  echoReady(): void {
    this.tone(1200, 0.05, { type: 'sine', gain: 0.05, bus: 'echo' });
    this.tone(1800, 0.06, { type: 'sine', gain: 0.045, at: 0.06, bus: 'echo' });
  }

  /** 冷卻中再按：一聲很輕的「喀」，告訴玩家還不能發 */
  echoNotReady(): void {
    this.tone(260, 0.04, { type: 'triangle', gain: 0.05, bus: 'echo' });
  }

  /** 回聲被感測器干擾：短暫的雜訊，沒有任何反射 */
  echoJammed(): void {
    this.noise(0.5, { freq: 2600, q: 0.4, gain: 0.12, bus: 'echo' });
    this.tone(180, 0.4, { type: 'sawtooth', gain: 0.04, filter: 900, bus: 'echo' });
  }

  /* ----------------------------- 盲區員：方向提示 ----------------------------- */

  /**
   * 轉向提示（不定位，單聲道也聽得出來）：
   *   minor＝每 45° 的輕響、axis＝轉到右翼／左翼、deep＝轉到深處（上升雙音）、entry＝轉到入口（低音）。
   */
  headingTick(kind: 'minor' | 'axis' | 'deep' | 'entry'): void {
    const o = { bus: 'nav' as const };
    if (kind === 'minor') this.tone(1500, 0.025, { type: 'sine', gain: 0.045, ...o });
    else if (kind === 'axis') this.tone(990, 0.06, { type: 'triangle', gain: 0.07, ...o });
    else if (kind === 'deep') {
      this.tone(880, 0.06, { type: 'triangle', gain: 0.08, ...o });
      this.tone(1320, 0.08, { type: 'triangle', gain: 0.08, at: 0.07, ...o });
    } else this.tone(440, 0.1, { type: 'triangle', gain: 0.08, ...o });
  }

  /** 音訊校準：左／右聲道各自播放；both＝兩邊同時（確認音量） */
  testChannel(side: 'left' | 'right' | 'both'): void {
    const pan = side === 'left' ? -1 : side === 'right' ? 1 : 0;
    for (let i = 0; i < 3; i++) this.tone(side === 'both' ? 660 : 880, 0.12, { type: 'triangle', gain: 0.2, pan, at: i * 0.2 });
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

  /** 隊友被設備鎖定時的電擊聲（空間定位） */
  zap(pos: Pos): void {
    for (let i = 0; i < 4; i++) this.noise(0.05, { freq: 3200 + i * 500, q: 3, gain: 0.12, at: i * 0.045, pos });
    this.tone(95, 0.25, { type: 'square', gain: 0.08, filter: 600, pos });
  }

  /** 聲學感測器偵測到回聲：兩音交替的警報（在感測器位置播放） */
  alarm(pos: Pos): void {
    for (let i = 0; i < 4; i++) {
      this.tone(i % 2 ? 620 : 830, 0.28, { type: 'sawtooth', gain: 0.12, at: i * 0.3, filter: 2000, pos, y: 3 });
    }
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
      o.connect(lp).connect(gn).connect(this.buses.env ?? this.master!);
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
      src.connect(f).connect(g).connect(this.buses.env ?? this.master!);
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
    src.connect(panner).connect(this.buses.voice ?? this.master);
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
