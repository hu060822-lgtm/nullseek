import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MeshLambertMaterial, type Group, type Sprite } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { DEVICES, ROLE_INFO, forwardOf, type DeviceDef, type Role } from '@null-protocol/shared';
import { useStore } from '../../state/store';
import { remotes, type RemotePose } from '../remote';
import { contactShadow, nameTexture, rolePlate } from '../textures';
import { CharacterAnimator, type ActPose } from './animator';
import { loadCrew, type CrewAsset } from './assets';

/**
 * 隊友的角色模型。位置與朝向完全來自伺服器同步（remotes），動畫只是呈現。
 * 模型載入中不顯示；載入失敗時退回備用人形（FallbackAvatar），遊戲照常進行。
 */

/** 隊友面前（±60°、2.8 m 內）最近的設備：決定操作動作的高度與手的位置 */
function deviceInFront(r: RemotePose): DeviceDef | null {
  const [fx, fz] = forwardOf(r.yaw);
  let best: DeviceDef | null = null;
  let bestD = 2.8;
  for (const d of DEVICES) {
    const vx = d.pos[0] - r.x;
    const vz = d.pos[1] - r.z;
    const dist = Math.hypot(vx, vz);
    if (dist > bestD) continue;
    if ((vx * fx + vz * fz) / (dist || 1) < 0.5) continue;
    best = d;
    bestD = dist;
  }
  return best;
}

const HIGH_KINDS = new Set(['tap_source', 'gauge', 'door_slot', 'light_panel', 'symbol_panel', 'monitor']);

function actPoseFor(r: RemotePose): ActPose {
  const d = deviceInFront(r);
  if (r.act === 'inspect') return d && d.kind !== 'document' ? 'observe' : 'read';
  return d && HIGH_KINDS.has(d.kind) ? 'high' : 'low';
}

function useName(role: Role): { name: string; online: boolean } {
  const players = useStore((s) => s.room?.players);
  const p = players?.find((x) => x.role === role);
  return { name: p?.name ?? ROLE_INFO[role].name, online: p?.connected ?? false };
}

function NameTag({ role, crouchRef }: { role: Role; crouchRef: { current: boolean } }): JSX.Element {
  const { name } = useName(role);
  const tag = useMemo(() => nameTexture(`${ROLE_INFO[role].letter}　${name}`), [role, name]);
  const ref = useRef<Sprite>(null);
  useFrame((_, dt) => {
    if (!ref.current) return;
    const goal = crouchRef.current ? 1.62 : 2.1;
    ref.current.position.y += (goal - ref.current.position.y) * (1 - Math.exp(-dt * 8));
  });
  return (
    <sprite ref={ref} position={[0, 2.1, 0]} scale={[0.82, 0.17, 1]}>
      <spriteMaterial map={tag} transparent depthWrite={false} opacity={0.85} />
    </sprite>
  );
}

function SkinnedAvatar({ role, asset }: { role: Role; asset: CrewAsset }): JSX.Element {
  const group = useRef<Group>(null);
  const crouchRef = useRef(false);
  const { online } = useName(role);
  // 每個實例各自複製骨架（材質共用，不會互相影響）
  const model = useMemo(() => cloneSkinned(asset.template), [asset]);
  const anim = useMemo(() => new CharacterAnimator(model, asset.clips), [model, asset]);
  useEffect(() => () => anim.dispose(), [anim]);

  useFrame((_, dt) => {
    const g = group.current;
    const r = remotes[role];
    if (!g) return;
    if (!r) {
      g.visible = false;
      return;
    }
    g.visible = online;
    g.position.set(r.x, 0, r.z);
    g.rotation.y = r.yaw;
    crouchRef.current = r.crouch;
    anim.update(Math.min(dt, 0.1), {
      speed: r.speed,
      turnRate: r.turnRate,
      crouch: r.crouch,
      act: r.act,
      actPose: r.act ? actPoseFor(r) : 'low',
      hurt: r.hurt,
    });
  });

  return (
    <group ref={group} visible={false}>
      <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.9, 0.9]} />
        <meshBasicMaterial map={contactShadow()} transparent depthWrite={false} opacity={0.8} />
      </mesh>
      {/* 模型正面是 +Z；遊戲的朝向 yaw=0 是面向 -Z，所以轉半圈 */}
      <group rotation={[0, Math.PI + asset.yaw, 0]} scale={asset.scale}>
        <primitive object={model} />
      </group>
      <NameTag role={role} crouchRef={crouchRef} />
    </group>
  );
}

/* ------------------------------- 備用人形（模型載入失敗時） ------------------------------- */

const FB = {
  body: new MeshLambertMaterial({ color: '#5E666A' }),
  dark: new MeshLambertMaterial({ color: '#2A2E30' }),
  head: new MeshLambertMaterial({ color: '#8A8076' }),
};

function FallbackAvatar({ role }: { role: Role }): JSX.Element {
  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const crouchRef = useRef(false);
  const { online } = useName(role);
  const plate = useMemo(() => rolePlate(ROLE_INFO[role].letter), [role]);
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
    crouchRef.current = r.crouch;
    if (body.current) {
      body.current.scale.y = r.crouch ? 0.7 : 1;
      body.current.position.y = r.speed > 0.3 ? Math.abs(Math.sin(clock.elapsedTime * 9)) * 0.035 : 0;
    }
  });
  return (
    <group ref={group} visible={false}>
      <group ref={body}>
        <mesh position={[0, 0.45, 0]} material={FB.body}>
          <boxGeometry args={[0.32, 0.9, 0.22]} />
        </mesh>
        <mesh position={[0, 1.15, 0]} material={FB.body}>
          <boxGeometry args={[0.46, 0.55, 0.28]} />
        </mesh>
        <mesh position={[0, 1.63, 0]} material={FB.head}>
          <boxGeometry args={[0.24, 0.28, 0.26]} />
        </mesh>
        {role === 'BLIND' && (
          <mesh position={[0, 1.66, -0.14]} material={FB.dark}>
            <boxGeometry args={[0.3, 0.08, 0.06]} />
          </mesh>
        )}
        {role === 'DEAF' &&
          [-1, 1].map((s) => (
            <mesh key={s} position={[0.14 * s, 1.63, 0]} material={FB.dark}>
              <boxGeometry args={[0.06, 0.12, 0.12]} />
            </mesh>
          ))}
        {role === 'MUTE' && (
          <mesh position={[0, 1.56, -0.14]} material={FB.dark}>
            <boxGeometry args={[0.16, 0.08, 0.08]} />
          </mesh>
        )}
        <mesh position={[0, 1.18, -0.145]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[0.16, 0.16]} />
          <meshBasicMaterial map={plate} />
        </mesh>
      </group>
      <NameTag role={role} crouchRef={crouchRef} />
    </group>
  );
}

export function CrewAvatar({ role }: { role: Role }): JSX.Element | null {
  const [asset, setAsset] = useState<CrewAsset | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadCrew(role).then((a) => {
      if (alive) setAsset(a);
    });
    return () => {
      alive = false;
    };
  }, [role]);
  if (asset === undefined) return null;
  if (asset === null) return <FallbackAvatar role={role} />;
  return <SkinnedAvatar role={role} asset={asset} />;
}

export { FallbackAvatar, SkinnedAvatar };
