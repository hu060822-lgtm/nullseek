import { useEffect, useState } from 'react';
import {
  ROLE_INFO,
  TOKEN_CLASS,
  TOKEN_COLOR,
  TOKEN_LABEL,
  ZONES,
  type PuzzleStatus,
  type Role,
  type SignalToken,
} from '@null-protocol/shared';
import { deviceCode } from '../game/codes';
import { currentTarget, pose } from '../game/controller';
import { requestLock } from '../game/loop';
import { useStore } from '../state/store';
import { Icon, Loop, RoleGlyph, TokenGlyph, type LoopState } from './icons';

export function TokenChip({ t, size = 18 }: { t: SignalToken; size?: number }): JSX.Element {
  const color = TOKEN_COLOR[t];
  if (color) {
    return <span className="tok lamp-tok" style={{ background: color }} title={TOKEN_LABEL[t]} aria-label={TOKEN_LABEL[t]} />;
  }
  // 手勢與敲擊附上文字，避免「是」（閉合圓）與符號「○」混淆
  const labeled = t.startsWith('GEST_') || t.startsWith('TAP_');
  return (
    <span className={`tok ${labeled ? 'tap' : ''}`} title={TOKEN_LABEL[t]} aria-label={TOKEN_LABEL[t]}>
      <TokenGlyph t={t} size={size} />
      {labeled && <span className="xs">{TOKEN_LABEL[t]}</span>}
    </span>
  );
}

/** 準星與互動提示（每 100ms 更新，不需要每一幀重繪 React） */
function Aim({ role }: { role: Role }): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  const t = currentTarget(role);
  const zone = ZONES.find((z) => pose.x >= z.minX && pose.x <= z.maxX && pose.z >= z.minZ && pose.z <= z.maxZ);
  return (
    <>
      <div className={`crosshair ${t ? 'hot' : ''}`}>
        <Loop state={t ? 'active' : 'open'} size={22} />
      </div>
      {t && (
        <div className={`prompt plate ${t.usable ? '' : 'no'}`}>
          {t.usable ? <kbd>E</kbd> : <Icon name="lock" size={16} />}
          <span className="code">{deviceCode(t.device.id)}</span>
          <span>{t.device.label}</span>
          {!t.usable && <span>・不是你的設備</span>}
        </div>
      )}
      {zone && <div className="zone-tag plate">{zone.label}</div>}
    </>
  );
}

const LOOP_OF: Record<PuzzleStatus, LoopState> = {
  locked: 'locked',
  ready: 'ready',
  active: 'active',
  failed: 'failed',
  completed: 'solved',
};
const STATUS_TEXT: Partial<Record<PuzzleStatus, string>> = { ready: '就緒', failed: '失敗', active: '進行中' };

function Ledger(): JSX.Element | null {
  const world = useStore((s) => s.world);
  if (!world) return null;
  const done = world.puzzles.filter((p) => p.status === 'completed').length;
  const stage = world.stage;
  return (
    <div className="ledger plate">
      <header>
        <span>第一章　失聯設施</span>
        <span className="code">{done}／{world.puzzles.length}</span>
      </header>
      <ol>
        {world.puzzles.map((p, i) => {
          const active = world.activePuzzle === p.id;
          return (
            <li key={p.id} className={`${active ? 'active' : ''} ${p.status}`}>
              <Loop state={LOOP_OF[p.status]} size={16} />
              <span>
                <span className="code rno">R{String(i + 1).padStart(2, '0')}</span>
                {p.status === 'locked' ? '未開放' : p.title}
              </span>
              <span className="st">{STATUS_TEXT[p.status] ?? ''}</span>
            </li>
          );
        })}
      </ol>
      {stage && world.activePuzzle && (
        <footer>
          {stage.phase !== undefined && <span>階段 {stage.phase}</span>}
          {stage.visit !== undefined && <span>第 {stage.visit} 次進入</span>}
          <span>嘗試 {stage.attempts} 次</span>
          <span>提示 {world.hints.used}／3</span>
        </footer>
      )}
    </div>
  );
}

/** 三人同步的倒數條（看得見的人；聽得見的人另外會聽到每秒一聲滴答） */
function CountdownBar(): JSX.Element | null {
  const cd = useStore((s) => s.countdown);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!cd) return;
    const t = window.setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() > cd.until + 400 && useStore.getState().countdown?.id === cd.id) useStore.getState().set({ countdown: null });
    }, 100);
    return () => clearInterval(t);
  }, [cd]);
  if (!cd) return null;
  const left = Math.max(0, cd.until - Date.now());
  return (
    <div className="countdown plate" role="timer" aria-live="off">
      <span>同步窗口</span>
      <span className="bar">
        <i style={{ width: `${(left / cd.windowMs) * 100}%` }} />
      </span>
      <span className="code">{(left / 1000).toFixed(1)}s</span>
    </div>
  );
}

