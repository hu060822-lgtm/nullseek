import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionBtn, Control, PanelView } from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { closePanel, doAction } from '../net/socket';
import { useStore } from '../state/store';
import { requestLock } from '../game/loop';
import { BlockView, StatusIcon } from './blocks';
import { deviceCode } from '../game/codes';
import { Icon } from './icons';

type Vals = Record<string, string[]>;

function initialValues(controls: Control[]): Vals {
  const v: Vals = {};
  for (const c of controls) {
    if (c.type === 'digits') v[c.id] = Array.from({ length: c.minLength }, () => '');
    else if (c.type === 'selects') v[c.id] = Array.from({ length: c.count }, () => '');
    else if (c.type === 'select') v[c.id] = [''];
    else if (c.type === 'knobs') v[c.id] = Array.from({ length: c.count }, () => '1');
  }
  return v;
}

function DigitsCtl({ c, value, onChange, onEnter }: { c: Extract<Control, { type: 'digits' }>; value: string[]; onChange: (v: string[]) => void; onEnter: () => void }): JSX.Element {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const variable = c.minLength !== c.maxLength;
  const set = (i: number, raw: string): void => {
    const digit = raw.replace(/[^0-9]/g, '').slice(-1);
    const next = [...value];
    next[i] = digit;
    onChange(next);
    if (digit && i < value.length - 1) refs.current[i + 1]?.focus();
    audio.uiKey();
  };
  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < value.length - 1) refs.current[i + 1]?.focus();
    else if (e.key === 'Enter') onEnter();
  };
  const paste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text').replace(/[^0-9]/g, '');
    if (!text) return;
    e.preventDefault();
    const n = variable ? Math.min(c.maxLength, Math.max(c.minLength, text.length)) : c.minLength;
    onChange(Array.from({ length: n }, (_, i) => text[i] ?? ''));
  };
  return (
    <div className="cells">
      {value.map((v, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="cell"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={2}
          value={v}
          aria-label={`${c.label} 第 ${i + 1} 位`}
          onChange={(e) => set(i, e.target.value)}
          onKeyDown={(e) => onKey(i, e)}
          onPaste={paste}
          onFocus={(e) => e.target.select()}
        />
      ))}
      {variable && (
        <>
          <button type="button" className="btn small" disabled={value.length >= c.maxLength} onClick={() => onChange([...value, ''])} aria-label="增加一位">
            ＋
          </button>
          <button type="button" className="btn small" disabled={value.length <= c.minLength} onClick={() => onChange(value.slice(0, -1))} aria-label="減少一位">
            －
          </button>
        </>
      )}
    </div>
  );
}

