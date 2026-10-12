import { lazy, Suspense, useEffect } from 'react';
import { DOOR_IDS, PUZZLE_IDS, PUZZLE_TITLES, roomRect, type Role, type SceneClues, type WorldPublic } from '@null-protocol/shared';
import { useStore } from '../state/store';
import { pose, setDoors } from '../game/controller';
import { remotes } from '../game/remote';
import Ending from './Ending';
import Hud from './Hud';

/**
 * 美術審視用的離線預覽（網址加 ?preview=…）。不連伺服器，只用假的公開世界狀態渲染場景。
 *
 *   ?preview=start             遊戲開始（R01，門都關著）
 *   ?preview=room&room=4       站在第 4 個房間（前面的門都已開啟、後面的房間未通電）
 *   ?preview=ending            結局畫面
 *   &role=BLIND|DEAF|MUTE      以哪個角色的視角（預設 MUTE）
 *   &yaw=-90                   視角朝向（度；預設 180＝面向前方的門）
 *
 * 角色專屬的場景線索在預覽裡用「示範值」，與真正的謎題資料無關（客戶端本來就拿不到答案）。
 */
const Scene = lazy(() => import('../game/Scene'));

function fakeWorld(mode: string, room: number): WorldPublic {
  const done = mode === 'ending' ? 10 : mode === 'room' ? room - 1 : 0;
  return {
    version: 1,
    puzzles: PUZZLE_IDS.map((id, i) => ({ id, title: PUZZLE_TITLES[id], status: i < done ? 'completed' : i === done ? 'active' : 'locked' })),
    activePuzzle: done < 10 ? PUZZLE_IDS[done] : null,
    doors: Object.fromEntries(DOOR_IDS.map((d, i) => [d, i < done])) as WorldPublic['doors'],
    stage: done < 10 ? { attempts: 0 } : null,
    chapterComplete: mode === 'ending',
    hints: { used: 0, tier: 0, nextAt: 0 },
  };
}

function demoClues(role: Role): SceneClues {
  if (role === 'DEAF') return { r1Symbols: ['SQR', 'CIR', 'DIA'], r2Lamps: { A: 'WHITE', B: 'RED', C: 'WHITE', D: 'GREEN' }, r4Landmark: 'TRIANGLE', r9Labels: ['C', 'A', 'D', 'B'], r9Lights: [0, 1, 0, 0] };
  if (role === 'MUTE') return { r4Landmark: 'CYLINDER' };
  return {};
}

export default function Preview({ mode, role }: { mode: string; role: Role }): JSX.Element {
  useEffect(() => {
    const room = Math.min(10, Math.max(1, Number(new URLSearchParams(location.search).get('room') ?? 1) || 1));
    const world = fakeWorld(mode, room);
    setDoors(world.doors);
    const r = roomRect(mode === 'room' ? room : 1);
    pose.x = 0.6;
    pose.z = r.minZ + 1.6;
    const yawDeg = Number(new URLSearchParams(location.search).get('yaw'));
    pose.yaw = Number.isFinite(yawDeg) && new URLSearchParams(location.search).has('yaw') ? (yawDeg * Math.PI) / 180 : Math.PI;
    pose.pitch = -0.05;
    useStore.getState().set({
      world,
      clues: demoClues(role),
      me: { id: 'p', role, isHost: true },
      room: {
        code: 'PREVIEW',
        phase: mode === 'ending' ? 'COMPLETE' : 'PLAYING',
        canStart: true,
        players: [
          { id: 'a', name: 'Aki', role: 'BLIND', connected: true, isHost: true },
          { id: 'b', name: 'Bao', role: 'DEAF', connected: true, isHost: false },
          { id: 'c', name: 'Cleo', role: 'MUTE', connected: true, isHost: false },
        ],
      },
      briefed: true,
      locked: true,
      complete: mode === 'ending',
    });
    const mz = r.minZ + 4.5;
    const still = (x: number, z: number, yaw: number) => ({ x, z, yaw, tx: x, tz: z, tyaw: yaw, movedAt: 0, stride: 0, seen: true, speed: 0, turnRate: 0, at: performance.now(), crouch: false, act: null, hurt: 0 });
    remotes.BLIND = still(-2, mz, 0.6);
    remotes.DEAF = still(1.5, mz + 1.2, 2.6);
    remotes.MUTE = still(2.6, mz - 0.6, -2.4);
  }, [mode, role]);
  return (
    <div className="game">
      {mode !== 'ending' && (
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      )}
      {mode !== 'ending' && <Hud />}
      <Ending />
    </div>
  );
}
