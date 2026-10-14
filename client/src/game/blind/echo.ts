import {
  ECHO_CONFIG,
  castEcho,
  planEcho,
  summarizeEcho,
  visionSolids,
  type AcousticLevel,
  type Box,
  type EchoConfig,
  type EchoHit,
  type EchoPlan,
  type EchoSummary,
} from '@null-protocol/shared';
import { audio } from '../../audio/engine';
import { emit, type EchoDisplay } from '../bus';

/**
 * EcholocationController：主動回聲脈衝。
 *
 * 輸入：玩家位置與朝向、目前的碰撞盒（牆、道具、未開啟的門）、關卡的材質規則、設定（ECHO_CONFIG）。
 * 輸出：
 *   - 聲音：每道射線的第一個反射點用 HRTF 定位播放，近的先到、清楚；遠的較晚、較弱、較悶；
 *     材質決定音色；沒有反射的方向只有遠處微弱的空氣聲；殘響長度由平均自由路徑決定。
 *   - 畫面（回聲視野）：從玩家位置擴散的波照出範圍內的結構——牆、門、設備外形、地面網格、當下的隊友位置——
 *     全部反白，維持 holdMs 後淡出。只有幾何，沒有顏色、文字、燈號或任何謎題線索；牆會擋住牆後的東西。
 *   - 單聲道模式：另外用語音報出前／右／後／左最近的距離（立體聲時不報，保留探索與學習）。
 *
 * 限制：射線數、距離上限與冷卻時間來自設定；射線遇到第一個實體就停（不穿牆）；
 * 只在本機計算（使用與伺服器相同的公開碰撞資料），不會向伺服器索取任何隱藏資訊。
 */

export interface PulseResult {
  ok: boolean;
  reason?: 'cooldown' | 'jammed';
  hits?: EchoHit[];
  summary?: EchoSummary;
  plan?: EchoPlan;
}

const fmt = (d: number, range: number): string => (d >= range - 0.05 ? '開放' : `${(Math.round(d * 2) / 2).toString()} 公尺`);

/** 單聲道模式的語音摘要 */
export function monoSummary(s: EchoSummary, range = ECHO_CONFIG.range): string {
  return `前 ${fmt(s.front, range)}，右 ${fmt(s.right, range)}，後 ${fmt(s.back, range)}，左 ${fmt(s.left, range)}`;
}

export class EcholocationController {
  private readyAt = 0;
  private jammedUntil = 0;
  /** 冷卻結束時播一聲「準備好了」 */
  private announced = true;
  last: PulseResult | null = null;

  constructor(
    private readonly level: AcousticLevel,
    readonly cfg: EchoConfig = ECHO_CONFIG,
  ) {}

  /** 還要多久才能再發（毫秒） */
  cooldownLeft(now: number): number {
    return Math.max(0, this.readyAt - now);
  }

  jam(ms: number, now: number): void {
    this.jammedUntil = Math.max(this.jammedUntil, now + ms);
  }
  jammed(now: number): boolean {
    return now < this.jammedUntil;
  }

  /** 每一幀呼叫：冷卻結束時提示一聲 */
  update(now: number): void {
    if (!this.announced && now >= this.readyAt && !this.jammed(now)) {
      this.announced = true;
      audio.echoReady();
    }
  }

  pulse(
    x: number,
    z: number,
    yaw: number,
    boxes: readonly Box[],
    now: number,
    opts: { mono: boolean; speak?: (t: string) => void; bodies?: ReadonlyArray<readonly [number, number]> },
  ): PulseResult {
    if (this.jammed(now)) {
      audio.echoJammed();
      return (this.last = { ok: false, reason: 'jammed' });
    }
    if (now < this.readyAt) {
      audio.echoNotReady();
      return { ok: false, reason: 'cooldown' };
    }
    this.readyAt = now + this.cfg.cooldownMs;
    this.announced = false;
    const hits = castEcho(x, z, yaw, boxes, this.level.materialOf, this.cfg);
    const plan = planEcho(hits, this.cfg);
    const summary = summarizeEcho(hits, this.cfg.range);
    audio.echoPing();
    for (const v of plan.voices) audio.echoVoice(v);
    audio.echoTail(plan.tail, plan.tailGain);
    const display: EchoDisplay = {
      origin: [x, z],
      solids: visionSolids(boxes, x, z, this.cfg.range, this.level, opts.bodies),
      hits: hits.map((h) => ({ rel: h.rel, dist: h.dist, hit: h.hit, material: h.material })),
      range: this.cfg.range,
      waveSpeed: this.cfg.waveSpeed,
      holdMs: this.cfg.holdMs,
      fadeMs: this.cfg.fadeMs,
      cooldownMs: this.cfg.cooldownMs,
    };
    emit('echo', display);
    if (opts.mono) opts.speak?.(monoSummary(summary, this.cfg.range));
    return (this.last = { ok: true, hits, summary, plan });
  }

  /** 重設冷卻與干擾（重新開始遊戲、角色改變時） */
  reset(): void {
    this.readyAt = 0;
    this.jammedUntil = 0;
    this.announced = true;
    this.last = null;
  }
}
