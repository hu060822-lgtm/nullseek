/** 遊戲迴圈 → 介面 的輕量事件（不經過 React 狀態，避免每幀重繪） */
export interface EchoReading {
  front: number;
  left: number;
  right: number;
  back: number;
}
/** 謎題回饋的視覺效果（只有看得見的角色會收到） */
export type FxVisual = 'flash' | 'shake' | 'countdown' | 'error' | 'selftest' | 'shift';
type Events = { echo: EchoReading; bump: void; near: void; fault: void; fx: { visual: FxVisual; targetId?: string } };
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
