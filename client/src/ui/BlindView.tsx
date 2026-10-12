import { useEffect, useRef, useState } from 'react';
import { on, type EchoDisplay } from '../game/bus';
import { requestLock } from '../game/loop';

/**
 * 盲區員的畫面：炭黑底，沒有任何 3D 場景、物件或位置資訊（Scene 模組根本不會載入）。
 * 只有幾種「必要的輔助」，而且都是短暫的：
 *   - 回聲（F）後短暫出現的反射點：以玩家為中心（上方＝正前方），每道射線一小段，與聲音提供的資訊相同，
 *     displayMs 後完全消失。材質用線條樣式區分（聲音裡也聽得出來）；沒有反射的方向什麼都不畫。
 *   - 振動：撞牆、靠近可操作設備時畫面邊緣的短促震動（支援的裝置也會實際震動）
 *   - 回聲受到干擾時的雜訊條紋
 */
const RADIUS = 150; // 畫面上回聲最大距離的半徑（像素）

function Returns({ e }: { e: EchoDisplay }): JSX.Element {
  const k = RADIUS / e.range;
  const step = (Math.PI * 2) / Math.max(1, e.hits.length);
  return (
    <svg width={RADIUS * 2 + 20} height={RADIUS * 2 + 20} viewBox={`${-RADIUS - 10} ${-RADIUS - 10} ${RADIUS * 2 + 20} ${RADIUS * 2 + 20}`}>
      {e.hits.map((h, i) => {
        if (!h.hit) return null;
        // 反射點在玩家前方 rel 弧度處（正值往右）；線段垂直於射線，長度約等於射線之間的弧長
        const r = h.dist * k;
        const half = Math.max(5, (h.dist * step * k) / 2.2);
        const cx = Math.sin(h.rel) * r;
        const cy = -Math.cos(h.rel) * r;
        const tx = Math.cos(h.rel) * half;
        const ty = Math.sin(h.rel) * half;
        return (
          <path
            key={i}
            className={`contour m-${h.material ?? 'concrete'}`}
            d={`M${(cx - tx).toFixed(1)} ${(cy - ty).toFixed(1)} L${(cx + tx).toFixed(1)} ${(cy + ty).toFixed(1)}`}
            style={{ animationDuration: `${e.displayMs}ms`, opacity: 0 }}
          />
        );
      })}
    </svg>
  );
}

export default function BlindView(): JSX.Element {
  const [echo, setEcho] = useState<{ e: EchoDisplay; k: number } | null>(null);
  const [vibe, setVibe] = useState<{ kind: 'bump' | 'near' | 'jam'; k: number } | null>(null);
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
      on('echo', (e) => setEcho({ e, k: ++n.current })),
      on('bump', () => {
        setVibe({ kind: 'bump', k: ++n.current });
        vib(60);
      }),
      on('near', () => {
        setVibe({ kind: 'near', k: ++n.current });
        vib([20, 40, 20]);
      }),
      on('riskTripped', () => {
        setEcho(null);
        setVibe({ kind: 'jam', k: ++n.current });
        vib([80, 60, 80]);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  return (
    <div className="blind-view" onClick={() => requestLock()}>
      <div className="listener" aria-hidden />
      {echo && (
        <div className="echo-field" key={echo.k} aria-hidden data-echo={echo.e.hits.filter((h) => h.hit).length}>
          <Returns e={echo.e} />
        </div>
      )}
      {vibe && <div className={`vibe ${vibe.kind}`} key={vibe.k} aria-hidden />}
      <div className="whisper">
        盲區員：畫面不會顯示環境影像，請戴耳機。<kbd>F</kbd> 回聲　<kbd>V</kbd> 報出朝向　<kbd>K</kbd> 音訊校準　<kbd>E</kbd> 操作　<kbd>H</kbd> 說明
      </div>
    </div>
  );
}
