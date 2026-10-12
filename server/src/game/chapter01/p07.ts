import { ROLES, type ActionResult, type PanelView, type Role } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { SyncRound } from '../sync';
import { failRes, makeView, okRes, parseSelect, parseSelects, statusBlock, toneSequence, warnRes } from '../util';
import { BaseModule } from './base';
import { MODE_LABEL, P07, POS_LABEL, eqArr, type Mode, type Pos3, type Tap } from './data';

const CONSOLE: Record<Role, string> = { BLIND: 'r7_resonator', DEAF: 'r7_lights', MUTE: 'r7_protocol' };
const MODES = Object.keys(MODE_LABEL) as Mode[];
const POS: readonly Pos3[] = ['LEFT', 'CENTER', 'RIGHT'];
const BEATS: readonly Tap[] = ['S', 'L'];

/**
 * P07 三秒鐘的真相。
 * 每個人要設定的內容都由另一個人感知（交叉持有）；三人設定正確並準備完成後，由 MUTE 啟動同步輪次，
 * 三人必須在伺服器定義的 3 秒窗口內各自執行。
 */
export class P07ThreeSecondTruth extends BaseModule {
  readonly id = 'P07_THREE_SECOND_TRUTH' as const;
  readonly room = 7;
  readonly hints = [
    '每個人要設定的答案都在別人那裡：共振器的節奏要看靜默員的閃光器，燈光的順序要聽盲區員的定位音箱，協定盤的模式要同時知道兩者。',
    '靜默員說出節奏給盲區員和失語員聽；盲區員說出三個音從哪邊傳來給失語員聽，再由失語員用信號器轉告靜默員。',
    '三人設定正確、各自按下「準備完成」後，失語員啟動同步，三人必須在 3 秒內各自按「執行」。事先約好由誰倒數、怎麼回應。',
  ] as const;

  private correct: Record<Role, boolean> = { BLIND: false, DEAF: false, MUTE: false };
  private set: Record<Role, boolean> = { BLIND: false, DEAF: false, MUTE: false };
  private ready: Record<Role, boolean> = { BLIND: false, DEAF: false, MUTE: false };
  private readonly sync: SyncRound;

  constructor(...args: ConstructorParameters<typeof BaseModule>) {
    super(...args);
    this.sync = new SyncRound(() => this.api.now(), this.api.syncWindowMs, () => this.onTimeout());
  }

  override status(): 'active' | 'ready' {
    return ROLES.every((r) => this.ready[r]) ? 'ready' : 'active';
  }

  override stage() {
    return { syncRemainingMs: this.sync.remainingMs() };
  }

  private consoleView(role: Role): PanelView {
    const deviceId = CONSOLE[role];
    const state = !this.set[role] ? '尚未設定' : this.correct[role] ? '設定正確' : '設定錯誤';
    const others = ROLES.filter((r) => r !== role && this.ready[r]).length;
    const round = this.sync.active;
    const controls =
      role === 'BLIND'
        ? [{ type: 'selects' as const, id: 'beats', label: '共振節奏（三拍）', count: 3, options: BEATS.map((b) => ({ value: b, label: b === 'S' ? '短' : '長' })) }]
        : role === 'DEAF'
          ? [{ type: 'selects' as const, id: 'order', label: '燈光點亮順序', count: 3, options: POS.map((p) => ({ value: p, label: POS_LABEL[p] })) }]
          : [{ type: 'select' as const, id: 'mode', label: '協定模式', options: MODES.map((m) => ({ value: m, label: MODE_LABEL[m] })) }];
    return makeView({
      deviceId,
      title: role === 'BLIND' ? '聲學共振器' : role === 'DEAF' ? '燈光控制台' : '中央協定盤',
      subtitle: '三方同步',
      blocks: [
        statusBlock(this.set[role] ? (this.correct[role] ? 'ok' : 'error') : 'info', `本台設定：${state}${this.ready[role] ? '（已準備完成）' : ''}`),
        statusBlock('info', `其他控制台準備完成：${others}／2${round ? '　同步窗口開啟中，請立刻執行。' : ''}`),
      ],
      controls,
      actions: [
        { id: 'set', label: '套用設定', kind: 'neutral' },
        // 只有「套用設定」需要輸入；其餘按鈕不受未填的欄位影響（同步窗口只有 3 秒）
        { id: 'ready', label: '準備完成', kind: 'neutral', disabled: !this.correct[role], uses: [] },
        ...(role === 'MUTE' ? [{ id: 'start', label: '啟動同步', kind: 'primary' as const, uses: [] }] : []),
        { id: 'execute', label: '執行', kind: 'primary', uses: [] },
      ],
    });
  }