function ControlView({ c, vals, setVals, onEnter }: { c: Control; vals: Vals; setVals: (v: Vals) => void; onEnter: () => void }): JSX.Element {
  const value = vals[c.id] ?? [];
  const update = (v: string[]): void => setVals({ ...vals, [c.id]: v });
  return (
    <div className="ctrl" data-control={c.id} data-type={c.type}>
      <div className="lbl">{c.label}</div>
      {c.type === 'digits' && <DigitsCtl c={c} value={value} onChange={update} onEnter={onEnter} />}
      {c.type === 'selects' && (
        <div className="cells">
          {value.map((v, i) => (
            <select
              key={i}
              value={v}
              aria-label={`${c.label} 第 ${i + 1} 個`}
              onChange={(e) => {
                const next = [...value];
                next[i] = e.target.value;
                update(next);
                audio.uiKey();
              }}
            >
              <option value="">—</option>
              {c.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
      {c.type === 'select' && (
        <div className="opts" role="radiogroup" aria-label={c.label}>
          {c.options.map((o) => (
            <label key={o.value} className={`opt ${value[0] === o.value ? 'sel' : ''}`}>
              <input type="radio" name={c.id} value={o.value} checked={value[0] === o.value} onChange={() => { update([o.value]); audio.uiKey(); }} />
              <span>
                <b>{o.label}</b>
                {o.description && <div className="hint">{o.description}</div>}
              </span>
            </label>
          ))}
        </div>
      )}
      {c.type === 'knobs' && (
        <div className="cells">
          {value.map((v, i) => (
            <div className="stepper" key={i}>
              <button type="button" className="btn small mech" aria-label={`旋鈕 ${i + 1} 加一`} onClick={() => { const n = Math.min(c.positions, Number(v || 1) + 1); const next = [...value]; next[i] = String(n); update(next); audio.uiKey(); }}>
                ▲
              </button>
              <input
                type="number"
                min={1}
                max={c.positions}
                value={v}
                aria-label={`旋鈕 ${i + 1}`}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(c.positions, Number(e.target.value) || 1));
                  const next = [...value];
                  next[i] = String(n);
                  update(next);
                }}
                onKeyDown={(e) => e.key === 'Enter' && onEnter()}
              />
              <button type="button" className="btn small mech" aria-label={`旋鈕 ${i + 1} 減一`} onClick={() => { const n = Math.max(1, Number(v || 1) - 1); const next = [...value]; next[i] = String(n); update(next); audio.uiKey(); }}>
                ▼
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 轉成送給伺服器的值；不完整就回傳錯誤訊息（伺服器仍會再驗證一次） */
function collect(controls: Control[], vals: Vals, uses?: string[]): { values: Record<string, unknown> } | { error: string } {
  const out: Record<string, unknown> = {};
  for (const c of controls) {
    if (uses && !uses.includes(c.id)) continue;
    const v = vals[c.id] ?? [];
    if (c.type === 'digits') {
      let end = v.length;
      if (c.minLength !== c.maxLength) while (end > 0 && v[end - 1] === '') end--;
      const filled = v.slice(0, Math.max(end, c.minLength));
      if (filled.some((x) => x === '')) return { error: `「${c.label}」還沒有填完。` };
      if (filled.length < c.minLength || filled.length > c.maxLength) return { error: `「${c.label}」長度不符。` };
      const nums = filled.map(Number);
      if (nums.some((n) => !Number.isInteger(n) || n < c.min || n > c.max)) return { error: `「${c.label}」每一位必須是 ${c.min}～${c.max}。` };
      out[c.id] = nums;
    } else if (c.type === 'selects') {
      if (v.some((x) => x === '')) return { error: `「${c.label}」還沒有選完。` };
      out[c.id] = v;
    } else if (c.type === 'select') {
      if (!v[0]) return { error: `請先選擇「${c.label}」。` };
      out[c.id] = v[0];
    } else if (c.type === 'knobs') {
      out[c.id] = v.map(Number);
    }
  }
  return { values: out };
}

function TapPlayer({ view }: { view: PanelView }): JSX.Element | null {
  const [playing, setPlaying] = useState(false);
  const [count, setCount] = useState(0);
  const pattern = view.tap;
  const play = useCallback(() => {
    if (!pattern) return;
    setPlaying(true);
    setCount((n) => n + 1);
    audio.playTaps(pattern, () => setPlaying(false));
  }, [pattern]);

  useEffect(() => {
    if (!pattern) return;
    const t = window.setTimeout(play, 450);
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'KeyP' && !(e.target as HTMLElement)?.matches?.('input,select,textarea')) play();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      audio.stopTaps();
    };
    // 只在打開這個面板（或內容改變）時自動播放一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.deviceId, pattern?.durationMs, pattern?.events.length]);

  if (!pattern) return null;
  return (
    <div className="tapbox">
      <button className="btn mech" onClick={play} disabled={playing} autoFocus>
        <Icon name="play" size={16} /> {playing ? '播放中' : '聆聽機械聲'}
      </button>
      <span className="hint">按 <kbd>P</kbd> 重聽，已聽 {count} 次。注意停頓的長短與聲音的左右位置。</span>
    </div>
  );
}

export default function PanelModal(): JSX.Element | null {
  const panel = useStore((s) => s.panel);
  const [vals, setVals] = useState<Vals>({});
  const [local, setLocal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sig = panel ? `${panel.deviceId}|${panel.view.controls.map((c) => c.id + c.type).join(',')}` : '';
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panel) {
      setVals(initialValues(panel.view.controls));
      setLocal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // 伺服器回傳 clear（例如錯誤答案）：只清空這次的輸入，線索與已接受的進度不受影響
  useEffect(() => {
    if (panel?.clearKey) setVals(initialValues(panel.view.controls));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel?.clearKey]);

  useEffect(() => {
    if (!panel?.view.lockedUntil) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [panel?.view.lockedUntil]);

  useEffect(() => {
    if (!panel) return;
    const el = bodyRef.current?.querySelector<HTMLElement>('input, select, button.primary');
    el?.focus();
    // 只在切換設備時聚焦
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel?.deviceId]);

  const controls = panel?.view.controls ?? [];
  const submit = useCallback(
    async (a: ActionBtn): Promise<void> => {
      if (!panel || busy) return;
      const r = collect(controls, vals, a.uses);
      if ('error' in r) {
        setLocal(r.error);
        audio.uiWarn();
        return;
      }
      setLocal(null);
      setBusy(true);
      await doAction(panel.deviceId, a.id, r.values);
      setBusy(false);
    },
    [panel, busy, controls, vals],
  );

  const primary = useMemo(() => panel?.view.actions.find((a) => a.kind === 'primary') ?? panel?.view.actions[0], [panel]);

  if (!panel) return null;
  const { view, result } = panel;
  const lockedFor = view.lockedUntil ? Math.max(0, Math.ceil((view.lockedUntil - now) / 1000)) : 0;

  const close = (): void => {
    closePanel();
    requestLock();
  };

  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-label={view.title} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <header>
          <span className="plateno">{deviceCode(view.deviceId)}</span>
          <div>
            <h2>{view.title}</h2>
            {view.subtitle && <div className="sub">{view.subtitle}</div>}
          </div>
          <button className="btn small icon" onClick={close} aria-label="關閉面板（Esc）" title="關閉（Esc）">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="body" ref={bodyRef}>
          <TapPlayer view={view} />
          {view.blocks.map((b, i) => (
            <BlockView key={i} b={b} />
          ))}
          {lockedFor > 0 && (
            <div className="status error">
              <StatusIcon tone="error" />
              <span>設備暫時鎖定，{lockedFor} 秒後恢復。</span>
            </div>
          )}
          {controls.map((c) => (
            <ControlView key={c.id} c={c} vals={vals} setVals={setVals} onEnter={() => primary && void submit(primary)} />
          ))}
          {(local || result) && (
            <div className={`result ${local ? 'warn' : result!.tone}`} role="status" aria-live="polite">
              <StatusIcon tone={local ? 'warn' : result!.tone} />
              <span>{local ?? result!.message}</span>
            </div>
          )}
          {view.actions.length > 0 && (
            <div className="actions">
              {view.actions.map((a) => (
                <button
                  key={a.id}
                  data-action={a.id}
                  className={`btn ${a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger' : ''}`}
                  disabled={busy || a.disabled || lockedFor > 0}
                  onClick={() => void submit(a)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
