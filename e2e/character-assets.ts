/**
 * 角色資產的瀏覽器測試：載入失敗的退回、正式模型的匯入介面（骨骼名稱對照）、動畫庫缺失。
 * 使用角色預覽頁（?preview=crew），以 Playwright 攔截網路請求模擬各種情況。
 *
 * 執行：先 `npm run build` 並啟動伺服器，然後
 *   npx tsx e2e/character-assets.ts [網址]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type Route } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const MODELS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/public/models');
const manifest = JSON.parse(readFileSync(path.join(MODELS, 'manifest.json'), 'utf8')) as Record<string, unknown>;

/** 把 GLB 裡的骨骼節點改名（模擬外部工具輸出的模型，例如 Mixamo 的 mixamorig:Hips） */
function renameBones(file: string, map: Record<string, string>): Buffer {
  const b = readFileSync(path.join(MODELS, file));
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8')) as { nodes: Array<{ name?: string }> };
  for (const n of json.nodes) if (n.name && map[n.name]) n.name = map[n.name];
  let text = JSON.stringify(json);
  while (Buffer.byteLength(text) % 4) text += ' ';
  const jsonBuf = Buffer.from(text, 'utf8');
  const rest = b.subarray(20 + jsonLen);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBuf.length + rest.length, 8);
  header.writeUInt32LE(jsonBuf.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, jsonBuf, rest]);
}

const ours = manifest.bones as string[];
const toMixamo = Object.fromEntries(ours.map((b) => [b, `mixamorig:${b[0].toUpperCase()}${b.slice(1)}`]));
const fromMixamo = Object.fromEntries(Object.entries(toMixamo).map(([a, b]) => [b, a]));

let failures = 0;
const check = (cond: unknown, msg: string): void => {
  console.log(`  ${cond ? '✓' : '✘'} ${msg}`);
  if (!cond) failures++;
};

async function scenario(name: string, setup: (p: Page) => Promise<void>, verify: (info: string, warnings: string[], errors: string[]) => void): Promise<void> {
  console.log(`▶ ${name}`);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const warnings: string[] = [];
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  await page.goto(`${BASE}/?preview=crew&clip=Walk`);
  await page.waitForSelector('[data-ready="1"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const info = (await page.textContent('.crew-preview-info')) ?? '';
  verify(info, warnings, errors.filter((e) => !e.includes('Failed to load resource')));
  await browser.close();
}

const fulfillManifest = (overrides: Record<string, unknown>) => (route: Route) =>
  route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...manifest, overrides }) });

try {
  await scenario('正常載入', async () => undefined, (info, warnings, errors) => {
    check(/盲區員：程式模型.*靜默員：程式模型.*失語員：程式模型/.test(info), '三名角色都載入程式產生的模型');
    check(warnings.filter((w) => w.includes('[角色]')).length === 0, '沒有角色相關的警告');
    check(errors.length === 0, `沒有錯誤${errors.length ? '：' + errors.join(' / ') : ''}`);
  });

  await scenario(
    '一個角色的模型下載失敗',
    async (p) => p.route('**/models/crew_mute.glb', (r) => r.abort()),
    (info, warnings, errors) => {
      check(info.includes('失語員：載入失敗（備用人形）'), '失語員改用備用人形');
      check(info.includes('盲區員：程式模型'), '其他角色不受影響');
      check(warnings.some((w) => w.includes('MUTE')), '主控台有警告說明原因');
      check(errors.length === 0, '頁面沒有崩潰');
    },
  );

  await scenario(
    '動畫庫下載失敗',
    async (p) => p.route('**/models/crew_anims.glb', (r) => r.fulfill({ status: 404, body: 'not found' })),
    (info, warnings, errors) => {
      check(/程式模型/.test(info), '模型仍然載入');
      check(warnings.some((w) => w.includes('動畫庫載入失敗')), '主控台說明動畫缺失');
      check(errors.length === 0, '頁面沒有崩潰（角色保持靜止姿勢）');
    },
  );

  await scenario(
    'manifest 指定的正式模型不存在',
    async (p) => p.route('**/models/manifest.json', fulfillManifest({ MUTE: { model: 'formal_mute_missing.glb' } })),
    (info, warnings, errors) => {
      check(info.includes('失語員：程式模型'), '退回程式產生的模型');
      check(warnings.some((w) => w.includes('formal_mute_missing.glb')), '主控台指出哪個檔案載入失敗');
      check(errors.length === 0, '頁面沒有崩潰');
    },
  );

  const external = renameBones('crew_mute.glb', toMixamo);
  await scenario(
    '正式模型的骨骼名稱不同、但提供了對照表（boneMap）',
    async (p) => {
      await p.route('**/models/manifest.json', fulfillManifest({ MUTE: { model: 'external_mute.glb', boneMap: fromMixamo } }));
      await p.route('**/models/external_mute.glb', (r) => r.fulfill({ contentType: 'model/gltf-binary', body: external }));
    },
    (info, warnings, errors) => {
      check(info.includes('失語員：正式模型'), '以對照表接上共用骨骼名稱，使用正式模型');
      check(!warnings.some((w) => w.includes('缺少骨骼')), '沒有缺少骨骼的警告');
      check(errors.length === 0, '沒有錯誤');
    },
  );

  await scenario(
    '正式模型的骨骼名稱不同、而且沒有對照表',
    async (p) => {
      await p.route('**/models/manifest.json', fulfillManifest({ MUTE: { model: 'external_mute.glb' } }));
      await p.route('**/models/external_mute.glb', (r) => r.fulfill({ contentType: 'model/gltf-binary', body: external }));
    },
    (info, warnings, errors) => {
      check(info.includes('失語員：程式模型'), '驗證不通過，退回程式產生的模型');
      check(warnings.some((w) => w.includes('缺少骨骼') && w.includes('boneMap')), '警告列出缺少的骨骼並提示使用 boneMap');
      check(errors.length === 0, '頁面沒有崩潰');
    },
  );
} catch (e) {
  console.error('✘', (e as Error).message);
  failures++;
}

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過 ✔');
process.exitCode = failures ? 1 : 0;
