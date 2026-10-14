import { describe, expect, it } from 'vitest';
import {
  BLIND_LAB,
  CHAPTER1_ACOUSTICS,
  DOOR_SLOTS,
  ECHO_CONFIG,
  LAB_SPAWN,
  PORTALS,
  ROOM_COUNT,
  audibility,
  buildColliders,
  castEcho,
  closedDoors,
  forwardOf,
  headingOf,
  labColliders,
  planEcho,
  rayBox,
  relativeAzimuth,
  riskPhase,
  summarizeEcho,
  wallZ,
  zoneOfPoint,
  type Box,
  DOOR_HEIGHT,
  visionDurationMs,
  visionSolids,
} from '@null-protocol/shared';
import { EchoRiskTracker } from '../src/game/echoRisk';

const deg = (r: number) => (r * 180) / Math.PI;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/**
 * Web Audio 規格中 PannerNode 的方位角計算（"Azimuth and Elevation"），照規格逐步實作，
 * 用來確認我們設定聽者的方式（forward＝forwardOf(yaw)、up＝+y）與移動／鏡頭的座標一致。
 */
function webAudioAzimuth(listener: [number, number, number], forward: [number, number, number], source: [number, number, number]): number {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  const norm = (a: number[]) => {
    const l = Math.hypot(...a) || 1;
    return a.map((v) => v / l);
  };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const up = [0, 1, 0];
  const right = norm(cross(forward, up));
  const sl = norm(sub(source, listener));
  const proj = norm(sub(sl, up.map((u) => u * dot(sl, up))));
  let az = deg(Math.acos(Math.max(-1, Math.min(1, dot(proj, right)))));
  if (dot(proj, forward) < 0) az = 360 - az;
  az = az >= 0 && az <= 270 ? 90 - az : 450 - az;
  return az;
}

describe('A. 方向基準：座標一致', () => {
  it('四個基本朝向的名稱：yaw=π 面向深處（+z）、往右轉 90° 面向右翼（-x）', () => {
    expect(headingOf(Math.PI).label).toBe('深處');
    expect(headingOf(Math.PI / 2).label).toBe('右翼');
    expect(headingOf(0).label).toBe('入口');
    expect(headingOf(-Math.PI / 2).label).toBe('左翼');
    expect(headingOf(Math.PI - Math.PI / 4).label).toBe('深處偏右翼');
    // 往右轉＝滑鼠往右＝yaw 減少；右翼就是面向深處時的右手邊
    const [fx, fz] = forwardOf(Math.PI / 2);
    expect(fx).toBeCloseTo(-1);
    expect(fz).toBeCloseTo(0);
  });

  it('玩家面對四個基本方向時，固定聲源的方位與 Web Audio 的計算一致', () => {
    const src: [number, number] = [0, 5]; // 正「深處」5 m
    const expected: Record<string, number> = { 深處: 0, 右翼: -90, 入口: 180, 左翼: 90 };
    for (const yaw of [Math.PI, Math.PI / 2, 0, -Math.PI / 2]) {
      const label = headingOf(yaw).label;
      const ours = relativeAzimuth(0, 0, yaw, src[0], src[1]);
      const [fx, fz] = forwardOf(yaw);
      const wa = webAudioAzimuth([0, 1.6, 0], [fx, 0, fz], [src[0], 1.6, src[1]]);
      const want = expected[label];
      expect(near(Math.abs(ours), Math.abs(want), 1e-6) && (want === 180 || near(ours, want, 1e-6))).toBe(true);
      // Web Audio 的 ±180 等價
      expect(near(((wa - ours + 540) % 360) - 180, 0, 1e-6)).toBe(true);
    }
  });

  it('隨機位置與朝向：方位角與 Web Audio 一致（左右不會顛倒）', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 200; i++) {
      const lx = rnd() * 6;
      const lz = rnd() * 50;
      const yaw = rnd() * Math.PI * 3;
      const sx = rnd() * 6;
      const sz = lz + rnd() * 8;
      const [fx, fz] = forwardOf(yaw);
      const wa = webAudioAzimuth([lx, 1.6, lz], [fx, 0, fz], [sx, 1.6, sz]);
      const ours = relativeAzimuth(lx, lz, yaw, sx, sz);
      expect(Math.abs(((wa - ours + 540) % 360) - 180)).toBeLessThan(1e-6);
    }
  });

  it('旋轉鏡頭時，聲源方位跟著連續更新（往右轉，聲源往左移）', () => {
    let prev = relativeAzimuth(0, 0, Math.PI, 0, 5);
    for (let k = 1; k <= 12; k++) {
      const yaw = Math.PI - (k * Math.PI) / 18; // 每次往右轉 10°
      const az = relativeAzimuth(0, 0, yaw, 0, 5);
      expect(az).toBeCloseTo(prev - 10, 6);
      prev = az;
    }
  });
});

