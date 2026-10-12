/**
 * 瀏覽器端到端測試：三個真正的 Chromium（三個獨立的瀏覽器行程，就像三台電腦），
 * 透過實際的前端 UI 從建立房間一路玩完第一章十道謎題。
 *
 * - 解題邏輯沿用 server/test/solver.ts（只使用各角色在畫面上真的看得到／聽得到的資料）
 * - 開啟設備：走到設備前（沿著開啟的門移動）、面向設備、按 E
 * - 直接互動的設備（P02 的門）：按 E 直接推
 * - 門洞（P04、P09）：真的走進去，由前端的觸發判定送出 puzzle:action，伺服器傳送後再繼續
 * - 送出操作：在面板上填入數字格／下拉選單／單選，再點按鈕
 * - 同時檢查：WebRTC 語音只建立三條允許的邊、盲區員不載入 3D 場景、標記工具、正式環境沒有開發者工具
 *
 * 執行：先 `npm run build` 並以 NODE_ENV=production 啟動伺服器（預設 http://localhost:3001），然後
 *   npx tsx e2e/browser-playthrough.ts [網址] [截圖資料夾]
 * 需要：devDependency `playwright` 與一個 Chromium（`npx playwright install chromium`，或以 CHROMIUM_PATH 指定執行檔）。
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import {
  DEVICE_BY_ID,
  DOOR_SLOTS,
  PORTAL_BY_ID,
  ROLES,
  ZONES,
  buildColliders,
  moveWithCollision,
  portalFront,
  wallZ,
  zoneAt,
  type ActionResult,
  type DoorState,
  type PanelView,
  type PuzzleId,
  type Role,
  type SceneClues,
} from '@null-protocol/shared';
import { solveChapter, type Driver } from '../server/test/solver';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'e2e-shots';
mkdirSync(OUT, { recursive: true });

const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
const browsers: Browser[] = [];
const errors: string[] = [];
const pages = {} as Record<Role, Page>;

async function newPlayer(role: Role): Promise<Page> {
  const browser = await launch();
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${role}] ${m.text()}`);
    // 角色模型載入失敗會退回備用人形（只是警告）；正式的通關測試要求模型全部正常載入
    if (m.type() === 'warning' && m.text().includes('[角色]')) errors.push(`[${role}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${role}] pageerror: ${e.message}`));
  // tsx（esbuild）會把傳進 page.evaluate 的具名函式包上 __name()；頁面裡沒有這個輔助函式
  await page.addInitScript('window.__name = (f) => f;');
  await page.goto(`${BASE}/?debug`);
  return page;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { __NP__: { useStore: { getState(): any }; pose: { x: number; z: number; yaw: number; pitch: number } } };
const st = <T>(p: Page, fn: string): Promise<T> => p.evaluate(`(() => { const s = window.__NP__.useStore.getState(); return ${fn}; })()`) as Promise<T>;

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`檢查失敗：${msg}`);
  console.log(`  ✓ ${msg}`);
}

/* ------------------------------ 走路 ------------------------------ */

type Pt = [number, number];
const poseOf = (p: Page) => p.evaluate(() => ({ ...(window as unknown as Win).__NP__.pose }));

