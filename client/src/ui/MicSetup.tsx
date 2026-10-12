import { ROLE_INFO, type Role } from '@null-protocol/shared';
import { useStore } from '../state/store';
import { voice } from '../voice/voice';
import { Icon } from './icons';

const STATE_TEXT: Record<string, string> = {
  off: '麥克風尚未啟用',
  requesting: '正在要求麥克風權限…',
  on: '麥克風已啟用',
  denied: '麥克風權限被拒絕。請在網址列旁的權限設定允許麥克風，再按一次啟用。',
  unavailable: '這個瀏覽器不支援麥克風或 WebRTC。',
  forbidden: '你的角色不能使用麥克風。',
};

export default function MicSetup({ role }: { role: Role | null }): JSX.Element | null {
  const micState = useStore((s) => s.micState);
  const level = useStore((s) => s.micLevel);
  const muted = useStore((s) => s.micMuted);
  if (!role) return null;
  const info = ROLE_INFO[role];

  if (!info.canSpeak) {
    return (
      <div className="stack">
        <div className="row">
          <Icon name="micOff" />
          <b>失語員沒有麥克風。</b>
        </div>
        <p className="note">
          這是角色限制而不是設定：你的瀏覽器不會被要求麥克風權限，伺服器也會拒絕任何由你發出的語音連線。
          你聽得見盲區員與靜默員；要回話，請用信號器（<kbd>Q</kbd>）。
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        {micState !== 'on' ? (
          <button className="btn" onClick={() => void voice.enableMic()} disabled={micState === 'requesting'}>
            <Icon name="mic" size={18} /> 啟用麥克風
          </button>
        ) : (
          <button className="btn" onClick={() => voice.setMuted(!muted)}>
            <Icon name={muted ? 'mic' : 'micOff'} size={18} /> {muted ? '取消靜音' : '靜音'}
          </button>
        )}
        <span className="meter" aria-hidden>
          <i style={{ width: `${Math.min(100, level * 260)}%` }} />
        </span>
        <span className="sm dim">{STATE_TEXT[micState] ?? ''}</span>
      </div>
      <p className="note">
        {role === 'BLIND'
          ? '你的聲音只會傳到失語員那裡；靜默員聽不到。'
          : '你的聲音會傳給盲區員與失語員，但你自己聽不到任何人。'}
      </p>
    </div>
  );
}
