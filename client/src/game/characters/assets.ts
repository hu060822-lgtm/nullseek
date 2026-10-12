import {
  AnimationClip,
  Bone,
  PropertyBinding,
  LinearMipmapLinearFilter,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  SRGBColorSpace,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Role } from '@null-protocol/shared';

/**
 * 角色資產：模型、骨架、動畫庫的載入與驗證。
 *
 * - 三名角色各一個 GLB（蒙皮網格＋骨架），動畫放在共用的動畫庫 GLB；兩者以骨骼名稱對應。
 * - 正式模型的匯入介面：在 manifest.json 的 overrides 指定某個角色的 GLB 與骨骼名稱對照表（boneMap）。
 *   載入時檢查必要骨骼是否齊全；不齊全或載入失敗就退回程式產生的模型，再不行就退回最簡單的備用人形。
 * - 動畫只保留旋轉軌與 hips 的位移軌，讓不同比例的模型也能共用同一組動畫（前提：靜止姿勢相近，見 docs/CHARACTERS.md）。
 */

export interface ModelOverride {
  /** 相對於 models/ 的 GLB 路徑 */
  model: string;
  /** 外部骨骼名稱 → 本專案骨骼名稱，例如 { "mixamorig:Hips": "hips" } */
  boneMap?: Record<string, string>;
  /** 外部模型自帶的動畫名稱 → 本專案動畫名稱；沒有就使用共用動畫庫 */
  clipMap?: Record<string, string>;
  scale?: number;
  /** 模型正面不是 +Z 時的修正（弧度） */
  yaw?: number;
}

export interface CrewManifest {
  version: number;
  animations: string;
  bones: string[];
  requiredClips: string[];
  roles: Record<Role, { model: string; height: number }>;
  overrides: Partial<Record<Role, ModelOverride>>;
}

export interface CrewAsset {
  role: Role;
  /** 範本；每個實例用 SkeletonUtils.clone 複製（材質共用、骨架各自獨立） */
  template: Object3D;
  clips: Map<string, AnimationClip>;
  scale: number;
  yaw: number;
  source: 'override' | 'generated';
  warnings: string[];
}

const BASE = `${import.meta.env.BASE_URL ?? '/'}models/`;

/** manifest 讀不到時的預設值（與 tools/characters/build_crew.py 的輸出一致） */
const DEFAULT_MANIFEST: CrewManifest = {
  version: 1,
  animations: 'crew_anims.glb',
  bones: [
    'hips', 'spine', 'chest', 'neck', 'head',
    'shoulder_L', 'upperArm_L', 'lowerArm_L', 'hand_L', 'upperLeg_L', 'lowerLeg_L', 'foot_L',
    'shoulder_R', 'upperArm_R', 'lowerArm_R', 'hand_R', 'upperLeg_R', 'lowerLeg_R', 'foot_R',
  ],
  requiredClips: ['Idle', 'Walk', 'Run', 'StartMoving', 'StopMoving', 'Turn', 'Crouch', 'Interact', 'Inspect', 'Hurt', 'Death'],
  roles: {
    BLIND: { model: 'crew_blind.glb', height: 1.79 },
    DEAF: { model: 'crew_deaf.glb', height: 1.79 },
    MUTE: { model: 'crew_mute.glb', height: 1.79 },
  },
  overrides: {},
};

const loader = new GLTFLoader();
const loadGltf = (file: string): Promise<GLTF> => loader.loadAsync(`${BASE}${file}`);

let manifestP: Promise<CrewManifest> | null = null;
export function loadManifest(): Promise<CrewManifest> {
  manifestP ??= fetch(`${BASE}manifest.json`)
    .then((r) => (r.ok ? (r.json() as Promise<CrewManifest>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((m) => ({ ...DEFAULT_MANIFEST, ...m, overrides: m.overrides ?? {} }))
    .catch((e: unknown) => {
      console.warn('[角色] 讀不到 models/manifest.json，使用預設設定：', e);
      return DEFAULT_MANIFEST;
    });
  return manifestP;
}

/* ---------------------------- 材質：PS1 方向 ---------------------------- */

const pixelate = (t: Texture | null): Texture | null => {
  if (!t) return null;
  // 近距離放大時保留像素（nearest）；遠距離縮小時用 mipmap 平均，避免閃爍
  t.magFilter = NearestFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 1;
  t.needsUpdate = true;
  return t;
};

const matCache = new Map<Material, MeshLambertMaterial>();
/** 換成不反光的 Lambert 材質（沒有金屬光澤、沒有塑膠高光），保留貼圖並使用平面著色 */
function toPs1(m: Material): MeshLambertMaterial {
  const hit = matCache.get(m);
  if (hit) return hit;
  const src = m as MeshStandardMaterial;
  const out = new MeshLambertMaterial({ map: pixelate(src.map ?? null), color: src.map ? 0xffffff : src.color, flatShading: true, name: m.name });
  matCache.set(m, out);
  return out;
}

function prepareModel(scene: Object3D): void {
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toPs1) : toPs1(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    // 動畫會讓網格超出靜止姿勢的包圍盒；關掉視錐剔除避免蹲下、倒地時整個消失
    mesh.frustumCulled = false;
  });
}

function bonesOf(scene: Object3D): Map<string, Bone> {
  const out = new Map<string, Bone>();
  scene.traverse((o) => {
    if ((o as Bone).isBone) out.set(o.name, o as Bone);
  });
  return out;
}

/**
 * 骨骼名稱對照表的鍵改成 three.js 載入後的名稱：GLTFLoader 會移除節點名稱裡的保留字元
 * （例如 Mixamo 的 "mixamorig:Hips" 載入後是 "mixamorigHips"），對照表兩種寫法都能用。
 */
function normalizeMap(map?: Record<string, string>): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = v;
    out[PropertyBinding.sanitizeNodeName(k)] = v;
  }
  return out;
}