describe('A. 參考音（通風口）', () => {
  it('每個房間一個；位置在房間內；離任何門、假門、門洞至少 2 m（不會變成找門的提示）', () => {
    const ref = CHAPTER1_ACOUSTICS.reference;
    expect(ref).toHaveLength(ROOM_COUNT);
    expect(new Set(ref.map((r) => r.zone)).size).toBe(ROOM_COUNT);
    for (const r of ref) {
      expect(zoneOfPoint(CHAPTER1_ACOUSTICS, r.pos[0], r.pos[1])).toBe(r.zone);
      for (const s of DOOR_SLOTS) expect(Math.hypot(r.pos[0] - s.x, r.pos[1] - wallZ(s.wall))).toBeGreaterThanOrEqual(2);
      for (const p of PORTALS) expect(Math.hypot(r.pos[0] - p.pos[0], r.pos[1] - p.pos[1])).toBeGreaterThanOrEqual(2);
    }
  });

  it('遮蔽：只有同一個房間聽得到；門開著也不會傳到隔壁（不能隔牆追蹤）', () => {
    const vent = { ...CHAPTER1_ACOUSTICS.reference[0] };
    const open = () => true;
    expect(audibility(CHAPTER1_ACOUSTICS, vent, 'R1', open).mode).toBe('direct');
    expect(audibility(CHAPTER1_ACOUSTICS, vent, 'R2', open).mode).toBe('none');
    expect(audibility(CHAPTER1_ACOUSTICS, vent, null, open).mode).toBe('none');
  });
});