function Mates({ me }: { me: Role }): JSX.Element {
  const players = useStore((s) => s.room?.players ?? []);
  const talking = useStore((s) => s.talking);
  return (
    <div className="mates">
      {players
        .filter((p) => p.role && p.role !== me)
        .map((p) => (
          <div key={p.id} className={`mate plate ${p.connected ? '' : 'off'}`}>
            <RoleGlyph role={p.role!} size={18} />
            <span>{p.name}</span>
            {talking[p.role!] && (
              <span className="talkbars" aria-label="說話中">
                <i /><i /><i />
              </span>
            )}
            {!p.connected && <span className="xs">離線</span>}
          </div>
        ))}
    </div>
  );
}

function Signals({ canSee }: { canSee: boolean }): JSX.Element | null {
  const signals = useStore((s) => s.signals);
  if (!canSee) return null;
  return (
    <div className="signals" aria-live="polite">
      {signals.map((s) => {
        const info = ROLE_INFO[s.from];
        const visual = s.tokens.filter((t) => TOKEN_CLASS[t] === 'visual');
        const audible = s.tokens.filter((t) => TOKEN_CLASS[t] === 'audio');
        if (!visual.length && !audible.length) return null;
        return (
          <div key={s.id} className="sigcard plate">
            <span className="who">
              <RoleGlyph role={s.from} size={18} />
              {info.name}
            </span>
            {visual.map((t, i) => (
              <TokenChip key={i} t={t} />
            ))}
            {audible.length > 0 && <span className="xs dim">另有 {audible.length} 個敲擊（以聲音播放）</span>}
          </div>
        );
      })}
    </div>
  );
}

function Toasts({ canSee }: { canSee: boolean }): JSX.Element | null {
  const notices = useStore((s) => s.notices);
  if (!canSee) return null;
  return (
    <div className="toasts" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast plate ${n.tone}`}>
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

function MicChip({ role }: { role: Role }): JSX.Element {
  const micState = useStore((s) => s.micState);
  const muted = useStore((s) => s.micMuted);
  const level = useStore((s) => s.micLevel);
  if (!ROLE_INFO[role].canSpeak) {
    return (
      <div className="mic plate">
        <Icon name="micOff" size={16} /> 不能說話・<kbd>Q</kbd> 信號器
      </div>
    );
  }
  if (micState !== 'on') {
    return (
      <div className="mic plate">
        <Icon name="micOff" size={16} /> 麥克風未啟用・<kbd>H</kbd> 設定
      </div>
    );
  }
  return (
    <div className="mic plate">
      <Icon name={muted ? 'micOff' : 'mic'} size={16} />
      {muted ? '已靜音' : (
        <span className="meter">
          <i style={{ width: `${Math.min(100, level * 260)}%` }} />
        </span>
      )}
      <kbd>M</kbd>
    </div>
  );
}

function Solved(): JSX.Element | null {
  const solved = useStore((s) => s.solved);
  if (!solved) return null;
  return (
    <div className="solved-banner plate" key={solved.key}>
      <Loop state="solved" size={36} />
      <div>
        <div className="t">迴路閉合</div>
        <div className="n">{solved.title}</div>
      </div>
    </div>
  );
}

export default function Hud(): JSX.Element | null {
  const role = useStore((s) => s.me?.role ?? null);
  const locked = useStore((s) => s.locked);
  const panel = useStore((s) => s.panel);
  const overlay = useStore((s) => s.overlay);
  const briefed = useStore((s) => s.briefed);
  const complete = useStore((s) => s.complete);
  if (!role) return null;
  const canSee = ROLE_INFO[role].canSee;
  const showResume = briefed && !locked && !panel && overlay === 'none' && !complete;

  return (
    <div className="hud">
      {canSee && <Aim role={role} />}
      {canSee && <Ledger />}
      {canSee && <Mates me={role} />}
      <Toasts canSee={canSee} />
      <Signals canSee={canSee} />
      {canSee && <Solved />}
      {canSee && <CountdownBar />}
      <div className="bottombar">
        <MicChip role={role} />
        {canSee && (
          <div className="keys plate">
            <span><kbd>E</kbd>操作</span>
            <span><kbd>Q</kbd>信號器</span>
            <span><kbd>Tab</kbd>線索</span>
            <span><kbd>H</kbd>說明與提示</span>
            {role === 'MUTE' && <span><kbd>G</kbd>標記</span>}
          </div>
        )}
      </div>
      {showResume && (
        <div className="resume interactive" onClick={() => requestLock()}>
          <div className="box plate">
            <b>點一下畫面繼續</b>
            <span className="sm dim">遊戲沒有暫停，隊友仍在行動。<kbd>H</kbd> 說明與提示</span>
          </div>
        </div>
      )}
    </div>
  );
}
