import { ROLES, ROLE_INFO, type ActionResult, type DebugState, type PanelView, type PuzzleFeedback, type PuzzleId, type Role, type SceneClues, type StagePublic } from '@null-protocol/shared';
import type { ActionInput, ChapterApi, PuzzleModule } from '../types';
import { failRes, warnRes } from '../util';

/** 謎題模組的共用基底 */
export abstract class BaseModule implements PuzzleModule {
  abstract readonly id: PuzzleId;
  abstract readonly room: number;
  abstract readonly hints: readonly [string, string, string];

  constructor(protected readonly api: ChapterApi) {}

  initialize(): void {
    /* 固定資料：在 data.ts 由 assertChapterData() 檢查 */
  }
  status(): 'active' | 'ready' {
    return 'active';
  }
  stage(): Omit<StagePublic, 'attempts'> {
    return {};
  }
  clues(_role: Role): SceneClues {
    return {};
  }
  abstract view(role: Role, deviceId: string): PanelView | null;
  abstract act(role: Role, input: ActionInput): ActionResult | null;
  reset(): void {
    /* 預設沒有內部狀態 */
  }
  abstract debug(): Pick<DebugState, 'answer' | 'conditions'>;
  dispose(): void {
    /* 預設沒有計時器 */
  }

  /** 答案錯誤：累加嘗試次數、暫時鎖定這台設備 */
  protected wrong(role: Role, target: string, message: string, extra: Partial<ActionResult> = {}): ActionResult {
    const ms = this.api.wrong(role, target);
    return failRes(message, { lockMs: ms, ...extra });
  }
  /** 操作錯誤：格式不合法，不改變任何狀態 */
  protected invalid(message = '輸入格式不正確。'): ActionResult {
    return failRes(message);
  }
  protected feedback(f: Omit<PuzzleFeedback, 'puzzleId'>): void {
    this.api.hooks.feedback({ puzzleId: this.id, ...f });
  }
  /** 三人同步操作前檢查：有人離線時暫停（回傳警告；全員在線回傳 null） */
  protected offlineGuard(): ActionResult | null {
    const off = ROLES.filter((r) => !this.api.hooks.isConnected(r));
    return off.length ? warnRes(`有隊友離線（${off.map((r) => ROLE_INFO[r].name).join('、')}），同步操作暫停。`) : null;
  }
  protected finish(target?: string): boolean {
    const ok = this.api.complete(this.id);
    if (ok) this.feedback({ targetId: target, sound: 'unlock', visual: 'flash' });
    return ok;
  }
}
