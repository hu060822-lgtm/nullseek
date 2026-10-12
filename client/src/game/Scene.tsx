import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  EdgesGeometry,
  FogExp2,
  InstancedMesh,
  LineBasicMaterial,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  TorusGeometry,
  type Group,
  type LineSegments,
  type Mesh,
  type PointLight,
  type Texture,
} from 'three';
import {
  DEVICES,
  DEVICE_BY_ID,
  DOOR_BOX_BY_ID,
  DOOR_SLOTS,
  EXIT_RECT,
  LAMP_HEX,
  PORTALS,
  PUZZLE_IDS,
  ROLE_INFO,
  ROOM_PITCH,
  TOKEN_LABEL,
  WALL_BOXES,
  WALL_HEIGHT,
  ZONES,
  roleCanUseDevice,
  roomRect,
  type Box,
  type DeviceDef,
  type DoorSlot,
  type PortalDef,
  type Role,
  type SceneClues,
  type WorldPublic,
  type ZoneDef,
} from '@null-protocol/shared';
import { useStore, type Marker } from '../state/store';
import { on } from './bus';
import { deviceCode, roomCode } from './codes';
import { currentTarget, pose } from './controller';
import { remotes } from './remote';
import {
  C,
  ceilingTile,
  contactShadow,
  crtScreen,
  devicePlate,
  floorTile,
  markPlate,
  nameTexture,
  paperSheet,
  punchCard,
  rolePlate,
  roomSign,
  symbolPlate,
  wallPanel,
  wallShadow,
} from './textures';

/*
 * 美術方向：後工業極簡主義 × 復古科學儀器 × 非自然空間構成
 *  - 十個房間沿 +z 線性排列，模組完全相同（12 × 10 m、等距燈具、等距牆板）；差異只來自設備與異常。
 *  - 骨白琺瑯、霧灰粉體烤漆、炭黑橡膠；黃銅只用在可操作的機械部件；朱紅只用在「鎖定」的門燈。
 *  - 異常（皆有可辨認的規則，且不影響碰撞）：
 *      1. 每個房間恰有一盞燈具錯位半個模組並轉了 90°
 *      2. 「沒有門的門框」：只出現在沒有設備的側牆段；真正的門框上方一定有狀態燈
 *      3. 出口走廊的門框一個比一個低（每個低 0.15 公尺），間距一個比一個短
 *      4. 設施核心天花板上的巨大圓環：每完成一道謎題，缺口就縮小一段；十題全部完成才閉合
 *      5. 無窗迷宮與循環走廊的門洞：門洞後面不是另一側的房間，而是一片沒有深度的暗面
 *  - 角色專屬線索（伺服器依角色授權後才送來）：靜默員看得到 R01 符號燈、R02 門燈、R09 門標籤與燈號；
 *    看得見的人看得到 R04 的地標。沒有授權的人看到的是同一個場景、但燈是熄的。
 *  - 光照：三盞跟著玩家所在房間移動的點光源＋半球光；陰影用烘焙式的接觸陰影貼圖。
 */

const DOOR_H = 2.6;
const VIEW_ROOMS = 3; // 只渲染目前房間前後各 3 間（更遠的被霧與牆遮住）

/* ------------------------------- 共用材質 ------------------------------- */

const M = {
  enamel: new MeshStandardMaterial({ color: C.bone, roughness: 0.42, metalness: 0.05 }),
  enamel2: new MeshStandardMaterial({ color: '#D3CFC4', roughness: 0.5, metalness: 0.05 }),
  powder: new MeshStandardMaterial({ color: C.fog, roughness: 0.72, metalness: 0.15 }),
  ink: new MeshStandardMaterial({ color: C.ink, roughness: 0.85, metalness: 0.1 }),
  brass: new MeshStandardMaterial({ color: C.brass, roughness: 0.32, metalness: 0.85 }),
  steel: new MeshStandardMaterial({ color: '#8F928E', roughness: 0.38, metalness: 0.8 }),
  glassOff: new MeshStandardMaterial({ color: '#4A4D4E', roughness: 0.15, metalness: 0.2 }),
  frosted: new MeshStandardMaterial({ color: '#C9C6BD', roughness: 0.9, metalness: 0, transparent: true, opacity: 0.92 }),
  void: new MeshBasicMaterial({ color: '#1B1D1E' }),
};
const lineInk = new LineBasicMaterial({ color: C.ink });
const lineRed = new LineBasicMaterial({ color: C.red });

function useRepeat(tex: Texture, rx: number, ry: number): Texture {
  return useMemo(() => {
    const t = tex.clone();
    t.repeat.set(Math.max(0.25, rx), Math.max(0.25, ry));
    t.needsUpdate = true;
    return t;
  }, [tex, rx, ry]);
}

type V3 = [number, number, number];
function B({ p, s, m, r }: { p: V3; s: V3; m: MeshStandardMaterial | MeshBasicMaterial; r?: V3 }): JSX.Element {
  return (
    <mesh position={p} rotation={r} material={m}>
      <boxGeometry args={s} />
    </mesh>
  );
}
function Cyl({ p, r, h, m, rot, seg = 16 }: { p: V3; r: number; h: number; m: MeshStandardMaterial; rot?: V3; seg?: number }): JSX.Element {
  return (
    <mesh position={p} rotation={rot} material={m}>
      <cylinderGeometry args={[r, r, h, seg]} />
    </mesh>
  );
}

/* ------------------------------- 房間與電力 ------------------------------- */

/** 玩家所在的房間編號（1–10；出口走廊為 11） */
const roomAtZ = (z: number): number => Math.min(11, Math.max(1, Math.floor(z / ROOM_PITCH) + 1));

/** 進行中的謎題所在房間；章節完成後為 11 */
function activeRoom(w: WorldPublic | null): number {
  if (!w) return 1;
  if (w.chapterComplete || !w.activePuzzle) return 11;
  return PUZZLE_IDS.indexOf(w.activePuzzle) + 1;
}

/** 尚未抵達的房間保持低電力；出口走廊在最後一扇門打開後才亮 */
function roomPower(index: number, w: WorldPublic | null): number {
  if (!w) return 1;
  if (index === 11) return w.doors.d10 ? 1.25 : 0.15;
  return index <= activeRoom(w) ? 1 : 0.3;
}