/** 直線走到 (x,z)：以 3.4 m/s 逐步更新控制器位置，由前端的正常流程把位置送給伺服器驗證 */
async function stepTo(p: Page, x: number, z: number): Promise<void> {
  await p.evaluate(
    ([tx, tz]) =>
      new Promise<void>((resolve) => {
        const pose = (window as unknown as Win).__NP__.pose;
        let lx = pose.x;
        let lz = pose.z;
        // 位置每畫一幀才送出一次；軟體算繪只有 1–2 fps，每幀最多走 1.5 m，
        // 避免一次送出的位移超過伺服器的防瞬移額度（2.5 m）而被拉回
        let movedThisFrame = 0;
        let raf = 0;
        const onFrame = () => {
          movedThisFrame = 0;
          raf = requestAnimationFrame(onFrame);
        };
        raf = requestAnimationFrame(onFrame);
        const t = setInterval(() => {
          if (movedThisFrame >= 1.5) return;
          // 伺服器傳送（或校正）了位置：停止這段走路，就像玩家放開按鍵
          if (Math.hypot(pose.x - lx, pose.z - lz) > 0.5) {
            clearInterval(t);
            cancelAnimationFrame(raf);
            resolve();
            return;
          }
          const dx = tx - pose.x;
          const dz = tz - pose.z;
          const d = Math.hypot(dx, dz);
          const s = 3.4 * 0.033;
          if (d <= s) {
            pose.x = tx;
            pose.z = tz;
            clearInterval(t);
            cancelAnimationFrame(raf);
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 90)));
            return;
          }
          pose.x += (dx / d) * s;
          pose.z += (dz / d) * s;
          movedThisFrame += s;
          pose.yaw = Math.atan2(-dx, -dz);
          lx = pose.x;
          lz = pose.z;
        }, 33);
      }),
    [x, z],
  );
}

const roomIndex = (pt: Pt): number => {
  const z = zoneAt(pt[0], pt[1]);
  if (!z) throw new Error(`位置不在房間內：${pt.join(',')}`);
  return z.index;
};
const exitSlot = (k: number) => DOOR_SLOTS.find((s) => s.doorId === `d${k}`)!;
const roomCenter = (i: number): Pt => {
  const z = ZONES.find((q) => q.index === i)!;
  return [(z.minX + z.maxX) / 2, (z.minZ + z.maxZ) / 2];
};

function waypoints(from: Pt, to: Pt): Pt[] {
  let cur = roomIndex(from);
  const j = roomIndex(to);
  const pts: Pt[] = [];
  while (cur < j) {
    const s = exitSlot(cur);
    pts.push([s.x, wallZ(cur) - 1.0], [s.x, wallZ(cur) + 1.4]);
    cur++;
  }
  pts.push(to);
  return pts;
}

/** 依合法路徑（穿過開著的門、不穿牆）走到某一點；被擋住時先繞到房間中央 */
async function walkToPoint(role: Role, target: Pt): Promise<void> {
  const p = pages[role];
  const doors = (await st<DoorState>(p, 's.world.doors')) as DoorState;
  const boxes = buildColliders(doors);
  const clear = (a: Pt, b: Pt) => {
    const r = moveWithCollision(a[0], a[1], b[0], b[1], boxes);
    return !r.blocked && Math.hypot(r.x - b[0], r.z - b[1]) < 0.02;
  };
  const here = await poseOf(p);
  if (Math.hypot(here.x - target[0], here.z - target[1]) < 0.3) return;
  for (const wp of waypoints([here.x, here.z], target)) {
    const now = await poseOf(p);
    const from: Pt = [now.x, now.z];
    if (!clear(from, wp)) {
      const mid = roomCenter(roomIndex(from));
      if (!clear(from, mid) || !clear(mid, wp)) throw new Error(`[${role}] 找不到路：${from} → ${wp}`);
      await stepTo(p, mid[0], mid[1]);
    }
    await stepTo(p, wp[0], wp[1]);
  }
}

async function face(p: Page, x: number, z: number): Promise<void> {
  await p.evaluate(([tx, tz]) => {
    const pose = (window as unknown as Win).__NP__.pose;
    pose.yaw = Math.atan2(-(tx - pose.x), -(tz - pose.z));
    pose.pitch = -0.2;
  }, [x, z]);
  await p.waitForTimeout(150);
}

async function walkToDevice(role: Role, deviceId: string): Promise<void> {
  const d = DEVICE_BY_ID[deviceId];
  const off = d.kind === 'door_slot' ? 1.2 : d.size[2] / 2 + 1.0;
  await walkToPoint(role, [d.pos[0] + Math.sin(d.facing) * off, d.pos[1] + Math.cos(d.facing) * off]);
  await face(pages[role], d.pos[0], d.pos[1]);
}

/* ------------------------------ 面板 ------------------------------ */

