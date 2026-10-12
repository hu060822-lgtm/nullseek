import { audibility, type AcousticLevel, type Audibility } from '@null-protocol/shared';
import { audio } from '../../audio/engine';

/**
 * SpatialAudioManager：持續存在的空間聲源（參考音、聲學地標、感測器）。
 *
 * 輸入：聲源定義（位置、所在區域、遮蔽規則、聲音產生方式）＋每一幀的聽者區域與門的狀態。
 * 輸出：Web Audio 節點鏈  聲音 → input → 低通（遮蔽） → 遮蔽音量 → HRTF panner → env 匯流排。
 *
 * 遮蔽規則統一由 shared 的 audibility() 決定：同一區域直接聽到、指定的相鄰區域經由暢通的開口聽到悶聲、其餘聽不到。
 * 聽不到的聲源會在淡出後拆掉節點（不在背景持續耗用 CPU），再次可聽時重新建立。
 * 聽者的位置與朝向由 audio.setListener() 統一設定，所以轉身時所有聲源的雙耳方位一起更新。
 */

export interface EmitterDef {
  id: string;
  zone: string;
  pos: [number, number];
  y: number;
  audibleFrom?: string[];
  /** 聲源整體音量 */
  gain: number;
  /** 持續音：建立節點並接到 input，回傳停止函式 */
  loop?: (ctx: AudioContext, input: AudioNode) => () => void;
  /** 週期性聲音：每隔 period() 毫秒呼叫一次 fire(input) */
  period?: () => number;
  fire?: (input: AudioNode) => void;
  /** 額外的播放條件（例如某扇門開著、感測器正在警戒） */
  enabled?: () => boolean;
}

interface Live {
  ctx: AudioContext;
  input: GainNode;
  lp: BiquadFilterNode;
  occ: GainNode;
  panner: PannerNode;
  stop?: () => void;
  silentSince: number;
  nextFire: number;
  mode: Audibility['mode'];
}

const FADE = 0.12;
const TEARDOWN_MS = 1500;

export class SpatialAudioManager {
  private defs = new Map<string, EmitterDef>();
  private live = new Map<string, Live>();
  private last = new Map<string, Audibility['mode']>();

  constructor(private readonly level: AcousticLevel) {}

  add(def: EmitterDef): void {
    this.defs.set(def.id, def);
  }

  remove(id: string): void {
    this.teardown(id);
    this.defs.delete(id);
    this.last.delete(id);
  }

  /** 每一幀呼叫：依聽者所在區域與門的狀態，更新每個聲源的遮蔽與定位 */
  update(listenerZone: string | null, isOpen: (door: string) => boolean, now: number): void {
    const ctx = audio.context;
    const out = audio.bus('env');
    // 音訊被關閉或重新建立（例如角色改變）：舊的節點全部作廢
    for (const [id, l] of this.live) if (l.ctx !== ctx) this.live.delete(id);
    for (const def of this.defs.values()) {
      const aud: Audibility = def.enabled && !def.enabled() ? { mode: 'none' } : audibility(this.level, def, listenerZone, isOpen);
      this.last.set(def.id, aud.mode);
      let l = this.live.get(def.id);
      if (aud.mode === 'none') {
        if (!l) continue;
        if (l.mode !== 'none') {
          l.occ.gain.setTargetAtTime(0, l.ctx.currentTime, FADE);
          l.mode = 'none';
          l.silentSince = now;
        } else if (now - l.silentSince > TEARDOWN_MS) this.teardown(def.id);
        continue;
      }
      if (!ctx || !out) continue;
      if (!l) {
        l = this.build(ctx, out, def, now);
        this.live.set(def.id, l);
      }
      const t = ctx.currentTime;
      l.panner.positionX.setValueAtTime(aud.pos[0], t);
      l.panner.positionZ.setValueAtTime(aud.pos[1], t);
      if (l.mode !== aud.mode) {
        const direct = aud.mode === 'direct';
        l.occ.gain.setTargetAtTime(direct ? def.gain : def.gain * this.level.muffle.gain, t, FADE);
        l.lp.frequency.setTargetAtTime(direct ? 16000 : this.level.muffle.cutoff, t, FADE);
        l.mode = aud.mode;
      }
      if (def.fire && def.period && now >= l.nextFire) {
        def.fire(l.input);
        l.nextFire = now + def.period();
      }
    }
  }

  private build(ctx: AudioContext, out: AudioNode, def: EmitterDef, now: number): Live {
    const input = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 16000;
    const occ = ctx.createGain();
    occ.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 1;
    panner.maxDistance = 30;
    panner.positionX.value = def.pos[0];
    panner.positionY.value = def.y;
    panner.positionZ.value = def.pos[1];
    input.connect(lp).connect(occ).connect(panner).connect(out);
    const stop = def.loop?.(ctx, input);
    // 週期聲源第一次出現時稍微錯開，避免所有地標同時響起
    return { ctx, input, lp, occ, panner, stop, silentSince: 0, nextFire: now + 300 + Math.random() * 500, mode: 'none' };
  }

  private teardown(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    try {
      l.stop?.();
      l.input.disconnect();
      l.panner.disconnect();
    } catch {
      /* 已經斷開 */
    }
    this.live.delete(id);
  }

  /** 目前的遮蔽狀態（測試與開發者工具用） */
  modeOf(id: string): Audibility['mode'] {
    return this.last.get(id) ?? 'none';
  }
  liveCount(): number {
    return this.live.size;
  }

  dispose(): void {
    for (const id of [...this.live.keys()]) this.teardown(id);
    this.defs.clear();
    this.last.clear();
  }
}
