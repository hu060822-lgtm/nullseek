import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { on } from '../game/bus';
import { ROLES, ROLE_INFO } from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { bindInput, requestLock, startGameLoop } from '../game/loop';
import { useStore } from '../state/store';
import { voice } from '../voice/voice';
import { preloadCrew } from '../game/characters/assets';
import BlindView from './BlindView';
import DebugPanel from './DebugPanel';
import Briefing from './Briefing';
import Ending from './Ending';
import Hud from './Hud';
import { Overlays } from './Overlays';
import PanelModal from './PanelModal';

// 只有看得見的角色才會下載／執行 3D 場景
const Scene = lazy(() => import('../game/Scene'));

/** 謎題失敗時的一次性故障：兩條朱紅掃描線與一段錯位帶，0.6 秒內消失 */
function Fault(): JSX.Element | null {
  const [k, setK] = useState(0);
  useEffect(() => on('fault', () => setK((n) => n + 1)), []);
  if (!k) return null;
  return (
    <div className="fault" key={k} aria-hidden>
      <i />
      <i />
      <div className="band" />
    </div>
  );
}

/** 謎題回饋的畫面效果：閃燈、空間轉換（傳送）、儀器自檢；倒數與故障另外處理 */
function Fx(): JSX.Element | null {
  const [fx, setFx] = useState<{ k: number; v: string } | null>(null);
  useEffect(
    () =>
      on('fx', (f) => {
        if (f.visual === 'flash' || f.visual === 'shift' || f.visual === 'selftest') setFx((p) => ({ k: (p?.k ?? 0) + 1, v: f.visual }));
      }),
    [],
  );
  if (!fx) return null;
  return <div className={`fx ${fx.v}`} key={fx.k} aria-hidden />;
}

export default function GameScreen(): JSX.Element | null {
  const role = useStore((s) => s.me?.role ?? null);
  const briefed = useStore((s) => s.briefed);
  const panel = useStore((s) => s.panel);
  const volume = useStore((s) => s.prefs.volume);
  const prefs = useStore((s) => s.prefs);
  const debug = useStore((s) => s.debug && s.debugOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const unbind = bindInput(ref.current);
    const stop = startGameLoop();
    void voice.start();
    return () => {
      unbind();
      stop();
    };
  }, []);

  useEffect(() => {
    audio.setVolume(volume);
  }, [volume]);

  // 各類聲音的音量與單聲道模式（音訊還沒啟動時引擎會先記住，啟動後套用）
  useEffect(() => {
    audio.setBusVolume('env', prefs.envVolume);
    audio.setBusVolume('echo', prefs.echoVolume);
    audio.setBusVolume('nav', prefs.navVolume);
    audio.setBusVolume('voice', prefs.voiceVolume);
    audio.setMono(prefs.mono);
  }, [prefs.envVolume, prefs.echoVolume, prefs.navVolume, prefs.voiceVolume, prefs.mono]);

  useEffect(() => {
    if (panel && document.pointerLockElement) document.exitPointerLock();
  }, [panel]);

  // 看得見的角色預先下載隊友的角色模型（盲區員不載入任何 3D 資產）
  useEffect(() => {
    if (role && ROLE_INFO[role].canSee) preloadCrew(ROLES.filter((r) => r !== role));
  }, [role]);

  if (!role) return null;
  const canSee = ROLE_INFO[role].canSee;

  return (
    <div className="game" ref={ref}>
      {canSee ? (
        <Suspense fallback={<div className="blind-view"><div className="whisper">正在載入設施…</div></div>}>
          <div style={{ position: 'absolute', inset: 0 }} onClick={() => !panel && requestLock()}>
            <Scene />
          </div>
        </Suspense>
      ) : (
        <BlindView />
      )}
      {canSee && <Fault />}
      {canSee && <Fx />}
      <Hud />
      <PanelModal />
      <Overlays />
      {!briefed && <Briefing />}
      <Ending />
      {debug && <DebugPanel />}
    </div>
  );
}
