import { ROLES, SYMBOL_GLYPH, type ActionResult, type PanelView, type Role } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { SyncRound } from '../sync';
import { failRes, makeView, okRes, parseDigits, parseSelect, parseSelects, statusBlock, toneSequence, warnRes } from '../util';
import { BaseModule } from './base';
import { ANSWERS, OPS, OP_LABEL, P10, eqArr, evenParity, type Op } from './data';

const CORE: Record<Role, string> = { BLIND: 'r10_core_a', DEAF: 'r10_core_b', MUTE: 'r10_core_c' };
type Choice = 'EXECUTE' | 'RESET' | 'CONSENSUS';
const CHOICES: readonly Choice[] = ['EXECUTE', 'RESET', 'CONSENSUS'];
const RESET_CONFIRM_MS = 6000;

/**
 * P10 NULL：最後的協定（三階段）。
 * 第一階段重建訊號、第二階段確認時間順序、第三階段建立共識（三方驗證＋同步輪次）。
 * 每個階段由伺服器獨立驗證；最終成功是單一狀態轉換，只會觸發一次。
 */
export class P10NullProtocol extends BaseModule {
  readonly id = 'P10_NULL_PROTOCOL' as const;
  readonly room = 10;
  readonly hints = [
    '這一題有三個階段。第一階段：盲區員聽訊號、靜默員看燈號組（有一組被遮蔽）、失語員有協定總則；三份拼起來才是完整的七位元。',
    '第二階段：盲區員聽出四個音的先後（可以先試聽音 1～4），靜默員看音階對照燈，失語員把符號換成操作。第三階段：三人各自按「已驗證」，再由失語員選 CONSENSUS。',
    '第一階段答案的第二組是「1、缺失」，缺失位元用偶數校驗補。第二階段依序是 開啟→等待→重複→關閉。第三階段選 CONSENSUS 後 3 秒內三人各按一次「最終確認」。',
  ] as const;

  private phase: 1 | 2 | 3 = 1;
  private verified: Record<Role, boolean> = { BLIND: false, DEAF: false, MUTE: false };
  private resetPendingAt = 0;
  private readonly sync: SyncRound;

  constructor(...args: ConstructorParameters<typeof BaseModule>) {
    super(...args);
    this.sync = new SyncRound(() => this.api.now(), this.api.syncWindowMs, () => this.onTimeout());
  }

  override status(): 'active' | 'ready' {
    return this.phase === 3 && ROLES.every((r) => this.verified[r]) ? 'ready' : 'active';
  }

  override stage() {
    return { phase: this.phase, syncRemainingMs: this.sync.remainingMs() };
  }

  logRound(): number {
    return this.phase;
  }

  /* ----------------------------- 面板 ----------------------------- */

  view(role: Role, deviceId: string): PanelView | null {
    switch (deviceId) {
      case 'r10_signal':
        return this.signalView();
      case 'r10_groups':
        return this.groupsView();
      case 'r10_rules':
        return this.rulesView();
      case 'r10_analyzer':
        return this.analyzerView();
      default:
        if (deviceId === CORE[role]) return this.coreView(role);
        return null;
    }
  }

  private signalView(single?: number): PanelView {
    if (this.phase === 1) {
      const heard: Array<{ len: number; tone: number; gapAfter?: number }> = [];
      let start = 0;
      P10.groups.forEach((size) => {
        for (let i = start; i < start + size; i++) {
          if (i === P10.missing) continue; // 缺失的脈衝：沒有聲音，也聽不出空檔
          heard.push({ len: P10.bits[i] === 1 ? 430 : 130, tone: 300 });
        }
        if (heard.length) heard[heard.length - 1].gapAfter = 1300; // 停頓＝分隔
        start += size;
      });
      return makeView({
        deviceId: 'r10_signal',
        title: '訊號重建器',
        subtitle: '第一階段：殘缺的訊號',
        blocks: [{ type: 'text', text: '訊號由短音、長音與較長的停頓組成。' }],
        tap: toneSequence(heard, 380),
        clue: true,
      });
    }
    if (this.phase === 2) {
      return makeView({
        deviceId: 'r10_signal',
        title: '訊號重建器',
        subtitle: '第二階段：四個音的先後',
        blocks: [{ type: 'text', text: '四個不同高低的音依序響起。可以先試聽音 1～4 的參考音。' }],
        actions: [
          ...[1, 2, 3, 4].map((n) => ({ id: `ref_${n}`, label: `試聽音 ${n}`, kind: 'neutral' as const })),
          { id: 'full', label: '播放順序', kind: 'primary' as const },
        ],
        tap: single
          ? { events: [{ at: 150, len: 260, tone: P10.toneRef[single - 1] }], durationMs: 700 }
          : toneSequence(P10.toneOrder.map((n) => ({ len: 260, tone: P10.toneRef[n - 1] })), 520),
        clue: !single,
      });
    }
    return makeView({ deviceId: 'r10_signal', title: '訊號重建器', blocks: [statusBlock('ok', '訊號已重建。')] });
  }

