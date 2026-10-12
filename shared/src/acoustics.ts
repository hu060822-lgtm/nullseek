import {
  DEVICE_BY_ID,
  DOOR_SLOTS,
  ROOM_COUNT,
  ROOM_HALF_W,
  ZONES,
  forwardOf,
  roomRect,
  wallZ,
  type Box,
  type Rect,
} from './level';

/**
 * 盲區員的空間感知：聲學資料格式與純函式計算（伺服器、客戶端、測試共用）。
 *
 * 這個檔案只描述「聲音世界的規則」，不碰 Web Audio：
 *   - 方向基準：設施方位（headingOf）與每個房間的參考音（通風口）
 *   - 主動回聲：射線、材質、延遲與殘響的計算（castEcho → planEcho）
 *   - 聲學地標：位置、聲音種類、播放條件與遮蔽規則
 *   - 回聲風險區：感測器的週期（伺服器權威判定）
 *
 * 關卡設計者只需要編輯 AcousticLevel 資料（見 CHAPTER1_ACOUSTICS 與 BLIND_LAB），
 * 不必修改角色控制器或音訊元件。格式說明見 docs/BLIND_NAVIGATION.md。
 */

/* ------------------------------------------------------------------ */
/* 方向基準                                                            */
/* ------------------------------------------------------------------ */

/**
 * 設施方位（與移動、鏡頭、聽者朝向同一個座標系）：
 *   0°＝面向深處（+z，設施的前進方向）、90°＝面向右翼（-x）、180°＝面向入口（-z）、270°＝面向左翼（+x）。
 * 「右翼／左翼」以面向深處時的左右命名，所以不會隨玩家轉身而改變。
 */
