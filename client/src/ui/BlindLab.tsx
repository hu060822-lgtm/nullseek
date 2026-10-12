import { useEffect, useState } from 'react';
import {
  BLIND_LAB,
  LAB_DOOR_POS,
  LAB_SPAWN,
  LAB_TARGET_POS,
  LAB_WALLS,
  LAB_CABINET,
  LAB_DOOR,
  LAB_TARGET,
  forwardOf,
  headingOf,
  labColliders,
} from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { setSpeechEnabled, speak } from '../audio/speech';
import { BlindAudioSystem, type PulseResult } from '../game/blind';
import { emit } from '../game/bus';
import { clearKeys, getColliders, look, pose, setColliders, setKey, step } from '../game/controller';
import { calibrateAudio } from '../game/loop';
import { useStore } from '../state/store';
import BlindView from './BlindView';

/**
 * 盲區員測試關卡（?preview=blind-lab）。不需要伺服器，也不需要其他玩家。
 *
 * 目標：從起點出發，穿過走廊，在岔路找到通往目標房間的門（按 E 開門），再找到目標設備（按 E）。
 * 使用與正式遊戲相同的模組：BlindAudioSystem（方向基準、回聲、地標、風險區）與同一個移動控制器，
 * 只把關卡資料換成 BLIND_LAB。岔路中央有一個聲學感測器（本機模擬週期）。
 *
 * &map=1：顯示俯視圖（給關卡設計者檢查用；正式遊戲的盲區員永遠看不到）。
 */

interface LabState {
  door: boolean;
  done: boolean;
  pulses: number;
  jams: number;
  startedAt: number;
  doneAt: number;
}

const near = (p: readonly [number, number], r: number): boolean => {
  const dx = p[0] - pose.x;
  const dz = p[1] - pose.z;
  const d = Math.hypot(dx, dz);
  const [fx, fz] = forwardOf(pose.yaw);
  return d < r && (dx * fx + dz * fz) / (d || 1) > 0.5;
};

