import {
  DEVICE_BY_ID,
  PORTAL_BY_ID,
  PUZZLE_IDS,
  PUZZLE_TITLES,
  ROLES,
  closedDoors,
  isPuzzleId,
  roleCanUseDevice,
  type ActionResult,
  type DebugCommand,
  type DebugState,
  type DoorId,
  type DoorState,
  type PanelView,
  type PuzzleActionPayload,
  type PuzzleId,
  type PuzzleStatus,
  type Role,
  type SceneClues,
  type WorldPublic,
} from '@null-protocol/shared';
import { assertChapterData } from './chapter01/data';
import { P01ThreeLanguages } from './chapter01/p01';
import { P02PhantomDoor } from './chapter01/p02';
import { P03ReversedArchive } from './chapter01/p03';
import { P04MaplessRoom } from './chapter01/p04';
import { P05MuteProtocol } from './chapter01/p05';
import { P06MissingPulse } from './chapter01/p06';
import { P07ThreeSecondTruth } from './chapter01/p07';
import { P08LyingInstruments } from './chapter01/p08';
import { P09NonexistentLoop } from './chapter01/p09';
import { P10NullProtocol } from './chapter01/p10';
import type { ChapterApi, ChapterHooks, PuzzleModule } from './types';
import { failRes, makeView, statusBlock, warnRes, type Values } from './util';

export interface ChapterOptions {
  now?: () => number;
  /** 同步窗口（毫秒），預設 3000 */
  syncWindowMs?: number;
  /** 兩次提示之間的冷卻（毫秒），預設 15000 */
  hintCooldownMs?: number;
  /** 答案錯誤的鎖定基準（毫秒），預設 1500；每次加倍，上限為 4 倍 */
  lockBaseMs?: number;
}

type Factory = (api: ChapterApi) => PuzzleModule;
const FACTORIES: Record<PuzzleId, Factory> = {
  P01_THREE_LANGUAGES: (api) => new P01ThreeLanguages(api),
  P02_PHANTOM_DOOR: (api) => new P02PhantomDoor(api),
  P03_REVERSED_ARCHIVE: (api) => new P03ReversedArchive(api),
  P04_MAPLESS_ROOM: (api) => new P04MaplessRoom(api),
  P05_MUTE_PROTOCOL: (api) => new P05MuteProtocol(api),
  P06_MISSING_PULSE: (api) => new P06MissingPulse(api),
  P07_THREE_SECOND_TRUTH: (api) => new P07ThreeSecondTruth(api),
  P08_LYING_INSTRUMENTS: (api) => new P08LyingInstruments(api),
  P09_NONEXISTENT_LOOP: (api) => new P09NonexistentLoop(api),
  P10_NULL_PROTOCOL: (api) => new P10NullProtocol(api),
};

const REQUEST_CACHE = 64;
const MAX_REQUEST_ID = 80;

assertChapterData();

/**
 * 第一章：失聯設施（十道謎題）。
 *
 * 章節引擎不碰網路，所有對外動作都透過 hooks。伺服器是唯一的真相來源：
 * 謎題答案、角色專屬線索、機關狀態、完成條件與開門都只在這裡決定。
 *
 * 引擎負責所有謎題共用的部分：
 *   身分與角色權限、謎題狀態、requestId 去重、答案錯誤的鎖定、嘗試次數、提示、完成與開門、除錯工具。
 */
export class Chapter implements ChapterApi {
  readonly hooks: ChapterHooks;
  readonly syncWindowMs: number;
  private readonly nowFn: () => number;
  private readonly hintCooldownMs: number;
  private readonly lockBaseMs: number;

  private doors: DoorState = closedDoors();
  private idx = 0;
  private module: PuzzleModule;
  private readonly attempts = new Map<PuzzleId, number>();
  private version = 1;
  private finished = false;
  private failedUntil = 0;
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly locks = new Map<string, { fails: number; until: number }>();
  private readonly hintTier = new Map<PuzzleId, number>();
  private hintNextAt = 0;
  private hintsUsed = 0;
  private readonly requests = new Map<string, Map<string, ActionResult>>();
  private readonly recent: DebugState['recent'] = [];
  private disposed = false;