/** 外部模型的骨骼改名成本專案的名稱；回傳缺少的骨骼 */
function applyBoneMap(scene: Object3D, required: string[], rawMap?: Record<string, string>): string[] {
  const boneMap = normalizeMap(rawMap);
  if (boneMap) {
    scene.traverse((o) => {
      const to = boneMap[o.name];
      if (to) o.name = to;
    });
  }
  const have = bonesOf(scene);
  return required.filter((b) => !have.has(b));
}

/* ---------------------------- 動畫 ---------------------------- */

/** 只保留旋轉軌與 hips 的位移；把軌道名稱改成本專案的骨骼名稱 */
export function sanitizeClip(clip: AnimationClip, bones: Set<string>, rawMap?: Record<string, string>, rename?: string): AnimationClip | null {
  const boneMap = normalizeMap(rawMap);
  const tracks = clip.tracks
    .map((t) => {
      const dot = t.name.lastIndexOf('.');
      const node = t.name.slice(0, dot);
      const prop = t.name.slice(dot + 1);
      const name = boneMap?.[node] ?? node;
      if (!bones.has(name)) return null;
      if (prop === 'quaternion' || (prop === 'position' && name === 'hips')) {
        const c = t.clone();
        c.name = `${name}.${prop}`;
        return c;
      }
      return null;
    })
    .filter((t): t is NonNullable<typeof t> => !!t);
  if (!tracks.length) return null;
  return new AnimationClip(rename ?? clip.name, clip.duration, tracks);
}

let clipsP: Promise<Map<string, AnimationClip>> | null = null;
function loadSharedClips(m: CrewManifest): Promise<Map<string, AnimationClip>> {
  clipsP ??= loadGltf(m.animations)
    .then((g) => {
      const bones = new Set(m.bones);
      const out = new Map<string, AnimationClip>();
      for (const c of g.animations) {
        const s = sanitizeClip(c, bones);
        if (s) out.set(s.name, s);
      }
      return out;
    })
    .catch((e: unknown) => {
      console.warn('[角色] 動畫庫載入失敗，角色只會保持靜止姿勢：', e);
      return new Map<string, AnimationClip>();
    });
  return clipsP;
}

/* ---------------------------- 角色 ---------------------------- */

async function tryOverride(role: Role, m: CrewManifest, o: ModelOverride, shared: Map<string, AnimationClip>): Promise<CrewAsset | string> {
  let g: GLTF;
  try {
    g = await loadGltf(o.model);
  } catch (e) {
    return `正式模型 ${o.model} 載入失敗：${String(e)}`;
  }
  const missing = applyBoneMap(g.scene, m.bones, o.boneMap);
  if (missing.length) return `正式模型 ${o.model} 缺少骨骼：${missing.join('、')}（請在 boneMap 指定對照）`;
  prepareModel(g.scene);
  const clips = new Map(shared);
  const bones = new Set(m.bones);
  if (o.clipMap) {
    for (const c of g.animations) {
      const to = o.clipMap[c.name];
      const s = to ? sanitizeClip(c, bones, o.boneMap, to) : null;
      if (s) clips.set(to!, s);
    }
  }
  return { role, template: g.scene, clips, scale: o.scale ?? 1, yaw: o.yaw ?? 0, source: 'override', warnings: missingClips(m, clips) };
}

const missingClips = (m: CrewManifest, clips: Map<string, AnimationClip>): string[] => {
  const miss = m.requiredClips.filter((c) => !clips.has(c));
  return miss.length ? [`缺少動畫：${miss.join('、')}（會以待機姿勢代替）`] : [];
};

const roleP = new Map<Role, Promise<CrewAsset | null>>();

/** 角色資產；完全載入失敗時回傳 null（呼叫端使用備用人形） */
export function loadCrew(role: Role): Promise<CrewAsset | null> {
  let p = roleP.get(role);
  if (!p) {
    p = (async () => {
      const m = await loadManifest();
      const shared = await loadSharedClips(m);
      const o = m.overrides[role];
      const warnings: string[] = [];
      if (o) {
        const r = await tryOverride(role, m, o, shared);
        if (typeof r !== 'string') return r;
        warnings.push(r);
        console.warn(`[角色] ${r}；改用程式產生的模型。`);
      }
      try {
        const g = await loadGltf(m.roles[role].model);
        const missing = applyBoneMap(g.scene, m.bones);
        if (missing.length) throw new Error(`缺少骨骼：${missing.join('、')}`);
        prepareModel(g.scene);
        const w = [...warnings, ...missingClips(m, shared)];
        w.forEach((x) => console.warn(`[角色] ${role}：${x}`));
        return { role, template: g.scene, clips: shared, scale: 1, yaw: 0, source: 'generated', warnings: w } satisfies CrewAsset;
      } catch (e) {
        console.warn(`[角色] ${role} 的模型載入失敗，使用備用人形：`, e);
        return null;
      }
    })();
    roleP.set(role, p);
  }
  return p;
}

/** 預先載入三名角色（進入遊戲時呼叫，避免隊友第一次出現時才下載） */
export function preloadCrew(roles: Role[]): void {
  for (const r of roles) void loadCrew(r);
}