/** 依玩家位置只顯示附近的房間 */
function RoomGroup({ index, children }: { index: number; children: ReactNode }): JSX.Element {
  const ref = useRef<Group>(null);
  useFrame(() => {
    if (ref.current) ref.current.visible = Math.abs(roomAtZ(pose.z) - index) <= VIEW_ROOMS;
  });
  return <group ref={ref}>{children}</group>;
}

/* ------------------------------- 建築外殼 ------------------------------- */

function ZoneShell({ z }: { z: ZoneDef }): JSX.Element {
  const w = z.maxX - z.minX;
  const d = z.maxZ - z.minZ;
  const cx = (z.minX + z.maxX) / 2;
  const cz = (z.minZ + z.maxZ) / 2;
  const floor = useRepeat(floorTile(), w + 0.4, d + 0.4);
  const ceil = useRepeat(ceilingTile(), (w + 0.4) / 1.2, (d + 0.4) / 1.2);
  const shadow = wallShadow();
  const strips: Array<{ p: V3; rot: number; len: number }> = [
    { p: [cx, 0.004, z.minZ + 0.3], rot: 0, len: w },
    { p: [cx, 0.004, z.maxZ - 0.3], rot: Math.PI, len: w },
    { p: [z.maxX - 0.3, 0.004, cz], rot: -Math.PI / 2, len: d },
    { p: [z.minX + 0.3, 0.004, cz], rot: Math.PI / 2, len: d },
  ];
  return (
    <group>
      <mesh position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.4, d + 0.4]} />
        <meshStandardMaterial map={floor} roughness={0.8} metalness={0.05} />
      </mesh>
      <mesh position={[cx, WALL_HEIGHT, cz]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.4, d + 0.4]} />
        <meshStandardMaterial map={ceil} roughness={0.95} />
      </mesh>
      {strips.map((s, i) => (
        <group key={i} position={s.p} rotation={[0, s.rot, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[s.len, 0.6]} />
            <meshBasicMaterial map={shadow} transparent depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function WallMesh({ box }: { box: Box }): JSX.Element {
  const w = box.maxX - box.minX;
  const d = box.maxZ - box.minZ;
  const tex = useRepeat(wallPanel(), Math.max(w, d) / 1.2, 1);
  const cx = (box.minX + box.maxX) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  return (
    <group>
      <mesh position={[cx, WALL_HEIGHT / 2, cz]}>
        <boxGeometry args={[w, WALL_HEIGHT, d]} />
        <meshStandardMaterial map={tex} roughness={0.55} metalness={0.05} />
      </mesh>
      <B p={[cx, 0.06, cz]} s={[w + 0.04, 0.12, d + 0.04]} m={M.ink} />
    </group>
  );
}

/* ------------------------------- 燈具與光源 ------------------------------- */

const fixtureGeo = new BoxGeometry(1.2, 0.04, 0.16);
const housingGeo = new BoxGeometry(1.32, 0.05, 0.28);

function Fixtures({ z }: { z: ZoneDef }): JSX.Element {
  const lit = useRef<InstancedMesh>(null);
  const housing = useRef<InstancedMesh>(null);
  const power = useStore((s) => roomPower(z.index, s.world));
  const mat = useMemo(() => new MeshBasicMaterial({ color: '#F6F4EE' }), []);
  const spots = useMemo(() => {
    const out: Array<{ x: number; z: number; rot: number }> = [];
    const w = z.maxX - z.minX;
    const d = z.maxZ - z.minZ;
    const cols = Math.max(1, Math.floor(w / 2.5));
    const rows = Math.max(1, Math.floor(d / 2.5));
    const sx = w / cols;
    const sz = d / rows;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) out.push({ x: z.minX + sx * (i + 0.5), z: z.minZ + sz * (j + 0.5), rot: 0 });
    // 異常規則 1：每個房間恰有一盞錯位半個模組、轉了 90°（位置隨房間編號移動，但永遠只有一盞）
    const k = (z.index * 7) % out.length;
    if (out[k]) {
      out[k].z += sz / 2 > 1 ? sz / 2 : 0;
      out[k].rot = Math.PI / 2;
    }
    return out;
  }, [z]);

  useLayoutEffect(() => {
    const o = new Object3D();
    spots.forEach((s, i) => {
      o.position.set(s.x, WALL_HEIGHT - 0.03, s.z);
      o.rotation.set(0, s.rot, 0);
      o.updateMatrix();
      lit.current?.setMatrixAt(i, o.matrix);
      o.position.y = WALL_HEIGHT - 0.012;
      o.updateMatrix();
      housing.current?.setMatrixAt(i, o.matrix);
    });
    if (lit.current) lit.current.instanceMatrix.needsUpdate = true;
    if (housing.current) housing.current.instanceMatrix.needsUpdate = true;
  }, [spots]);

  useEffect(() => {
    mat.color.set(new Color('#3A3D3F').lerp(new Color('#F6F4EE'), Math.min(1, power)));
  }, [power, mat]);

  return (
    <group>
      <instancedMesh ref={housing} args={[housingGeo, M.ink, spots.length]} />
      <instancedMesh ref={lit} args={[fixtureGeo, mat, spots.length]} />
    </group>
  );
}

/** 三盞跟著玩家移動的點光源（目前房間與前後各一間）：光源數固定，不會因走動而重新編譯材質 */
function RoomLights(): JSX.Element {
  const refs = [useRef<PointLight>(null), useRef<PointLight>(null), useRef<PointLight>(null)];
  useFrame((_, dt) => {
    const cur = roomAtZ(pose.z);
    const w = useStore.getState().world;
    refs.forEach((ref, i) => {
      const l = ref.current;
      if (!l) return;
      const idx = cur - 1 + i;
      const zone = ZONES.find((z) => z.index === idx);
      if (!zone) {
        l.intensity = MathUtils.damp(l.intensity, 0, 6, dt);
        return;
      }
      const cz = (zone.minZ + zone.maxZ) / 2;
      if (Math.abs(l.position.z - cz) > 0.01) {
        l.position.set(0, 2.35, cz);
        l.intensity = 0;
      }
      l.intensity = MathUtils.damp(l.intensity, 13 * roomPower(idx, w), 3, dt);
    });
  });
  return (
    <group>
      {refs.map((r, i) => (
        <pointLight key={i} ref={r} position={[0, 2.35, i * ROOM_PITCH]} color="#F3F2EC" intensity={0} distance={11.5} decay={1.35} />
      ))}
    </group>
  );
}

/* ------------------------------- 門、門框、門洞 ------------------------------- */

/** 門框：兩側門柱＋楣樑；沿 along 軸開口寬 open，穿牆厚度 thick */
function Frame({ c, along, open, thick, height, lamp }: { c: [number, number]; along: 'x' | 'z'; open: number; thick: number; height: number; lamp?: MeshStandardMaterial }): JSX.Element {
  const jamb = 0.2;
  const half = open / 2 + jamb / 2;
  const size = (a: number, t: number, h: number): V3 => (along === 'x' ? [a, h, t] : [t, h, a]);
  const at = (o: number, y: number): V3 => (along === 'x' ? [c[0] + o, y, c[1]] : [c[0], y, c[1] + o]);
  return (
    <group>
      <B p={at(-half, height / 2)} s={size(jamb + 0.04, thick, height)} m={M.ink} />
      <B p={at(half, height / 2)} s={size(jamb + 0.04, thick, height)} m={M.ink} />
      <B p={at(0, height + 0.1)} s={size(open + jamb * 2 + 0.04, thick + 0.01, 0.24)} m={M.ink} />
      {lamp && <B p={at(0, height + 0.11)} s={size(0.36, thick + 0.04, 0.09)} m={lamp} />}
    </group>
  );
}

type LampLook = { color: string; emissive: string; intensity: number };
const LAMP_OFF: LampLook = { color: '#6E7174', emissive: '#000000', intensity: 0 };
const LAMP_OPEN: LampLook = { color: C.bone, emissive: '#6f6d66', intensity: 0.3 };
const LAMP_LOCKED: LampLook = { color: C.red, emissive: C.red, intensity: 1.3 };
const lit = (hex: string): LampLook => ({ color: hex, emissive: hex, intensity: 1.2 });

const R2_KEY: Record<string, 'A' | 'B' | 'C' | 'D'> = { r2A: 'A', d2: 'B', r2C: 'C', r2D: 'D' };

/** 門燈的樣子：大部分的門是「朱紅＝鎖定、骨白＝已開」；R02 與 R09 的門燈是靜默員專屬的線索 */
function lampFor(slot: DoorSlot, w: WorldPublic | null, clues: SceneClues): LampLook {
  const open = !!(slot.doorId && w?.doors[slot.doorId]);
  if (open) return LAMP_OPEN;
  if (slot.wall === 2) {
    const k = R2_KEY[slot.id];
    const c = k && clues.r2Lamps?.[k];
    return c && c !== 'OFF' ? lit(LAMP_HEX[c]) : LAMP_OFF;
  }
  if (slot.id === 'd9') return clues.r9Lights?.[0] ? lit('#F6F4EE') : LAMP_OFF;
  return LAMP_LOCKED;
}

function useLamp(look: LampLook): MeshStandardMaterial {
  const mat = useMemo(() => new MeshStandardMaterial({ color: LAMP_OFF.color, roughness: 0.3 }), []);
  useEffect(() => {
    mat.color.set(look.color);
    mat.emissive.set(look.emissive);
    mat.emissiveIntensity = look.intensity;
  }, [look.color, look.emissive, look.intensity, mat]);
  return mat;
}

function Door({ slot }: { slot: DoorSlot }): JSX.Element {
  const box = DOOR_BOX_BY_ID[slot.id];
  const w = box.maxX - box.minX;
  const d = box.maxZ - box.minZ;
  const cx = (box.minX + box.maxX) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  const slab = useRef<Group>(null);
  const isOpen = useStore((s) => !!(slot.doorId && s.world?.doors[slot.doorId]));
  // 選擇器必須回傳穩定的值（字串），否則每次都是新物件會造成無限重繪
  const lookKey = useStore((s) => JSON.stringify(lampFor(slot, s.world, s.clues)));
  const look = useMemo(() => JSON.parse(lookKey) as LampLook, [lookKey]);
  const lamp = useLamp(look);
  const lintelTex = useRepeat(wallPanel(), w / 1.2, 1);
  const y = useRef(DOOR_H / 2);

  useFrame((_, dt) => {
    const goal = isOpen ? -DOOR_H / 2 - 0.05 : DOOR_H / 2;
    y.current = MathUtils.damp(y.current, goal, 4, dt);
    if (slab.current) slab.current.position.y = y.current;
  });

  return (
    <group>
      <mesh position={[cx, DOOR_H + (WALL_HEIGHT - DOOR_H) / 2, cz]}>
        <boxGeometry args={[w, WALL_HEIGHT - DOOR_H, d]} />
        <meshStandardMaterial map={lintelTex} roughness={0.55} />
      </mesh>
      <group position={[cx, 0, cz]}>
        <group ref={slab} position={[0, DOOR_H / 2, 0]}>
          <B p={[0, 0, 0]} s={[w, DOOR_H, d - 0.12]} m={M.powder} />
          <B p={[0, 0, 0]} s={[0.02, DOOR_H, d - 0.1]} m={M.ink} />
          <B p={[0, -0.25, 0]} s={[w * 0.55, 0.06, d]} m={M.brass} />
        </group>
      </group>
      <Frame c={[cx, cz]} along="x" open={w} thick={d + 0.24} height={DOOR_H} lamp={lamp} />
    </group>
  );
}

const facingVec = (f: number): [number, number] => [Math.sin(f), Math.cos(f)];

/** 牆上的平面標示（面向房間內） */
function WallPlate({ pos, facing, y, w, h, map, off = 0.13 }: { pos: [number, number]; facing: number; y: number; w: number; h: number; map: Texture; off?: number }): JSX.Element {
  const [fx, fz] = facingVec(facing);
  return (
    <mesh position={[pos[0] + fx * off, y, pos[1] + fz * off]} rotation={[0, facing, 0]}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={map} transparent />
    </mesh>
  );
}

/** 門洞（P04／P09）：門框＋沒有深度的暗面；楣上標示 I–IV 或 1–4 */
function PortalView({ p }: { p: PortalDef }): JSX.Element {
  const [fx, fz] = facingVec(p.facing);
  const along: 'x' | 'z' = Math.abs(fz) > 0.5 ? 'x' : 'z';
  const slotIndex = p.id.startsWith('r9_') ? Number(p.id.slice(3)) - 1 : -1;
  const isRealDoor = slotIndex === 0; // R09 的門位 1 就是真正的出口門 d9
  const label = useStore((s) => (slotIndex >= 0 ? s.clues.r9Labels?.[slotIndex] : undefined));
  const light = useStore((s) => (slotIndex > 0 ? !!s.clues.r9Lights?.[slotIndex] : false));
  const lamp = useLamp(slotIndex > 0 ? (light ? lit('#F6F4EE') : LAMP_OFF) : LAMP_OFF);
  const width = slotIndex >= 0 ? 1.6 : 2;
  return (
    <group>
      {!isRealDoor && (
        <>
          <mesh position={[p.pos[0] + fx * 0.012, DOOR_H / 2, p.pos[1] + fz * 0.012]} rotation={[0, p.facing, 0]} material={M.void}>
            <planeGeometry args={[width, DOOR_H]} />
          </mesh>
          <Frame c={[p.pos[0] + fx * 0.06, p.pos[1] + fz * 0.06]} along={along} open={width} thick={0.14} height={DOOR_H} lamp={slotIndex > 0 ? lamp : undefined} />
        </>
      )}
      <WallPlate pos={p.pos} facing={p.facing} y={DOOR_H + 0.42} w={0.5} h={0.25} map={markPlate(p.mark)} off={isRealDoor ? 0.15 : 0.14} />
      {label && <WallPlate pos={[p.pos[0] + (along === 'x' ? 0.5 : 0), p.pos[1] + (along === 'z' ? 0.5 : 0)]} facing={p.facing} y={DOOR_H + 0.42} w={0.36} h={0.18} map={markPlate(label, true)} off={0.15} />}
    </group>
  );
}

/** 異常規則 2：沒有設備的側牆段上的「假門框」（沒有門板、沒有狀態燈） */
const BLIND_FRAMES: Array<{ room: number; side: -1 | 1; at: number }> = [
  { room: 1, side: -1, at: 8.6 },
  { room: 2, side: -1, at: 7.5 },
  { room: 3, side: 1, at: 8.6 },
  { room: 5, side: -1, at: 3.2 },
  { room: 6, side: 1, at: 8.6 },
];

function BlindFrame({ room, side, at }: { room: number; side: -1 | 1; at: number }): JSX.Element {
  const r = roomRect(room);
  const c: [number, number] = [side * (r.maxX - 0.06), r.minZ + at];
  return (
    <group>
      <Frame c={c} along="z" open={2} thick={0.14} height={DOOR_H} />
      <B p={[c[0] + side * 0.04, DOOR_H / 2, c[1]]} s={[0.02, DOOR_H, 2]} m={M.enamel2} />
    </group>
  );
}

/** 異常規則 3：出口走廊的門框逐一降低、間距逐一縮短 */
function ExitPortals(): JSX.Element {
  const items = useMemo(() => {
    const out: Array<{ z: number; h: number }> = [];
    let z = EXIT_RECT.minZ + 1.3;
    let gap = 2.0;
    for (let i = 0; i < 4; i++) {
      out.push({ z, h: 2.9 - i * 0.15 });
      z += gap;
      gap *= 0.78;
    }
    return out;
  }, []);
  return (
    <group>
      {items.map((it) => (
        <group key={it.z}>
          <B p={[EXIT_RECT.minX + 0.08, it.h / 2, it.z]} s={[0.16, it.h, 0.3]} m={M.ink} />
          <B p={[EXIT_RECT.maxX - 0.08, it.h / 2, it.z]} s={[0.16, it.h, 0.3]} m={M.ink} />
          <B p={[0, it.h + 0.1, it.z]} s={[EXIT_RECT.maxX - EXIT_RECT.minX, 0.2, 0.3]} m={M.ink} />
        </group>
      ))}
    </group>
  );
}

function ExitLight(): JSX.Element {
  const done = useStore((s) => !!s.world?.chapterComplete);
  const mat = useMemo(() => new MeshBasicMaterial({ color: '#5A5C5B' }), []);
  useEffect(() => {
    mat.color.set(done ? '#FFFFFF' : '#5A5C5B');
  }, [done, mat]);
  return (
    <mesh position={[0, 1.4, EXIT_RECT.maxZ - 0.03]} rotation={[0, Math.PI, 0]} material={mat}>
      <planeGeometry args={[2.2, 2.6]} />
    </mesh>
  );
}

/** 異常規則 4：設施核心天花板上的未閉合圓環（缺口隨完成的謎題縮小） */
function CoreLoop(): JSX.Element {
  const done = useStore((s) => s.world?.puzzles.filter((p) => p.status === 'completed').length ?? 0);
  const total = PUZZLE_IDS.length;
  const gap = ((total - done) / total) * (Math.PI * 0.5);
  const geo = useMemo(() => new TorusGeometry(2.4, 0.08, 10, 96, Math.PI * 2 - gap), [gap]);
  const r = roomRect(10);
  const cz = (r.minZ + r.maxZ) / 2;
  return (
    <group position={[0, WALL_HEIGHT - 0.28, cz]} rotation={[Math.PI / 2, 0, 0]}>
      <mesh geometry={geo} material={M.ink} rotation={[0, 0, gap / 2]} />
      {gap > 0.001 && <B p={[2.4 + 0.3 * (gap / (Math.PI * 0.5)), 0, 0]} s={[0.2, 0.2, 0.2]} m={M.brass} />}
    </group>
  );
}

/* ------------------------------- 房間標示 ------------------------------- */

/** 每個房間的入口牆上（後牆）一塊標示，避開門與門洞 */
function RoomSign({ z }: { z: ZoneDef }): JSX.Element | null {
  const x = useMemo(() => {
    const blocked = [
      ...DOOR_SLOTS.filter((s) => s.wall === z.index - 1).map((s) => s.x),
      ...PORTALS.filter((p) => p.zone === z.id && Math.abs(p.pos[1] - z.minZ) < 0.01).map((p) => p.pos[0]),
    ];
    return [3.6, -3.6, 0].find((c) => blocked.every((b) => Math.abs(b - c) > 2.1)) ?? 0;
  }, [z]);
  if (z.id === 'EXIT') return null;
  return (
    <mesh position={[x, 2.55, z.minZ + 0.02]}>
      <planeGeometry args={[2.1, 0.84]} />
      <meshBasicMaterial map={roomSign(roomCode(z.id), z.label)} transparent depthWrite={false} />
    </mesh>
  );
}

/* ------------------------------- 角色專屬的場景線索 ------------------------------- */

/** R01：符號燈依序亮起（靜默員專屬；其他人看到的是三塊熄滅的板） */
function R1SymbolLamps(): JSX.Element {
  const d = DEVICE_BY_ID.r1_lamps;
  const symbols = useStore((s) => s.clues.r1Symbols);
  const mats = useMemo(() => [0, 1, 2].map(() => new MeshBasicMaterial({ color: '#ffffff' })), []);
  const last = useRef('');
  useFrame(({ clock }) => {
    const cycle = 3 * 1.1 + 1.6;
    const t = clock.elapsedTime % cycle;
    const idx = t < 3.3 && t % 1.1 < 0.85 ? Math.floor(t / 1.1) : -1;
    const key = `${symbols?.join(',') ?? ''}|${idx}`;
    if (key === last.current) return;
    last.current = key;
    mats.forEach((m, i) => {
      m.map = symbols ? symbolPlate(symbols[i], idx === i) : symbolPlate('SQR', false);
      m.color.set(symbols ? '#ffffff' : '#9A9C98');
      m.needsUpdate = true;
    });
  });
  return (
    <group position={[d.pos[0], 0, d.pos[1]]} rotation={[0, d.facing, 0]}>
      {[0, 1, 2].map((i) => (
        <group key={i}>
          <B p={[(i - 1) * 0.6, 2.38, -0.42]} s={[0.5, 0.5, 0.04]} m={M.ink} />
          <mesh position={[(i - 1) * 0.6, 2.38, -0.395]} material={mats[i]}>
            <planeGeometry args={[0.42, 0.42]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** R04：目前節點的地標（只有看得見的人收到） */
function R4Landmark(): JSX.Element | null {
  const lm = useStore((s) => s.clues.r4Landmark);
  const r = roomRect(4);
  const cz = (r.minZ + r.maxZ) / 2;
  const cone = useMemo(() => new ConeGeometry(0.55, 0.8, 3), []);
  if (!lm || lm === 'NONE') return null;
  if (lm === 'TRIANGLE') {
    return (
      <group position={[0, 0, cz]}>
        <Cyl p={[0, WALL_HEIGHT - 0.35, 0]} r={0.015} h={0.7} m={M.steel} />
        <mesh geometry={cone} material={M.enamel} position={[0, WALL_HEIGHT - 1.05, 0]} rotation={[Math.PI, 0, 0]} />
      </group>
    );
  }
  if (lm === 'CYLINDER') {
    return (
      <group position={[0, 0, cz]}>
        <Cyl p={[0, WALL_HEIGHT - 0.2, 0]} r={0.015} h={0.4} m={M.steel} />
        <Cyl p={[0, WALL_HEIGHT - 1.0, 0]} r={0.35} h={1.2} m={M.powder} seg={28} />
        <Cyl p={[0, WALL_HEIGHT - 1.62, 0]} r={0.36} h={0.04} m={M.ink} seg={28} />
      </group>
    );
  }
  return (
    <group position={[0, 0, cz]}>
      <B p={[0, 0.006, 0]} s={[1.8, 0.012, 1.8]} m={M.ink} />
      <B p={[0, 0.008, 0]} s={[1.5, 0.012, 1.5]} m={M.enamel2} />
    </group>
  );
}

/* ------------------------------- 設備 ------------------------------- */

function Gauge({ p, r = 0.13 }: { p: V3; r?: number }): JSX.Element {
  return (
    <group position={p}>
      <Cyl p={[0, 0, 0]} r={r} h={0.05} m={M.brass} rot={[Math.PI / 2, 0, 0]} seg={24} />
      <Cyl p={[0, 0, 0.026]} r={r * 0.81} h={0.01} m={M.enamel} rot={[Math.PI / 2, 0, 0]} seg={24} />
      <B p={[r * 0.23, r * 0.23, 0.034]} s={[0.012, r * 0.7, 0.006]} m={M.ink} r={[0, 0, -0.7]} />
    </group>
  );
}

function Screen({ w, h, p, r, on, seed }: { w: number; h: number; p: V3; r?: V3; on: boolean; seed: number }): JSX.Element {
  const tex = crtScreen(seed, on);
  return (
    <group position={p} rotation={r}>
      <B p={[0, 0, -0.02]} s={[w + 0.08, h + 0.08, 0.04]} m={M.ink} />
      <mesh position={[0, 0, 0.002]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={on ? 0.85 : 0} roughness={0.2} />
      </mesh>
    </group>
  );
}

function Papers({ y, w, d, seed }: { y: number; w: number; d: number; seed: number }): JSX.Element {
  return (
    <group>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[-w * 0.28 + i * 0.22, y + 0.002 + i * 0.002, (i % 2 ? 0.05 : -0.04) * d]} rotation={[-Math.PI / 2, 0, (i - 1) * 0.12]}>
          <planeGeometry args={[0.21, 0.28]} />
          <meshStandardMaterial map={paperSheet(seed + i)} roughness={0.95} />
        </mesh>
      ))}
      <mesh position={[w * 0.25, y + 0.003, 0.02]} rotation={[-Math.PI / 2, 0, 0.08]}>
        <planeGeometry args={[0.19, 0.087]} />
        <meshStandardMaterial map={punchCard(seed)} transparent roughness={0.95} />
      </mesh>
    </group>
  );
}

/** 依設備種類組出的機械造型（只是外觀：線索只存在於伺服器傳來的面板與授權線索中） */
function DeviceBody({ d, on, seed }: { d: DeviceDef; on: boolean; seed: number }): JSX.Element {
  const [w, h, dep] = d.size;
  const front = dep / 2;
  const plinth = <B p={[0, 0.04, 0]} s={[w - 0.06, 0.08, dep - 0.06]} m={M.ink} />;

  const desk = (top: JSX.Element): JSX.Element => (
    <group>
      {plinth}
      <B p={[0, 0.08 + (h - 0.2) / 2, 0]} s={[w, h - 0.2, dep]} m={M.enamel} />
      <B p={[0, h - 0.13, front - 0.02]} s={[w + 0.02, 0.05, 0.06]} m={M.ink} />
      <group position={[0, h - 0.06, 0]} rotation={[0.32, 0, 0]}>
        <B p={[0, 0, 0]} s={[w, 0.1, dep]} m={M.enamel} />
        {top}
      </group>
    </group>
  );

  switch (d.kind) {
    case 'console':
      return desk(
        <group>
          <Screen w={w * 0.36} h={dep * 0.55} p={[-w * 0.24, 0.052, -0.02]} r={[-Math.PI / 2, 0, 0]} on={on} seed={seed} />
          {[0, 1, 2].map((i) => (
            <Cyl key={i} p={[w * 0.08 + i * 0.12, 0.09, 0.12]} r={0.022} h={0.08} m={M.brass} />
          ))}
          <B p={[w * 0.36, 0.14, -0.05]} s={[0.035, 0.22, 0.035]} m={M.brass} r={[0.4, 0, 0]} />
          <B p={[w * 0.36, 0.06, -0.05]} s={[0.12, 0.03, 0.18]} m={M.ink} />
        </group>,
      );
    case 'lamp_ctrl':
      return desk(
        <group>
          {[0, 1, 2].map((i) => (
            <group key={i} position={[-w * 0.26 + i * (w * 0.26), 0.05, -0.08]}>
              <Cyl p={[0, 0.03, 0]} r={0.085} h={0.06} m={M.ink} />
              <Cyl p={[0, 0.07, 0]} r={0.065} h={0.03} m={M.glassOff} />
              <Cyl p={[0, 0.04, 0.2]} r={0.04} h={0.05} m={M.brass} />
            </group>
          ))}
        </group>,
      );
    case 'knobs':
      return desk(
        <group>
          {[0, 1, 2, 3].map((i) => (
            <group key={i} position={[-w * 0.33 + i * (w * 0.22), 0.05, 0]}>
              <Cyl p={[0, 0.05, 0]} r={0.11} h={0.09} m={M.brass} seg={20} />
              <B p={[0, 0.1, -0.05]} s={[0.025, 0.02, 0.1]} m={M.ink} />
              <Cyl p={[0, 0.002, 0]} r={0.15} h={0.004} m={M.ink} seg={24} />
            </group>
          ))}
        </group>,
      );
    case 'tap_source':
      return (
        <group>
          <B p={[0, h / 2, -front + 0.08]} s={[w, h, 0.16]} m={M.powder} />
          {[-0.4, 0, 0.4].map((x) => (
            <group key={x}>
              <Cyl p={[x * w * 0.8, h / 2 + 0.25, -front + 0.3]} r={0.075} h={h + 0.5} m={M.ink} />
              <Cyl p={[x * w * 0.8, 0.55, -front + 0.3]} r={0.11} h={0.06} m={M.brass} />
              <Cyl p={[x * w * 0.8, 1.45, -front + 0.3]} r={0.11} h={0.06} m={M.brass} />
            </group>
          ))}
          <Gauge p={[w * 0.18, 1.0, -front + 0.42]} />
          {plinth}
        </group>
      );
    case 'gauge':
      // 校準儀器：細長立柱、大型圓錶盤、往天花板的導管
      return (
        <group>
          {plinth}
          <B p={[0, 0.08 + (h - 0.08) / 2, -0.05]} s={[w * 0.7, h - 0.08, dep * 0.7]} m={M.powder} />
          <Gauge p={[0, h - 0.42, dep * 0.32]} r={0.34} />
          <Cyl p={[0, h + (WALL_HEIGHT - h) / 2, -0.12]} r={0.05} h={WALL_HEIGHT - h} m={M.steel} />
          <B p={[0, 0.5, dep * 0.3]} s={[w * 0.5, 0.18, 0.04]} m={M.enamel} />
        </group>
      );
    case 'light_panel':
    case 'symbol_panel':
      return (
        <group>
          {plinth}
          <B p={[0, 0.08 + (h - 0.08) / 2, 0]} s={[w, h - 0.08, dep]} m={M.enamel} />
          <B p={[0, h * 0.72, front + 0.01]} s={[w * 0.92, h * 0.34, 0.02]} m={M.ink} />
          {[0, 1, 2, 3].map((i) => {
            const x = -w * 0.33 + i * (w * 0.22);
            return d.kind === 'light_panel' ? (
              <group key={i}>
                <Cyl p={[x, h * 0.72, front + 0.06]} r={0.15} h={0.08} m={M.ink} rot={[Math.PI / 2, 0, 0]} seg={20} />
                <Cyl p={[x, h * 0.72, front + 0.1]} r={0.12} h={0.02} m={M.glassOff} rot={[Math.PI / 2, 0, 0]} seg={20} />
              </group>
            ) : (
              <B key={i} p={[x, h * 0.72, front + 0.03]} s={[0.3, 0.3, 0.02]} m={M.frosted} />
            );
          })}
          <B p={[0, h * 0.42, front + 0.01]} s={[w * 0.5, 0.02, 0.02]} m={M.ink} />
        </group>
      );
    case 'monitor':
      return (
        <group>
          {plinth}
          <B p={[0, 0.08 + 0.36, 0]} s={[w, 0.72, dep]} m={M.enamel} />
          {[-1, 1].map((sgn) => (
            <group key={sgn} position={[sgn * w * 0.24, 1.05, 0]}>
              <B p={[0, 0, -0.05]} s={[w * 0.44, 0.58, dep * 0.8]} m={M.enamel} />
              <Screen w={w * 0.34} h={0.42} p={[0, 0.02, dep * 0.35 + 0.01]} on={on} seed={seed + sgn} />
            </group>
          ))}
        </group>
      );
    case 'document':
      if (h < 1.5) {
        return (
          <group>
            {plinth}
            <B p={[0, (h - 0.04) / 2 + 0.04, 0]} s={[w, h - 0.08, dep]} m={M.powder} />
            <B p={[0, h - 0.02, 0]} s={[w + 0.04, 0.04, dep + 0.04]} m={M.enamel} />
            <Papers y={h} w={w} d={dep} seed={seed} />
          </group>
        );
      }
      return (
        <group>
          {plinth}
          <B p={[0, 0.08 + (h - 0.08) / 2, 0]} s={[w, h - 0.08, dep]} m={M.powder} />
          {[0, 1, 2, 3].map((i) => {
            const y = 0.08 + (h - 0.08) * (0.125 + i * 0.25);
            return (
              <group key={i}>
                <B p={[0, y - (h - 0.08) * 0.125 + 0.005, front + 0.005]} s={[w * 0.98, 0.015, 0.012]} m={M.ink} />
                <B p={[0, y + 0.08, front + 0.012]} s={[0.22, 0.09, 0.012]} m={M.brass} />
                <B p={[0, y + 0.08, front + 0.02]} s={[0.17, 0.06, 0.004]} m={M.enamel} />
                <B p={[0, y - 0.05, front + 0.03]} s={[0.3, 0.035, 0.04]} m={M.brass} />
              </group>
            );
          })}
          <Papers y={h} w={w} d={dep} seed={seed} />
        </group>
      );
    default:
      return (
        <group>
          {plinth}
          <B p={[0, h / 2, 0]} s={[w, h, dep]} m={M.enamel} />
        </group>
      );
  }
}

function DeviceModel({ d, role }: { d: DeviceDef; role: Role | null }): JSX.Element {
  const [w, h, dep] = d.size;
  const outline = useRef<LineSegments>(null);
  const lampRef = useRef<Mesh>(null);
  const on = useStore((s) => roomPower(Number(d.zone.slice(1)), s.world) > 0.5);
  const plate = useMemo(() => devicePlate(deviceCode(d.id), d.label), [d.id, d.label]);
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(w + 0.08, h + 0.12, dep + 0.08)), [w, h, dep]);
  const usable = role ? roleCanUseDevice(role, d) : false;
  const seed = useMemo(() => DEVICES.indexOf(d) + 1, [d]);
  const lamp = useMemo(() => new MeshStandardMaterial({ color: '#7d7f7c', emissive: '#000000', roughness: 0.3 }), []);

  useFrame(() => {
    const t = role ? currentTarget(role) : null;
    const hot = t?.device.id === d.id;
    if (outline.current) {
      outline.current.visible = hot;
      outline.current.material = usable ? lineInk : lineRed;
    }
    lamp.color.set(hot && usable ? '#F6F4EE' : '#7d7f7c');
    lamp.emissive.set(hot && usable ? '#F6F4EE' : '#000000');
    lamp.emissiveIntensity = hot && usable ? 1.4 : 0;
  });

  const plateY = Math.min(h * 0.5, 0.62);
  const faceZ = dep / 2;
  return (
    <group position={[d.pos[0], 0, d.pos[1]]} rotation={[0, d.facing, 0]}>
      <mesh position={[0, 0.006, 0.05]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.9, dep + 0.9]} />
        <meshBasicMaterial map={contactShadow()} transparent depthWrite={false} />
      </mesh>
      <DeviceBody d={d} on={on} seed={seed} />
      <mesh position={[w / 2 - 0.36, plateY, faceZ + 0.008]}>
        <planeGeometry args={[0.64, 0.14]} />
        <meshBasicMaterial map={plate} />
      </mesh>
      <group position={[-w / 2 + 0.1, plateY, faceZ + 0.02]}>
        <Cyl p={[0, 0, 0]} r={0.045} h={0.03} m={M.brass} rot={[Math.PI / 2, 0, 0]} />
        <mesh ref={lampRef} position={[0, 0, 0.02]} rotation={[Math.PI / 2, 0, 0]} material={lamp}>
          <cylinderGeometry args={[0.03, 0.03, 0.02, 14]} />
        </mesh>
      </group>
      <lineSegments ref={outline} geometry={edges} position={[0, (h + 0.12) / 2 - 0.02, 0]} visible={false} material={lineInk} />
    </group>
  );
}

/** 直接互動的門（P02）：注視時描出門框輪廓 */
function DoorSlotTarget({ d, role }: { d: DeviceDef; role: Role | null }): JSX.Element {
  const outline = useRef<LineSegments>(null);
  const [w, h, dep] = d.size;
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(w + 0.1, h + 0.1, dep + 0.3)), [w, h, dep]);
  useFrame(() => {
    const t = role ? currentTarget(role) : null;
    if (outline.current) outline.current.visible = t?.device.id === d.id;
  });
  return <lineSegments ref={outline} geometry={edges} position={[d.pos[0], (h + 0.1) / 2, d.pos[1]]} visible={false} material={lineInk} />;
}

/* ------------------------------- 失語員的標記 ------------------------------- */

function MarkerPin({ m }: { m: Marker }): JSX.Element | null {
  const d = DEVICE_BY_ID[m.targetId];
  const ref = useRef<Group>(null);
  const tag = useMemo(() => nameTexture(m.token ? `標記・${TOKEN_LABEL[m.token]}` : '標記'), [m.token]);
  useFrame(({ clock }) => {
    if (!ref.current || !d) return;
    ref.current.position.y = d.size[1] + 0.55 + Math.sin(clock.elapsedTime * 3) * 0.06;
    ref.current.rotation.y = clock.elapsedTime * 1.2;
  });
  if (!d) return null;
  return (
    <group position={[d.pos[0], 0, d.pos[1]]}>
      <group ref={ref}>
        <mesh material={M.ink} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[0.22, 0.22, 0.05]} />
        </mesh>
      </group>
      <sprite position={[0, d.size[1] + 0.95, 0]} scale={[0.9, 0.19, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}

function Markers(): JSX.Element {
  const markers = useStore((s) => s.markers);
  return (
    <group>
      {markers.map((m) => (
        <MarkerPin key={m.id} m={m} />
      ))}
    </group>
  );
}

/* ------------------------------- 隊友 ------------------------------- */

function Avatar({ role }: { role: Role }): JSX.Element {
  const info = ROLE_INFO[role];
  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const players = useStore((s) => s.room?.players);
  const name = players?.find((p) => p.role === role)?.name ?? info.name;
  const online = players?.find((p) => p.role === role)?.connected ?? false;
  const tag = useMemo(() => nameTexture(`${info.letter}　${name}`), [info.letter, name]);
  const plate = useMemo(() => rolePlate(info.letter), [info.letter]);

  useFrame(({ clock }) => {
    const r = remotes[role];
    const g = group.current;
    if (!g) return;
    if (!r) {
      g.visible = false;
      return;
    }
    g.visible = online;
    g.position.set(r.x, 0, r.z);
    g.rotation.y = r.yaw;
    const moving = performance.now() - r.movedAt < 300;
    if (body.current) body.current.position.y = moving ? Math.abs(Math.sin(clock.elapsedTime * 9)) * 0.035 : 0;
  });

  return (
    <group ref={group} visible={false}>
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.1, 1.1]} />
        <meshBasicMaterial map={contactShadow()} transparent depthWrite={false} />
      </mesh>
      <group ref={body}>
        {[-0.11, 0.11].map((x) => (
          <group key={x}>
            <B p={[x, 0.05, -0.03]} s={[0.13, 0.1, 0.27]} m={M.ink} />
            <Cyl p={[x, 0.45, 0]} r={0.075} h={0.72} m={M.powder} />
          </group>
        ))}
        <B p={[0, 0.84, 0]} s={[0.48, 0.09, 0.3]} m={M.ink} />
        <B p={[0, 1.13, 0]} s={[0.46, 0.5, 0.28]} m={M.enamel} />
        <B p={[0, 1.41, 0]} s={[0.52, 0.07, 0.3]} m={M.ink} />
        {[-0.3, 0.3].map((x) => (
          <Cyl key={x} p={[x, 1.1, 0]} r={0.062} h={0.6} m={M.enamel} />
        ))}
        <mesh position={[0, 1.18, -0.142]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[0.18, 0.18]} />
          <meshBasicMaterial map={plate} />
        </mesh>
        <mesh position={[0, 1.18, 0.142]}>
          <planeGeometry args={[0.18, 0.18]} />
          <meshBasicMaterial map={plate} />
        </mesh>
        <Cyl p={[0, 1.48, 0]} r={0.07} h={0.08} m={M.ink} />
        <mesh position={[0, 1.63, 0]} material={M.enamel}>
          <sphereGeometry args={[0.17, 18, 14]} />
        </mesh>
        {role === 'BLIND' && <B p={[0, 1.66, -0.13]} s={[0.33, 0.09, 0.09]} m={M.ink} />}
        {role === 'DEAF' && (
          <>
            <Cyl p={[-0.18, 1.63, 0]} r={0.08} h={0.07} m={M.ink} rot={[0, 0, Math.PI / 2]} />
            <Cyl p={[0.18, 1.63, 0]} r={0.08} h={0.07} m={M.ink} rot={[0, 0, Math.PI / 2]} />
            <B p={[0, 1.81, 0]} s={[0.38, 0.035, 0.05]} m={M.ink} />
          </>
        )}
        {role === 'MUTE' && <B p={[0, 1.56, -0.14]} s={[0.19, 0.085, 0.08]} m={M.ink} />}
      </group>
      <sprite position={[0, 2.08, 0]} scale={[0.9, 0.19, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}

function Avatars({ me }: { me: Role | null }): JSX.Element | null {
  if (!me) return null;
  return (
    <group>
      {(['BLIND', 'DEAF', 'MUTE'] as Role[])
        .filter((r) => r !== me)
        .map((r) => (
          <Avatar key={r} role={r} />
        ))}
    </group>
  );
}

/* ------------------------------- 相機與環境 ------------------------------- */

function Rig(): null {
  const { camera, scene, gl } = useThree();
  const shake = useRef(0);
  useEffect(() => {
    camera.rotation.order = 'YXZ';
    scene.background = new Color('#C9C8C2');
    scene.fog = new FogExp2('#C9C8C2', 0.038);
    gl.toneMapping = NeutralToneMapping;
    gl.toneMappingExposure = 1.0;
  }, [camera, scene, gl]);
  // 回饋：推不開的門會讓視角短暫震動（事件連動，不做隨機晃動）
  useEffect(() => on('fx', (f) => {
    if (f.visual === 'shake') shake.current = 0.5;
  }), []);
  useFrame(({ clock }, dt) => {
    shake.current = Math.max(0, shake.current - dt);
    const k = shake.current * 0.05;
    const t = clock.elapsedTime * 60;
    camera.position.set(pose.x + Math.sin(t) * k, pose.y + Math.cos(t * 1.3) * k * 0.5, pose.z);
    camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
  });
  return null;
}

/** 等字型載入後再產生銘牌貼圖，避免第一次畫出來是後備字型 */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        setReady(true);
      }
    };
    const t = window.setTimeout(finish, 2500);
    const text = DEVICES.map((d) => d.label).join('') + ZONES.map((z) => z.label).join('') + '標記';
    const fonts = document.fonts;
    if (!fonts?.load) finish();
    else {
      Promise.all([fonts.load('700 62px "Noto Sans TC"', text), fonts.load('600 46px "IBM Plex Mono"', 'RFACILTYEX-0123456789IV')])
        .then(finish)
        .catch(finish);
    }
    return () => clearTimeout(t);
  }, []);
  return ready;
}