  constructor(hooks: ChapterHooks, opts: ChapterOptions = {}) {
    this.hooks = hooks;
    this.nowFn = opts.now ?? Date.now;
    this.syncWindowMs = opts.syncWindowMs ?? 3000;
    this.hintCooldownMs = opts.hintCooldownMs ?? 15_000;
    this.lockBaseMs = opts.lockBaseMs ?? 1500;
    this.module = this.activate(0);
  }

  private activate(i: number): PuzzleModule {
    const m = FACTORIES[PUZZLE_IDS[i]](this);
    m.initialize();
    return m;
  }

  /* -------------------------- ChapterApi -------------------------- */

  now(): number {
    return this.nowFn();
  }

  private lockKey(role: Role, target: string): string {
    return `${role}:${target}`;
  }

  lockRemaining(role: Role, target: string): number {
    const l = this.locks.get(this.lockKey(role, target));
    return l ? Math.max(0, l.until - this.now()) : 0;
  }

  wrong(role: Role, target: string): number {
    this.attempt();
    const key = this.lockKey(role, target);
    const fails = (this.locks.get(key)?.fails ?? 0) + 1;
    const ms = Math.min(this.lockBaseMs * 2 ** (fails - 1), this.lockBaseMs * 4);
    this.locks.set(key, { fails, until: this.now() + ms });
    this.hooks.penalized?.(role);
    return ms;
  }

  lockClear(role: Role, target: string): void {
    this.locks.delete(this.lockKey(role, target));
  }

  attempt(): void {
    const id = this.activeId;
    if (id) this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
  }

  transientFail(ms: number): void {
    if (this.failTimer) clearTimeout(this.failTimer);
    this.failedUntil = this.now() + ms;
    this.failTimer = setTimeout(() => {
      this.failTimer = null;
      this.failedUntil = 0;
      if (!this.disposed) this.changed();
    }, ms);
    this.changed();
  }

  /** 單一狀態轉換：標記完成、開門、停止計時、啟用下一題（或結束章節）。重複呼叫無效。 */
  complete(id: PuzzleId): boolean {
    if (this.finished || this.disposed || this.activeId !== id) return false;
    const done = this.module;
    done.dispose();
    this.locks.clear();
    if (this.failTimer) clearTimeout(this.failTimer);
    this.failTimer = null;
    this.failedUntil = 0;
    this.doors[`d${done.room}` as DoorId] = true;
    this.hooks.completed(id, PUZZLE_TITLES[id]);
    this.idx += 1;
    if (this.idx >= PUZZLE_IDS.length) {
      this.finished = true;
      this.hooks.chapterComplete();
    } else {
      this.module = this.activate(this.idx);
    }
    this.changed();
    return true;
  }

  changed(): void {
    this.version += 1;
    if (!this.disposed) this.hooks.onChange();
  }

  /* --------------------------- 公開狀態 --------------------------- */

  get activeId(): PuzzleId | null {
    return this.finished ? null : PUZZLE_IDS[this.idx];
  }

  get isComplete(): boolean {
    return this.finished;
  }

  doorState(): DoorState {
    return { ...this.doors };
  }

  statusOf(i: number): PuzzleStatus {
    if (this.finished || i < this.idx) return 'completed';
    if (i > this.idx) return 'locked';
    if (this.failedUntil > this.now()) return 'failed';
    return this.module.status();
  }

  world(): WorldPublic {
    const id = this.activeId;
    const tier = id ? (this.hintTier.get(id) ?? 0) : 0;
    return {
      version: this.version,
      puzzles: PUZZLE_IDS.map((pid, i) => ({ id: pid, title: PUZZLE_TITLES[pid], status: this.statusOf(i) })),
      activePuzzle: id,
      doors: { ...this.doors },
      stage: id ? { attempts: this.attempts.get(id) ?? 0, ...this.module.stage() } : null,
      chapterComplete: this.finished,
      hints: { used: this.hintsUsed, tier: tier as 0 | 1 | 2 | 3, nextAt: this.hintNextAt },
    };
  }

  /** 只屬於這個角色的 3D 線索（其他角色永遠拿不到） */
  cluesFor(role: Role): SceneClues {
    return this.finished ? {} : this.module.clues(role);
  }

