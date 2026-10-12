import { riskPhase, type AcousticLevel, type RiskState, type RiskStatus, type RiskZoneDef } from '@null-protocol/shared';
import { sensorArmed, sensorWarn } from './presets';
import type { SpatialAudioManager } from './spatial';

/**
 * EchoRiskMonitor：回聲風險區的客戶端部分（只負責「聽得到的預警」與顯示用的狀態）。
 *
 * 真正的偵測由伺服器判定（伺服器用自己記錄的位置與時間，見 server/src/rooms/room.ts 的 echoPulse）；
 * 客戶端只是把伺服器送來的狀態轉成聲音：
 *   預警（warning）＝每 0.5 秒一聲上升的啁啾；警戒（armed）＝快速的滴答；休息（idle）＝安靜。
 * 測試關卡沒有伺服器，使用 simulate 以同一個 riskPhase 規則在本機計算。
 */
export class EchoRiskMonitor {
  private status = new Map<string, { state: RiskState; until: number }>();
  private readonly ids: string[] = [];
  private epoch: number | null = null;

  constructor(
    private readonly spatial: SpatialAudioManager,
    private readonly level: AcousticLevel,
    private readonly clock: () => number = () => performance.now(),
  ) {
    for (const r of level.risks) {
      const id = `risk:${r.id}`;
      this.ids.push(id);
      spatial.add({
        id,
        zone: r.zone,
        pos: r.pos,
        y: 3.0,
        gain: 0.14,
        enabled: () => this.stateOf(r.id) !== 'idle',
        period: () => (this.stateOf(r.id) === 'armed' ? 300 : 500),
        fire: (dest) => (this.stateOf(r.id) === 'armed' ? sensorArmed(dest) : sensorWarn(dest)),
      });
    }
  }

  /** 在本機模擬週期（測試關卡用） */
  simulate(epoch = this.clock()): void {
    this.epoch = epoch;
  }

  /** 伺服器送來的狀態 */
  setStatus(list: readonly RiskStatus[]): void {
    const now = this.clock();
    for (const s of list) this.status.set(s.id, { state: s.state, until: now + s.msLeft });
  }

  stateOf(id: string): RiskState {
    const def = this.level.risks.find((r) => r.id === id);
    if (!def) return 'idle';
    if (this.epoch !== null) return riskPhase(def, this.clock() - this.epoch).state;
    return this.status.get(id)?.state ?? 'idle';
  }

  /** 玩家所在的風險區（不論狀態） */
  zoneAt(x: number, z: number): RiskZoneDef | null {
    return this.level.risks.find((r) => Math.hypot(x - r.pos[0], z - r.pos[1]) <= r.radius) ?? null;
  }

  /** 此刻在這個位置發出回聲會被偵測到的感測器（本機判定；正式關卡以伺服器為準） */
  dangerAt(x: number, z: number): RiskZoneDef | null {
    const r = this.zoneAt(x, z);
    return r && this.stateOf(r.id) === 'armed' ? r : null;
  }

  dispose(): void {
    for (const id of this.ids) this.spatial.remove(id);
    this.status.clear();
  }
}
