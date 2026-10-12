import { useState } from 'react';
import { ROLES, ROLE_INFO, type Role } from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { leaveRoom, selectRole, startGame } from '../net/socket';
import { useStore } from '../state/store';
import { RoleGlyph } from './icons';
import { SheetHead } from './Menu';
import MicSetup from './MicSetup';
import { Sense } from './RoleTable';

export default function Lobby(): JSX.Element | null {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!room || !me) return null;

  const holder = (r: Role) => room.players.find((p) => p.role === r);
  const pick = async (r: Role): Promise<void> => {
    setErr(null);
    const e = await selectRole(me.role === r ? null : r);
    if (e) setErr(e);
    void audio.init();
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 不支援剪貼簿 */
    }
  };
  const missing = 3 - room.players.length;

  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead
          right={
            <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
              <span className="code-box" aria-label="房間代碼">{room.code}</span>
              <button className="btn small" onClick={() => void copy()}>
                {copied ? '已複製代碼' : '複製代碼'}
              </button>
            </div>
          }
        />

        <section className="sec">
          <div className="sec-label">
            <div className="no">1</div>
            <h3>成員</h3>
            <p>{missing > 0 ? `還差 ${missing} 人。` : '三人到齊。'}</p>
          </div>
          <div className="sec-body">
            <div className="players">
              {room.players.map((p) => (
                <div key={p.id} className="player">
                  <span className={`dot ${p.connected ? '' : 'off'}`} title={p.connected ? '在線' : '離線'} />
                  <span>
                    <b>{p.name}</b>
                    {p.id === me.id && <span className="tag">你</span>}
                    {p.isHost && <span className="tag">房主</span>}
                  </span>
                  {p.role ? (
                    <span className="row" style={{ gap: 8 }}>
                      <RoleGlyph role={p.role} size={18} />
                      {ROLE_INFO[p.role].name}
                    </span>
                  ) : (
                    <span className="dim sm">尚未選擇角色</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec" style={{ display: 'block' }}>
          <div className="sec-label" style={{ borderRight: 0, paddingBottom: 14 }}>
            <div className="no">2</div>
            <h3>選擇角色</h3>
            <p>三種角色各一人。再按一次可以放棄已選的角色。</p>
          </div>
          <div className="roles">
            {ROLES.map((r) => {
              const info = ROLE_INFO[r];
              const h = holder(r);
              const mine = me.role === r;
              const taken = !!h && !mine;
              return (
                <button key={r} className={`role-card ${mine ? 'mine' : ''}`} disabled={taken} onClick={() => void pick(r)} aria-pressed={mine}>
                  {h && <span className="held">{mine ? '你的角色' : `${h.name} 已選`}</span>}
                  <div className="role-head">
                    <RoleGlyph role={r} size={28} />
                    <span className="code">ROLE {info.letter}</span>
                  </div>
                  <h3>{info.name}</h3>
                  <div className="dim sm">{info.tagline}</div>
                  <dl className="spec">
                    <dt>視覺</dt>
                    <dd className={info.canSee ? '' : 'no'}><Sense on={info.canSee} label="視覺" /> {info.canSee ? '看得見' : '看不見'}</dd>
                    <dt>聽覺</dt>
                    <dd className={info.canHear ? '' : 'no'}><Sense on={info.canHear} label="聽覺" /> {info.canHear ? '聽得見' : '聽不見'}</dd>
                    <dt>語音</dt>
                    <dd className={info.canSpeak ? '' : 'no'}><Sense on={info.canSpeak} label="語音" /> {info.canSpeak ? '能說話' : '不能說話'}</dd>
                  </dl>
                  <div className="sm" style={{ marginTop: 4 }}>{info.strengths[0]}</div>
                </button>
              );
            })}
          </div>
          <div className="err" role="alert" style={{ padding: '0 32px' }}>{err}</div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <div className="no">3</div>
            <h3>語音</h3>
            <p>路由由伺服器依角色強制執行，沒有其他語音通道。</p>
          </div>
          <div className="sec-body">
            {me.role ? <MicSetup role={me.role} /> : <p className="note">選好角色後再設定麥克風。</p>}
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <div className="no">4</div>
            <h3>開始</h3>
          </div>
          <div className="sec-body row">
            <p className="note grow">
              {room.canStart ? '三人到齊、角色各不相同。' : '等待三位玩家各自選好不同的角色。'}
              {me.isHost ? '' : '由房主按下開始。'}
            </p>
            {me.isHost && (
              <button
                className="btn primary"
                disabled={!room.canStart}
                onClick={async () => {
                  void audio.init();
                  const e = await startGame();
                  if (e) setErr(e);
                }}
              >
                開始第一章
              </button>
            )}
            <button className="btn danger" onClick={leaveRoom}>
              離開房間
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