  /* ----------------------------- 設備 ----------------------------- */

  private puzzleOfZone(zone: string): number {
    return Number(zone.replace('R', '')) - 1;
  }

  openDevice(role: Role, deviceId: string): { ok: true; view: PanelView } | { ok: false; error: string } {
    const dev = DEVICE_BY_ID[deviceId];
    if (!dev) return { ok: false, error: '找不到這個設備。' };
    if (!roleCanUseDevice(role, dev)) return { ok: false, error: '這台設備與你的權限不符。' };
    if (dev.direct) return { ok: false, error: '這不是可以開啟面板的設備。' };
    const view = this.buildView(role, deviceId);
    if (view.clue) this.recordClue(role, view);
    return { ok: true, view };
  }

  private buildView(role: Role, deviceId: string): PanelView {
    const dev = DEVICE_BY_ID[deviceId];
    const i = this.puzzleOfZone(dev.zone);
    let view: PanelView | null = null;
    if (!this.finished && i === this.idx) view = this.module.view(role, deviceId);
    if (!view) {
      const status = this.statusOf(i);
      view = makeView({
        deviceId,
        title: dev.label,
        blocks: [
          status === 'completed'
            ? statusBlock('ok', '這台設備已經完成任務，處於待機狀態。')
            : status === 'locked'
              ? statusBlock('info', '設備尚未通電。')
              : statusBlock('info', '這台設備目前沒有需要處理的訊號。'),
        ],
      });
    }
    const rem = this.lockRemaining(role, deviceId);
    if (rem > 0) view = { ...view, lockedUntil: this.now() + rem };
    return view;
  }

  private recordClue(role: Role, view: PanelView): void {
    const puzzle = this.activeId;
    if (!puzzle) return;
    const round = this.module.logRound?.();
    const audioOnly = role === 'BLIND' || !!view.tap;
    this.hooks.log(role, {
      key: `${puzzle}:${view.deviceId}${round !== undefined ? `:r${round}` : ''}`,
      puzzle,
      deviceId: view.deviceId,
      title: round !== undefined ? `${view.title}（第 ${round} 次記錄）` : view.title,
      at: this.now(),
      round,
      audioOnly,
      tap: view.tap,
      blocks: audioOnly ? [] : view.blocks.filter((b) => b.type !== 'status'),
    });
  }

  /**
   * 規格 1.3 的統一操作入口 puzzle:action。
   * 距離、身分與房間由呼叫端（RoomManager）檢查；這裡檢查謎題狀態、目標、角色權限、去重與鎖定。
   */
  action(playerId: string, role: Role, p: PuzzleActionPayload): ActionResult {
    const requestId = typeof p?.requestId === 'string' ? p.requestId : '';
    if (!requestId || requestId.length > MAX_REQUEST_ID) return failRes('操作缺少有效的 requestId。');
    let cache = this.requests.get(playerId);
    if (!cache) this.requests.set(playerId, (cache = new Map()));
    const cached = cache.get(requestId);
    if (cached) return cached;

    const result = this.execute(role, p);
    cache.set(requestId, result);
    if (cache.size > REQUEST_CACHE) cache.delete(cache.keys().next().value as string);
    this.recent.push({
      at: this.now(),
      role,
      puzzleId: String(p.puzzleId),
      actionType: String(p.actionType).slice(0, 40),
      targetId: String(p.targetId).slice(0, 40),
      ok: result.ok,
      message: result.message,
    });
    if (this.recent.length > 10) this.recent.shift();
    return result;
  }

  private execute(role: Role, p: PuzzleActionPayload): ActionResult {
    if (!isPuzzleId(p.puzzleId)) return failRes('無效的謎題。');
    if (typeof p.actionType !== 'string' || p.actionType.length > 40 || typeof p.targetId !== 'string') {
      return failRes('無效的操作。');
    }
    const values: Values = p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload) ? (p.payload as Values) : {};
    if (JSON.stringify(values).length > 2000) return failRes('輸入過長。');

    const pi = PUZZLE_IDS.indexOf(p.puzzleId);
    if (this.finished || pi < this.idx) return failRes('這道謎題已經完成，操作不會再生效。');
    if (pi > this.idx) return failRes('這道謎題還沒開始。');

