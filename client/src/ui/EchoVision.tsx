import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BoxGeometry, Color, EdgesGeometry, PlaneGeometry, ShaderMaterial, Vector2, type BufferGeometry } from 'three';
import type { EchoDisplay } from '../game/bus';
import { pose } from '../game/controller';

/**
 * 盲區員的回聲視野：按 F 後，從脈衝位置擴散的波照出範圍內的結構模型——牆、門、設備外形、地面網格、隊友——
 * 全部是反白的線框與網格，維持一段時間後淡出。
 *
 * 只畫 EchoDisplay.solids（種類與尺寸），沒有任何貼圖、顏色、文字、燈號或謎題線索；
 * 牆面是不透明的，所以牆後的東西不會出現；超出範圍的東西也不會出現。
 * 視野是世界座標的模型：顯示期間可以邊走邊轉頭觀察，但它停在脈衝的那一刻，不會即時更新。
 * 這個元件只在盲區員第一次按 F 時才載入，而且只在視野可見期間繪製（其餘時間不耗用 GPU）。
 */

// 著色器直接輸出 sRGB 數值（不經過色彩管理），清除色則交給 renderer 轉換，兩者才會是同一個炭黑
const BG_HEX = '#242729'; // 與 BlindView 的炭黑底相同
const raw = (hex: number) => new Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
const BG = raw(0x242729);
const INK = raw(0xeceae1);

const VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/** 共用的「照亮程度」：波是否已經到達、距離衰減、波前的亮線、整體淡出 */
const LIGHT = /* glsl */ `
uniform vec2 uO;
uniform float uT, uR, uS, uHold, uFade, uGlow;
uniform vec3 uBg, uInk;
varying vec3 vW;
varying vec3 vN;
float lit(out float front) {
  float d = distance(vW.xz, uO);
  float r = uT * uS;
  float reached = step(d, r) * (1.0 - smoothstep(uR * 0.72, uR, d));
  float life = 1.0 - clamp((uT - uR / uS - uHold) / uFade, 0.0, 1.0);
  front = exp(-pow((r - d) * 2.2, 2.0)) * step(d, uR) * (1.0 - step(uR / uS + 0.25, uT)) * uGlow * life;
  return reached * (1.0 - 0.45 * clamp(d / uR, 0.0, 1.0)) * life;
}`;

/** 面：很淡的填色＋每公尺一條的網格（讓牆面與地面有距離感） */
const FACE_FRAG = /* glsl */ `
${LIGHT}
uniform float uFill, uGrid;
void main() {
  float front;
  float l = lit(front);
  vec3 fw = max(fwidth(vW), vec3(1e-4));
  vec3 g = abs(fract(vW - 0.5) - 0.5) / fw;
  vec3 n = abs(normalize(vN));
  float line = max(max((1.0 - n.x) * (1.0 - min(g.x, 1.0)), (1.0 - n.y) * (1.0 - min(g.y, 1.0))), (1.0 - n.z) * (1.0 - min(g.z, 1.0)));
  float v = (uFill + uGrid * line) * l + front * 0.35;
  gl_FragColor = vec4(mix(uBg, uInk, clamp(v, 0.0, 1.0)), 1.0);
}`;

/** 稜線 */
const LINE_FRAG = /* glsl */ `
${LIGHT}
uniform float uEdge;
void main() {
  float front;
  float l = lit(front);
  gl_FragColor = vec4(mix(uBg, uInk, clamp(uEdge * l + front, 0.0, 1.0)), 1.0);
}`;

type Uniforms = Record<string, { value: unknown }>;

function shared(): Uniforms {
  return {
    uO: { value: new Vector2() },
    uT: { value: 0 },
    uR: { value: 10 },
    uS: { value: 18 },
    uHold: { value: 1.8 },
    uFade: { value: 1.2 },
    uGlow: { value: 0.8 },
    uBg: { value: BG },
    uInk: { value: INK },
  };
}

function faceMat(u: Uniforms, fill: number, grid: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...u, uFill: { value: fill }, uGrid: { value: grid } },
    vertexShader: VERT,
    fragmentShader: FACE_FRAG,
    // 面往後推一點，讓稜線畫在面的前面
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

