import { DEVICES, DEVICE_BY_ID, PORTAL_BY_ID, PUZZLE_IDS, ZONES, ZONE_BY_ID, type PuzzleId, type ZoneId } from '@null-protocol/shared';

/** 房間編號（銘牌、面板標頭、牆上標示用），例如 R03；出口走廊為 EX */
export const roomCode = (id: ZoneId): string => (id === 'EXIT' ? 'EX' : `R${String(ZONE_BY_ID[id].index).padStart(2, '0')}`);

/** 設施內的設備編號，例如 R03-02 */
const CODES: Record<string, string> = {};
const counters: Partial<Record<ZoneId, number>> = {};
for (const d of DEVICES) {
  const n = (counters[d.zone] ?? 0) + 1;
  counters[d.zone] = n;
  CODES[d.id] = `${roomCode(d.zone)}-${String(n).padStart(2, '0')}`;
}

export const deviceCode = (id: string): string => CODES[id] ?? '—';

export const zoneLabel = (id: ZoneId): string => ZONES.find((z) => z.id === id)?.label ?? '';

/** 設備或門洞屬於哪一道謎題（每個房間一道） */
export function puzzleOf(targetId: string): PuzzleId {
  const zone = DEVICE_BY_ID[targetId]?.zone ?? PORTAL_BY_ID[targetId]?.zone ?? 'R1';
  return PUZZLE_IDS[ZONE_BY_ID[zone].index - 1] ?? PUZZLE_IDS[0];
}