  private groupsView(): PanelView {
    if (this.phase === 1) {
      return makeView({
        deviceId: 'r10_groups',
        title: '燈號組',
        subtitle: '第一階段：三組燈號',
        blocks: [
          {
            type: 'slots',
            groups: [...P10.groups],
            seq: P10.bits.map((b, i) => (i === P10.masked ? 'MASKED' : i === P10.missing ? 'MISSING' : b ? 'ON' : 'OFF')),
            caption: '● 亮　○ 暗　▨ 被遮蔽　□ 無訊號',
          },
        ],
        clue: true,
      });
    }
    if (this.phase === 2) {
      return makeView({
        deviceId: 'r10_groups',
        title: '燈號組',
        subtitle: '第二階段：音階對照燈',
        blocks: [{ type: 'table', header: ['音', '亮起的符號'], rows: [1, 2, 3, 4].map((n) => [`音 ${n}`, SYMBOL_GLYPH[P10.toneSymbol[n]]]) }],
        clue: true,
      });
    }
    return makeView({ deviceId: 'r10_groups', title: '燈號組', blocks: [statusBlock('ok', '燈號已全部熄滅。')] });
  }

  private rulesView(): PanelView {
    return makeView({
      deviceId: 'r10_rules',
      title: '協定總則',
      subtitle: `目前：第 ${this.phase} 階段`,
      blocks: [
        { type: 'heading', text: '第一階段：重建訊號' },
        { type: 'list', items: ['短音代表 0，長音代表 1。', '較長的停頓是分組的分隔符。', '全部位元中，1 的總數必須為偶數。'] },
        { type: 'heading', text: '第二階段：時間順序' },
        {
          type: 'table',
          header: ['符號', '操作'],
          rows: (['CIR', 'SQR', 'DIA', 'TRI'] as const).map((s) => [SYMBOL_GLYPH[s], OP_LABEL[P10.symbolOp[s]]]),
        },
        { type: 'text', text: '依訊號實際發生的先後排列操作。' },
        { type: 'heading', text: '第三階段：建立共識' },
        {
          type: 'list',
          items: [
            '三人各自在自己的核心控制台按下「已驗證」。',
            '三方驗證完成後，在核心協定盤選擇 CONSENSUS。EXECUTE 不會執行；RESET 需要再選一次才會重置本階段。',
            '同步啟動後的 3 秒內，三人各自按下「最終確認」。',
          ],
        },
      ],
      clue: true,
    });
  }

  private analyzerView(): PanelView {
    if (this.phase === 1) {
      return makeView({
        deviceId: 'r10_analyzer',
        title: '核心分析儀',
        subtitle: '第一階段：輸入完整訊號',
        controls: [{ type: 'digits', id: 'bits', label: '七位元訊號', minLength: 1, maxLength: 8, min: 0, max: 1 }],
        actions: [{ id: 'submit_bits', label: '送出訊號', kind: 'primary' }],
      });
    }
    if (this.phase === 2) {
      return makeView({
        deviceId: 'r10_analyzer',
        title: '核心分析儀',
        subtitle: '第二階段：排列操作指令',
        controls: [{ type: 'selects', id: 'ops', label: '依時間先後的四個操作', count: 4, options: OPS.map((o) => ({ value: o, label: OP_LABEL[o] })) }],
        actions: [{ id: 'submit_ops', label: '送出排列', kind: 'primary' }],
      });
    }
    return makeView({
      deviceId: 'r10_analyzer',
      title: '核心分析儀',
      blocks: [statusBlock('ok', 'COMMUNICATION STATUS: COMPLETE　CONSENSUS STATUS: NULL')],
    });
  }

