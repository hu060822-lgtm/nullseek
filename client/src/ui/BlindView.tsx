import { useEffect, useRef, useState } from 'react';
import { on, type EchoReading } from '../game/bus';
import { requestLock } from '../game/loop';

/**
 * 盲區員的畫面：炭黑底，沒有任何 3D 場景、物件或位置資訊（Scene 模組根本不會載入）。
 * 只有兩種「必要的輔助」：
 *   - 回聲定位（F）後短暫出現的局部輪廓：只有前／左／右／後四個方向到牆的距離，與聲音提供的資訊相同
 *   - 振動：撞牆、靠近可操作設備時畫面邊緣的短促震動（支援的裝置也會實際震動）
 */
const SCALE = 11; // 每公尺像素
const MAX = 12;

function Contour({ r }: { r: EchoReading }): JSX.Element {
  const seg = (d: number) => Math.min(d, MAX) * SCALE;
  const f = seg(r.front);
  const b = seg(r.back);
  const l = seg(r.left);
  const rr = seg(r.right);
  const w = 22;
  return (
    <svg width={320} height={320} viewBox="-160 -160 320 320">
      {r.front < MAX && <path className="contour" d={`M${-w} ${-f} H${w}`} />}
      {r.back < MAX && <path className="contour" d={`M${-w} ${b} H${w}`} />}
      {r.left < MAX && <path className="contour" d={`M${-l} ${-w} V${w}`} />}
      {r.right < MAX && <path className="contour" d={`M${rr} ${-w} V${w}`} />}
    </svg>
  );
}

export default function BlindView(): JSX.Element {
  const [echo, setEcho] = useState<{ r: EchoReading; k: number } | null>(null);
  const [vibe, setVibe] = useState<{ kind: 'bump' | 'near'; k: number } | null>(null);
  const n = useRef(0);

  useEffect(() => {
    const vib = (ms: number | number[]): void => {
      try {
        navigator.vibrate?.(ms);
      } catch {
        /* 不支援震動 */
      }
    };
    const offs = [
      on('echo', (r) => setEcho({ r, k: ++n.current })),
      on('bump', () => {
        setVibe({ kind: 'bump', k: ++n.current });
        vib(60);
      }),
      on('near', () => {
        setVibe({ kind: 'near', k: ++n.current });
        vib([20, 40, 20]);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  return (
    <div className="blind-view" onClick={() => requestLock()}>
      <div className="listener" aria-hidden />
      {echo && (
        <div className="echo-field" key={echo.k} aria-hidden>
          <Contour r={echo.r} />
        </div>
      )}
      {vibe && <div className={`vibe ${vibe.kind}`} key={vibe.k} aria-hidden />}
      <div className="whisper">
        盲區員：畫面不會顯示環境影像，請戴耳機。<kbd>F</kbd> 回聲　<kbd>E</kbd> 操作　<kbd>H</kbd> 說明
      </div>
    </div>
  );
}
