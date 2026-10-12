import { useEffect, useState } from 'react';
import { LAMP_HEX, LAMP_LABEL, type Block, type LampColor, type SlotMark } from '@null-protocol/shared';
import { Icon, Loop, SymbolIcon } from './icons';

function LightsBlock({ seq, animate, caption }: { seq: LampColor[]; animate?: boolean; caption?: string }): JSX.Element {
  const [cursor, setCursor] = useState(-1);
  const [run, setRun] = useState(0);
  const key = seq.join(',');

  useEffect(() => {
    if (!animate) return;
    let alive = true;
    const timers: number[] = [];
    const play = (i: number): void => {
      if (!alive) return;
      if (i >= seq.length) {
        setCursor(-1);
        return;
      }
      setCursor(i);
      timers.push(window.setTimeout(() => alive && setCursor(-1), 650));
      timers.push(window.setTimeout(() => play(i + 1), 950));
    };
    timers.push(window.setTimeout(() => play(0), 400));
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [animate, key, run, seq.length]);

  return (
    <div className="seq">
      {caption && <div className="caption">{caption}</div>}
      {seq.map((c, i) => {
        const on = !animate || cursor === i;
        return (
          <div key={i} className={`lamp ${on ? 'on' : 'dim'}`} style={{ ['--lc' as string]: LAMP_HEX[c] }}>
            <i />
            <span>
              <span className="code">{i + 1}</span>　{LAMP_LABEL[c]}
            </span>
          </div>
        );
      })}
      {animate && (
        <button className="btn small" onClick={() => setRun((n) => n + 1)}>
          重播燈號
        </button>
      )}
    </div>
  );
}

/** 閃光節奏：短閃＝短條、長閃＝長條；animate 時依真實長短依序亮起 */
function PulsesBlock({ seq, animate, caption }: { seq: Array<'S' | 'L'>; animate?: boolean; caption?: string }): JSX.Element {
  const [cursor, setCursor] = useState(-1);
  const [run, setRun] = useState(0);
  const key = seq.join('');
  useEffect(() => {
    if (!animate) return;
    let alive = true;
    const timers: number[] = [];
    let t = 400;
    seq.forEach((p, i) => {
      timers.push(window.setTimeout(() => alive && setCursor(i), t));
      t += p === 'L' ? 700 : 220;
      timers.push(window.setTimeout(() => alive && setCursor(-1), t));
      t += 380;
    });
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [animate, key, run, seq]);
  return (
    <div className="seq pulses">
      {caption && <div className="caption">{caption}</div>}
      {seq.map((p, i) => (
        <div key={i}>
          <div className={`pulse ${p === 'L' ? 'long' : 'short'} ${!animate || cursor === i ? 'on' : ''}`} aria-label={p === 'L' ? '長' : '短'} />
          <div className="cellno">{i + 1}・{p === 'L' ? '長' : '短'}</div>
        </div>
      ))}
      {animate && (
        <button className="btn small" onClick={() => setRun((n) => n + 1)}>
          重播閃光
        </button>
      )}
    </div>
  );
}

const SLOT_TEXT: Record<SlotMark, string> = { ON: '亮', OFF: '暗', RECEIVED: '有訊號', MASKED: '遮蔽', MISSING: '無訊號' };

/** 時間槽／燈號組：依 groups 分組顯示（每組之間留空） */
function SlotsBlock({ seq, groups, caption }: { seq: SlotMark[]; groups?: number[]; caption?: string }): JSX.Element {
  const parts: Array<Array<{ m: SlotMark; i: number }>> = [];
  if (groups?.length) {
    let i = 0;
    for (const n of groups) {
      parts.push(seq.slice(i, i + n).map((m, k) => ({ m, i: i + k })));
      i += n;
    }
  } else parts.push(seq.map((m, i) => ({ m, i })));
  return (
    <div className="seq slots">
      {caption && <div className="caption">{caption}</div>}
      {parts.map((g, gi) => (
        <div key={gi} className="slotgroup">
          {g.map(({ m, i }) => (
            <div key={i}>
              <div className={`slot ${m.toLowerCase()}`} aria-label={SLOT_TEXT[m]} />
              <div className="cellno">
                {i + 1}
                <br />
                {SLOT_TEXT[m]}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const STATUS_ICON = {
  ok: <Loop state="solved" size={18} />,
  info: <Loop state="open" size={18} />,
  warn: <Loop state="ready" size={18} />,
  error: <Icon name="lock" size={18} />,
} as const;

export function StatusIcon({ tone }: { tone: keyof typeof STATUS_ICON }): JSX.Element {
  return STATUS_ICON[tone];
}

export function BlockView({ b }: { b: Block }): JSX.Element | null {
  switch (b.type) {
    case 'heading':
      return <div className="blk-heading">{b.text}</div>;
    case 'text':
      return <div className="blk-text">{b.text}</div>;
    case 'list':
      return (
        <ol className="blk-list">
          {b.items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <table className="tbl">
          {b.header && (
            <thead>
              <tr>
                {b.header.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'lights':
      return <LightsBlock seq={b.seq} animate={b.animate} caption={b.caption} />;
    case 'pulses':
      return <PulsesBlock seq={b.seq} animate={b.animate} caption={b.caption} />;
    case 'slots':
      return <SlotsBlock seq={b.seq} groups={b.groups} caption={b.caption} />;
    case 'symbols':
      return (
        <div className="seq">
          {b.caption && <div className="caption">{b.caption}</div>}
          {b.seq.map((s, i) => (
            <div key={i}>
              <div className="glyph" aria-label={s}>
                <SymbolIcon id={s} size={36} />
              </div>
              <div className="cellno">{i + 1}</div>
            </div>
          ))}
        </div>
      );
    case 'digits':
      return (
        <div className="seq">
          {b.caption && <div className="caption">{b.caption}</div>}
          {b.seq.map((n, i) => (
            <div key={i}>
              <div className="counter">{n}</div>
              <div className="cellno">{i + 1}</div>
            </div>
          ))}
        </div>
      );
    case 'status':
      return (
        <div className={`status ${b.tone}`}>
          <StatusIcon tone={b.tone} />
          <span>{b.text}</span>
        </div>
      );
    default:
      return null;
  }
}