function lineMat(u: Uniforms, edge: number): ShaderMaterial {
  return new ShaderMaterial({ uniforms: { ...u, uEdge: { value: edge } }, vertexShader: VERT, fragmentShader: LINE_FRAG });
}

/** 各種結構的亮度：門比牆亮（聽起來是金屬），設備介於中間，門洞只有輪廓、不遮擋 */
const LOOK = {
  wall: { fill: 0.1, grid: 0.3, edge: 1.0 },
  door: { fill: 0.24, grid: 0.0, edge: 1.0 },
  prop: { fill: 0.18, grid: 0.0, edge: 1.0 },
  frame: { fill: 0, grid: 0, edge: 0.9 },
  body: { fill: 0.3, grid: 0, edge: 1.0 },
} as const;

interface Piece {
  kind: keyof typeof LOOK;
  center: [number, number, number];
  box: BufferGeometry;
  edges: BufferGeometry;
}

function Pulse({ e, k }: { e: EchoDisplay; k: number }): JSX.Element {
  const { invalidate } = useThree();
  const u = useMemo(shared, []);
  const mats = useMemo(() => {
    const out = {} as Record<keyof typeof LOOK, { face: ShaderMaterial; line: ShaderMaterial }>;
    for (const kind of Object.keys(LOOK) as Array<keyof typeof LOOK>) {
      out[kind] = { face: faceMat(u, LOOK[kind].fill, LOOK[kind].grid), line: lineMat(u, LOOK[kind].edge) };
    }
    return { ...out, floor: faceMat(u, 0.04, 0.32) };
  }, [u]);
  useEffect(
    () => () => {
      for (const m of Object.values(mats)) {
        if (m instanceof ShaderMaterial) m.dispose();
        else {
          m.face.dispose();
          m.line.dispose();
        }
      }
    },
    [mats],
  );

  const pieces = useMemo<Piece[]>(
    () =>
      e.solids.map((s) => {
        const box = new BoxGeometry(s.maxX - s.minX, s.maxY - s.minY, s.maxZ - s.minZ);
        return {
          kind: s.kind,
          center: [(s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2, (s.minZ + s.maxZ) / 2],
          box,
          edges: new EdgesGeometry(box),
        };
      }),
    [e],
  );
  const floor = useMemo(() => new PlaneGeometry(e.range * 2.2, e.range * 2.2), [e.range]);
  useEffect(
    () => () => {
      for (const p of pieces) {
        p.box.dispose();
        p.edges.dispose();
      }
    },
    [pieces],
  );
  useEffect(() => () => floor.dispose(), [floor]);

  // 每次脈衝：設定參數，只在可見期間要求重新繪製
  const start = useRef(0);
  const total = (e.range / e.waveSpeed) * 1000 + e.holdMs + e.fadeMs;
  useEffect(() => {
    start.current = performance.now();
    (u.uO.value as Vector2).set(e.origin[0], e.origin[1]);
    u.uR.value = e.range;
    u.uS.value = e.waveSpeed;
    u.uHold.value = e.holdMs / 1000;
    u.uFade.value = e.fadeMs / 1000;
    let raf = 0;
    const tick = (): void => {
      invalidate();
      if (performance.now() - start.current < total + 100) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [k, e, u, total, invalidate]);

  useFrame(({ camera }) => {
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
    u.uT.value = (performance.now() - start.current) / 1000;
  });

  return (
    <>
      <mesh geometry={floor} material={mats.floor} position={[e.origin[0], 0.001, e.origin[1]]} rotation={[-Math.PI / 2, 0, 0]} />
      {pieces.map((p, i) => (
        <group key={`${k}-${i}`} position={p.center}>
          {p.kind !== 'frame' && <mesh geometry={p.box} material={mats[p.kind].face} />}
          <lineSegments geometry={p.edges} material={mats[p.kind].line} />
        </group>
      ))}
    </>
  );
}

export default function EchoVision({ e, k }: { e: EchoDisplay; k: number }): JSX.Element {
  return (
    <Canvas
      className="echo-vision"
      frameloop="demand"
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: false, powerPreference: 'low-power' }}
      camera={{ fov: 72, near: 0.05, far: 40, position: [pose.x, pose.y, pose.z] }}
      onCreated={({ gl }) => gl.setClearColor(BG_HEX)}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Pulse e={e} k={k} />
    </Canvas>
  );
}
