import { useState } from 'react';
import { createRoom, joinRoom } from '../net/socket';
import { useStore } from '../state/store';
import { NullMark, NullWordmark } from './icons';
import RoleTable from './RoleTable';

const NAME_KEY = 'null-protocol.name';
const savedName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};

export function SheetHead({ right }: { right?: React.ReactNode }): JSX.Element {
  return (
    <div className="sheet-head">
      <div>
        <div className="mark">
          <NullMark size={44} />
          <NullWordmark height={40} />
        </div>
        <div className="title">無聲協定・第一章　失聯設施</div>
        <div className="sub">三人合作密室。每個人都少了一種感官，缺的那一份只有隊友有。</div>
      </div>
      {right}
    </div>
  );
}

export default function Menu(): JSX.Element {
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const error = useStore((s) => s.error);
  const reconnecting = useStore((s) => s.reconnecting);
  const [err, setErr] = useState<string | null>(null);

  const go = async (fn: () => Promise<string | null>): Promise<void> => {
    if (!name.trim()) {
      setErr('請先填寫暱稱。');
      return;
    }
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* ignore */
    }
    setBusy(true);
    setErr(null);
    useStore.getState().set({ error: null });
    const e = await fn();
    setBusy(false);
    if (e) setErr(e);
  };

  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead
          right={
            <div className="docmeta">
              <div>文件 <b>NP-01</b></div>
              <div>人數 <b>3</b>（固定）</div>
              <div>建議 耳機＋麥克風</div>
            </div>
          }
        />

        <section className="sec">
          <div className="sec-label">
            <div className="no">1</div>
            <h3>進入設施</h3>
            <p>一人開房，再把代碼交給另外兩人。</p>
          </div>
          <div className="sec-body stack">
            <div className="field" style={{ maxWidth: 360 }}>
              <label htmlFor="name">暱稱（1–16 字）</label>
              <input id="name" type="text" maxLength={16} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Luz" autoFocus />
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn primary" disabled={busy} onClick={() => void go(() => createRoom(name.trim()))}>
                建立房間
              </button>
              <span className="dim sm">或輸入代碼</span>
              <input
                className="code"
                type="text"
                maxLength={6}
                placeholder="______"
                aria-label="房間代碼"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && void go(() => joinRoom(name.trim(), code))}
              />
              <button className="btn" disabled={busy || code.length !== 6} onClick={() => void go(() => joinRoom(name.trim(), code))}>
                加入房間
              </button>
            </div>
            <div className="err" role="alert">
              {reconnecting ? '正在回到原本的房間…' : err ?? error ?? ''}
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <div className="no">2</div>
            <h3>人員配置</h3>
            <p>閉合的圓＝可用；斷開的圓＝被切斷的感官。</p>
          </div>
          <div className="sec-body">
            <RoleTable />
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <div className="no">3</div>
            <h3>注意事項</h3>
          </div>
          <div className="sec-body">
            <p className="note">遊戲內語音依角色限制路由：盲區員與靜默員可以說話，失語員只能用信號器（敲擊、燈號、符號、手勢）。</p>
            <p className="note">盲區員靠空間音訊辨位，請戴耳機；喇叭外放也可能讓語音回授。建議使用桌機版 Chrome 或 Edge。</p>
            <p className="note">請不要另外開通話軟體——這會讓三種限制失去意義。</p>
          </div>
        </section>
      </div>
    </div>
  );
}
