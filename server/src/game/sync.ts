import type { Role } from '@null-protocol/shared';

export type SyncPress = 'NO_ROUND' | 'EXPIRED' | 'DUPLICATE' | 'WAITING' | 'SUCCESS';

/**
 * 同步輪次（P07、P10 第三階段共用）。
 *
 * - 每一輪有遞增的 roundId；窗口從伺服器建立輪次的那一刻開始計算（Date.now）。
 * - 每個角色在同一輪只能按一次（重送不會計算兩次）。
 * - 逾時由伺服器計時器判定；舊輪次的計時器在取消／重置時一律清除，不會讓下一輪立即失敗。
 * - 不依賴客戶端時鐘：以伺服器收到合法操作的時間為準。
 */
export class SyncRound {
  private seq = 0;
  private current: { id: number; startedAt: number; presses: Set<Role> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly now: () => number,
    private readonly windowMs: number,
    private readonly onTimeout: (roundId: number, pressed: Role[]) => void,
    private readonly need: readonly Role[] = ['BLIND', 'DEAF', 'MUTE'],
  ) {}

  get active(): boolean {
    return !!this.current;
  }
  get roundId(): number | null {
    return this.current?.id ?? null;
  }
  remainingMs(): number | null {
    if (!this.current) return null;
    return Math.max(0, this.current.startedAt + this.windowMs - this.now());
  }
  pressed(): Role[] {
    return this.current ? [...this.current.presses] : [];
  }

  start(): number {
    this.cancel();
    const id = ++this.seq;
    this.current = { id, startedAt: this.now(), presses: new Set() };
    this.timer = setTimeout(() => {
      if (this.current?.id !== id) return;
      const pressed = [...this.current.presses];
      this.clear();
      this.onTimeout(id, pressed);
    }, this.windowMs);
    return id;
  }

  press(role: Role): SyncPress {
    const c = this.current;
    if (!c) return 'NO_ROUND';
    if (this.now() - c.startedAt > this.windowMs) return 'EXPIRED';
    if (c.presses.has(role)) return 'DUPLICATE';
    c.presses.add(role);
    if (this.need.every((r) => c.presses.has(r))) {
      this.clear();
      return 'SUCCESS';
    }
    return 'WAITING';
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
  }

  cancel(): void {
    this.clear();
  }

  dispose(): void {
    this.clear();
  }
}