describe('B. 主動回聲：反映實際幾何', () => {
  const lab = (open = false) => labColliders(open);

  it('slab 求交：正確的進入距離；平行或背向不相交', () => {
    const b = { minX: 2, maxX: 3, minZ: -1, maxZ: 1 };
    expect(rayBox(0, 0, 1, 0, b, 10)).toBeCloseTo(2);
    expect(rayBox(0, 0, -1, 0, b, 10)).toBeNull();
    expect(rayBox(0, 2, 1, 0, b, 10)).toBeNull();
    expect(rayBox(0, 0, 1, 0, b, 1.5)).toBeNull(); // 超過距離上限
  });

  it('射線數與距離上限來自設定；第 0 道朝正前方、往右遞增', () => {
    const hits = castEcho(LAB_SPAWN.x, LAB_SPAWN.z, LAB_SPAWN.yaw, lab(), BLIND_LAB.materialOf);
    expect(hits).toHaveLength(ECHO_CONFIG.rays);
    expect(hits[0].rel).toBe(0);
    expect(deg(hits[ECHO_CONFIG.rays / 4].rel)).toBeCloseTo(90);
    for (const h of hits) expect(h.dist).toBeLessThanOrEqual(ECHO_CONFIG.range);
  });

  it('起點：前方是走廊（8 m 內沒有反射）、背後 1.5 m、左右各 3 m 的混凝土牆', () => {
    const hits = castEcho(0, 1.5, Math.PI, lab(), BLIND_LAB.materialOf);
    const at = (d: number) => hits.find((h) => near(deg(h.rel), d, 1e-6))!;
    expect(at(0).hit).toBe(false);
    expect(at(0).dist).toBe(ECHO_CONFIG.range);
    expect(at(180).dist).toBeCloseTo(1.5);
    expect(at(90).dist).toBeCloseTo(3);
    expect(at(-90).dist).toBeCloseTo(3);
    for (const d of [90, -90, 180]) expect(at(d).material).toBe('concrete');
    // 扇區摘要（單聲道語音用）：每個 90° 扇區最近的反射
    expect(summarizeEcho(hits).back).toBeCloseTo(1.5);
  });

  it('同樣的位置與朝向永遠得到同樣的結果（不是隨機音效）', () => {
    const a = castEcho(0.3, 10, Math.PI - 0.4, lab(), BLIND_LAB.materialOf);
    const b = castEcho(0.3, 10, Math.PI - 0.4, lab(), BLIND_LAB.materialOf);
    expect(a).toEqual(b);
  });

  it('轉身後，同一面牆出現在另一側（相對方位跟著朝向改變）', () => {
    const facingDeep = summarizeEcho(castEcho(-2, 3, Math.PI, lab(), BLIND_LAB.materialOf));
    const facingRight = summarizeEcho(castEcho(-2, 3, Math.PI / 2, lab(), BLIND_LAB.materialOf));
    // -x 的牆距離 1 m：面向深處時在右邊，面向右翼時在前方
    expect(facingDeep.right).toBeCloseTo(1);
    expect(facingRight.front).toBeCloseTo(1);
  });

  it('走廊盡頭的岔路：斜前方的射線比兩側長（聽得出空間在那裡延伸）', () => {
    const hits = castEcho(0, 13.8, Math.PI, lab(), BLIND_LAB.materialOf);
    const at = (d: number) => hits.find((h) => near(deg(h.rel), d, 1e-6))!;
    expect(at(90).dist).toBeCloseTo(1);
    expect(at(-90).dist).toBeCloseTo(1);
    expect(at(45).dist).toBeGreaterThan(at(90).dist * 1.4);
    expect(at(-45).dist).toBeGreaterThan(at(-90).dist * 1.4);
  });

  it('門與材質：關著的門是金屬；開門後射線穿過門洞，打到後面的目標設備', () => {
    const facingDoor = -Math.PI / 2; // 面向左翼（+x）
    const closed = castEcho(5, 16.25, facingDoor, lab(false), BLIND_LAB.materialOf)[0];
    expect(closed.material).toBe('metal');
    expect(closed.dist).toBeCloseTo(2);
    const opened = castEcho(5, 16.25, facingDoor, lab(true), BLIND_LAB.materialOf)[0];
    expect(opened.dist).toBeGreaterThan(closed.dist + 4);
    expect(opened.material).toBe('machine');
    // 岔路另一頭的死巷是木櫃
    const dead = castEcho(-3, 16.25, Math.PI / 2, lab(), BLIND_LAB.materialOf)[0];
    expect(dead.material).toBe('wood');
  });

  it('不穿牆：每道射線只回報第一個反射，牆後的物體永遠不會出現', () => {
    // 正式關卡：R1 裡面朝 R2 方向，前牆（含關著的門）擋住，R2 的任何設備都不會被回報
    const cols = buildColliders(closedDoors());
    const hits = castEcho(0, 8, Math.PI, cols, CHAPTER1_ACOUSTICS.materialOf, { rays: 64, range: 8 });
    for (const h of hits) {
      if (h.hit) expect(h.z).toBeLessThanOrEqual(wallZ(1) + 1e-6);
      expect(h.boxId?.startsWith('prop_r2')).toBeFalsy();
    }
    // 門關著時正前方是金屬門
    expect(hits[0].material).toBe('metal');
  });

  it('播放規則：近的反射較早、較大聲、較亮；沒有反射的方向只有微弱的空氣聲', () => {
    const plan = planEcho(castEcho(0, 3, Math.PI, lab(), BLIND_LAB.materialOf));
    const returns = plan.voices.filter((v) => v.kind === 'return').sort((a, b) => a.dist - b.dist);
    for (let i = 1; i < returns.length; i++) {
      const [a, b] = [returns[i - 1], returns[i]];
      if (b.dist - a.dist < 0.05 || a.material !== b.material) continue;
      expect(a.at).toBeLessThan(b.at);
      expect(a.gain).toBeGreaterThan(b.gain);
      expect(a.cutoff).toBeGreaterThan(b.cutoff);
    }
    const open = plan.voices.filter((v) => v.kind === 'open');
    expect(open.length).toBeGreaterThan(0);
    for (const v of open) expect(v.gain).toBeLessThan(Math.min(...returns.map((r) => r.gain)));
  });

  it('開放空間的殘響較長：岔路 > 走廊中段', () => {
    const hall = planEcho(castEcho(0, 10, Math.PI, lab(), BLIND_LAB.materialOf));
    const fork = planEcho(castEcho(0, 16.25, Math.PI, lab(), BLIND_LAB.materialOf));
    expect(fork.tail).toBeGreaterThan(hall.tail);
  });

  it('效能：每次脈衝只測試附近的碰撞盒（正式關卡也一樣）', () => {
    const cols = buildColliders(closedDoors());
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) castEcho(0, 30 + (i % 10), i, cols, CHAPTER1_ACOUSTICS.materialOf);
    expect((performance.now() - t0) / 200).toBeLessThan(2); // 每次遠低於一幀
  });
});

