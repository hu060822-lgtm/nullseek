import { useCallback, useEffect, useState } from 'react';
import {
  DEVICE_BY_ID,
  MAX_SIGNAL_LEN,
  PUZZLE_IDS,
  PUZZLE_TITLES,
  ROLES,
  ROLE_INFO,
  SIGNAL_TOKENS,
  TOKEN_CLASS,
  TOKEN_COLOR,
  TOKEN_LABEL,
  canPerceive,
  type LogEntry,
  type Role,
  type SignalToken,
} from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { setSpeechEnabled, speak } from '../audio/speech';
import { requestLock, toggleOverlay } from '../game/loop';
import { emitSignal, leaveRoom, requestHint, restartGame } from '../net/socket';
import { useStore } from '../state/store';
import { BlockView } from './blocks';
import { TokenChip } from './Hud';
import MicSetup from './MicSetup';
import { Icon, RoleGlyph, TokenGlyph, type IconName } from './icons';
import { deviceCode } from '../game/codes';

function Shell({ title, sub, icon, onClose, children }: { title: string; sub?: string; icon: IconName; onClose: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <Icon name={icon} size={22} />
          <div>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button className="btn small icon" onClick={onClose} aria-label="關閉（Esc）" title="關閉（Esc）">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

const close = (): void => {
  useStore.getState().set({ overlay: 'none' });
  requestLock();
};

/* ------------------------------ 線索紀錄 ------------------------------ */

function LogItem({ e }: { e: LogEntry }): JSX.Element {
  const dev = DEVICE_BY_ID[e.deviceId];
  return (
    <div className="log-entry">
      <h4>
        <span className="code">{deviceCode(e.deviceId)}</span>
        {e.title}
        <span className="where">{e.puzzle === 'LORE' ? '設施紀錄' : PUZZLE_TITLES[e.puzzle]}・{dev?.label}</span>
      </h4>
      {e.audioOnly ? (
        e.tap ? (
          <div className="row">
            <button className="btn small mech" onClick={() => e.tap && audio.playTaps(e.tap)} aria-label={`重聽：${e.title}`}>
              <Icon name="play" size={16} /> 重聽這段聲音
            </button>
          </div>
        ) : (
          <p className="note">這是只能用聽的線索。回到 {deviceCode(e.deviceId)}「{dev?.label ?? e.deviceId}」按 <kbd>E</kbd> 重聽。</p>
        )
      ) : (
        e.blocks.map((b, i) => <BlockView key={i} b={b} />)
      )}
    </div>
  );
}

export function LogOverlay(): JSX.Element {
  const log = useStore((s) => s.log);
  const role = useStore((s) => s.me?.role);
  useEffect(() => {
    if (role && !ROLE_INFO[role].canSee) {
      speak(log.length ? `你有 ${log.length} 則線索紀錄。${log.map((e) => e.title).join('、')}` : '還沒有線索紀錄', { interrupt: true });
    }
  }, [log, role]);
  const groups = [...PUZZLE_IDS, 'LORE' as const].map((id) => ({ id, items: log.filter((e) => e.puzzle === id) })).filter((g) => g.items.length);
  return (
    <Shell icon="log" title="線索紀錄" sub="只有你看得到這份紀錄，隊友只能靠你轉述。" onClose={close}>
      {groups.length === 0 && <p className="note">還沒有任何線索。走到自己的設備前按 <kbd>E</kbd> 查看。</p>}
      {groups.map((g) => g.items.map((e) => <LogItem key={e.key} e={e} />))}
    </Shell>
  );
}

/* ------------------------------ 信號器 ------------------------------ */

const GROUPS: Array<{ title: string; tokens: SignalToken[] }> = [
  { title: '敲擊（聽覺）', tokens: ['TAP_S', 'TAP_L'] },
  { title: '燈號（視覺）', tokens: ['LIGHT_R', 'LIGHT_B', 'LIGHT_G', 'LIGHT_W'] },
  { title: '符號（視覺）', tokens: ['SYM_TRI', 'SYM_CIR', 'SYM_SQR', 'SYM_DIA', 'SYM_H', 'SYM_V'] },
  { title: '手勢（視覺）', tokens: ['GEST_WAIT', 'GEST_YES', 'GEST_NO', 'GEST_GO', 'GEST_LEFT', 'GEST_CENTER', 'GEST_RIGHT', 'GEST_AGAIN'] },
];

export function SignalOverlay(): JSX.Element | null {
  const me = useStore((s) => s.me?.role ?? null);
  const signals = useStore((s) => s.signals);
  const [queue, setQueue] = useState<SignalToken[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = useCallback((t: SignalToken) => {
    setQueue((q) => (q.length >= MAX_SIGNAL_LEN ? q : [...q, t]));
    audio.uiKey();
    if (me && !ROLE_INFO[me].canSee) speak(TOKEN_LABEL[t], { interrupt: true });
  }, [me]);

  const send = useCallback(async () => {
    if (!queue.length || busy) return;
    setBusy(true);
    const e = await emitSignal(queue);
    setBusy(false);
    if (e) {
      setMsg(e);
      speak(e);
    } else {
      setMsg(`已送出 ${queue.length} 個訊號。`);
      speak('已送出');
      audio.signalTokens(queue);
      setQueue([]);
    }
  }, [queue, busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.matches?.('input,select,textarea')) return;
      if (e.code === 'KeyT') add('TAP_S');
      else if (e.code === 'KeyY') add('TAP_L');
      else if (e.code === 'Enter') {
        e.preventDefault();
        void send();
      } else if (e.code === 'Backspace') setQueue((q) => q.slice(0, -1));
      else if (e.code === 'Delete') setQueue([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [add, send]);

  if (!me) return null;
  const others = ROLES.filter((r) => r !== me);
  const who = (t: SignalToken): string => {
    const ok = others.filter((r) => canPerceive(r, t)).map((r) => ROLE_INFO[r].letter);
    return ok.length ? `${ok.join('、')} 感知得到` : '沒有隊友感知得到';
  };

  return (
    <Shell icon="signal" title="信號器" sub="沒有自由文字。敲擊只傳給聽得見的人，燈號、符號、手勢只傳給看得見的人。" onClose={close}>
      {GROUPS.map((g) => (
        <div key={g.title} className="ctrl">
          <div className="lbl">
            {g.title}　<span className="legend">{who(g.tokens[0])}</span>
          </div>
          <div className="palette">
            {g.tokens.map((t) =>
              TOKEN_COLOR[t] ? (
                <button key={t} className="tok lamp-tok" style={{ background: TOKEN_COLOR[t] }} onClick={() => add(t)} aria-label={TOKEN_LABEL[t]} title={TOKEN_LABEL[t]} />
              ) : (
                <button key={t} className={`tok ${TOKEN_CLASS[t] === 'audio' || g.title.startsWith('手勢') ? 'tap' : ''}`} onClick={() => add(t)} aria-label={TOKEN_LABEL[t]} title={TOKEN_LABEL[t]}>
                  <TokenGlyph t={t} size={20} />
                  {(TOKEN_CLASS[t] === 'audio' || g.title.startsWith('手勢')) && <span className="sm">{TOKEN_LABEL[t]}</span>}
                </button>
              ),
            )}
          </div>
        </div>
      ))}
      <div className="ctrl">
        <div className="lbl">
          待送出（最多 {MAX_SIGNAL_LEN} 個）
        </div>
        <div className="queue">
          {queue.length === 0 && <span className="sm dim">點選上方的訊號加入序列</span>}
          {queue.map((t, i) => (
            <TokenChip key={i} t={t} />
          ))}
        </div>
      </div>
      {msg && (
        <div className="result info">
          <Icon name="signal" size={18} />
          <span>{msg}</span>
        </div>
      )}
      <div className="actions">
        <button className="btn primary" disabled={!queue.length || busy} onClick={() => void send()}>
          送出（Enter）
        </button>
        <button className="btn" disabled={!queue.length} onClick={() => setQueue((q) => q.slice(0, -1))}>
          刪除最後一個（Backspace）
        </button>
        <button className="btn" disabled={!queue.length} onClick={() => setQueue([])}>
          清空（Delete）
        </button>
      </div>
      <p className="legend">快速鍵：<kbd>T</kbd> 短敲、<kbd>Y</kbd> 長敲。</p>
      {signals.length > 0 && (
        <div className="ctrl">
          <div className="lbl">最近收到</div>
          {signals.map((s) => (
            <div key={s.id} className="recv">
              <RoleGlyph role={s.from} size={18} />
              <span className="sm" style={{ minWidth: 56 }}>{ROLE_INFO[s.from].name}</span>
              {s.tokens.map((t, i) => (
                <TokenChip key={i} t={t} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------ 說明／提示／設定 ------------------------------ */

function VolumeSlider({ label, k, max = 1 }: { label: string; k: 'volume' | 'envVolume' | 'echoVolume' | 'navVolume' | 'voiceVolume'; max?: number }): JSX.Element {
  const v = useStore((s) => s.prefs[k]);
  return (
    <label className="slider">
      {label}
      <input type="range" min={0} max={max} step={0.05} value={v} onChange={(e) => {
        const n = Number(e.target.value);
        useStore.getState().setPrefs({ [k]: n });
        if (k === 'volume') audio.setVolume(n);
      }} />
      <span>{Math.round(v * 100)}</span>
    </label>
  );
}

/** 音訊設定與校準（聽得見的角色）。回聲、方向提示與隊友語音的音量分開調整 */
function AudioSettings({ blind }: { blind: boolean }): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  return (
    <>
      <VolumeSlider label="總音量" k="volume" />
      <VolumeSlider label="環境音與地標" k="envVolume" max={1.5} />
      {blind && <VolumeSlider label="回聲" k="echoVolume" max={1.5} />}
      {blind && <VolumeSlider label="方向提示與設備指引" k="navVolume" max={1.5} />}
      <VolumeSlider label="隊友語音" k="voiceVolume" max={1.5} />
      <div className="row sm calibrate">
        <span>音訊校準：</span>
        <button className="btn small" onClick={() => void audio.init().then(() => audio.testChannel('left'))}>左聲道</button>
        <button className="btn small" onClick={() => void audio.init().then(() => audio.testChannel('right'))}>右聲道</button>
        <button className="btn small" onClick={() => void audio.init().then(() => audio.testChannel('both'))}>兩邊（音量）</button>
      </div>
      <label className="row sm">
        <input type="checkbox" checked={prefs.mono} onChange={(e) => useStore.getState().setPrefs({ mono: e.target.checked })} />
        單聲道模式（只有一個喇叭、或左右聲道聽起來一樣時使用{blind ? '；回聲會另外用語音報出四個方向的距離' : ''}）
      </label>
      {blind && (
        <label className="row sm">
          <input type="checkbox" checked={prefs.beacon} onChange={(e) => useStore.getState().setPrefs({ beacon: e.target.checked })} />
          設備指引音（靠近自己能操作的設備時發出的「滴」聲）
        </label>
      )}
    </>
  );
}

export function HelpOverlay(): JSX.Element | null {
  const me = useStore((s) => s.me);
  const world = useStore((s) => s.world);
  const prefs = useStore((s) => s.prefs);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!me?.role) return null;
  const info = ROLE_INFO[me.role];
  const role: Role = me.role;
  const hints = world?.hints;
  const wait = hints ? Math.max(0, Math.ceil((hints.nextAt - now) / 1000)) : 0;
  const active = world?.puzzles.find((p) => p.id === world.activePuzzle);

  return (
    <Shell icon="help" title="說明與提示" sub={`你是${info.name}：${info.tagline}`} onClose={close}>
      <div className="blk-heading">提示</div>
      <div className="note">
        {active ? `目前謎題：${active.title}。` : ''}提示分三層，由淺到深，會廣播給全隊（文字給看得見的人，語音給看不見的人）。
        {hints && ` 這一題已使用 ${hints.tier}／3 層。`}
      </div>
      <div className="row">
        <button className="btn" disabled={!active || wait > 0 || (hints?.tier ?? 0) >= 3} onClick={() => void requestHint()}>
          <Icon name="hint" size={18} />
          {wait > 0 ? `${wait} 秒後可再請求` : (hints?.tier ?? 0) >= 3 ? '這一題的提示已用完' : '請求下一層提示'}
        </button>
      </div>

      <div className="blk-heading">你的角色</div>
      <ul className="blk-list">
        {info.limits.map((t) => (
          <li key={t}>{t}</li>
        ))}
        {info.strengths.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <div className="blk-heading">操作</div>
      <div className="note">
        <kbd>WASD</kbd> 移動、<kbd>Shift</kbd> 跑、<kbd>C</kbd> 蹲下／站起、滑鼠轉向、<kbd>E</kbd> 操作設備、<kbd>Q</kbd> 信號器、<kbd>Tab</kbd> 線索、<kbd>H</kbd> 本頁
        {info.canSpeak && <>、<kbd>M</kbd> 麥克風靜音</>}
        {!info.canSee && <>、<kbd>F</kbd> 回聲定位、<kbd>V</kbd> 報出朝向、<kbd>P</kbd> 重聽機械聲</>}
        {info.canHear && <>、<kbd>K</kbd> 音訊校準</>}
        {role === 'MUTE' && <>、<kbd>G</kbd> 標記注視中的設備（隊友會看到標記、聽到方位）</>}。
        門洞（無窗迷宮、循環走廊）只要走進去就會觸發。
      </div>

      <div className="blk-heading">語音</div>
      <MicSetup role={role} />

      <div className="blk-heading">設定</div>
      {info.canHear && <AudioSettings blind={!info.canSee} />}
      <label className="slider">
        滑鼠靈敏度
        <input type="range" min={0.3} max={2.5} step={0.05} value={prefs.sensitivity} onChange={(e) => useStore.getState().setPrefs({ sensitivity: Number(e.target.value) })} />
        <span>{prefs.sensitivity.toFixed(2)}</span>
      </label>
      {info.canSee && (
        <label className="row sm">
          <input type="checkbox" checked={prefs.retro} onChange={(e) => useStore.getState().setPrefs({ retro: e.target.checked })} />
          復古低解析度畫面（PS1 風格；遠處的銘牌文字會比較難讀）
        </label>
      )}
      {!info.canSee && (
        <label className="row sm">
          <input type="checkbox" checked={prefs.speech} onChange={(e) => {
            useStore.getState().setPrefs({ speech: e.target.checked });
            setSpeechEnabled(e.target.checked);
          }} />
          語音播報（設備名稱、面板文字、通知）
        </label>
      )}

      <div className="blk-heading">房間</div>
      <div className="row">
        {me.isHost && (
          <button className="btn" onClick={() => { if (confirm('確定要讓全隊回到大廳、重新開始第一章嗎？')) void restartGame(); }}>
            重新開始（全隊）
          </button>
        )}
        <button className="btn danger" onClick={() => { if (confirm('確定要離開房間嗎？隊友將無法繼續。')) leaveRoom(); }}>
          離開房間
        </button>
      </div>
    </Shell>
  );
}

export function Overlays(): JSX.Element | null {
  const overlay = useStore((s) => s.overlay);
  const panel = useStore((s) => s.panel);
  if (panel) return null;
  if (overlay === 'log') return <LogOverlay />;
  if (overlay === 'signals') return <SignalOverlay />;
  if (overlay === 'help') return <HelpOverlay />;
  return null;
}

export { toggleOverlay };