    const dev = DEVICE_BY_ID[p.targetId];
    const portal = PORTAL_BY_ID[p.targetId];
    if (!dev && !portal) return failRes('找不到這個操作目標。');
    const zone = dev?.zone ?? portal!.zone;
    if (this.puzzleOfZone(zone) !== this.idx) return failRes('這個目標與目前的謎題無關。');
    if (dev && !roleCanUseDevice(role, dev)) return failRes('這台設備與你的權限不符。');

    const rem = this.lockRemaining(role, p.targetId);
    if (rem > 0) return warnRes(`設備暫時鎖定，請 ${Math.ceil(rem / 1000)} 秒後再試。`, { lockMs: rem });

    // 只在謎題狀態真的改變時才要求其他人的面板刷新；純查詢（例如試聽參考音）不刷新，
    // 否則客戶端會用預設畫面蓋掉這次操作回傳的專屬畫面
    const before = this.fingerprint();
    let result: ActionResult | null;
    if (portal) {
      if (p.actionType !== 'enter' || !this.module.portal) return failRes('這裡沒有可以通過的門洞。');
      result = this.module.portal(role, p.targetId);
    } else {
      result = this.module.act(role, { actionType: p.actionType, targetId: p.targetId, payload: values });
    }
    if (!result) result = failRes('這台設備沒有這項操作。');

    this.changed();
    if (this.fingerprint() !== before) this.hooks.refreshDevices();
    if (dev && !dev.direct && result.view === undefined) {
      const view = this.buildView(role, p.targetId);
      return { ...result, view };
    }
    return result;
  }

  /** 目前謎題的狀態指紋（進度、狀態、內部條件） */
  private fingerprint(): string {
    if (this.finished) return 'done';
    return `${this.idx}|${this.statusOf(this.idx)}|${JSON.stringify(this.module.debug().conditions)}|${JSON.stringify(this.module.stage())}`;
  }

  onPresenceChange(): void {
    this.module.onPresenceChange?.();
    this.changed();
  }

  /* ----------------------------- 提示 ----------------------------- */

  requestHint(): { ok: true; tier: number; text: string; puzzle: PuzzleId } | { ok: false; error: string } {
    const id = this.activeId;
    if (!id) return { ok: false, error: '第一章已經完成。' };
    const now = this.now();
    const tier = this.hintTier.get(id) ?? 0;
    if (tier >= 3) return { ok: false, error: '這一題的提示已經用完了。' };
    if (tier >= 1 && now < this.hintNextAt) {
      return { ok: false, error: `請再等 ${Math.ceil((this.hintNextAt - now) / 1000)} 秒，先和隊友討論看看。` };
    }
    const next = tier + 1;
    this.hintTier.set(id, next);
    this.hintNextAt = now + this.hintCooldownMs;
    this.hintsUsed += 1;
    const text = this.module.hints[next - 1];
    this.hooks.hint(id, next, text);
    this.changed();
    return { ok: true, tier: next, text, puzzle: id };
  }

  /* ----------------------------- 除錯 ----------------------------- */

  debugState(roles: Record<string, Role | null>): DebugState {
    const id = this.activeId;
    const d = id ? this.module.debug() : { answer: null, conditions: {} };
    const stage = id ? this.module.stage() : null;
    return {
      puzzleId: id,
      status: id ? this.statusOf(this.idx) : 'chapter-complete',
      answer: d.answer,
      conditions: d.conditions,
      syncRemainingMs: stage?.syncRemainingMs ?? null,
      recent: [...this.recent],
      roles,
    };
  }

  debugCommand(cmd: Exclude<DebugCommand, 'reinit_room'>): boolean {
    const id = this.activeId;
    if (!id) return false;
    if (cmd === 'reset_puzzle') {
      this.module.reset();
      this.attempts.set(id, 0);
      this.locks.clear();
      this.failedUntil = 0;
      this.hooks.reset(id, 'full');
      this.changed();
      this.hooks.refreshDevices();
      return true;
    }
    if (cmd === 'complete_puzzle') return this.complete(id);
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.module.dispose();
    if (this.failTimer) clearTimeout(this.failTimer);
    this.failTimer = null;
  }
}

export { ROLES };