  view(role: Role, deviceId: string): PanelView | null {
    if (deviceId === CONSOLE[role]) return this.consoleView(role);
    switch (deviceId) {
      case 'r7_speaker':
        return makeView({
          deviceId,
          title: '定位音箱',
          subtitle: '三個音依序從不同方向傳來（請戴耳機）',
          blocks: [{ type: 'text', text: '三個音一樣高，只是來自不同的方向。' }],
          tap: toneSequence(P07.order.map((p) => ({ len: 260, tone: 440, pan: p === 'LEFT' ? -1 : p === 'RIGHT' ? 1 : 0 })), 500),
          clue: true,
        });
      case 'r7_strobe':
        return makeView({
          deviceId,
          title: '節奏閃光器',
          subtitle: '共振節奏',
          blocks: [{ type: 'pulses', seq: [...P07.rhythm], animate: true, caption: '閃光的長短就是共振器的節奏' }],
          clue: true,
        });
      case 'r7_manual':
        return makeView({
          deviceId,
          title: '模式手冊',
          blocks: [
            {
              type: 'table',
              header: ['共振節奏的最後一拍', '燈光點亮的方向', '模式'],
              rows: P07.modeTable.map((r) => [r.last === 'L' ? '長' : '短', r.dir === 'LTR' ? '由左至右' : '由右至左', MODE_LABEL[r.mode]]),
            },
            {
              type: 'list',
              items: [
                '三台控制台的設定必須各自正確，才能按「準備完成」。',
                '三人都準備完成後，由中央協定盤啟動同步。',
                '同步啟動後的 3 秒內，三人必須各自按下「執行」；逾時或在窗口內更動設定，本輪即失敗，必須重新準備。',
              ],
            },
          ],
          clue: true,
        });
      default:
        return null;
    }
  }

  act(role: Role, input: ActionInput): ActionResult | null {
    if (input.targetId !== CONSOLE[role]) return null;
    switch (input.actionType) {
      case 'set':
        return this.applySetting(role, input);
      case 'ready':
        if (!this.correct[role]) return warnRes('本台設定尚未正確，不能準備完成。');
        this.ready[role] = true;
        return okRes('已準備完成。');
      case 'start':
        if (role !== 'MUTE') return null;
        if (this.sync.active) return warnRes('同步已經啟動。');
        if (!ROLES.every((r) => this.ready[r])) return warnRes('尚未三人準備完成，拒絕啟動。');
        {
          const off = this.offlineGuard();
          if (off) return off;
        }
        this.sync.start();
        this.feedback({ sound: 'countdown', visual: 'countdown', windowMs: this.api.syncWindowMs });
        return okRes('同步啟動：3 秒內各自執行。');
      case 'execute':
        return this.execute(role);
      default:
        return null;
    }
  }

  private applySetting(role: Role, input: ActionInput): ActionResult {
    let ok: boolean;
    if (role === 'BLIND') {
      const v = parseSelects<Tap>(input.payload, 'beats', 3, BEATS);
      if (!v) return this.invalid('請把三拍都設定好。');
      ok = eqArr(v, P07.rhythm);
    } else if (role === 'DEAF') {
      const v = parseSelects<Pos3>(input.payload, 'order', 3, POS);
      if (!v) return this.invalid('請把三個位置都設定好。');
      ok = eqArr(v, P07.order);
    } else {
      const v = parseSelect<Mode>(input.payload, 'mode', MODES);
      if (!v) return this.invalid('請選擇模式。');
      ok = v === 'SYNC';
    }
    // 窗口內更動設定：本輪同步失敗
    if (this.sync.active) {
      this.sync.cancel();
      this.failRound('同步失敗：有人在窗口內更動了設定。');
    }
    this.set[role] = true;
    this.correct[role] = ok;
    this.ready[role] = false;
    if (!ok) return this.wrong(role, CONSOLE[role], '設定錯誤，控制台顯示錯誤狀態。可以重新設定。');
    return okRes('設定正確。');
  }

  private execute(role: Role): ActionResult {
    if (!this.ready[role]) return warnRes('本台尚未準備完成。');
    const r = this.sync.press(role);
    switch (r) {
      case 'NO_ROUND':
        return warnRes('同步尚未啟動。');
      case 'EXPIRED':
        return failRes('同步窗口已經關閉。');
      case 'DUPLICATE':
        return okRes('已經執行過了，等待其他人。', { tone: 'info' });
      case 'WAITING':
        return okRes('已執行，等待其他人。', { tone: 'info' });
      case 'SUCCESS':
        this.finish('d7');
        return okRes('三方同步成功，系統啟動。');
    }
  }

  private failRound(text: string): void {
    for (const r of ROLES) this.ready[r] = false;
    this.api.attempt();
    this.api.transientFail(2500);
    this.feedback({ sound: 'reject', visual: 'error' });
    this.api.hooks.broadcast({ tone: 'warn', text });
  }

  private onTimeout(): void {
    this.failRound('同步失敗：窗口逾時。三人需要重新按「準備完成」。');
    this.api.hooks.refreshDevices();
  }

  override reset(): void {
    this.sync.cancel();
    for (const r of ROLES) {
      this.correct[r] = false;
      this.set[r] = false;
      this.ready[r] = false;
    }
  }

  debug() {
    return {
      answer: 'BLIND 短短長／DEAF 左中右／MUTE 同步模式，三人準備後 3 秒內執行',
      conditions: { correct: { ...this.correct }, set: { ...this.set }, ready: { ...this.ready }, roundId: this.sync.roundId, pressed: this.sync.pressed() },
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