const panelOf = (p: Page) => st<{ deviceId: string; view: PanelView; result: { id: number; ok: boolean; message: string; tone: ActionResult['tone'] } | null } | null>(p, 's.panel');

async function closePanel(p: Page): Promise<void> {
  if (await panelOf(p)) {
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !(window as unknown as Win).__NP__.useStore.getState().panel);
  }
}

async function openPanel(role: Role, deviceId: string): Promise<PanelView> {
  const p = pages[role];
  await closePanel(p);
  await walkToDevice(role, deviceId);
  await p.keyboard.press('KeyE');
  try {
    await p.waitForFunction((id) => (window as unknown as Win).__NP__.useStore.getState().panel?.deviceId === id, deviceId, { timeout: 20000 });
  } catch (e) {
    const d = DEVICE_BY_ID[deviceId];
    const info = await p.evaluate(() => {
      const w = window as unknown as Win;
      const s = w.__NP__.useStore.getState();
      return { pose: { ...w.__NP__.pose }, notices: s.notices.map((n: { text: string }) => n.text), panel: s.panel?.deviceId ?? null, locked: s.locked, overlay: s.overlay };
    });
    console.log(`    [${role}] 開不了 ${deviceId}（設備位置 ${d.pos.join(',')}）：${JSON.stringify(info)}`);
    throw e;
  }
  await p.waitForSelector('.modal header h2');
  return (await panelOf(p))!.view;
}

async function fillAndClick(role: Role, action: string, values: Record<string, unknown>): Promise<ActionResult> {
  const p = pages[role];
  for (const [id, v] of Object.entries(values)) {
    const ctrl = p.locator(`.ctrl[data-control="${id}"]`);
    const type = await ctrl.getAttribute('data-type');
    if (type === 'digits') {
      const arr = v as number[];
      for (let guard = 0; guard < 10; guard++) {
        const n = await ctrl.locator('.cell').count();
        if (n < arr.length) await ctrl.locator('button[aria-label="增加一位"]').click();
        else if (n > arr.length) await ctrl.locator('button[aria-label="減少一位"]').click();
        else break;
      }
      for (let i = 0; i < arr.length; i++) await ctrl.locator('.cell').nth(i).fill(String(arr[i]));
      const got = await ctrl.locator('.cell').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(','));
      if (got !== arr.join(',')) {
        console.log(`    [${role}] 數字格不符：想填 ${arr.join(',')}，實際 ${got}`);
        for (let i = 0; i < arr.length; i++) await ctrl.locator('.cell').nth(i).fill(String(arr[i]));
        console.log(`    [${role}] 重填後：${await ctrl.locator('.cell').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(','))}`);
      }
    } else if (type === 'selects') {
      const arr = v as string[];
      for (let i = 0; i < arr.length; i++) await ctrl.locator('select').nth(i).selectOption(arr[i]);
    } else if (type === 'select') {
      await ctrl.locator(`input[type="radio"][value="${v as string}"]`).check();
    } else {
      throw new Error(`[${role}] 面板上找不到輸入元件 ${id}`);
    }
  }
  const before = (await panelOf(p))?.result?.id ?? 0;
  if (process.env.E2E_TRACE) {
    const cells = await p.locator('.cell').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(','));
    console.log(`    trace [${role}] click ${action} cells=${cells} before=${before}`);
  }
  await p.click(`button[data-action="${action}"]`);
  if (process.env.E2E_TRACE) {
    await p.waitForTimeout(300);
    const cells = await p.locator('.cell').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(','));
    const panel = await panelOf(p);
    console.log(`    trace [${role}] after ${action} cells=${cells} result=${JSON.stringify(panel?.result)}`);
  }
  return awaitResult(role, before);
}