const DEVICES_BY_ROOM = new Map<number, DeviceDef[]>();
for (const d of DEVICES) {
  const i = Number(d.zone.slice(1));
  DEVICES_BY_ROOM.set(i, [...(DEVICES_BY_ROOM.get(i) ?? []), d]);
}

export default function Scene(): JSX.Element {
  const role = useStore((s) => s.me?.role ?? null);
  const fontsReady = useFontsReady();
  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ fov: 72, near: 0.05, far: 60, position: [0, 1.6, 0] }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Rig />
      <hemisphereLight args={['#F2F2EE', '#8E908C', 1.1]} />
      <ambientLight intensity={0.12} color="#E8E5DC" />
      <RoomLights />
      {ZONES.map((z) => (
        <RoomGroup key={z.id} index={z.index}>
          <ZoneShell z={z} />
          <Fixtures z={z} />
          {fontsReady && <RoomSign z={z} />}
          {fontsReady &&
            (DEVICES_BY_ROOM.get(z.index) ?? []).map((d) =>
              d.kind === 'door_slot' ? <DoorSlotTarget key={d.id} d={d} role={role} /> : <DeviceModel key={d.id} d={d} role={role} />,
            )}
        </RoomGroup>
      ))}
      {WALL_BOXES.map((b) => (
        <WallMesh key={b.id} box={b} />
      ))}
      {DOOR_SLOTS.map((s) => (
        <Door key={s.id} slot={s} />
      ))}
      {fontsReady && PORTALS.map((p) => <PortalView key={p.id} p={p} />)}
      {BLIND_FRAMES.map((f, i) => (
        <BlindFrame key={i} {...f} />
      ))}
      <R1SymbolLamps />
      <R4Landmark />
      <CoreLoop />
      <ExitPortals />
      <ExitLight />
      <Markers />
      <Avatars me={role} />
    </Canvas>
  );
}
