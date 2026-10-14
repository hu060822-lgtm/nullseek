/**
 * 盲區員測試關卡的瀏覽器測試（?preview=blind-lab）。
 *
 * 1. 雙耳方位：用離線音訊實際算繪 HRTF，確認四個基本朝向、轉身後、單聲道模式的左右能量。
 * 2. 音訊路由：環境音（參考音）、回聲、隊友語音三條匯流排同時有聲音；隊友說話時環境音被壓低。
 * 3. 遮蔽：只有目前房間的參考音與地標是「直接聽到」；其他房間聽不到。
 * 4. 風險區：警戒中在感測器範圍內發出回聲 → 被偵測、回聲被干擾，之後恢復。
 * 5. 實際遊玩：一個「只用聽得到的資訊」的自動玩家，從起點走過走廊、在岔路找到門、開門、找到目標。
 *    它只讀取回聲結果（方向、距離、材質）、朝向播報、感測器是否在響，不讀取自己的座標或地圖。
 *
 * 執行：先 `npm run build` 並啟動伺服器，然後
 *   npx tsx e2e/blind-lab.ts [網址]
 */
import { chromium, type Page } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');

let failures = 0;
const check = (cond: unknown, msg: string): void => {
  console.log(`  ${cond ? '✓' : '✘'} ${msg}`);
  if (!cond) failures++;
};

