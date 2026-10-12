import { useEffect } from 'react';
import { ROLE_INFO } from '@null-protocol/shared';
import { leaveRoom, restartGame } from '../net/socket';
import { useStore } from '../state/store';
import { RoleGlyph } from './icons';

const LINES: Record<string, string> = {
  BLIND: '你從沒看見過這座設施的樣子。但你記得每一扇門開啟時的聲音，也記得隊友的聲音是怎麼一步一步把你帶到出口的。',
  DEAF: '整段路上你沒有聽見任何一個字。燈號一閃一滅、符號一格一格——你用眼睛把三個人的訊息接成一條線。',
  MUTE: '你一句話也沒說。所有的規則都握在你手上，你把它們拆成敲擊、燈號與手勢，交給了看不見與聽不見的人。',
};

export default function Ending(): JSX.Element | null {
  const complete = useStore((s) => s.complete);
  const me = useStore((s) => s.me);
  const world = useStore((s) => s.world);
  const players = useStore((s) => s.room?.players ?? []);

  useEffect(() => {
    if (complete && document.pointerLockElement) document.exitPointerLock();
  }, [complete]);

  if (!complete || !me?.role || !world?.chapterComplete) return null;
  return (
    <div className="ending" role="dialog" aria-label="第一章完成">
      <div className="inner">
        {/* 一直沒有閉合的迴路，在這裡第一次閉合；缺口的那一格回到原位 */}
        <svg className="loop" width="120" height="120" viewBox="0 0 120 120" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden>
          <circle cx="60" cy="60" r="48" transform="rotate(-62 60 60)" />
          <rect x="84" y="8" width="12" height="12" fill="currentColor" stroke="none" />
        </svg>
        <div className="body">
          <h1>失聯設施：脫出</h1>
          <p>出口的門在三個人同時按下確認的那一刻滑開。外面的空氣很冷，但通訊頻道裡第一次傳來了回應。</p>
          <p>{LINES[me.role]}</p>
          <dl className="credits">
            {players.map((p) => (
              <Fragment key={p.id} name={p.name} role={p.role} />
            ))}
            <dt>提示</dt>
            <dd>使用 {world.hints.used} 次</dd>
          </dl>
          <div className="row" style={{ marginTop: 22 }}>
            {me.isHost ? (
              <button className="btn primary" onClick={() => void restartGame()}>
                回到大廳
              </button>
            ) : (
              <span className="sm dim">等待房主帶全隊回到大廳。</span>
            )}
            <button className="btn" onClick={leaveRoom}>
              離開房間
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Fragment({ name, role }: { name: string; role: string | null }): JSX.Element {
  const info = role ? ROLE_INFO[role as keyof typeof ROLE_INFO] : null;
  return (
    <>
      <dt className="row" style={{ gap: 6 }}>
        {info && <RoleGlyph role={info.role} size={16} />}
        {info?.name ?? '—'}
      </dt>
      <dd>{name}</dd>
    </>
  );
}
