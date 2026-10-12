import type { AcousticLevel } from '@null-protocol/shared';
import { landmarkSound } from './presets';
import type { SpatialAudioManager } from './spatial';

/**
 * AcousticLandmarkManager：依關卡資料（level.landmarks）建立聲學地標。
 *
 * 每個地標有：位置、聲音種類（vent／buzz／drip／pipe／alarm／hum）、週期、播放條件（whenDoorOpen）、
 * 遮蔽規則（audibleFrom）。遮蔽與定位交給 SpatialAudioManager。
 * 地標是公開的環境聲音：聽得見的角色（盲區員、失語員）都聽得到；靜默員的客戶端根本不建立音訊。
 * 地標不會被轉成任何畫面上的地圖或標記。
 */
export class AcousticLandmarkManager {
  private readonly ids: string[] = [];

  constructor(
    private readonly spatial: SpatialAudioManager,
    level: AcousticLevel,
    isOpen: (door: string) => boolean,
  ) {
    for (const lm of level.landmarks) {
      const { loop, fire } = landmarkSound(lm.sound);
      const id = `lm:${lm.id}`;
      this.ids.push(id);
      const period = lm.periodMs ?? 0;
      spatial.add({
        id,
        zone: lm.zone,
        pos: lm.pos,
        y: lm.y,
        audibleFrom: lm.audibleFrom,
        gain: 0.16 * (lm.gain ?? 1),
        loop,
        fire: period ? fire : undefined,
        period: period ? () => period : undefined,
        enabled: lm.whenDoorOpen ? () => isOpen(lm.whenDoorOpen!) : undefined,
      });
    }
  }

  dispose(): void {
    for (const id of this.ids) this.spatial.remove(id);
  }
}