interface Hit {
  rel: number;
  dist: number;
  hit: boolean;
  material: string | null;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

async function openLab(query = ''): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', (e) => {
    failures++;
    console.log(`  ✘ pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      failures++;
      console.log(`  ✘ console: ${m.text()}`);
    }
  });
  await page.addInitScript('window.__name = (f) => f;');
  await page.goto(`${BASE}/?preview=blind-lab${query}`);
  await page.waitForFunction(() => !!(window as unknown as { __LAB__?: unknown }).__LAB__);
  await page.evaluate(() => (window as unknown as { __LAB__: { start(): Promise<void> } }).__LAB__.start());
  await page.waitForTimeout(300);
  return page;
}

/** 畫面中央區域（避開說明文字與充能條）亮像素的比例：用來確認回聲視野真的畫出來、之後真的消失 */
async function brightRatio(p: Page): Promise<number> {
  const png = await p.screenshot({ clip: { x: 300, y: 120, width: 560, height: 360 } });
  return p.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] > 110) n++;
    return n / (d.length / 4);
  }, png.toString('base64'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lab = <T>(p: Page, expr: string): Promise<T> => p.evaluate(`(async () => { const L = window.__LAB__; return ${expr}; })()`) as Promise<T>;

try {
  console.log('▶ 雙耳方位（離線算繪 HRTF）');
  {
    const p = await openLab();
    const running = await lab<string>(p, 'L.audio.context ? L.audio.context.state : "none"');
    check(running === 'running', `音訊已啟動（${running}）`);
    // 聲源在 -x 3 m（面向深處時的右手邊）
    const probe = (yaw: number, mono = false) => lab<{ left: number; right: number }>(p, `L.audio.probe({ x: 0, z: 0, yaw: ${yaw}, sx: -3, sz: 0, mono: ${mono} })`);
    const cases: Array<[string, number, 'right' | 'left' | 'center']> = [
      ['面向深處：聲源在右邊', Math.PI, 'right'],
      ['面向入口：聲源在左邊', 0, 'left'],
      ['面向右翼：聲源在正前方（左右相近）', Math.PI / 2, 'center'],
      ['面向左翼：聲源在正後方（左右相近）', -Math.PI / 2, 'center'],
    ];
    for (const [label, yaw, side] of cases) {
      const { left, right } = await probe(yaw);
      const ratio = right / Math.max(1e-9, left);
      const ok = side === 'right' ? ratio > 1.5 : side === 'left' ? ratio < 1 / 1.5 : ratio > 0.7 && ratio < 1.4;
      check(ok, `${label}（右／左能量比 ${ratio.toFixed(2)}）`);
    }
    // 連續轉身（每次往右 22.5°，共 180°）：聲源先在右邊，轉到正對它時左右相同，再轉過去就到了左邊
    const ratios: number[] = [];
    for (let k = 0; k <= 8; k++) {
      const { left, right } = await probe(Math.PI - (k * Math.PI) / 8);
      ratios.push(right / left);
    }
    const sideOk = ratios.every((r, k) => (k < 4 ? r > 1.2 : k === 4 ? Math.abs(r - 1) < 0.2 : r < 1 / 1.2));
    check(sideOk, `往右轉 0°→180°：聲源從右邊經過正前方移到左邊（右／左比 ${ratios.map((r) => r.toFixed(2)).join(' → ')}）`);
    const mono = await probe(Math.PI, true);
    check(Math.abs(mono.left - mono.right) / Math.max(mono.left, mono.right) < 0.01, '單聲道模式：左右聲道相同');
    await p.close();
  }

  console.log('▶ 回聲視野（按 F 後短暫出現的結構模型）');
  {
    const p = await openLab();
    check((await p.locator('canvas').count()) === 0, '按 F 之前：頁面沒有任何 3D 畫布');
    const base = await brightRatio(p); // 說明文字的一部分會落在量測區域裡，以按下前的畫面為基準
    check(base < 0.01, `按 F 之前：畫面全黑（基準亮像素 ${(base * 100).toFixed(2)}%）`);
    const t0 = Date.now();
    await lab(p, 'L.pulse()');
    await p.waitForSelector('.echo-vision canvas, canvas.echo-vision, .echo-field canvas', { state: 'attached', timeout: 20000 });
    const solids = Number(await p.getAttribute('.echo-field', 'data-echo'));
    check(solids > 5, `回聲視野載入：範圍內有 ${solids} 個結構`);
    await p.waitForTimeout(Math.max(0, 1300 - (Date.now() - t0)));
    const lit = await brightRatio(p);
    check(lit - base > 0.008, `視野可見期間：畫面出現反白的結構（亮像素 ${(lit * 100).toFixed(1)}%）`);
    await p.screenshot({ path: 'e2e-shots/blind-vision.png' }).catch(() => undefined);
    const dur = await lab<number>(p, 'L.sys.echo.cfg.range / L.sys.echo.cfg.waveSpeed * 1000 + L.sys.echo.cfg.holdMs + L.sys.echo.cfg.fadeMs');
    await p.waitForTimeout(Math.max(0, dur + 600 - (Date.now() - t0)));
    const after = await brightRatio(p);
    check(Math.abs(after - base) < 0.002, `約 ${(dur / 1000).toFixed(1)} 秒後：視野完全消失（亮像素 ${(after * 100).toFixed(2)}%）`);
    const again = await lab<{ ok: boolean; reason?: string }>(p, 'L.pulse()');
    check(!again.ok && again.reason === 'cooldown', '視野消失後仍在冷卻：不能立刻再按（每次之間一定有一段全黑）');
    // 往前走到走廊入口再發一次：視野跟著新的位置
    await p.waitForFunction(() => (window as unknown as { __LAB__: { sys: { echo: { cooldownLeft(n: number): number } } } }).__LAB__.sys.echo.cooldownLeft(performance.now()) <= 0, undefined, { timeout: 8000 });
    await lab(p, 'Object.assign(L.pose, { x: 0, z: 13.5 })');
    await lab(p, 'L.pulse()');
    await p.waitForTimeout(1300);
    await p.screenshot({ path: 'e2e-shots/blind-vision-fork.png' }).catch(() => undefined);
    check((await brightRatio(p)) - base > 0.008, '在岔路前再發一次：照出岔路的結構');
    await p.close();
  }

  console.log('▶ 音訊路由與遮蔽');
  {
    const p = await openLab();
    await p.waitForTimeout(600);
    const modes = await lab<Record<string, string>>(
      p,
      `Object.fromEntries(['ref:LAB_START','ref:LAB_HALL','ref:LAB_FORK','lm:lab_drip','lm:lab_buzz'].map((id) => [id, L.sys.spatial.modeOf(id)]))`,
    );
    check(modes['ref:LAB_START'] === 'direct', '起點房間的參考音：直接聽到');
    check(['ref:LAB_HALL', 'ref:LAB_FORK', 'lm:lab_drip', 'lm:lab_buzz'].every((k) => modes[k] === 'none'), '其他區域的參考音與地標：聽不到（牆壁完全遮蔽）');
    check((await lab<number>(p, 'L.sys.spatial.liveCount()')) <= 2, '聽不到的聲源不建立音訊節點（只有附近的聲源在運作）');
    const env0 = await lab<number>(p, 'L.audio.meter("env")');
    check(env0 > 0, `環境匯流排有聲音（參考音與環境底噪，RMS ${env0.toFixed(4)}）`);
    check((await lab<boolean>(p, 'L.fakeVoice(true)')) === true, '模擬一位隊友說話');
    await lab(p, 'L.pulse()');
    await p.waitForTimeout(150);
    const levels = await lab<Record<string, number>>(p, `({ env: L.audio.meter('env'), echo: L.audio.meter('echo'), voice: L.audio.meter('voice') })`);
    check(levels.env > 0 && levels.echo > 0 && levels.voice > 0, `環境音、回聲、隊友語音同時播放（${Object.entries(levels).map(([k, v]) => `${k} ${v.toFixed(4)}`).join('、')}）`);
    await p.waitForTimeout(400);
    check((await lab<number>(p, 'L.audio.busValue("env")')) < 0.8, '隊友說話時，環境音自動壓低（回聲與語音維持原音量）');
    check((await lab<number>(p, 'L.audio.busValue("echo")')) === 1, '回聲匯流排不受影響');
    await lab(p, 'L.fakeVoice(false)');
    await p.waitForTimeout(500);
    check((await lab<number>(p, 'L.audio.busValue("env")')) > 0.95, '隊友停止說話後，環境音恢復');
    // 冷卻
    const again = await lab<{ ok: boolean; reason?: string }>(p, 'L.pulse()');
    check(!again.ok && again.reason === 'cooldown', '冷卻時間內再按：不會發出新的脈衝');
    await p.close();
  }

  console.log('▶ 回聲風險區（測試關卡在本機模擬週期）');
  {
    const p = await openLab();
    // 測試設定：直接把玩家放到感測器下方，等到警戒
    await lab(p, 'Object.assign(L.pose, { x: 0, z: 16.6 })');
    await p.waitForFunction(() => (window as unknown as { __LAB__: { riskState(): string } }).__LAB__.riskState() === 'armed', undefined, { timeout: 15000 });
    await p.waitForTimeout(200);
    const heard = await lab<string>(p, 'L.sys.spatial.modeOf("risk:lab_sensor")');
    check(heard === 'direct', '警戒中：在岔路聽得到感測器的滴答聲（可學習的預警）');
    const r1 = await lab<{ ok: boolean }>(p, 'L.pulse()');
    check(r1.ok && (await lab<number>(p, 'L.state.jams')) === 1, '警戒中發出回聲：被偵測');
    await p.waitForTimeout(1300);
    const r2 = await lab<{ ok: boolean; reason?: string }>(p, 'L.pulse()');
    check(!r2.ok && r2.reason === 'jammed', '干擾期間：回聲只有雜訊');
    await p.waitForFunction(() => !(window as unknown as { __LAB__: { sys: { echo: { jammed(n: number): boolean } } } }).__LAB__.sys.echo.jammed(performance.now()), undefined, {
      timeout: 8000,
    });
    await p.waitForFunction(() => (window as unknown as { __LAB__: { sys: { echo: { cooldownLeft(n: number): number } } } }).__LAB__.sys.echo.cooldownLeft(performance.now()) <= 0, undefined, {
      timeout: 8000,
    });
    // 離開範圍（往左翼走 3 m）：一般區域可以自由使用回聲
    await lab(p, 'Object.assign(L.pose, { x: 4.5, z: 16.25 })');
    const r3 = await lab<{ ok: boolean }>(p, 'L.pulse()');
    check(r3.ok && (await lab<number>(p, 'L.state.jams')) === 1, '干擾結束、離開感測器範圍後：回聲恢復，不會再被偵測（可以挽回）');
    await p.close();
  }

  console.log('▶ 實際遊玩：只靠聲音資訊的自動玩家');
  {
    const p = await openLab();
    // 隨機的起始朝向（玩家一開始不一定面向正確方向）
    await lab(p, 'L.turn(0.9)');
    const log: string[] = [];
    const t0 = Date.now();

    const heading = () => lab<{ label: string }>(p, 'L.heading()');
    const turn = (rad: number) => lab(p, `L.turn(${rad})`);
    /** 等到可以安全發出回聲：冷卻結束；如果聽得到感測器在預警或警戒，就等它安靜 */
    const safePulse = async (): Promise<Hit[]> => {
      for (let guard = 0; guard < 200; guard++) {
        const cool = await lab<number>(p, 'L.sys.echo.cooldownLeft(performance.now())');
        const jam = await lab<boolean>(p, 'L.sys.echo.jammed(performance.now())');
        const sensor = await lab<string>(p, 'L.sys.spatial.modeOf("risk:lab_sensor")');
        if (cool <= 0 && !jam && sensor === 'none') break;
        if (sensor !== 'none' && guard % 10 === 0) log.push('聽到感測器在響：等待');
        await p.waitForTimeout(150);
      }
      const r = await lab<{ ok: boolean; hits?: Hit[] }>(p, 'L.pulse()');
      if (!r.ok || !r.hits) throw new Error('回聲沒有成功');
      return r.hits;
    };
    /** 按住 W 走 d 公尺（實際距離取決於碰撞，之後再用回聲確認） */
    const walk = async (d: number) => {
      await p.keyboard.down('KeyW');
      await p.waitForTimeout(Math.max(120, (d / 2.3) * 1000));
      await p.keyboard.up('KeyW');
      await p.waitForTimeout(60);
    };

    // 1. 用方向基準轉到「深處」（每次轉 45°，靠轉向提示與 V 的播報）
    for (let i = 0; i < 8 && (await heading()).label !== '深處'; i++) await turn(Math.PI / 4);
    log.push(`朝向：${(await heading()).label}`);

    let goal: 'metal' | 'machine' = 'metal';
    let lastTurn = 0;
    for (let step = 0; step < 60; step++) {
      const hits = await safePulse();
      const target = hits.filter((h) => h.hit && h.material === goal).sort((a, b) => a.dist - b.dist)[0];
      if (target) {
        await turn(target.rel);
        if (target.dist < 1.6) {
          const what = await lab<string>(p, 'L.interact()');
          log.push(`在 ${target.dist.toFixed(1)} m 處聽到${goal === 'metal' ? '金屬門' : '設備'}，按 E → ${what}`);
          if (what === 'door') goal = 'machine';
          if (what === 'target') break;
          continue;
        }
        log.push(`聽到${goal === 'metal' ? '金屬門' : '設備'}在 ${((target.rel * 180) / Math.PI).toFixed(0)}°、${target.dist.toFixed(1)} m：走過去`);
        await walk(Math.min(3, target.dist - 1.2));
        continue;
      }
      // 沒有聽到目標：往最開闊、而且最接近正前方的方向走（不走回頭路）
      const options = hits
        .filter((h) => Math.abs(h.rel) < (Math.PI * 2) / 3)
        .map((h) => ({ h, score: h.dist - Math.abs(h.rel) * 1.2 - (h.hit ? 0 : -1.5) }))
        .sort((a, b) => b.score - a.score);
      const best = options[0]?.h;
      if (!best || best.dist < 1.4) {
        await turn(Math.PI / 2);
        lastTurn++;
        log.push('前方被擋住：轉 90°');
        continue;
      }
      await turn(best.rel);
      await walk(Math.min(3, best.dist - 1.2));
    }
    const st = await lab<{ door: boolean; done: boolean; pulses: number; jams: number; startedAt: number; doneAt: number }>(p, '({ ...L.state })');
    for (const l of log) console.log(`    · ${l}`);
    check(st.door, '在岔路找到並打開金屬門');
    check(st.done, `找到目標設備（${st.pulses} 次回聲、${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
    check(st.jams === 0, '全程沒有被感測器偵測（聽到預警就等待）');
    void lastTurn;
    await p.screenshot({ path: 'e2e-shots/blind-lab.png' }).catch(() => undefined);
    await p.close();
  }

  console.log('▶ 設計者俯視圖（&map=1）');
  {
    const p = await openLab('&map=1');
    await lab(p, 'L.pulse()');
    await p.waitForTimeout(250);
    check((await p.locator('.lab-map').count()) === 1, '俯視圖只在 &map=1 時出現');
    await p.screenshot({ path: 'e2e-shots/blind-lab-map.png' }).catch(() => undefined);
    await p.close();
    const q = await openLab();
    check((await q.locator('.lab-map').count()) === 0, '一般模式沒有俯視圖');
    await q.close();
  }
} catch (e) {
  console.error('✘', (e as Error).message);
  failures++;
}

await browser.close();
console.log(failures ? `\n${failures} 項失敗` : '\n全部通過 ✔');
process.exitCode = failures ? 1 : 0;
