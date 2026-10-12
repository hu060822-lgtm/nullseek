import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Color, FogExp2, MeshBasicMaterial, NeutralToneMapping, PCFShadowMap, type DirectionalLight, type Group, type Mesh } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ROLES, ROLE_INFO, type Role } from '@null-protocol/shared';
import { CharacterAnimator, type BodyInput } from '../game/characters/animator';
import { loadCrew, loadManifest, type CrewAsset } from '../game/characters/assets';

/**
 * 角色預覽（網址 ?preview=crew）。不連伺服器。
 *
 *   &clip=Walk            播放某個動畫（預設 cycle：依序播放全部）；demo＝狀態機示範（走、停、轉身、蹲、受傷）
 *   &t=0.25               停在動畫的某個比例（截圖用）
 *   &role=DEAF            只顯示一個角色
 *   &cam=front|side|back|34|close|far   視角
 *   &sil=1                純黑剪影（檢查三名角色不靠顏色也能分辨）
 *
 * 「死亡」只出現在這裡：遊戲中沒有傷害系統。
 */

const CLIP_ORDER = ['Idle', 'StartMoving', 'Walk', 'StopMoving', 'Run', 'Turn', 'Crouch', 'CrouchIdle', 'CrouchWalk', 'Interact', 'InteractHigh', 'Inspect', 'Observe', 'Hurt', 'Death'];

const CAMS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  front: { pos: [0, 1.1, 5.2], look: [0, 0.9, 0] },
  side: { pos: [5.2, 1.1, 0], look: [0, 0.9, 0] },
  back: { pos: [0, 1.1, -5.2], look: [0, 0.9, 0] },
  '34': { pos: [3.2, 1.7, 3.6], look: [0, 0.9, 0] },
  close: { pos: [0.5, 1.62, 1.35], look: [0, 1.5, 0] },
  far: { pos: [0, 1.6, 12], look: [0, 1.0, 0] },
};

const SIL = new URLSearchParams(location.search).get('sil') === '1';
const SIL_MAT = new MeshBasicMaterial({ color: '#000000' });

function Stage({ cam }: { cam: string }): null {
  const { camera, scene, gl } = useThree();
  useEffect(() => {
    const c = CAMS[cam] ?? CAMS.front;
    camera.position.set(...c.pos);
    camera.lookAt(...c.look);
    scene.background = new Color(SIL ? '#FFFFFF' : '#2C3235');
    scene.fog = SIL ? null : new FogExp2('#2C3235', 0.045);
    gl.toneMapping = NeutralToneMapping;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = PCFShadowMap;
  }, [camera, scene, gl, cam]);
  return null;
}

function Actor({ asset, x, clip, t, onState }: { asset: CrewAsset; x: number; clip: string; t: number | null; onState?: (s: string) => void }): JSX.Element {
  const model = useMemo(() => {
    const m = cloneSkinned(asset.template);
    if (SIL) m.traverse((o) => ((o as Mesh).isMesh ? ((o as Mesh).material = SIL_MAT) : undefined));
    return m;
  }, [asset]);
  const anim = useMemo(() => new CharacterAnimator(model, asset.clips), [model, asset]);
  const group = useRef<Group>(null);
  const demo = useRef({ time: 0, hurt: 0, yaw: 0, x, z: 0 });
  const cycleIdx = useRef(0);
  const cycleUntil = useRef(0);

  useEffect(() => () => anim.dispose(), [anim]);
  useEffect(() => {
    if (t !== null && clip !== 'cycle' && clip !== 'demo') anim.pose(clip, t);
    else if (clip !== 'cycle' && clip !== 'demo') anim.force(clip, 0);
    else anim.force(null);
  }, [anim, clip, t]);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const g = group.current;
    if (!g) return;
    if (clip === 'cycle') {
      const d = demo.current;
      d.time += dt;
      if (d.time > cycleUntil.current) {
        const name = CLIP_ORDER[cycleIdx.current % CLIP_ORDER.length];
        cycleIdx.current += 1;
        anim.force(name, 0.25);
        const c = asset.clips.get(name);
        cycleUntil.current = d.time + Math.max(2.2, c ? c.duration * (name === 'Death' ? 1.6 : 1.4) : 2);
        onState?.(name);
      }
      anim.update(dt, IDLE_INPUT);
      return;
    }
    if (clip === 'demo') {
      // 狀態機示範：依時間表產生「伺服器會送來的」輸入
      const d = demo.current;
      d.time += dt;
      const p = d.time % 16;
      let speed = 0;
      let turn = 0;
      let crouch = false;
      if (p < 4) speed = 2.3;
      else if (p < 5.5) speed = 0;
      else if (p < 7) turn = 2.4;
      else if (p < 9) speed = 4.4;
      else if (p < 10) speed = 0;
      else if (p < 13) {
        crouch = true;
        speed = p > 11 ? 1.0 : 0;
      } else if (p > 14 && p - dt <= 14) d.hurt += 1;
      d.yaw += turn * dt;
      if (speed > 0) {
        d.yaw += 0.5 * dt;
        d.x += -Math.sin(d.yaw) * speed * dt;
        d.z += -Math.cos(d.yaw) * speed * dt;
        if (Math.hypot(d.x, d.z) > 5) {
          d.x *= 0.98;
          d.z *= 0.98;
        }
      }
      g.position.set(d.x, 0, d.z);
      g.rotation.y = d.yaw;
      const input: BodyInput = { speed, turnRate: turn, crouch, act: null, actPose: 'low', hurt: d.hurt };
      anim.update(dt, input);
      onState?.(anim.state ?? '');
      return;
    }
    anim.update(t === null ? dt : 0, IDLE_INPUT);
  });

  return (
    <group ref={group} position={[x, 0, 0]} rotation={[0, clip === 'demo' ? 0 : Math.PI, 0]}>
      <group rotation={[0, Math.PI + asset.yaw, 0]} scale={asset.scale}>
        <primitive object={model} />
      </group>
    </group>
  );
}