/** 等面板出現新的操作結果（或面板關閉／第一章完成） */
async function awaitResult(role: Role, before: number): Promise<ActionResult> {
  const p = pages[role];
  await p.waitForFunction(
    (b) => {
      const s = (window as unknown as Win).__NP__.useStore.getState();
      const r = s.panel?.result;
      return s.complete || !s.panel || (r && r.id !== b);
    },
    before,
    { timeout: 20000 },
  );
  const panel = await panelOf(p);
  if (!panel?.result) {
    const complete = await st<boolean>(p, 's.complete');
    return { ok: complete, message: complete ? '（第一章完成，面板已由結局關閉）' : '（面板已關閉）', tone: complete ? 'ok' : 'warn' };
  }
  const r = panel.result;
  return { ok: r.ok, message: r.message, tone: r.tone, view: panel.view };
}

/** 直接互動（推門）：按 E，從通知讀回結果 */
async function directAct(role: Role, deviceId: string): Promise<ActionResult> {
  const p = pages[role];
  await closePanel(p);
  await walkToDevice(role, deviceId);
  const before = await st<number>(p, 's.notices.length ? s.notices[s.notices.length - 1].id : 0');
  const active = await st<string | null>(p, 's.world.activePuzzle');
  await p.keyboard.press('KeyE');
  await p.waitForFunction(
    ([b, a]) => {
      const s = (window as unknown as Win).__NP__.useStore.getState();
      const last = s.notices[s.notices.length - 1];
      return (last && last.id !== b) || s.world.activePuzzle !== a;
    },
    [before, active] as const,
    { timeout: 10000 },
  );
  const last = await st<{ tone: string; text: string } | null>(p, 's.notices[s.notices.length - 1] ?? null');
  const ok = (await st<string | null>(p, 's.world.activePuzzle')) !== active || last?.tone === 'info';
  return { ok, message: last?.text ?? '', tone: ok ? 'ok' : 'error' };
}

/** 走進門洞：走到門洞前，再往前一步讓前端觸發；等伺服器傳送（或拒絕） */
async function walkIntoPortal(role: Role, portalId: string): Promise<ActionResult> {
  const p = pages[role];
  await closePanel(p);
  const portal = PORTAL_BY_ID[portalId];
  const approach = portalFront(portal, 1.7);
  await walkToPoint(role, approach);
  const before = await st<number>(p, 's.notices.length ? s.notices[s.notices.length - 1].id : 0');
  const active = await st<string | null>(p, 's.world.activePuzzle');
  const inside = portalFront(portal, 0.45); // 玩家半徑 0.35：不能貼進牆裡；仍在觸發範圍（0.95）內
  await stepTo(p, inside[0], inside[1]);
  // 傳送後位置會跳離門洞；被拒絕時會出現通知
  await p.waitForFunction(
    ([fx, fz, b, a]) => {
      const w = window as unknown as Win;
      const s = w.__NP__.useStore.getState();
      const pose = w.__NP__.pose;
      const last = s.notices[s.notices.length - 1];
      return Math.hypot(pose.x - (fx as number), pose.z - (fz as number)) > 1.5 || (last && last.id !== b) || s.world.activePuzzle !== a;
    },
    [inside[0], inside[1], before, active] as const,
    { timeout: 10000 },
  );
  const pose = await poseOf(p);
  const moved = Math.hypot(pose.x - inside[0], pose.z - inside[1]) > 1.5;
  const done = (await st<string | null>(p, 's.world.activePuzzle')) !== active;
  const last = await st<{ text: string } | null>(p, 's.notices[s.notices.length - 1] ?? null');
  // 讓伺服器的傳送保護時間過去，再繼續走動
  await p.waitForTimeout(350);
  return { ok: moved || done, message: moved || done ? '（穿過門洞）' : last?.text ?? '', tone: moved || done ? 'ok' : 'warn' };
}

