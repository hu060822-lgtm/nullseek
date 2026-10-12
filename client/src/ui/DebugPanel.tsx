import { useCallback, useEffect, useState } from 'react';
import { PUZZLE_TITLES, ROLE_INFO, type DebugCommand, type DebugState } from '@null-protocol/shared';
import { debugCommand, fetchDebugState } from '../net/socket';
import { useStore } from '../state/store';

/**
 * 開發者工具（規格 8：除錯模式）。
 * 只有伺服器開啟 DEBUG_TOOLS（或非 production）時才會出現；正式環境的玩家既看不到面板，伺服器也會拒絕指令。
 * 按 ` 開關。
 */
export default function DebugPanel(): JSX.Element {
  const [state, setState] = useState<DebugState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const world = useStore((s) => s.world);

  const refresh = useCallback(async () => {
    const r = await fetchDebugState();
    if (typeof r === 'string') setErr(r);
    else {
      setErr(null);
      setState(r);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [refresh, world?.version]);

  const run = async (cmd: DebugCommand): Promise<void> => {
    setBusy(true);
    const e = await debugCommand(cmd);
    setBusy(false);
    if (e) setErr(e);
    void refresh();
  };

  return (
    <aside className="debug plate interactive" aria-label="開發者工具">
      <header>
        <b>開發者工具</b>
        <span className="xs dim">僅開發環境・按 ` 關閉</span>
      </header>
      {err && <div className="status error">{err}</div>}
      {state && (
        <div className="body">
          <dl>
            <dt>目前謎題</dt>
            <dd>{state.puzzleId ? `${state.puzzleId}　${PUZZLE_TITLES[state.puzzleId]}` : '（章節已完成）'}</dd>
            <dt>狀態</dt>
            <dd className="code">{state.status}</dd>
            <dt>正解</dt>
            <dd className="code">{JSON.stringify(state.answer)}</dd>
            {state.syncRemainingMs !== null && (
              <>
                <dt>同步剩餘</dt>
                <dd className="code">{state.syncRemainingMs} ms</dd>
              </>
            )}
            <dt>玩家</dt>
            <dd>
              {Object.entries(state.roles).map(([name, role]) => (
                <span key={name} className="chip">
                  {name}：{role ? ROLE_INFO[role].name : '—'}
                </span>
              ))}
            </dd>
          </dl>
          <div className="lbl">已滿足的條件</div>
          <pre>{JSON.stringify(state.conditions, null, 1)}</pre>
          <div className="lbl">最近操作</div>
          <ol className="recent">
            {state.recent
              .slice()
              .reverse()
              .map((r, i) => (
                <li key={i} className={r.ok ? '' : 'bad'}>
                  <span className="code">{new Date(r.at).toLocaleTimeString()}</span> {ROLE_INFO[r.role].name} {r.targetId}/{r.actionType}：{r.message}
                </li>
              ))}
          </ol>
        </div>
      )}
      <div className="actions">
        <button className="btn small" disabled={busy} onClick={() => void run('reset_puzzle')}>
          重置目前謎題
        </button>
        <button className="btn small" disabled={busy} onClick={() => void run('complete_puzzle')}>
          直接完成目前謎題
        </button>
        <button className="btn small danger" disabled={busy} onClick={() => void run('reinit_room')}>
          重新初始化房間
        </button>
      </div>
    </aside>
  );
}
