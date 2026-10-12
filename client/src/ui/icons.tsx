import type { Role, SignalToken, SymbolId } from '@null-protocol/shared';

/**
 * NULL 圖形符號系統。
 *
 * 規格：24×24 格線、1.5 線寬、方形線端、斜接轉角、無填色（實心點除外）。
 * 語彙只有三種：
 *   1. 未閉合迴路 — 尚未完成、感官被切斷（圓環留缺口）
 *   2. 斷開路徑   — 傳遞被中斷（直線中間缺一段）
 *   3. 錯位節點   — 缺掉的那一段被移到別處（小方塊偏離原位）
 * 任何新圖示都必須只用這三種語彙與基本幾何組成。
 */

type P = { size?: number; className?: string; title?: string };

function Svg({ size = 20, className, title, children }: P & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={`ico ${className ?? ''}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {children}
    </svg>
  );
}

/** 圓環上 from→to 度（0° 在正上方、順時針）的弧 */
function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const pt = (deg: number): [number, number] => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const [x1, y1] = pt(from);
  const [x2, y2] = pt(to);
  const large = (to - from + 360) % 360 > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/* ------------------------------ 標誌 ------------------------------ */

/** NULL 標誌：留缺口的圓環，缺口那一段變成右上方錯位的節點 */
export function NullMark({ size = 40, className }: P): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="square" className={`ico ${className ?? ''}`} aria-hidden>
      <path d={arc(24, 24, 15, 58, 22)} />
      <rect x="35" y="5" width="7" height="7" fill="currentColor" stroke="none" />
      <path d="M24 24 H24.01" strokeWidth={5} />
    </svg>
  );
}

/** NULL 字標：每個字母都少一段；第二個 L 下沉一格（錯位） */
export function NullWordmark({ height = 56, className }: { height?: number; className?: string }): JSX.Element {
  return (
    <svg height={height} viewBox="0 0 120 30" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="square" strokeLinejoin="miter" className={`ico ${className ?? ''}`} role="img" aria-label="NULL">
      {/* N：斜線中段斷開 */}
      <path d="M4 26 V4 L11 15" />
      <path d="M15 21 L22 26 V4" />
      {/* U：右側直線沒有回到頂端 */}
      <path d="M34 4 V18 A6 6 0 0 0 46 18 V10" />
      {/* L */}
      <path d="M58 4 V26 H72" />
      {/* L：整個下沉並右移，像是被放錯位置 */}
      <path d="M84 7 V29 H98" />
      <rect x="104" y="1" width="5" height="5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* ------------------------------ 角色 ------------------------------ */

/** 盲區員：視覺圓環被一道橫槓封住 */
function BlindGlyph(p: P): JSX.Element {
  return (
    <Svg {...p}>
      <path d={arc(12, 12, 7, 100, 80)} />
      <path d="M3 12 H21" />
    </Svg>
  );
}
/** 靜默員：聲波在半途斷開，缺掉的一段錯位到上方 */
function DeafGlyph(p: P): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 12 H5.01" strokeWidth={3} />
      <path d={arc(5, 12, 6, 40, 140)} />
      <path d={arc(5, 12, 11, 60, 75)} />
      <path d={arc(5, 12, 11, 105, 120)} />
      <rect x="17" y="3" width="3" height="3" fill="currentColor" stroke="none" />
    </Svg>
  );
}
/** 失語員：話語路徑中間斷開，中段被移到上方 */
function MuteGlyph(p: P): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 15 H9" />
      <path d="M15 15 H21" />
      <path d="M9.5 8 H14.5" />
    </Svg>
  );
}

export function RoleGlyph({ role, ...p }: P & { role: Role }): JSX.Element {
  if (role === 'BLIND') return <BlindGlyph {...p} />;
  if (role === 'DEAF') return <DeafGlyph {...p} />;
  return <MuteGlyph {...p} />;
}

/* ------------------------------ 謎題狀態 ------------------------------ */

export type LoopState = 'locked' | 'open' | 'active' | 'ready' | 'solved' | 'failed';

/** 謎題進度：未解開＝未閉合；解開時迴路才會閉合 */
export function Loop({ state, ...p }: P & { state: LoopState }): JSX.Element {
  switch (state) {
    case 'locked':
      return (
        <Svg {...p}>
          <path d="M6 6 H18 V18 H6 Z" strokeDasharray="2 3" />
        </Svg>
      );
    case 'open':
      return (
        <Svg {...p}>
          <path d={arc(12, 12, 7, 40, 0)} />
        </Svg>
      );
    case 'active':
      return (
        <Svg {...p}>
          <path d={arc(12, 12, 7, 40, 0)} />
          <rect x="15.5" y="2.5" width="4" height="4" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'ready':
      return (
        <Svg {...p}>
          <path d={arc(12, 12, 7, 15, 0)} />
          <rect x="11" y="3.5" width="3" height="3" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'solved':
      return (
        <Svg {...p}>
          <circle cx="12" cy="12" r="7" />
          <path d="M12 12 H12.01" strokeWidth={3.5} />
        </Svg>
      );
    case 'failed':
      return (
        <Svg {...p}>
          <path d={arc(12, 12, 7, 40, 0)} />
          <path d="M15 3 L21 9 M21 3 L15 9" />
        </Svg>
      );
  }
}

/* ------------------------------ 介面 ------------------------------ */

export function Icon({ name, ...p }: P & { name: IconName }): JSX.Element {
  switch (name) {
    case 'mic':
      return (
        <Svg {...p}>
          <path d="M9 4 H15 V13 H9 Z" />
          <path d="M6 11 V14 L9 17 H15 L18 14 V11" />
          <path d="M12 17 V21 M8 21 H16" />
        </Svg>
      );
    case 'micOff':
      return (
        <Svg {...p}>
          <path d="M9 4 H15 V8" />
          <path d="M9 11 V13 H13" />
          <path d="M6 11 V14 L9 17 H15 L16 16" />
          <path d="M12 17 V21 M8 21 H16" />
          <path d="M4 4 L20 20" />
        </Svg>
      );
    case 'signal':
      return (
        <Svg {...p}>
          <path d="M3 12 H4" strokeWidth={3} />
          <path d="M8 12 H14" />
          <path d="M18 12 H19" strokeWidth={3} />
          <rect x="10" y="5" width="3" height="3" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'log':
      return (
        <Svg {...p}>
          <path d="M5 3 H15 L19 7 V21 H5 Z" />
          <path d="M8 10 H16 M8 14 H16 M8 18 H12" />
        </Svg>
      );
    case 'help':
      return (
        <Svg {...p}>
          <path d={arc(12, 9, 4.5, 270, 150)} />
          <path d="M12 14 V15" />
          <rect x="11" y="19" width="2.5" height="2.5" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'hint':
      return (
        <Svg {...p}>
          <path d="M4 4 H20 V20 H12" />
          <path d="M4 4 V12" />
          <rect x="5" y="16" width="3" height="3" fill="currentColor" stroke="none" />
        </Svg>
      );
    case 'echo':
      return (
        <Svg {...p}>
          <path d="M12 18 H12.01" strokeWidth={3} />
          <path d={arc(12, 18, 5, 315, 45)} />
          <path d={arc(12, 18, 10, 320, 335)} />
          <path d={arc(12, 18, 10, 345, 15)} />
          <path d={arc(12, 18, 10, 25, 40)} />
        </Svg>
      );
    case 'lock':
      return (
        <Svg {...p}>
          <path d="M6 11 H18 V20 H6 Z" />
          <path d="M8.5 11 V7 H15.5 V9" />
        </Svg>
      );
    case 'key':
      return (
        <Svg {...p}>
          <path d="M4 8 H12 V16 H4 Z" />
          <path d="M12 12 H20 V15 M17 12 V14" />
        </Svg>
      );
    case 'close':
      return (
        <Svg {...p}>
          <path d="M6 6 L18 18 M18 6 L6 18" />
        </Svg>
      );
    case 'exit':
      return (
        <Svg {...p}>
          <path d="M13 4 H5 V20 H13" />
          <path d="M10 12 H20 M16 8 L20 12 L16 16" />
        </Svg>
      );
    case 'play':
      return (
        <Svg {...p}>
          <path d="M8 5 L18 12 L8 19 Z" />
        </Svg>
      );
  }
}

export type IconName = 'mic' | 'micOff' | 'signal' | 'log' | 'help' | 'hint' | 'echo' | 'lock' | 'key' | 'close' | 'exit' | 'play';

/* ------------------------------ 幾何符號（謎題用） ------------------------------ */

export function SymbolIcon({ id, ...p }: P & { id: SymbolId }): JSX.Element {
  switch (id) {
    case 'TRI':
      return (
        <Svg {...p}>
          <path d="M12 4 L20.5 19 H3.5 Z" />
        </Svg>
      );
    case 'CIR':
      return (
        <Svg {...p}>
          <circle cx="12" cy="12" r="8" />
        </Svg>
      );
    case 'SQR':
      return (
        <Svg {...p}>
          <path d="M5 5 H19 V19 H5 Z" />
        </Svg>
      );
    case 'DIA':
      return (
        <Svg {...p}>
          <path d="M12 3 L21 12 L12 21 L3 12 Z" />
        </Svg>
      );
  }
}

/* ------------------------------ 信號 ------------------------------ */

const SYM_OF: Partial<Record<SignalToken, SymbolId>> = { SYM_TRI: 'TRI', SYM_CIR: 'CIR', SYM_SQR: 'SQR', SYM_DIA: 'DIA' };

/** 信號 token 的圖形（燈號以色塊呈現，不用這個函式） */
export function TokenGlyph({ t, ...p }: P & { t: SignalToken }): JSX.Element | null {
  const sym = SYM_OF[t];
  if (sym) return <SymbolIcon id={sym} {...p} />;
  switch (t) {
    case 'TAP_S':
      return (
        <Svg {...p}>
          <path d="M12 12 H12.01" strokeWidth={5} />
        </Svg>
      );
    case 'TAP_L':
      return (
        <Svg {...p}>
          <path d="M5 12 H19" strokeWidth={4} />
        </Svg>
      );
    case 'GEST_WAIT':
      return (
        <Svg {...p}>
          <path d="M8 5 V19 M16 5 V19" />
        </Svg>
      );
    case 'GEST_YES':
      return (
        <Svg {...p}>
          <circle cx="12" cy="12" r="7" />
        </Svg>
      );
    case 'GEST_NO':
      return (
        <Svg {...p}>
          <path d="M6 6 L18 18 M18 6 L6 18" />
        </Svg>
      );
    case 'GEST_GO':
      return (
        <Svg {...p}>
          <path d="M8 5 L18 12 L8 19 Z" />
        </Svg>
      );
    case 'GEST_LEFT':
      return (
        <Svg {...p}>
          <path d="M19 12 H5 M10 7 L5 12 L10 17" />
        </Svg>
      );
    case 'GEST_RIGHT':
      return (
        <Svg {...p}>
          <path d="M5 12 H19 M14 7 L19 12 L14 17" />
        </Svg>
      );
    case 'GEST_CENTER':
      return (
        <Svg {...p}>
          <path d="M12 4 V20 M7 12 H17" />
        </Svg>
      );
    case 'GEST_AGAIN':
      return (
        <Svg {...p}>
          <path d="M18 8 A7 7 0 1 0 19 13 M18 3 V8 H13" />
        </Svg>
      );
    case 'SYM_H':
      return (
        <Svg {...p}>
          <path d="M4 12 H20" strokeWidth={4} />
        </Svg>
      );
    case 'SYM_V':
      return (
        <Svg {...p}>
          <path d="M12 4 V20" strokeWidth={4} />
        </Svg>
      );
    default:
      return null;
  }
}