let shot = 0;
const driver: Driver = {
  open: (role, deviceId) => openPanel(role, deviceId),
  async act(role, targetId, actionType, payload = {}) {
    if (DEVICE_BY_ID[targetId]?.direct) return directAct(role, targetId);
    const cur = await panelOf(pages[role]);
    if (cur?.deviceId !== targetId) await openPanel(role, targetId);
    const r = await fillAndClick(role, actionType, payload);
    if (!r.ok) {
      await pages[role].screenshot({ path: `${OUT}/fail-${++shot}-${role}-${targetId}.png` });
      console.log(`  ! [${role}] ${targetId}/${actionType}：${r.message}`);
    }
    return r;
  },
  enter: (role, portalId) => walkIntoPortal(role, portalId),
  clues: (role) => st<SceneClues>(pages[role], 's.clues'),
  async syncPress(presses) {
    // 三個人各自操作自己的電腦：檢查面板與按下都同時進行。按鈕直接在頁面裡點擊——
    // Playwright 的 click 會先等元素「連續兩幀位置不變」，軟體算繪只有 1–4 fps，光是等待就會吃掉大半的 3 秒窗口
    await Promise.all(
      presses.map(async (pr) => {
        const cur = await panelOf(pages[pr.role]);
        if (cur?.deviceId !== pr.targetId) await openPanel(pr.role, pr.targetId);
      }),
    );
    const t0 = Date.now();
    const res = await Promise.all(
      presses.map(async (pr) => {
        const p = pages[pr.role];
        const before = await p.evaluate((action) => {
          const s = (window as unknown as Win).__NP__.useStore.getState();
          const id = (s.panel?.result?.id as number | undefined) ?? 0;
          (document.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement | null)?.click();
          return id;
        }, pr.actionType);
        return awaitResult(pr.role, before);
      }),
    );
    // 失敗時印出每一下的結果與耗時，方便判斷是逾時還是內容錯誤
    if (res.some((r) => !r.ok)) console.log('    同步按下', Date.now() - t0, 'ms', res.map((r) => `${r.ok ? '✓' : '✘'} ${r.message}`));
    return res;
  },
  activePuzzle: async () => {
    await pages.MUTE.waitForTimeout(60);
    return st<PuzzleId | null>(pages.MUTE, 's.world?.activePuzzle ?? null');
  },
};

/* ------------------------------ 流程 ------------------------------ */

