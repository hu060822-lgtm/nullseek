import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 角色資產的結構檢查（tools/characters/build_crew.py 的輸出，放在 client/public/models/）。
 * 不需要瀏覽器：直接解析 GLB 的 JSON 區塊。
 */

const DIR = path.resolve(__dirname, '../../client/public/models');

interface Gltf {
  nodes: Array<{ name?: string }>;
  skins?: Array<{ joints: number[] }>;
  meshes?: Array<{ primitives: Array<{ indices?: number; attributes: Record<string, number> }> }>;
  accessors: Array<{ count: number }>;
  animations?: Array<{ name: string; channels: Array<{ target: { node: number; path: string } }> }>;
  images?: Array<{ bufferView: number; mimeType: string }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
}

function readGlb(file: string): { json: Gltf; bin: Buffer } {
  const b = readFileSync(path.join(DIR, file));
  expect(b.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8')) as Gltf;
  const binStart = 20 + jsonLen;
  const binLen = b.readUInt32LE(binStart);
  return { json, bin: b.subarray(binStart + 8, binStart + 8 + binLen) };
}

const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as {
  animations: string;
  bones: string[];
  requiredClips: string[];
  roles: Record<string, { model: string }>;
  overrides: Record<string, unknown>;
};

describe('角色資產（GLB）', () => {
  it('manifest 列出的檔案都存在；骨骼 19 根、必要動畫 11 組；沒有預設的覆寫', () => {
    expect(manifest.bones).toHaveLength(19);
    expect(manifest.requiredClips).toEqual(['Idle', 'Walk', 'Run', 'StartMoving', 'StopMoving', 'Turn', 'Crouch', 'Interact', 'Inspect', 'Hurt', 'Death']);
    expect(Object.keys(manifest.roles).sort()).toEqual(['BLIND', 'DEAF', 'MUTE']);
    for (const f of [manifest.animations, ...Object.values(manifest.roles).map((r) => r.model)]) expect(existsSync(path.join(DIR, f)), f).toBe(true);
    expect(manifest.overrides).toEqual({});
  });

  for (const [role, { model }] of Object.entries(manifest.roles)) {
    it(`${role}：蒙皮骨架包含全部骨骼；低多邊形（≤ 2500 三角形）；貼圖 ≤ 128 px；檔案 ≤ 300 KB`, () => {
      const { json, bin } = readGlb(model);
      expect(json.skins).toHaveLength(1);
      const joints = json.skins![0].joints.map((i) => json.nodes[i].name);
      expect([...joints].sort()).toEqual([...manifest.bones].sort());
      let tris = 0;
      for (const m of json.meshes ?? []) {
        for (const p of m.primitives) {
          expect(p.attributes.JOINTS_0, '每個頂點都有骨骼權重').toBeDefined();
          expect(p.attributes.WEIGHTS_0).toBeDefined();
          tris += (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3;
        }
      }
      expect(tris).toBeGreaterThan(800);
      expect(tris).toBeLessThanOrEqual(2500);
      expect(json.animations ?? []).toHaveLength(0); // 動畫放在共用動畫庫
      for (const img of json.images ?? []) {
        const v = json.bufferViews[img.bufferView];
        const png = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
        expect(png.readUInt32BE(16), '寬').toBeLessThanOrEqual(128);
        expect(png.readUInt32BE(20), '高').toBeLessThanOrEqual(128);
      }
      expect(statSync(path.join(DIR, model)).size).toBeLessThanOrEqual(300 * 1024);
    });
  }

  it('動畫庫：包含全部必要動畫；每個動畫都有每根骨骼的旋轉軌，以及 hips 的位移軌', () => {
    const { json } = readGlb(manifest.animations);
    const anims = json.animations ?? [];
    const names = anims.map((a) => a.name);
    for (const c of [...manifest.requiredClips, 'CrouchIdle', 'CrouchWalk', 'InteractHigh', 'Observe']) expect(names, c).toContain(c);
    for (const a of anims) {
      const rot = new Set(a.channels.filter((c) => c.target.path === 'rotation').map((c) => json.nodes[c.target.node].name));
      for (const b of manifest.bones) expect(rot.has(b), `${a.name} 缺少 ${b} 的旋轉`).toBe(true);
      const hipsMove = a.channels.some((c) => c.target.path === 'translation' && json.nodes[c.target.node].name === 'hips');
      expect(hipsMove, `${a.name} 缺少 hips 位移`).toBe(true);
    }
  });
});