export function bearingOf(yaw: number): number {
  const [fx, fz] = forwardOf(yaw);
  const deg = (Math.atan2(-fx, fz) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

export const HEADING_LABELS = ['深處', '深處偏右翼', '右翼', '入口偏右翼', '入口', '入口偏左翼', '左翼', '深處偏左翼'] as const;

/** 朝向所在的八分位（0＝深處，順時針） */
export const octantOf = (yaw: number): number => Math.round(bearingOf(yaw) / 45) % 8;

export function headingOf(yaw: number): { bearing: number; octant: number; label: string; spoken: string } {
  const bearing = bearingOf(yaw);
  const octant = Math.round(bearing / 45) % 8;
  const label = HEADING_LABELS[octant];
  return { bearing, octant, label, spoken: `面向${label}` };
}

/**
 * 聲源相對於聽者的方位角（度）：0＝正前方、+90＝右邊、±180＝正後方。
 * 與 Web Audio 的 PannerNode 計算方式一致（聽者 forward＝forwardOf(yaw)、up＝+y、right＝forward×up）。
 */
export function relativeAzimuth(lx: number, lz: number, yaw: number, sx: number, sz: number): number {
  const [fx, fz] = forwardOf(yaw);
  const rx = -fz;
  const rz = fx;
  const vx = sx - lx;
  const vz = sz - lz;
  const front = vx * fx + vz * fz;
  const right = vx * rx + vz * rz;
  return (Math.atan2(right, front) * 180) / Math.PI;
}

/* ------------------------------------------------------------------ */
/* 材質                                                                */
/* ------------------------------------------------------------------ */

export type AcousticMaterial = 'concrete' | 'metal' | 'machine' | 'wood';

export interface MaterialVoice {
  label: string;
  /** 音色：noise＝寬頻的「嚓」、ring＝金屬的「叮」（兩個不和諧泛音）、buzz＝設備的「嗡」、knock＝木頭的「咚」 */
  voice: 'noise' | 'ring' | 'buzz' | 'knock';
  /** 主要頻率（Hz） */
  freq: number;
  /** 回聲本身的長度（秒） */
  ring: number;
  /** 相對音量 */
  gain: number;
}

export const MATERIALS: Record<AcousticMaterial, MaterialVoice> = {
  concrete: { label: '混凝土牆', voice: 'noise', freq: 1700, ring: 0.05, gain: 1 },
  metal: { label: '金屬門', voice: 'ring', freq: 2350, ring: 0.17, gain: 0.8 },
  machine: { label: '設備外殼', voice: 'buzz', freq: 620, ring: 0.08, gain: 0.85 },
  wood: { label: '木桌／文件櫃', voice: 'knock', freq: 470, ring: 0.06, gain: 0.95 },
};

/* ------------------------------------------------------------------ */
/* 主動回聲                                                            */
/* ------------------------------------------------------------------ */

export interface EchoConfig {
  /** 射線數（平均分布在 360°，第 0 道朝正前方） */
  rays: number;
  /** 最大偵測距離（公尺） */
  range: number;
  /** 冷卻時間（毫秒） */
  cooldownMs: number;
  /** 盲區員畫面上的短暫輪廓持續多久（毫秒） */
  displayMs: number;
  /** 發出脈衝到最近回聲的基本延遲（秒） */
  baseDelay: number;
  /** 每公尺增加的延遲（秒）。真實聲速下差異只有幾毫秒，這裡放大到人耳分辨得出的程度 */
  delayPerMeter: number;
  /** 距離造成的衰減：gain = 1 / (1 + d × falloff) */
  falloff: number;
  /** 最近距離的低通截止頻率（Hz）；越遠越悶：cutoff / (1 + d × darken) */
  brightHz: number;
  darken: number;
  /** 殘響長度＝reverbBase + 平均自由路徑 × reverbPerMeter（秒） */
  reverbBase: number;
  reverbPerMeter: number;
}

export const ECHO_CONFIG: EchoConfig = {
  rays: 16,
  range: 8,
  cooldownMs: 1100,
  displayMs: 1800,
  baseDelay: 0.06,
  delayPerMeter: 0.034,
  falloff: 0.42,
  brightHz: 9000,
  darken: 0.55,
  reverbBase: 0.18,
  reverbPerMeter: 0.13,
};

export interface EchoHit {
  index: number;
  /** 相對於玩家正前方的角度（弧度；正值＝往右） */
  rel: number;
  /** 反射距離；沒有反射時等於 range */
  dist: number;
  hit: boolean;
  /** 反射點（世界座標）；沒有反射時是最大距離處 */
  x: number;
  z: number;
  material: AcousticMaterial | null;
  boxId: string | null;
}

/** 射線與軸對齊方塊的交點距離（slab 法）；不相交回傳 null */
export function rayBox(ox: number, oz: number, ux: number, uz: number, b: Rect, maxDist: number): number | null {
  let t0 = 0;
  let t1 = maxDist;
  if (Math.abs(ux) < 1e-9) {
    if (ox < b.minX || ox > b.maxX) return null;
  } else {
    let a = (b.minX - ox) / ux;
    let c = (b.maxX - ox) / ux;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  if (Math.abs(uz) < 1e-9) {
    if (oz < b.minZ || oz > b.maxZ) return null;
  } else {
    let a = (b.minZ - oz) / uz;
    let c = (b.maxZ - oz) / uz;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t0;
}

/** 只留下脈衝範圍內的碰撞盒（每次脈衝只測試附近的十幾個方塊，而不是整個關卡） */
export function boxesNear(x: number, z: number, range: number, boxes: readonly Box[]): Box[] {
  return boxes.filter((b) => b.maxX >= x - range && b.minX <= x + range && b.maxZ >= z - range && b.minZ <= z + range);
}

/**
 * 發出一次回聲脈衝：從玩家位置往四周射出 cfg.rays 道射線，回傳每道射線的第一個反射。
 * 射線遇到第一個實體就停止（不穿牆）；開著的門沒有碰撞盒，所以射線會穿過門洞繼續前進。
 */
export function castEcho(
  ox: number,
  oz: number,
  yaw: number,
  boxes: readonly Box[],
  materialOf: (b: Box) => AcousticMaterial,
  cfg: Pick<EchoConfig, 'rays' | 'range'> = ECHO_CONFIG,
): EchoHit[] {
  const near = boxesNear(ox, oz, cfg.range, boxes);
  const out: EchoHit[] = [];
  for (let i = 0; i < cfg.rays; i++) {
    let rel = (i / cfg.rays) * Math.PI * 2;
    if (rel > Math.PI) rel -= Math.PI * 2;
    // 往右轉＝yaw 減少
    const [ux, uz] = forwardOf(yaw - rel);
    let best = cfg.range;
    let box: Box | null = null;
    for (const b of near) {
      const t = rayBox(ox, oz, ux, uz, b, best);
      if (t !== null && t < best) {
        best = t;
        box = b;
      }
    }
    out.push({
      index: i,
      rel,
      dist: best,
      hit: !!box,
      x: ox + ux * best,
      z: oz + uz * best,
      material: box ? materialOf(box) : null,
      boxId: box?.id ?? null,
    });
  }
  return out;
}

export interface EchoSummary {
  /** 四個扇區（各 90°）最近的反射距離；沒有反射＝range */
  front: number;
  right: number;
  back: number;
  left: number;
  /** 平均自由路徑（沒有反射的方向以 range 計算） */
  meanFree: number;
  /** 沒有反射（空間延伸超過偵測距離）的射線比例 */
  openRatio: number;
}

export function summarizeEcho(hits: readonly EchoHit[], range = ECHO_CONFIG.range): EchoSummary {
  const s = { front: range, right: range, back: range, left: range };
  let sum = 0;
  let open = 0;
  for (const h of hits) {
    sum += h.dist;
    if (!h.hit) open++;
    if (!h.hit) continue;
    const deg = (h.rel * 180) / Math.PI;
    const sector: keyof typeof s = Math.abs(deg) <= 45 ? 'front' : Math.abs(deg) >= 135 ? 'back' : deg > 0 ? 'right' : 'left';
    s[sector] = Math.min(s[sector], h.dist);
  }
  return { ...s, meanFree: hits.length ? sum / hits.length : range, openRatio: hits.length ? open / hits.length : 1 };
}

/** 一次回聲的「播放計畫」：每個反射何時、多大聲、多亮，以及殘響長度。純函式，規則一致、可測試 */
export interface EchoVoice {
  kind: 'return' | 'open';
  index: number;
  x: number;
  z: number;
  dist: number;
  material: AcousticMaterial | null;
  /** 從脈衝開始的延遲（秒） */
  at: number;
  gain: number;
  /** 低通截止頻率（Hz） */
  cutoff: number;
}

export interface EchoPlan {
  voices: EchoVoice[];
  /** 殘響長度（秒）：空間越開放越長 */
  tail: number;
  tailGain: number;
}

export function planEcho(hits: readonly EchoHit[], cfg: EchoConfig = ECHO_CONFIG): EchoPlan {
  const voices: EchoVoice[] = [];
  for (const h of hits) {
    const at = cfg.baseDelay + h.dist * cfg.delayPerMeter;
    if (h.hit && h.material) {
      voices.push({
        kind: 'return',
        index: h.index,
        x: h.x,
        z: h.z,
        dist: h.dist,
        material: h.material,
        at,
        gain: (MATERIALS[h.material].gain * 0.26) / (1 + h.dist * cfg.falloff),
        cutoff: cfg.brightHz / (1 + h.dist * cfg.darken),
      });
    } else {
      // 沒有反射的方向：最遠處一點點「空氣聲」，讓開口聽起來是「有東西延伸出去」，而不只是一片沉默
      voices.push({ kind: 'open', index: h.index, x: h.x, z: h.z, dist: h.dist, material: null, at, gain: 0.025, cutoff: 900 });
    }
  }
  const s = summarizeEcho(hits, cfg.range);
  return { voices, tail: cfg.reverbBase + s.meanFree * cfg.reverbPerMeter, tailGain: 0.035 + s.openRatio * 0.03 };
}

/* ------------------------------------------------------------------ */
/* 聲學關卡資料                                                         */
/* ------------------------------------------------------------------ */

export interface AcousticZone {
  id: string;
  label: string;
  rect: Rect;
}

/** 兩個區域之間的開口；door 沒有指定＝永遠暢通（例如沒有門的通道） */
export interface AcousticOpening {
  id: string;
  a: string;
  b: string;
  /** 開口中心 [x, z] */
  at: [number, number];
  door?: string;
}

/** 方向參考音：每個區域一個固定位置的低音量聲源（只在同一個區域內聽得到） */
export interface ReferenceSource {
  zone: string;
  pos: [number, number];
  /** 高度（公尺） */
  y: number;
}

export type LandmarkSound = 'vent' | 'buzz' | 'drip' | 'pipe' | 'alarm' | 'hum';

export interface LandmarkDef {
  /** 穩定的識別碼：謎題或文件可以用它指稱這個地標 */
  id: string;
  /** 給關卡設計者與文件看的名稱（不會在遊戲中顯示或播報） */
  label: string;
  zone: string;
  pos: [number, number];
  y: number;
  sound: LandmarkSound;
  /** 週期性聲音的間隔（毫秒）；持續音可省略 */
  periodMs?: number;
  /** 音量倍率（1＝預設） */
  gain?: number;
  /** 播放條件：指定的門開著才播放（例如門後的機房） */
  whenDoorOpen?: string;
  /**
   * 遮蔽規則：預設只有同一個區域聽得到。列在這裡的相鄰區域，在連接的開口暢通時可以聽到
   * 「從開口傳過來」的悶聲（低通、較小聲，方位在開口上）。牆壁永遠完全遮蔽。
   */
  audibleFrom?: string[];
}

export interface RiskZoneDef {
  id: string;
  /** 給文件與看得見的人看的名稱 */
  label: string;
  zone: string;
  /** 感測器位置 [x, z] */
  pos: [number, number];
  /** 偵測半徑（公尺）：在這個範圍內、警戒中發出回聲才會被偵測 */
  radius: number;
  /** 休息、預警、警戒的時間（毫秒）；預警屬於休息時間的最後一段 */
  idleMs: number;
  warnMs: number;
  armedMs: number;
  /** 被偵測後回聲受到干擾的時間（毫秒） */
  jamMs: number;
}

export interface AcousticLevel {
  id: string;
  zones: AcousticZone[];
  openings: AcousticOpening[];
  reference: ReferenceSource[];
  landmarks: LandmarkDef[];
  risks: RiskZoneDef[];
  /** 從開口傳過來的悶聲：音量倍率與低通頻率 */
  muffle: { gain: number; cutoff: number };
  materialOf: (b: Box) => AcousticMaterial;
}

export function zoneOfPoint(level: AcousticLevel, x: number, z: number): string | null {
  for (const zn of level.zones) {
    const r = zn.rect;
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return zn.id;
  }
  return null;
}

export type Audibility = { mode: 'direct'; pos: [number, number] } | { mode: 'muffled'; pos: [number, number] } | { mode: 'none' };

/**
 * 遮蔽規則：同一個區域＝直接聽到；列在 audibleFrom 的相鄰區域＝開口暢通時從開口聽到悶聲；其餘＝聽不到。
 * isOpen(doorId) 由呼叫端提供目前門的狀態（伺服器同步的 world.doors）。
 */
export function audibility(
  level: AcousticLevel,
  src: { zone: string; pos: [number, number]; audibleFrom?: string[] },
  listenerZone: string | null,
  isOpen: (door: string) => boolean,
): Audibility {
  if (!listenerZone) return { mode: 'none' };
  if (listenerZone === src.zone) return { mode: 'direct', pos: src.pos };
  if (!src.audibleFrom?.includes(listenerZone)) return { mode: 'none' };
  const gap = level.openings.find(
    (o) => ((o.a === src.zone && o.b === listenerZone) || (o.b === src.zone && o.a === listenerZone)) && (!o.door || isOpen(o.door)),
  );
  return gap ? { mode: 'muffled', pos: gap.at } : { mode: 'none' };
}

/* ------------------------------------------------------------------ */
/* 回聲風險區（伺服器權威）                                              */
/* ------------------------------------------------------------------ */

export type RiskState = 'idle' | 'warning' | 'armed';

/** 從計時起點經過 tMs 後，感測器的狀態與距離下一次改變的毫秒數。週期：休息（最後 warnMs 為預警）→ 警戒 */
export function riskPhase(def: RiskZoneDef, tMs: number): { state: RiskState; msLeft: number } {
  const cycle = def.idleMs + def.armedMs;
  const p = ((tMs % cycle) + cycle) % cycle;
  if (p < def.idleMs - def.warnMs) return { state: 'idle', msLeft: def.idleMs - def.warnMs - p };
  if (p < def.idleMs) return { state: 'warning', msLeft: def.idleMs - p };
  return { state: 'armed', msLeft: cycle - p };
}

export interface RiskStatus {
  id: string;
  state: RiskState;
  /** 這個狀態還剩多久（毫秒） */
  msLeft: number;
}

/* ------------------------------------------------------------------ */
/* 第一章的聲學資料                                                     */
/* ------------------------------------------------------------------ */

/** 第一章的材質：牆＝混凝土；門（含永遠關閉的假門）＝金屬；設備＝設備外殼；文件類＝木頭 */
export function chapterMaterial(b: Box): AcousticMaterial {
  if (b.kind === 'door') return 'metal';
  if (b.kind === 'prop') {
    const d = DEVICE_BY_ID[b.id.replace(/^prop_/, '')];
    return d?.kind === 'document' ? 'wood' : 'machine';
  }
  return 'concrete';
}

const rr = (i: number) => roomRect(i);
const midZ = (i: number) => (rr(i).minZ + rr(i).maxZ) / 2;

/**
 * 參考音（通風口）的位置規則：每個房間都在「右翼牆（-x）的高處、離入口那面牆 2.5 m」。
 * 規則固定，玩家學會一次就能在每個房間使用；位置刻意避開所有門與門洞（測試會檢查距離至少 2 m）。
 */
const VENT = (i: number): ReferenceSource => ({ zone: `R${i}`, pos: [-ROOM_HALF_W + 0.25, rr(i).minZ + 2.5], y: 2.8 });

export const CHAPTER1_ACOUSTICS: AcousticLevel = {
  id: 'chapter01',
  zones: ZONES.map((z) => ({ id: z.id, label: z.label, rect: { minX: z.minX, maxX: z.maxX, minZ: z.minZ, maxZ: z.maxZ } })),
  // 房間之間的門（第 k 道牆連接 R k 與 R k+1；第 10 道牆連接 R10 與出口走廊）。R2 的假門永遠關閉，不是開口
  openings: DOOR_SLOTS.filter((s) => s.doorId).map((s) => ({
    id: s.id,
    a: `R${s.wall}`,
    b: s.wall >= ROOM_COUNT ? 'EXIT' : `R${s.wall + 1}`,
    at: [s.x, wallZ(s.wall) + 0.2] as [number, number],
    door: s.doorId,
  })),
  reference: Array.from({ length: ROOM_COUNT }, (_, k) => VENT(k + 1)),
  // R4（無窗迷宮）刻意沒有地標：每個節點必須聽起來完全相同，才不會繞過 P04 的設計
  landmarks: [
    { id: 'r1_ballast', label: '入口訊號室：故障的日光燈安定器（間歇電流聲）', zone: 'R1', pos: [4.6, rr(1).minZ + 1.6], y: 3.0, sound: 'buzz', periodMs: 3800 },
    { id: 'r2_drip', label: '四門走廊：右翼角落的漏水', zone: 'R2', pos: [-5.2, rr(2).minZ + 1.4], y: 0.2, sound: 'drip', periodMs: 1700 },
    {
      id: 'r3_pipe',
      label: '檔案室：左翼牆內的金屬管線（週期性三連敲擊，門開著時隔壁也聽得到）',
      zone: 'R3',
      pos: [5.7, rr(3).minZ + 8],
      y: 2.2,
      sound: 'pipe',
      periodMs: 7000,
      audibleFrom: ['R2'],
    },
    { id: 'r5_transformer', label: '協定室：變壓器低鳴', zone: 'R5', pos: [5.4, rr(5).minZ + 1.6], y: 0.6, sound: 'hum' },
    { id: 'r6_fan', label: '訊號分析室：排風扇', zone: 'R6', pos: [-4, rr(6).minZ + 8.2], y: 3.0, sound: 'vent' },
    { id: 'r7_status', label: '中央控制室：狀態提示器（固定節奏的雙響）', zone: 'R7', pos: [-5.5, rr(7).minZ + 8.6], y: 2.4, sound: 'alarm', periodMs: 4200 },
    { id: 'r9_rumble', label: '循環走廊：管道低頻震動', zone: 'R9', pos: [5.5, midZ(9)], y: 2.6, sound: 'hum', gain: 0.8 },
    {
      id: 'r10_core',
      label: '設施核心：核心的脈動（門開著時出口走廊也聽得到）',
      zone: 'R10',
      pos: [3.5, rr(10).minZ + 6],
      y: 1.2,
      sound: 'hum',
      gain: 1.2,
      audibleFrom: ['EXIT'],
    },
  ],
  risks: [
    {
      id: 'r8_sensor',
      label: '校準實驗室：天花板的聲學感測器',
      zone: 'R8',
      pos: [0, midZ(8)],
      radius: 3,
      idleMs: 7000,
      warnMs: 1500,
      armedMs: 5000,
      jamMs: 8000,
    },
  ],
  muffle: { gain: 0.28, cutoff: 650 },
  materialOf: chapterMaterial,
};