const IDLE_INPUT: BodyInput = { speed: 0, turnRate: 0, crouch: false, act: null, actPose: 'low', hurt: 0 };

function Lights(): JSX.Element {
  const sun = useRef<DirectionalLight>(null);
  useEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.shadow.mapSize.set(1024, 1024);
    l.shadow.camera.left = -4;
    l.shadow.camera.right = 4;
    l.shadow.camera.top = 4;
    l.shadow.camera.bottom = -1;
    l.shadow.bias = -0.0008;
  }, []);
  return (
    <>
      <hemisphereLight args={['#B8C4C9', '#3A403C', 1.7]} />
      <directionalLight ref={sun} position={[2.5, 4.5, 3]} intensity={3.2} color="#E4ECEE" castShadow />
    </>
  );
}

export default function CrewPreview(): JSX.Element {
  const q = new URLSearchParams(location.search);
  const clip = q.get('clip') ?? 'cycle';
  const tRaw = q.get('t');
  const t = tRaw === null ? null : Number(tRaw);
  const only = q.get('role') as Role | null;
  const cam = q.get('cam') ?? 'front';
  const roles = only && ROLES.includes(only) ? [only] : [...ROLES];
  const [assets, setAssets] = useState<Partial<Record<Role, CrewAsset | null>>>({});
  const [state, setState] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    void loadManifest().then((m) => setNote(`骨骼 ${m.bones.length} 根・必要動畫 ${m.requiredClips.length} 組`));
    for (const r of roles) void loadCrew(r).then((a) => setAssets((s) => ({ ...s, [r]: a })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = roles.every((r) => assets[r] !== undefined);
  return (
    <div className="crew-preview">
      <Canvas shadows dpr={[1, 1.5]} camera={{ fov: 40, near: 0.05, far: 60 }} style={{ position: 'absolute', inset: 0 }}>
        <Stage cam={cam} />
        <Lights />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow visible={!SIL}>
          <planeGeometry args={[30, 30]} />
          <meshLambertMaterial color="#4A5153" />
        </mesh>
        {roles.map((r, i) => {
          const a = assets[r];
          if (!a) return null;
          return <Actor key={r} asset={a} x={(i - (roles.length - 1) / 2) * 1.35} clip={clip} t={t} onState={i === 0 ? setState : undefined} />;
        })}
      </Canvas>
      <div className="crew-preview-info plate" data-ready={ready ? '1' : '0'}>
        <b>角色預覽</b>
        <span>程式產生的低多邊形模型（原型等級）</span>
        <span>{roles.map((r) => `${ROLE_INFO[r].name}：${assets[r] === undefined ? '載入中' : assets[r] === null ? '載入失敗（備用人形）' : assets[r]!.source === 'override' ? '正式模型' : '程式模型'}`).join('　')}</span>
        <span className="code">{clip === 'cycle' || clip === 'demo' ? `動畫：${state}` : `動畫：${clip}${t !== null ? ` @ ${t}` : ''}`}</span>
        {note && <span className="xs dim">{note}</span>}
      </div>
    </div>
  );
}
