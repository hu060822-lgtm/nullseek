import { DOOR_BOX_BY_ID, type DoorId } from '@null-protocol/shared';
import { audio } from '../audio/engine';

export function playDoor(id: DoorId, open: boolean): void {
  const b = DOOR_BOX_BY_ID[id];
  audio.door([(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2], open);
}