describe('B2. 回聲視野（按 F 後短暫看到的結構模型）', () => {
  const cols = buildColliders(closedDoors());
  const r1 = { x: 0, z: 5 };

  it('只有幾何：每個立體只有種類與六個邊界，沒有識別碼、設備名稱或任何其他欄位', () => {
    const solids = visionSolids(cols, r1.x, r1.z, ECHO_CONFIG.range, CHAPTER1_ACOUSTICS, [[1, 5]]);
    expect(solids.length).toBeGreaterThan(5);
    for (const s of solids) expect(Object.keys(s).sort()).toEqual(['kind', 'maxX', 'maxY', 'maxZ', 'minX', 'minY', 'minZ']);
    expect(JSON.stringify(solids)).not.toMatch(/r1_|prop_|d1|label/);
  });

  it('有距離上限：範圍外的牆、設備、隊友都不會出現（看不到完整地圖）', () => {
    const range = ECHO_CONFIG.range;
    const solids = visionSolids(cols, r1.x, r1.z, range, CHAPTER1_ACOUSTICS, [[0, 40]]);
    for (const s of solids) {
      const dx = Math.max(s.minX - r1.x, 0, r1.x - s.maxX);
      const dz = Math.max(s.minZ - r1.z, 0, r1.z - s.maxZ);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(range + 0.5);
    }
    expect(solids.some((s) => s.kind === 'body')).toBe(false);
    // R3 以後的任何東西都不會出現在 R1 的視野裡
    expect(solids.every((s) => s.minZ < wallZ(2) + 1)).toBe(true);
  });

  it('門：關著是門板；打開後門板消失，但門楣還在（看得出那裡有一個開口）', () => {
    const near = { x: 0, z: wallZ(1) - 2 };
    const closed = visionSolids(cols, near.x, near.z, 6, CHAPTER1_ACOUSTICS);
    const door = (ss: typeof closed) => ss.filter((s) => s.kind === 'door' && s.minZ === wallZ(1));
    expect(door(closed)).toHaveLength(1);
    expect(door(closed)[0].maxY).toBe(DOOR_HEIGHT);
    const open = visionSolids(buildColliders({ ...closedDoors(), d1: true }), near.x, near.z, 6, CHAPTER1_ACOUSTICS);
    expect(door(open)).toHaveLength(0);
    expect(open.some((s) => s.kind === 'wall' && s.minY === DOOR_HEIGHT && s.minZ === wallZ(1) && s.minX === -1)).toBe(true);
  });

  it('設備外形用設備的實際高度；R4 的門洞在牆上有輪廓', () => {
    const r4 = visionSolids(cols, 0, wallZ(3) + 5, ECHO_CONFIG.range, CHAPTER1_ACOUSTICS);
    expect(r4.filter((s) => s.kind === 'frame')).toHaveLength(4);
    const props = visionSolids(cols, 0, 5, ECHO_CONFIG.range, CHAPTER1_ACOUSTICS).filter((s) => s.kind === 'prop');
    expect(new Set(props.map((p) => p.maxY)).size).toBeGreaterThan(1);
  });

  it('時間：視野顯示的時間短於冷卻時間（每次之間一定有一段全黑）', () => {
    expect(visionDurationMs()).toBeLessThan(ECHO_CONFIG.cooldownMs);
    expect(visionDurationMs()).toBeGreaterThan(2500);
  });
});

