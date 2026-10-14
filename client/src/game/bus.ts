import type { AcousticMaterial, VisionSolid } from '@null-protocol/shared';

/** 遊戲迴圈 → 介面 的輕量事件（不經過 React 狀態，避免每幀重繪） */

/**
 * 一次回聲的短暫顯示資料（盲區員的回聲視野）：脈衝的位置、範圍內的結構（只有種類與尺寸）、
 * 每道射線的反射（與聲音的資訊相同），以及視野的時間參數。
 */
export interface EchoDisplay {
  origin: [number, number];
  solids: VisionSolid[];
  hits: Array<{ rel: number; dist: number; hit: boolean; material: AcousticMaterial | null }>;
  range: number;
  waveSpeed: number;
  holdMs: number;
  fadeMs: number;
  cooldownMs: number;
}
/** 謎題回饋的視覺效果（只有看得見的角色會收到） */
export type FxVisual = 'flash' | 'shake' | 'countdown' | 'error' | 'selftest' | 'shift';
type Events = { echo: EchoDisplay; riskTripped: { id: string; jamMs: number }; bump: void; near: void; fault: void; fx: { visual: FxVisual; targetId?: string } };
type Handler<K extends keyof Events> = (p: Events[K]) => void;

const handlers = new Map<keyof Events, Set<(p: never) => void>>();

export function on<K extends keyof Events>(k: K, h: Handler<K>): () => void {
  let set = handlers.get(k);
  if (!set) handlers.set(k, (set = new Set()));
  set.add(h as (p: never) => void);
  return () => {
    set.delete(h as (p: never) => void);
  };
}

export function emit<K extends keyof Events>(k: K, p: Events[K]): void {
  handlers.get(k)?.forEach((h) => (h as Handler<K>)(p));
}