try {
  console.log('▶ 建立房間、加入、選角');
  for (const r of ROLES) pages[r] = await newPlayer(r);
  const A = pages.BLIND;
  const B = pages.DEAF;
  const C = pages.MUTE;
  await A.fill('#name', 'Aki');
  await A.click('text=建立房間');
  await A.waitForSelector('.code-box');
  const code = (await A.textContent('.code-box'))!.trim();
  for (const [p, n] of [[B, 'Bao'], [C, 'Cleo']] as const) {
    await p.fill('#name', n);
    await p.fill('input.code', code);
    await p.click('text=加入房間');
    await p.waitForSelector('.code-box');
  }
  await A.click('.role-card:has-text("盲區員")');
  await B.click('.role-card:has-text("靜默員")');
  await C.click('.role-card:has-text("失語員")');
  check((await C.locator('text=啟用麥克風').count()) === 0, '失語員的大廳沒有「啟用麥克風」按鈕');
  await A.click('text=啟用麥克風');
  await B.click('text=啟用麥克風');
  await A.waitForSelector('text=麥克風已啟用');
  await A.click('text=開始第一章');
  for (const p of [A, B, C]) {
    await p.waitForSelector('text=進入設施');
    await p.click('text=進入設施');
  }

  console.log('▶ 感官限制與工具');
  check((await A.locator('canvas').count()) === 0, '盲區員的頁面沒有任何 <canvas>（不載入 3D 場景）');
  check((await B.locator('canvas').count()) === 1 && (await C.locator('canvas').count()) === 1, '靜默員與失語員有 3D 場景');
  await A.waitForTimeout(4000);
  const links = async (p: Page) =>
    p.evaluate(() =>
      Object.entries((window as unknown as Win).__NP__.useStore.getState().voiceLinks as Record<string, string>)
        .filter(([, s]) => s === 'connected')
        .map(([k]) => k)
        .sort(),
    );
  const [la, lb, lc] = [await links(A), await links(B), await links(C)];
  console.log('    語音連線', { A: la, B: lb, C: lc });
  check(JSON.stringify(la) === JSON.stringify(['BLIND>MUTE', 'DEAF>BLIND']), '盲區員：送給失語員、收靜默員');
  check(JSON.stringify(lb) === JSON.stringify(['DEAF>BLIND', 'DEAF>MUTE']), '靜默員：只有發送，沒有任何接收');
  check(JSON.stringify(lc) === JSON.stringify(['BLIND>MUTE', 'DEAF>MUTE']), '失語員：只有接收，沒有任何發送');
  check((await st<boolean>(C, 's.debug')) === false, '正式環境：前端沒有開發者工具');
  check((await st<number>(B, 'Object.keys(s.clues).length')) > 0 && (await st<number>(C, 'Object.keys(s.clues).length')) === 0, '只有靜默員收到 R01 的符號燈線索');

  // 盲區員的空間感知系統：只有盲區員有回聲與轉向提示；失語員只有環境聲源；靜默員完全沒有音訊
  const sysInfo = (p: Page) =>
    p.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sys = (window as any).__NP__.blind.system();
      return sys ? { echo: !!sys.echo, orientation: !!sys.orientation } : null;
    });
  check(JSON.stringify(await sysInfo(A)) === JSON.stringify({ echo: true, orientation: true }), '盲區員：回聲與方向基準');
  check(JSON.stringify(await sysInfo(C)) === JSON.stringify({ echo: false, orientation: false }), '失語員：只有環境聲源，沒有回聲能力');
  check((await sysInfo(B)) === null, '靜默員：沒有任何音訊系統');
  await A.keyboard.press('KeyF');
  await A.waitForSelector('.echo-field[data-echo]', { timeout: 5000, state: 'attached' });
  const echoCount = Number(await A.getAttribute('.echo-field', 'data-echo'));
  check(echoCount > 0 && echoCount <= 16, `盲區員按 F：畫面短暫出現 ${echoCount} 個反射點（最多 16 道射線）`);
  await A.waitForSelector('.echo-field .contour', { state: 'attached' });
  await B.keyboard.press('KeyF');
  check((await B.locator('.echo-field').count()) === 0, '靜默員按 F 沒有任何作用');

  // 失語員的標記：注視密碼輸入器按 G
  await walkToDevice('MUTE', 'r1_lock');
  await C.keyboard.press('KeyG');
  await B.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().markers.length > 0, undefined, { timeout: 5000 });
  check((await st<string>(B, 's.markers[0].targetId')) === 'r1_lock', '失語員標記設備：靜默員看到標記');
  await B.screenshot({ path: `${OUT}/00-B-R01.png` });

  console.log('▶ 第一章十道謎題（玩家模擬解題器，透過 UI 操作）');
  let started = Date.now();
  await solveChapter(driver, {
    between: async (id) => {
      if (id !== 'P01_THREE_LANGUAGES') console.log(`  ✓ 完成上一題（${((Date.now() - started) / 1000).toFixed(1)}s）`);
      started = Date.now();
      console.log(`  ▶ ${id}`);
      await C.screenshot({ path: `${OUT}/${id.slice(0, 3)}-C.png` }).catch(() => undefined);
    },
  });
  console.log(`  ✓ 完成第十題（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  for (const p of [A, B, C]) await p.waitForSelector('.ending', { timeout: 20000 });
  check(true, '三個人的畫面都出現結局');
  await B.waitForTimeout(5500);
  await B.screenshot({ path: `${OUT}/99-B-ending.png` });

  console.log('▶ 回到大廳');
  await A.click('.ending >> text=回到大廳');
  for (const p of [A, B, C]) await p.waitForSelector('.code-box', { timeout: 15000 });
  check(true, '房主可以帶全隊回到大廳');

  check(errors.length === 0, `瀏覽器主控台沒有錯誤${errors.length ? '：\n' + errors.join('\n') : ''}`);
  console.log('\n全部通過 ✔');
} catch (e) {
  console.error('\n✘', (e as Error).message);
  for (const r of ROLES) await pages[r]?.screenshot({ path: `${OUT}/error-${r}.png` }).catch(() => undefined);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  for (const b of browsers) await b.close();
}
