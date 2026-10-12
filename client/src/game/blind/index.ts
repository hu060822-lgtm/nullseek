import { zoneOfPoint, type AcousticLevel, type Box } from '@null-protocol/shared';
import { audio } from '../../audio/engine';
import { EcholocationController, type PulseResult } from './echo';
import { AcousticLandmarkManager } from './landmarks';
import { BlindOrientationController } from './orientation';
import { EchoRiskMonitor } from './risk';
import { SpatialAudioManager } from './spatial';

export { EcholocationController, monoSummary, type PulseResult } from './echo';
export { SpatialAudioManager } from './spatial';

export interface BlindAudioOptions {
  level: AcousticLevel;
  /** 盲區員專用的能力（回聲、轉向提示）。其他聽得見的角色只有環境聲源（參考音、地標、感測器） */
  blind: boolean;
  isOpen: (door: string) => boolean;
  speak: (text: string) => void;
}

/**
 * 盲區員的空間感知系統（組合四個模組）。正式關卡（loop.ts）與測試關卡（BlindLab）都使用它，只換關卡資料。
 * 角色改變、離開遊戲或重新載入時呼叫 dispose()，所有聲源與能力一起移除，不會殘留。
 */
export class BlindAudioSystem {
  readonly spatial: SpatialAudioManager;
  readonly orientation: BlindOrientationController | null;
  readonly echo: EcholocationController | null;
  readonly landmarks: AcousticLandmarkManager;
  readonly risk: EchoRiskMonitor;
  zone: string | null = null;

  constructor(private readonly opts: BlindAudioOptions) {
    this.spatial = new SpatialAudioManager(opts.level);
    this.orientation = opts.blind ? new BlindOrientationController(this.spatial, opts.level) : null;
    this.echo = opts.blind ? new EcholocationController(opts.level) : null;
    this.landmarks = new AcousticLandmarkManager(this.spatial, opts.level, opts.isOpen);
    this.risk = new EchoRiskMonitor(this.spatial, opts.level);
  }

  update(x: number, z: number, yaw: number, now: number): void {
    this.zone = zoneOfPoint(this.opts.level, x, z);
    this.orientation?.update(yaw);
    this.spatial.update(this.zone, this.opts.isOpen, now);
  }

  /** 發出回聲（只有盲區員）；回傳 null＝這個角色沒有回聲能力 */
  pulse(x: number, z: number, yaw: number, boxes: readonly Box[], now: number): PulseResult | null {
    if (!this.echo) return null;
    return this.echo.pulse(x, z, yaw, boxes, now, { mono: audio.isMono(), speak: this.opts.speak });
  }

  speakHeading(yaw: number): void {
    if (this.orientation) this.opts.speak(this.orientation.describe(yaw));
  }

  /** 感測器偵測到回聲：警報（聽得見的人都聽到），盲區員的回聲被干擾一段時間 */
  tripped(id: string, jamMs: number, now: number): void {
    const r = this.opts.level.risks.find((q) => q.id === id);
    if (r) audio.alarm(r.pos);
    this.echo?.jam(jamMs, now);
  }

  dispose(): void {
    this.orientation?.dispose();
    this.landmarks.dispose();
    this.risk.dispose();
    this.spatial.dispose();
    this.echo?.reset();
  }
}
