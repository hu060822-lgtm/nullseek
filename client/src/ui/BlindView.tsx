import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { on, type EchoDisplay } from '../game/bus';
import { requestLock } from '../game/loop';

// 回聲視野（three.js）只在第一次按 F 時才下載；盲區員平常的頁面沒有任何 3D 場景
const EchoVision = lazy(() => import('./EchoVision'));

/**
 * 盲區員的畫面：炭黑底，沒有任何 3D 場景、物件或位置資訊（完整的 Scene 模組不會載入）。
 * 只有幾種「必要的輔助」，而且都是短暫的：
 *   - 回聲視野（F）：從自己的位置擴散的波照出範圍內的結構模型——牆、門、設備外形、地面網格、隊友——
 *     全部反白，幾秒後淡出；之後要等冷卻結束才能再按（畫面下方的細條顯示充能，結束時有提示音）。
 *     只有幾何，沒有顏色、文字、燈號或謎題線索；牆後的東西不會出現。
 *   - 振動：撞牆、靠近可操作設備時畫面邊緣的短促震動（支援的裝置也會實際震動）
 *   - 回聲受到干擾時的雜訊條紋
 */
export default function BlindView(): JSX.Element {
  const [echo, setEcho] = useState<{ e: EchoDisplay; k: number } | null>(null);
  const [vibe, setVibe] = useState<{ kind: 'bump' | 'near' | 'jam'; k: number } | null>(null);
  const [charge, setCharge] = useState<{ ms: number; k: number } | null>(null);
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
      on('echo', (e) => {
        const k = ++n.current;
        setEcho({ e, k });
        setCharge({ ms: e.cooldownMs, k });
      }),
      on('bump', () => {
        setVibe({ kind: 'bump', k: ++n.current });
        vib(60);
      }),
      on('near', () => {
        setVibe({ kind: 'near', k: ++n.current });
        vib([20, 40, 20]);
      }),
      on('riskTripped', (p) => {
        setVibe({ kind: 'jam', k: ++n.current });
        setCharge({ ms: p.jamMs, k: ++n.current });
        vib([80, 60, 80]);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  return (
    <div className="blind-view" onClick={() => requestLock()}>
      {echo && (
        <div className="echo-field" data-echo={echo.e.solids.length} aria-hidden>
          <Suspense fallback={null}>
            <EchoVision e={echo.e} k={echo.k} />
          </Suspense>
        </div>
      )}
      <div className="listener" aria-hidden />
      {charge && (
        <div className="echo-charge" aria-hidden>
          <i key={charge.k} style={{ animationDuration: `${charge.ms}ms` }} />
        </div>
      )}
      {vibe && <div className={`vibe ${vibe.kind}`} key={vibe.k} aria-hidden />}
      <div className="whisper">
        盲區員：畫面不會顯示環境影像，請戴耳機。<kbd>F</kbd> 回聲視野　<kbd>V</kbd> 報出朝向　<kbd>K</kbd> 音訊校準　<kbd>E</kbd> 操作　<kbd>H</kbd> 說明
      </div>
    </div>
  );
}
