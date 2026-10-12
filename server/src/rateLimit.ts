/** 簡單的 token bucket，用來限制單一連線的事件頻率 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number = Date.now(), n = 1): boolean {
    const elapsed = Math.max(0, (now - this.last) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** 滑動視窗失敗計數：在 windowMs 內失敗超過 max 次就暫時封鎖 */
export class FailureLimiter {
  private fails: number[] = [];
  private blockedUntil = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly blockMs: number,
  ) {}

  isBlocked(now: number = Date.now()): boolean {
    return now < this.blockedUntil;
  }

  fail(now: number = Date.now()): void {
    this.fails = this.fails.filter((t) => now - t < this.windowMs);
    this.fails.push(now);
    if (this.fails.length >= this.max) {
      this.blockedUntil = now + this.blockMs;
      this.fails = [];
    }
  }

  reset(): void {
    this.fails = [];
  }
}