export default function BlindLab(): JSX.Element {
  const showMap = new URLSearchParams(location.search).has('map');
  const [view, setView] = useState<{ door: boolean; done: boolean; jams: number; heading: string }>({ door: false, done: false, jams: 0, heading: '深處' });
  const [, tick] = useState(0);

  useEffect(() => {
    const prefs = useStore.getState().prefs;
    audio.setHearing(true);
    audio.setVolume(prefs.volume);
    audio.setBusVolume('env', prefs.envVolume);
    audio.setBusVolume('echo', prefs.echoVolume);
    audio.setBusVolume('nav', prefs.navVolume);
    audio.setBusVolume('voice', prefs.voiceVolume);
    audio.setMono(prefs.mono || new URLSearchParams(location.search).has('mono'));
    setSpeechEnabled(prefs.speech);

    const st: LabState = { door: false, done: false, pulses: 0, jams: 0, startedAt: performance.now(), doneAt: 0 };
    setColliders(labColliders(false));
    pose.x = LAB_SPAWN.x;
    pose.z = LAB_SPAWN.z;
    pose.yaw = LAB_SPAWN.yaw;
    pose.pitch = 0;

    const sys = new BlindAudioSystem({
      level: BLIND_LAB,
      blind: true,
      isOpen: (d) => d === 'lab_door' && st.door,
      speak: (t) => speak(t, { interrupt: true }),
    });
    sys.risk.simulate();

    const sync = () => setView({ door: st.door, done: st.done, jams: st.jams, heading: headingOf(pose.yaw).label });

    const pulse = (): PulseResult | null => {
      const now = performance.now();
      const res = sys.pulse(pose.x, pose.z, pose.yaw, getColliders(), now);
      if (!res?.ok) return res;
      st.pulses++;
      // 本機模擬伺服器的判定：警戒中、在感測器範圍內
      const danger = sys.risk.dangerAt(pose.x, pose.z);
      if (danger) {
        st.jams++;
        sys.tripped(danger.id, danger.jamMs, now);
        emit('riskTripped', { id: danger.id, jamMs: danger.jamMs });
        speak(`聲學感測器偵測到回聲，回聲受到干擾 ${Math.round(danger.jamMs / 1000)} 秒`);
        sync();
      }
      return res;
    };

    const interact = (): string => {
      if (!st.door && near(LAB_DOOR_POS, 1.9)) {
        st.door = true;
        setColliders(labColliders(true));
        audio.door(LAB_DOOR_POS, true);
        speak('門打開了');
        sync();
        return 'door';
      }
      if (!st.done && near(LAB_TARGET_POS, 2.1)) {
        st.done = true;
        st.doneAt = performance.now();
        audio.solved();
        speak('找到目標設備，測試完成');
        sync();
        return 'target';
      }
      audio.uiKey();
      return 'none';
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyF':
          pulse();
          return;
        case 'KeyV':
          sys.speakHeading(pose.yaw);
          sync();
          return;
        case 'KeyK':
          calibrateAudio();
          return;
        case 'KeyE':
          interact();
          return;
        default:
          setKey(e.code, true);
      }
    };
    const onUp = (e: KeyboardEvent): void => setKey(e.code, false);
    const onMouse = (e: MouseEvent): void => {
      if (document.pointerLockElement) look(e.movementX, e.movementY, useStore.getState().prefs.sensitivity);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    window.addEventListener('mousemove', onMouse);

    let raf = 0;
    let last = performance.now();
    let lastBump = 0;
    let lastDuck = 0;
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const res = step(dt, !st.done);
      if (res.footstep) audio.footstep(null, res.running);
      if (res.blocked && now - lastBump > 450) {
        lastBump = now;
        audio.bump();
        emit('bump', undefined);
      }
      audio.setListener(pose.x, pose.z, pose.yaw);
      sys.update(pose.x, pose.z, pose.yaw, now);
      audio.updateVoicePos('MUTE', pose.x + 1.2, pose.z);
      if (now - lastDuck > 150) {
        lastDuck = now;
        audio.setEnvDuck(audio.hasVoice('MUTE') && audio.voiceLevel('MUTE') > 0.06);
        if (showMap) tick((n) => n + 1);
      }
    };
    raf = requestAnimationFrame(frame);

    let fake: OscillatorNode | null = null;
    // 測試與自動化用的介面（只存在於測試關卡；這裡沒有任何隱藏資訊）
    (window as unknown as { __LAB__: unknown }).__LAB__ = {
      pose,
      state: st,
      sys,
      audio,
      pulse,
      interact,
      heading: () => headingOf(pose.yaw),
      turn: (rad: number) => {
        pose.yaw -= rad; // 正值＝往右轉（與滑鼠往右相同）
      },
      riskState: () => sys.risk.stateOf('lab_sensor'),
      start: () => audio.init().then(() => audio.startAmbient()),
      /** 模擬一位隊友正在說話（給「語音、回聲、環境音同時播放」的測試） */
      fakeVoice: (on: boolean) => {
        const ctx = audio.context;
        if (!ctx) return false;
        if (!on) {
          fake?.stop();
          fake = null;
          audio.detachVoice('MUTE');
          return true;
        }
        const dest = ctx.createMediaStreamDestination();
        fake = ctx.createOscillator();
        fake.frequency.value = 220;
        const g = ctx.createGain();
        g.gain.value = 0.6;
        fake.connect(g).connect(dest);
        fake.start();
        return audio.attachVoice('MUTE', dest.stream);
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('mousemove', onMouse);
      clearKeys();
      sys.dispose();
    };
  }, [showMap]);

  return (
    <div className="blind-lab">
      <BlindView />
      <div className="lab-brief">
        <h1>盲區員測試關卡</h1>
        <p>穿過走廊，在岔路找到通往目標房間的門並打開，再找到目標設備。岔路中央有聲學感測器：聽到滴答聲時發出回聲會被偵測。</p>
        <p className="lab-keys">
          點一下畫面開始（請戴耳機）。<kbd>WASD</kbd> 移動、滑鼠轉向、<kbd>F</kbd> 回聲、<kbd>V</kbd> 報出朝向、<kbd>K</kbd> 音訊校準、<kbd>E</kbd> 開門／操作。加上 <code>&amp;mono=1</code> 測試單聲道。
        </p>
        <p className="lab-status" data-door={view.door ? 1 : 0} data-done={view.done ? 1 : 0}>
          {view.done ? '完成：找到目標設備。' : view.door ? '門已打開。' : '門尚未打開。'}
          {view.jams > 0 && ` 被感測器偵測 ${view.jams} 次。`}
        </p>
      </div>
      {showMap && <LabMap door={view.door} />}
    </div>
  );
}

/** 俯視圖（只在 &map=1 時顯示，給關卡設計者檢查用） */
function LabMap({ door }: { door: boolean }): JSX.Element {
  const S = 14;
  const box = (b: { minX: number; maxX: number; minZ: number; maxZ: number }, cls: string, key: string) => (
    // 俯視圖：上方＝深處（+z），左右與「面向深處時」看到的一致（右邊＝右翼，-x）
    <rect key={key} className={cls} x={-b.maxX * S} y={-b.maxZ * S} width={(b.maxX - b.minX) * S} height={(b.maxZ - b.minZ) * S} />
  );
  const [fx, fz] = forwardOf(pose.yaw);
  return (
    <svg className="lab-map" viewBox={`${-14 * S} ${-22 * S} ${22 * S} ${24 * S}`} width={22 * S} height={24 * S} aria-hidden>
      {LAB_WALLS.map((b) => box(b, 'w', b.id))}
      {box(LAB_TARGET, 't', 'target')}
      {box(LAB_CABINET, 'c', 'cab')}
      {!door && box(LAB_DOOR, 'd', 'door')}
      {BLIND_LAB.risks.map((r) => (
        <circle key={r.id} className="risk" cx={-r.pos[0] * S} cy={-r.pos[1] * S} r={r.radius * S} />
      ))}
      <circle className="me" cx={-pose.x * S} cy={-pose.z * S} r={4} />
      <line className="me" x1={-pose.x * S} y1={-pose.z * S} x2={-(pose.x + fx) * S} y2={-(pose.z + fz) * S} />
    </svg>
  );
}
