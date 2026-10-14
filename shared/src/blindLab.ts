import type { AcousticLevel, AcousticMaterial } from './acoustics';
import type { Box } from './level';

/**
 * 盲區員測試關卡（?preview=blind-lab）：走廊、岔路、房門與目標物件。
 * 用來單獨驗證方向基準、主動回聲、聲學地標與回聲風險區；與正式關卡使用同一套模組，只換資料。
 *
 *   ┌───────────────┐
 *   │   目標房間     │
 *   │  [目標設備]  門├──────────┐
 *   │              │ ⊙感測器 櫃│   ← 岔路（往右是死巷，盡頭有木櫃）
 *   └──────────────┤ ┌─┐ ┌────┘
 *                  │走廊│
 *              ┌───┘    └───┐
 *              │    起點     │
 *              └─────────────┘
 *   （以「面向深處」時的視角畫：上方＝深處 +z，左邊＝左翼 +x，右邊＝右翼 -x）
 */

const T = 0.3;
const w = (id: string, minX: number, maxX: number, minZ: number, maxZ: number, kind: Box['kind'] = 'wall'): Box => ({ id, kind, minX, maxX, minZ, maxZ });

export const LAB_SPAWN = { x: 0, z: 1.5, yaw: Math.PI };

export const LAB_DOOR: Box = w('lab_door', 7, 7 + T, 15, 17.5, 'door');
export const LAB_TARGET: Box = w('lab_target', 12.45, 13.3, 15.45, 17.05, 'prop');
export const LAB_CABINET: Box = w('lab_cabinet', -7, -6.2, 15.6, 16.9, 'prop');
export const LAB_TARGET_POS: [number, number] = [12.85, 16.25];
export const LAB_DOOR_POS: [number, number] = [7.15, 16.25];

export const LAB_WALLS: readonly Box[] = [
  // 起點房間
  w('s_south', -3 - T, 3 + T, -T, 0),
  w('s_west', -3 - T, -3, 0, 6),
  w('s_east', 3, 3 + T, 0, 6),
  w('s_north_l', -3 - T, -1, 6, 6 + T),
  w('s_north_r', 1, 3 + T, 6, 6 + T),
  // 走廊
  w('h_west', -1 - T, -1, 6 + T, 15),
  w('h_east', 1, 1 + T, 6 + T, 15),
  // 岔路（T 字）
  w('f_south_l', -7 - T, -1, 15 - T, 15),
  w('f_south_r', 1, 7, 15 - T, 15),
  w('f_north', -7 - T, 7, 17.5, 17.5 + T),
  w('f_end', -7 - T, -7, 15, 17.5),
  // 目標房間
  w('t_west_s', 7, 7 + T, 12 - T, 15),
  w('t_west_n', 7, 7 + T, 17.5, 20.5 + T),
  w('t_south', 7, 13.3 + T, 12 - T, 12),
  w('t_north', 7, 13.3 + T, 20.5, 20.5 + T),
  w('t_east', 13.3, 13.3 + T, 12 - T, 20.5 + T),
];

export function labColliders(doorOpen: boolean): Box[] {
  return [...LAB_WALLS, LAB_TARGET, LAB_CABINET, ...(doorOpen ? [] : [LAB_DOOR])];
}

const LAB_MATERIALS: Record<string, AcousticMaterial> = { lab_door: 'metal', lab_target: 'machine', lab_cabinet: 'wood' };

export const BLIND_LAB: AcousticLevel = {
  id: 'blind-lab',
  zones: [
    { id: 'LAB_START', label: '起點房間', rect: { minX: -3, maxX: 3, minZ: 0, maxZ: 6 } },
    { id: 'LAB_HALL', label: '走廊', rect: { minX: -1, maxX: 1, minZ: 6, maxZ: 15 } },
    { id: 'LAB_FORK', label: '岔路', rect: { minX: -7, maxX: 7, minZ: 15, maxZ: 17.5 } },
    { id: 'LAB_TARGET', label: '目標房間', rect: { minX: 7.3, maxX: 13.3, minZ: 12, maxZ: 20.5 } },
  ],
  openings: [
    { id: 'o_start_hall', a: 'LAB_START', b: 'LAB_HALL', at: [0, 6.15] },
    { id: 'o_hall_fork', a: 'LAB_HALL', b: 'LAB_FORK', at: [0, 15] },
    { id: 'o_fork_target', a: 'LAB_FORK', b: 'LAB_TARGET', at: LAB_DOOR_POS, door: 'lab_door' },
  ],
  // 與第一章相同的規則：參考音在右翼牆（-x）
  reference: [
    { zone: 'LAB_START', pos: [-2.75, 2.5], y: 2.8 },
    { zone: 'LAB_HALL', pos: [-0.85, 9], y: 2.8 },
    { zone: 'LAB_FORK', pos: [-6.8, 16.25], y: 2.8 },
    { zone: 'LAB_TARGET', pos: [7.55, 13.2], y: 2.8 },
  ],
  landmarks: [
    { id: 'lab_drip', label: '岔路死巷的漏水', zone: 'LAB_FORK', pos: [-6.4, 15.3], y: 0.2, sound: 'drip', periodMs: 1600 },
    { id: 'lab_pipe', label: '走廊牆內的管線敲擊', zone: 'LAB_HALL', pos: [0.9, 12], y: 2.2, sound: 'pipe', periodMs: 6000 },
    {
      id: 'lab_buzz',
      label: '目標房間的電流聲（門開著時岔路也聽得到）',
      zone: 'LAB_TARGET',
      pos: [12.6, 19.6],
      y: 2.8,
      sound: 'buzz',
      periodMs: 3000,
      audibleFrom: ['LAB_FORK'],
    },
  ],
  risks: [
    { id: 'lab_sensor', label: '岔路中央的聲學感測器', zone: 'LAB_FORK', pos: [0, 16.25], radius: 2.2, idleMs: 6000, warnMs: 1500, armedMs: 4000, jamMs: 5000 },
  ],
  muffle: { gain: 0.28, cutoff: 650 },
  materialOf: (b) => LAB_MATERIALS[b.id] ?? (b.kind === 'door' ? 'metal' : b.kind === 'prop' ? 'machine' : 'concrete'),
  // 門楣（門打開後仍然存在）
  vision: [{ kind: 'wall', minX: 7, maxX: 7 + T, minZ: 15, maxZ: 17.5, minY: 2.6, maxY: 3.2 }],
  propHeight: (b) => (b.id === 'lab_cabinet' ? 1.8 : 1.1),
};
