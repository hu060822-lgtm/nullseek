import type { LandmarkSound } from '@null-protocol/shared';
import { audio } from '../../audio/engine';

/**
 * 空間聲源的聲音設計（全部程序化產生，不使用音檔）。
 * 每種聲音刻意落在不同的頻段與節奏，讓參考音、地標、回聲與語音彼此容易分辨：
 *   - 參考音（通風口）：2.9 kHz 附近的細微「呼吸」氣流聲，約 3 秒一次起伏；音量很低
 *   - 回聲：短促的「嗒／叮／嗡／咚」，只在按 F 之後出現
 *   - 地標：各有固定節奏（滴水、三連敲擊、雙響、間歇電流）或固定音高的持續音
 *   - 隊友語音：人聲頻段，說話時環境音會自動稍微壓低
 */

type Loop = (ctx: AudioContext, input: AudioNode) => () => void;

function loopNoise(ctx: AudioContext): AudioBufferSourceNode | null {
  const buf = audio.noise1s;
  if (!buf) return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

function lfo(ctx: AudioContext, target: AudioParam, rate: number, depth: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g).connect(target);
  o.start();
  return o;
}

const stopAll = (nodes: Array<AudioScheduledSourceNode | null>) => () => {
  for (const n of nodes) {
    try {
      n?.stop();
      n?.disconnect();
    } catch {
      /* 已停止 */
    }
  }
};

/** 方向參考音：通風口的氣流（每個房間同一種聲音、同一個位置規則） */
export const referenceVent: Loop = (ctx, input) => {
  const src = loopNoise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2900;
  bp.Q.value = 1.1;
  const amp = ctx.createGain();
  amp.gain.value = 0.55;
  const mod = lfo(ctx, amp.gain, 0.33, 0.4);
  src?.connect(bp).connect(amp).connect(input);
  src?.start(0, Math.random());
  return stopAll([src, mod]);
};

const LOOPS: Partial<Record<LandmarkSound, Loop>> = {
  /** 排風扇：低頻氣流＋葉片的快速起伏 */
  vent: (ctx, input) => {
    const src = loopNoise(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const amp = ctx.createGain();
    amp.gain.value = 0.5;
    const mod = lfo(ctx, amp.gain, 7.5, 0.35);
    src?.connect(lp).connect(amp).connect(input);
    src?.start(0, Math.random());
    const o = ctx.createOscillator();
    o.frequency.value = 47;
    const og = ctx.createGain();
    og.gain.value = 0.25;
    o.connect(og).connect(input);
    o.start();
    return stopAll([src, mod, o]);
  },
  /** 低鳴（變壓器、管道、核心）：98 Hz 與 196 Hz，與全域的 54 Hz 環境底噪不同 */
  hum: (ctx, input) => {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 480;
    lp.connect(input);
    const a = ctx.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = 98;
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.value = 196.5;
    const ga = ctx.createGain();
    ga.gain.value = 0.18;
    const gb = ctx.createGain();
    gb.gain.value = 0.12;
    a.connect(ga).connect(lp);
    b.connect(gb).connect(lp);
    const mod = lfo(ctx, ga.gain, 0.8, 0.06);
    a.start();
    b.start();
    return stopAll([a, b, mod]);
  },
};

type Fire = (input: AudioNode) => void;

const FIRES: Partial<Record<LandmarkSound, Fire>> = {
  /** 滴水：下滑的短音＋小小的水花 */
  drip: (dest) => {
    audio.tone(1500, 0.07, { type: 'sine', gain: 0.5, slideTo: 760, dest });
    audio.noise(0.05, { freq: 3200, q: 2, gain: 0.12, at: 0.02, dest });
  },
  /** 金屬管線：三次敲擊 */
  pipe: (dest) => {
    for (let i = 0; i < 3; i++) {
      audio.tone(330, 0.32, { type: 'triangle', gain: 0.4, at: i * 0.26, dest });
      audio.tone(497, 0.24, { type: 'sine', gain: 0.22, at: i * 0.26, dest });
      audio.noise(0.03, { freq: 1800, q: 2, gain: 0.2, at: i * 0.26, dest });
    }
  },
  /** 間歇電流聲：一段 120 Hz 的嗡聲夾著幾下爆裂 */
  buzz: (dest) => {
    audio.tone(120, 0.55, { type: 'square', gain: 0.16, filter: 1400, dest });
    for (const t of [0.05, 0.17, 0.24, 0.41]) audio.noise(0.025, { freq: 4200, q: 1.5, gain: 0.22, at: t, dest });
  },
  /** 狀態提示器：固定節奏的雙響 */
  alarm: (dest) => {
    audio.tone(1046, 0.11, { type: 'square', gain: 0.14, filter: 2400, dest });
    audio.tone(1046, 0.11, { type: 'square', gain: 0.14, filter: 2400, at: 0.2, dest });
  },
};

export function landmarkSound(sound: LandmarkSound): { loop?: Loop; fire?: Fire } {
  return { loop: LOOPS[sound], fire: FIRES[sound] };
}

/** 感測器預警：短促上升的啁啾（每 0.5 秒） */
export const sensorWarn: Fire = (dest) => audio.tone(900, 0.12, { type: 'sine', gain: 0.35, slideTo: 1500, dest });
/** 感測器警戒：快速而輕的滴答（每 0.3 秒） */
export const sensorArmed: Fire = (dest) => audio.tone(2200, 0.03, { type: 'square', gain: 0.22, filter: 5000, dest });
