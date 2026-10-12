import { useEffect, useRef } from 'react';
import { ROLE_INFO } from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { speak } from '../audio/speech';
import { requestLock } from '../game/loop';
import { useStore } from '../state/store';
import { RoleGlyph } from './icons';
import MicSetup from './MicSetup';
import { Sense } from './RoleTable';

const CONTROLS: Array<[string, string]> = [
  ['W A S D', '移動（按住 Shift 跑步）'],
  ['滑鼠', '轉向（點一下畫面鎖定游標）'],
  ['E', '操作面前的設備'],
  ['Q', '信號器：敲擊、燈號、符號、手勢'],
  ['Tab', '線索紀錄'],
  ['H', '說明、提示與設定'],
  ['M', '麥克風靜音'],
  ['Esc', '關閉面板，或放開游標'],
];

export default function Briefing(): JSX.Element | null {
  const role = useStore((s) => s.me?.role ?? null);
  const enter = useRef<HTMLButtonElement>(null);
  // 聚焦「進入設施」但不要把說明捲走
  useEffect(() => enter.current?.focus({ preventScroll: true }), []);
  if (!role) return null;
  const info = ROLE_INFO[role];

  const go = async (): Promise<void> => {
    await audio.init();
    audio.startAmbient();
    useStore.getState().set({ briefed: true });
    requestLock();
    if (!info.canSee) speak('你在入口訊號室，隊友就在你身邊。按 F 發出回聲，注意設備的提示音。按 H 聽說明。', { interrupt: true });
  };

  return (
    <div className="modal-bg" style={{ background: 'rgba(36,39,41,.82)' }}>
      <div className="modal" style={{ width: 'min(760px, 100%)' }}>
        <header>
          <RoleGlyph role={role} size={34} />
          <div>
            <div className="sub">人員規格・ROLE {info.letter}</div>
            <h2 style={{ fontSize: 'var(--t-xl)' }}>你是{info.name}</h2>
          </div>
          <span />
        </header>
        <div className="body">
          <p className="blk-text">
            設施的通訊系統在事故後全面失聯。你們三人從入口訊號室出發，前面是十個一模一樣、只有設備不同的房間，每個人只剩下一部分的感官。
            每一個房間的門，都要三個人手上的資訊拼在一起才能打開。
          </p>
          <dl className="spec" style={{ gridTemplateColumns: '48px 1fr' }}>
            <dt>視覺</dt>
            <dd className={info.canSee ? '' : 'no'}><Sense on={info.canSee} label="視覺" /> {info.canSee ? '看得見' : '看不見'}</dd>
            <dt>聽覺</dt>
            <dd className={info.canHear ? '' : 'no'}><Sense on={info.canHear} label="聽覺" /> {info.canHear ? '聽得見' : '聽不見'}</dd>
            <dt>語音</dt>
            <dd className={info.canSpeak ? '' : 'no'}><Sense on={info.canSpeak} label="語音" /> {info.canSpeak ? '能說話' : '不能說話'}</dd>
          </dl>
          <div className="cols">
            <div>
              <div className="blk-heading">你做不到的事</div>
              <ul className="blk-list">
                {info.limits.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="blk-heading">只有你能做的事</div>
              <ul className="blk-list">
                {info.strengths.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
          {!info.canSee && (
            <p className="note">
              你的畫面不會出現任何環境影像。請戴耳機：最近的可操作設備會發出提示音（左右聲道是方向，越近越密）；站到設備前會用語音報出名稱。
              按 <kbd>F</kbd> 發出回聲——回聲越晚、越低，代表那個方向的牆越遠，畫面中央會短暫留下對應的局部輪廓。撞到牆時會有悶響與震動。
            </p>
          )}
          {!info.canHear && (
            <p className="note">
              你聽不到任何遊戲聲音與隊友語音——這個分頁根本不會播放聲音。隊友只能用燈號、符號與手勢回應你，訊號會出現在畫面下方。
            </p>
          )}
          {!info.canSpeak && (
            <p className="note">你不能說話，也沒有文字聊天。檔案室的規則只有你看得到，你得用信號器把它們轉成隊友感知得到的訊號。</p>
          )}
          <div className="blk-heading">操作</div>
          <dl className="kv">
            {CONTROLS.filter(([k]) => info.canSpeak || k !== 'M').map(([k, v]) => (
              <Row key={k} k={k} v={v} />
            ))}
            {!info.canSee && <Row k="F" v="回聲定位（盲區員專用）" />}
            {!info.canSee && <Row k="P" v="在面板中重聽機械聲" />}
          </dl>
          <div className="blk-heading">語音</div>
          <MicSetup role={role} />
          <div className="actions">
            <button ref={enter} className="btn primary" onClick={() => void go()}>
              進入設施
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <>
      <dt>
        <kbd>{k}</kbd>
      </dt>
      <dd>{v}</dd>
    </>
  );
}
