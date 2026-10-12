import { ECHO_CONFIG, riskPhase, type RiskState, type RiskStatus, type RiskZoneDef } from '@null-protocol/shared';

/**
 * 回聲風險區（伺服器權威）。
 *
 * - 感測器的週期以遊戲開始的時間為起點，由伺服器計算；客戶端只收到狀態，用來播放預警。
 * - 盲區員發出回聲時，伺服器用「自己記錄的位置」判定是否在警戒中的感測器範圍內，客戶端無法謊報。
 * - 偵測的後果可以挽回：警報＋盲區員的回聲受到干擾 jamMs 毫秒；不改變任何謎題狀態。
 * - 脈衝事件沒有回覆內容，干擾期間或過於頻繁的脈衝直接忽略。
 */
export class EchoRiskTracker {
  private readonly epoch: number;
  private last = new Map<string, RiskState>();
  private jammedUntil = 0;
  private lastPulse = -Infinity;

  constructor(
    private readonly defs: readonly RiskZoneDef[],
    private readonly now: () => number = Date.now,
  ) {
    this.epoch = now();
    for (const d of defs) this.last.set(d.id, riskPhase(d, 0).state);
  }

  statuses(): RiskStatus[] {
    const t = this.now() - this.epoch;
    return this.defs.map((d) => ({ id: d.id, ...riskPhase(d, t) }));
  }

  /** 定期呼叫；有任何感測器改變狀態時回傳全部狀態，否則 null */
  tick(): RiskStatus[] | null {
    const list = this.statuses();
    let changed = false;
    for (const s of list) {
      if (this.last.get(s.id) !== s.state) {
        this.last.set(s.id, s.state);
        changed = true;
      }
    }
    return changed ? list : null;
  }

  /** 盲區員的回聲還會被干擾多久（毫秒）；重連時一併同步，重新整理頁面不會解除干擾 */
  jamLeft(): number {
    return Math.max(0, this.jammedUntil - this.now());
  }

  /** 盲區員發出回聲（位置與區域由伺服器提供）；被偵測時回傳感測器與干擾時間 */
  pulse(x: number, z: number, zone: string | null): { id: string; jamMs: number } | null {
    const now = this.now();
    if (now < this.jammedUntil) return null;
    // 客戶端有冷卻時間；伺服器容忍網路抖動，但拒絕明顯過於頻繁的脈衝
    if (now - this.lastPulse < ECHO_CONFIG.cooldownMs * 0.7) return null;
    this.lastPulse = now;
    const t = now - this.epoch;
    for (const d of this.defs) {
      if (d.zone !== zone) continue;
      if (Math.hypot(x - d.pos[0], z - d.pos[1]) > d.radius) continue;
      if (riskPhase(d, t).state !== 'armed') continue;
      this.jammedUntil = now + d.jamMs;
      return { id: d.id, jamMs: d.jamMs };
    }
    return null;
  }
}