describe('C. 聲學地標', () => {
  it('每個地標都在自己的區域內、識別碼不重複；R4（無窗迷宮）沒有地標', () => {
    const ids = new Set<string>();
    for (const l of CHAPTER1_ACOUSTICS.landmarks) {
      expect(zoneOfPoint(CHAPTER1_ACOUSTICS, l.pos[0], l.pos[1])).toBe(l.zone);
      expect(ids.has(l.id)).toBe(false);
      ids.add(l.id);
    }
    expect(CHAPTER1_ACOUSTICS.landmarks.some((l) => l.zone === 'R4')).toBe(false);
    for (const l of BLIND_LAB.landmarks) expect(zoneOfPoint(BLIND_LAB, l.pos[0], l.pos[1])).toBe(l.zone);
  });

  it('遮蔽規則：門關著隔壁聽不到；門開著時從門洞傳來悶聲（方位在門洞上）；沒有列出的房間永遠聽不到', () => {
    const pipe = CHAPTER1_ACOUSTICS.landmarks.find((l) => l.id === 'r3_pipe')!;
    const closed = () => false;
    const open = () => true;
    expect(audibility(CHAPTER1_ACOUSTICS, pipe, 'R3', closed).mode).toBe('direct');
    expect(audibility(CHAPTER1_ACOUSTICS, pipe, 'R2', closed).mode).toBe('none');
    const via = audibility(CHAPTER1_ACOUSTICS, pipe, 'R2', open);
    expect(via.mode).toBe('muffled');
    const d2 = DOOR_SLOTS.find((s) => s.id === 'd2')!;
    if (via.mode === 'muffled') expect(via.pos[0]).toBe(d2.x);
    expect(audibility(CHAPTER1_ACOUSTICS, pipe, 'R4', open).mode).toBe('none');
    const drip = CHAPTER1_ACOUSTICS.landmarks.find((l) => l.id === 'r2_drip')!;
    expect(audibility(CHAPTER1_ACOUSTICS, drip, 'R3', open).mode).toBe('none');
  });

  it('開口資料與門一致：每扇真正會開的門都是一個開口，假門不是', () => {
    const real = DOOR_SLOTS.filter((s) => s.doorId);
    expect(CHAPTER1_ACOUSTICS.openings.map((o) => o.id).sort()).toEqual(real.map((s) => s.id).sort());
    expect(CHAPTER1_ACOUSTICS.openings.find((o) => o.id === 'd10')?.b).toBe('EXIT');
  });
});

describe('D. 回聲風險區（伺服器權威）', () => {
  const def = CHAPTER1_ACOUSTICS.risks[0];

  it('週期：休息 → 預警 → 警戒 → 休息；只有警戒時會偵測', () => {
    expect(riskPhase(def, 0).state).toBe('idle');
    expect(riskPhase(def, def.idleMs - def.warnMs + 1).state).toBe('warning');
    expect(riskPhase(def, def.idleMs + 1).state).toBe('armed');
    expect(riskPhase(def, def.idleMs + def.armedMs + 1).state).toBe('idle');
    expect(riskPhase(def, def.idleMs + 10).msLeft).toBe(def.armedMs - 10);
  });

  it('只覆蓋 R8 的中央；R8 的四個儀表都在偵測範圍外（一般探索仍可自由使用回聲）', () => {
    expect(CHAPTER1_ACOUSTICS.risks.every((r) => r.zone === 'R8')).toBe(true);
    for (const id of ['r8_pressure', 'r8_temp', 'r8_flow', 'r8_volt']) {
      const box = buildColliders(closedDoors()).find((b: Box) => b.id === `prop_${id}`)!;
      const cx = (box.minX + box.maxX) / 2;
      const cz = (box.minZ + box.maxZ) / 2;
      expect(Math.hypot(cx - def.pos[0], cz - def.pos[1])).toBeGreaterThan(def.radius + 1.5);
    }
  });

  it('偵測：警戒中、範圍內才觸發；休息時、範圍外、別的房間都不會；干擾期間與過於頻繁的脈衝被忽略', () => {
    let now = 1_000_000;
    const tr = new EchoRiskTracker([def], () => now);
    const [x, z] = def.pos;
    expect(tr.pulse(x, z, 'R8')).toBeNull(); // 休息中
    now += def.idleMs + 100; // 警戒
    expect(tr.pulse(x + def.radius + 0.5, z, 'R8')).toBeNull(); // 範圍外
    now += 2000;
    expect(tr.pulse(x, z, 'R7')).toBeNull(); // 區域不符
    now += 2000;
    expect(tr.pulse(x, z, 'R8')).toEqual({ id: def.id, jamMs: def.jamMs });
    now += 2000;
    expect(tr.pulse(x, z, 'R8')).toBeNull(); // 干擾中
    now += def.jamMs + def.idleMs + 200; // 下一輪警戒
    const st = tr.statuses()[0];
    if (st.state === 'armed') {
      expect(tr.pulse(x, z, 'R8')).not.toBeNull();
      now += 100;
      expect(tr.pulse(x, z, 'R8')).toBeNull(); // 太頻繁
    }
  });

  it('狀態改變才回報；回報內容只有識別碼、狀態與剩餘時間', () => {
    let now = 0;
    const tr = new EchoRiskTracker([def], () => now);
    expect(tr.tick()).toBeNull();
    now = def.idleMs - def.warnMs + 10;
    const s = tr.tick();
    expect(s?.[0]).toEqual({ id: def.id, state: 'warning', msLeft: def.warnMs - 10 });
    expect(tr.tick()).toBeNull();
  });
});
