import { ROLES, ROLE_INFO } from '@null-protocol/shared';
import { Loop, RoleGlyph } from './icons';

/** 感官欄：可用＝閉合迴路；被切斷＝未閉合迴路（朱紅，代表限制） */
export function Sense({ on, label }: { on: boolean; label: string }): JSX.Element {
  return on ? (
    <span title={`${label}：可用`} aria-label={`${label}可用`}>
      <Loop state="solved" size={18} />
    </span>
  ) : (
    <span className="cut" title={`${label}：切斷`} aria-label={`${label}切斷`}>
      <Loop state="failed" size={18} />
    </span>
  );
}

/** 人員配置表：三種角色的感官與職責 */
export default function RoleTable(): JSX.Element {
  return (
    <table className="roster">
      <thead>
        <tr>
          <th>角色</th>
          <th style={{ textAlign: 'center' }}>視覺</th>
          <th style={{ textAlign: 'center' }}>聽覺</th>
          <th style={{ textAlign: 'center' }}>語音</th>
          <th>只有這個角色能做的事</th>
        </tr>
      </thead>
      <tbody>
        {ROLES.map((r) => {
          const info = ROLE_INFO[r];
          return (
            <tr key={r}>
              <td>
                <div className="rname">
                  <RoleGlyph role={r} size={22} />
                  {info.name}
                  <span className="code">{info.letter}／{info.en}</span>
                </div>
              </td>
              <td className="sense"><Sense on={info.canSee} label="視覺" /></td>
              <td className="sense"><Sense on={info.canHear} label="聽覺" /></td>
              <td className="sense"><Sense on={info.canSpeak} label="語音" /></td>
              <td>{info.strengths[0]}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