  private coreView(role: Role): PanelView {
    const deviceId = CORE[role];
    if (this.phase < 3) {
      return makeView({
        deviceId,
        title: role === 'MUTE' ? '核心協定盤' : `核心控制台 ${role === 'BLIND' ? 'A' : 'B'}`,
        blocks: [statusBlock('info', 'SYSTEM STATUS: OPERATIONAL　COMMUNICATION STATUS: INCOMPLETE　CONSENSUS STATUS: NULL')],
      });
    }
    const n = ROLES.filter((r) => this.verified[r]).length;
    return makeView({
      deviceId,
      title: role === 'MUTE' ? '核心協定盤' : `核心控制台 ${role === 'BLIND' ? 'A' : 'B'}`,
      subtitle: '第三階段：建立共識',
      blocks: [
        statusBlock(this.verified[role] ? 'ok' : 'info', this.verified[role] ? '本台已驗證。' : '按下「已驗證」確認你的控制台。'),
        statusBlock('info', `三方驗證：${n}／3${this.sync.active ? '　同步窗口開啟中，請立刻按「最終確認」。' : ''}`),
      ],
      controls: role === 'MUTE' ? [{ type: 'select', id: 'mode', label: '最終模式', options: CHOICES.map((c) => ({ value: c, label: c })) }] : [],
      actions: [
        { id: 'verify', label: '已驗證', kind: 'neutral', disabled: this.verified[role], uses: [] },
        ...(role === 'MUTE' ? [{ id: 'choose', label: '套用模式', kind: 'neutral' as const }] : []),
        { id: 'final', label: '最終確認', kind: 'primary', uses: [] },
      ],
    });
  }

  /* ----------------------------- 操作 ----------------------------- */

  act(role: Role, input: ActionInput): ActionResult | null {
    const { targetId, actionType } = input;
    if (targetId === 'r10_signal' && this.phase === 2) {
      const ref = /^ref_([1-4])$/.exec(actionType);
      if (ref) return okRes(`音 ${ref[1]} 的參考音。`, { tone: 'info', view: this.signalView(Number(ref[1])) });
      if (actionType === 'full') return okRes('四個音的順序。', { tone: 'info', view: this.signalView() });
    }
    if (targetId === 'r10_analyzer') {
      if (actionType === 'submit_bits') return this.submitBits(role, input);
      if (actionType === 'submit_ops') return this.submitOps(role, input);
      return null;
    }
    if (targetId === CORE[role]) {
      if (this.phase !== 3) return warnRes('核心控制台要到第三階段才會啟用。');
      if (actionType === 'verify') {
        this.verified[role] = true;
        return okRes('已驗證。');
      }
      if (actionType === 'choose' && role === 'MUTE') return this.choose(input);
      if (actionType === 'final') return this.final(role);
    }
    return null;
  }

  private submitBits(role: Role, input: ActionInput): ActionResult {
    if (this.phase !== 1) return warnRes('訊號已經重建完成。');
    const bits = parseDigits(input.payload, 'bits', { min: 0, max: 1, minLength: 1, maxLength: 8 });
    if (!bits) return this.invalid();
    if (bits.length !== 7) return warnRes('訊號不完整。', { clear: true });
    if (!evenParity(bits) || !eqArr(bits, ANSWERS.p10.bits)) {
      this.feedback({ targetId: 'r10_analyzer', sound: 'reject', visual: 'error' });
      return this.wrong(role, 'r10_analyzer', '校驗失敗。', { clear: true });
    }
    this.phase = 2;
    this.feedback({ targetId: 'r10_analyzer', sound: 'accept', visual: 'flash' });
    return okRes('訊號重建完成。第二階段：確認時間順序。');
  }

