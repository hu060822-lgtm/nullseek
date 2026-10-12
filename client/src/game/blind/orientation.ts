import { headingOf, octantOf, type AcousticLevel } from '@null-protocol/shared';
import { audio } from '../../audio/engine';
import { referenceVent } from './presets';
import type { SpatialAudioManager } from './spatial';

/**
 * BlindOrientationController：穩定的方向基準。
 *
 * 輸入：每一幀的朝向（yaw，與移動、鏡頭、聽者同一個座標系）。
 * 輸出：
 *   1. 轉向提示音（不定位、單聲道也有效）：跨過每 45° 一聲輕響；轉到右翼／左翼、深處、入口時各有不同的音色。
 *   2. 方向參考音：每個房間一個固定位置的通風口氣流聲（只在同一個房間聽得到、隨距離衰減、不穿牆）。
 *      聽者轉身時由 audio.setListener 更新雙耳方位，所以玩家可以用它當作「固定在牆上的參考點」。
 *   3. 按 V 用語音報出目前朝向（「面向深處偏左翼」）。
 *
 * 方向提示只描述「玩家面向哪裡」，不會指出門、出口或任何目標的位置。
 */
export class BlindOrientationController {
  private lastOct: number | null = null;
  private lastYaw: number | null = null;
  private readonly ids: string[] = [];

  constructor(
    private readonly spatial: SpatialAudioManager,
    level: AcousticLevel,
  ) {
    for (const r of level.reference) {
      const id = `ref:${r.zone}`;
      this.ids.push(id);
      spatial.add({ id, zone: r.zone, pos: r.pos, y: r.y, gain: 0.07, loop: referenceVent });
    }
  }

  /** 每一幀呼叫 */
  update(yaw: number): void {
    const oct = octantOf(yaw);
    if (this.lastYaw === null || this.lastOct === null) {
      this.lastYaw = yaw;
      this.lastOct = oct;
      return;
    }
    // 一幀內轉了超過 60°＝伺服器傳送或重新出生：安靜地重新對齊，不連續發出提示音
    const jump = Math.abs(Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)));
    this.lastYaw = yaw;
    if (jump > Math.PI / 3) {
      this.lastOct = oct;
      return;
    }
    if (oct === this.lastOct) return;
    this.lastOct = oct;
    audio.headingTick(oct === 0 ? 'deep' : oct === 4 ? 'entry' : oct % 2 === 0 ? 'axis' : 'minor');
  }

  /** 語音報出朝向 */
  describe(yaw: number): string {
    return headingOf(yaw).spoken;
  }

  dispose(): void {
    for (const id of this.ids) this.spatial.remove(id);
  }
}
