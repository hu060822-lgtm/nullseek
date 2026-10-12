import {
  ROLES,
  type ActionResult,
  type LogEntry,
  type Notice,
  type PanelView,
  type PuzzleFeedback,
  type PuzzleId,
  type Role,
  type SceneClues,
  type ZoneId,
} from '@null-protocol/shared';
import { Chapter, type ChapterOptions } from '../src/game/chapter';
import type { ChapterHooks } from '../src/game/types';
import type { Driver, Press } from './solver';

export interface Recorder {
  changes: number;
  feedback: PuzzleFeedback[];
  completed: Array<{ id: PuzzleId; title: string }>;
  resets: Array<{ id: PuzzleId; scope: string }>;
  hints: Array<{ id: PuzzleId; tier: number; text: string }>;
  notices: Notice[];
  logs: Record<Role, LogEntry[]>;
  teleports: Array<{ zone: ZoneId }>;
  chapterComplete: number;
  refresh: number;
  connected: Record<Role, boolean>;
}

export function recorder(): Recorder {
  return {
    changes: 0,
    feedback: [],
    completed: [],
    resets: [],
    hints: [],
    notices: [],
    logs: { BLIND: [], DEAF: [], MUTE: [] },
    teleports: [],
    chapterComplete: 0,
    refresh: 0,
    connected: { BLIND: true, DEAF: true, MUTE: true },
  };
}

export function hooksFor(r: Recorder): ChapterHooks {
  return {
    onChange: () => void r.changes++,
    notify: (_role, n) => void r.notices.push(n),
    broadcast: (n) => void r.notices.push(n),
    log: (role, e) => void r.logs[role].push(e),
    feedback: (f) => void r.feedback.push(f),
    completed: (id, title) => void r.completed.push({ id, title }),
    reset: (id, scope) => void r.resets.push({ id, scope }),
    hint: (id, tier, text) => void r.hints.push({ id, tier, text }),
    refreshDevices: () => void r.refresh++,
    chapterComplete: () => void r.chapterComplete++,
    isConnected: (role) => r.connected[role],
    teleport: (zone) => void r.teleports.push({ zone }),
  };
}

export interface Bench {
  chapter: Chapter;
  rec: Recorder;
  /** 以角色身分送出 puzzle:action（自動產生 requestId，可指定以測試去重） */
  act(role: Role, targetId: string, actionType: string, payload?: Record<string, unknown>, requestId?: string): ActionResult;
  open(role: Role, deviceId: string): PanelView;
  driver: Driver;
  dispose(): void;
}

let reqSeq = 0;
export const nextRequestId = (): string => `req-${++reqSeq}`;

export function bench(opts: ChapterOptions = {}): Bench {
  const rec = recorder();
  const chapter = new Chapter(hooksFor(rec), { syncWindowMs: 400, hintCooldownMs: 50, lockBaseMs: 0, ...opts });
  const playerOf = (role: Role) => `player-${role}`;
  const act: Bench['act'] = (role, targetId, actionType, payload = {}, requestId = nextRequestId()) => {
    const puzzleId = chapter.activeId ?? 'P10_NULL_PROTOCOL';
    return chapter.action(playerOf(role), role, { puzzleId, actionType, targetId, payload, requestId });
  };
  const open: Bench['open'] = (role, deviceId) => {
    const r = chapter.openDevice(role, deviceId);
    if (!r.ok) throw new Error(`[${role}] 開啟 ${deviceId} 失敗：${r.error}`);
    return r.view;
  };
  const driver: Driver = {
    open: async (role, id) => open(role, id),
    act: async (role, targetId, actionType, payload) => act(role, targetId, actionType, payload),
    enter: async (role, portalId) => act(role, portalId, 'enter'),
    clues: async (role): Promise<SceneClues> => chapter.cluesFor(role),
    syncPress: async (presses: Press[]) => presses.map((p) => act(p.role, p.targetId, p.actionType)),
    activePuzzle: async () => chapter.activeId,
  };
  return { chapter, rec, act, open, driver, dispose: () => chapter.dispose() };
}

export { ROLES };