  private submitOps(role: Role, input: ActionInput): ActionResult {
    if (this.phase === 1) return warnRes('尚未完成第一階段。');
    if (this.phase === 3) return warnRes('時間順序已經確認。');
    const ops = parseSelects<Op>(input.payload, 'ops', 4, OPS);
    if (!ops) return this.invalid('請排好四個操作。');
    if (!eqArr(ops, ANSWERS.p10.ops)) {
      this.feedback({ targetId: 'r10_analyzer', sound: 'reject', visual: 'error' });
      return this.wrong(role, 'r10_analyzer', '控制台拒絕執行，指令退回待排序狀態。', { clear: true });
    }
    this.phase = 3;
    this.feedback({ targetId: 'r10_analyzer', sound: 'accept', visual: 'flash' });
    return okRes('時間順序確認。第三階段：建立共識。');
  }

  private choose(input: ActionInput): ActionResult {
    const c = parseSelect<Choice>(input.payload, 'mode', CHOICES);
    if (!c) return this.invalid('請選擇模式。');
    if (c === 'EXECUTE') return warnRes('CONSENSUS REQUIRED');
    if (c === 'RESET') {
      const now = this.api.now();
      if (now - this.resetPendingAt > RESET_CONFIRM_MS) {
        this.resetPendingAt = now;
        return warnRes('確定要重置第三階段嗎？再套用一次 RESET 確認。');
      }
      this.resetPendingAt = 0;
      this.resetPhase3();
      this.api.hooks.reset(this.id, 'phase3');
      return okRes('第三階段已重置。');
    }
    if (this.sync.active) return warnRes('同步已經啟動。');
    if (!ROLES.every((r) => this.verified[r])) return warnRes('尚未完成三方驗證，不能啟動同步。');
    const off = this.offlineGuard();
    if (off) return off;
    this.sync.start();
    this.feedback({ sound: 'countdown', visual: 'countdown', windowMs: this.api.syncWindowMs });
    return okRes('CONSENSUS：同步啟動，3 秒內三人各自最終確認。');
  }

  private final(role: Role): ActionResult {
    if (!this.verified[role]) return warnRes('本台尚未驗證。');
    switch (this.sync.press(role)) {
      case 'NO_ROUND':
        return warnRes('同步尚未啟動。');
      case 'EXPIRED':
        return failRes('同步窗口已經關閉。');
      case 'DUPLICATE':
        return okRes('已經確認過了，等待其他人。', { tone: 'info' });
      case 'WAITING':
        return okRes('已確認，等待其他人。', { tone: 'info' });
      case 'SUCCESS':
        this.finish('d10');
        return okRes('共識成立。出口解鎖。');
    }
  }

  private onTimeout(): void {
    // 只清除同步輪次與最終操作，保留前兩階段與三方驗證
    this.api.attempt();
    this.api.transientFail(2500);
    this.feedback({ sound: 'reject', visual: 'error' });
    this.api.hooks.broadcast({ tone: 'warn', text: '同步逾時：本輪共識失敗。前兩階段與驗證保留，可以重新選擇 CONSENSUS。' });
    this.api.hooks.refreshDevices();
  }

  private resetPhase3(): void {
    this.sync.cancel();
    for (const r of ROLES) this.verified[r] = false;
  }

  override reset(): void {
    this.resetPhase3();
    this.phase = 1;
    this.resetPendingAt = 0;
  }

  debug() {
    return {
      answer: { phase1: ANSWERS.p10.bits.join(''), phase2: ANSWERS.p10.ops.join(' → '), phase3: 'CONSENSUS + 3 秒內三人最終確認' },
      conditions: { phase: this.phase, verified: { ...this.verified }, roundId: this.sync.roundId, pressed: this.sync.pressed() },
    };
  }

  /** 同步窗口進行中有人離線：取消這一輪（不算失敗、不清除任何進度） */
  onPresenceChange(): void {
    if (!this.sync.active || !this.offlineGuard()) return;
    this.sync.cancel();
    this.api.hooks.broadcast({ tone: 'warn', text: '有隊友離線，同步已取消；等隊友回來後再重新啟動。' });
  }

  override dispose(): void {
    this.sync.dispose();
  }
}
