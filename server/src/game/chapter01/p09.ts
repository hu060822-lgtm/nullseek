import { roomRect, type ActionResult, type PanelView, type Role, type SceneClues } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { makeView, okRes, rhythm, statusBlock } from '../util';
import { BaseModule } from './base';
import { ANSWERS, P09 } from './data';

const R9 = roomRect(9);
const SPOTS = {
  BLIND: { x: -1.5, z: R9.minZ + 1.5, yaw: Math.PI },
  DEAF: { x: 0, z: R9.minZ + 1.5, yaw: Math.PI },
  MUTE: { x: 1.5, z: R9.minZ + 1.5, yaw: Math.PI },
};

/**
 * P09 不曾發生的循環（規則由實作補完，見 docs/PUZZLES.md）。
 *
 * 伺服器維護 loopIndex（1–4）、本輪是否已扳下保留開關、換場次數。
 * 喇叭播放上一輪的音型；燈號第 k 位代表本輪保留的開關 Sk；
 * 出口輪（第 4 輪）：先扳下保留開關，再走進門序排第一位的門（標籤 D）。
 */
export class P09NonexistentLoop extends BaseModule {
  readonly id = 'P09_NONEXISTENT_LOOP' as const;
  readonly room = 9;
  readonly hints = [
    '每次走進一扇門，走廊都會重新排列。喇叭播的是上一輪的聲音；門序與燈號只有靜默員看得到；開關只有盲區員能扳；規則在失語員手上。',
    '把每一輪聽到的音型和看到的門序、燈號都記下來（Tab 可以看自己的紀錄）。比對後就會知道每一輪「真正的音型」，以及哪一輪的音型從來沒有被播放過。',
    '出口在第四輪：燈號亮在第 4 位，所以要扳 S4；門序第一位是 D。先扳開關、再走進最左邊那扇門。',
  ] as const;

  private loop = 1;
  private armed = false;
  private visit = 0;
  private roundsSeen = 1;

  private get round() {
    return P09.rounds[this.loop - 1];
  }

  override stage() {
    return { visit: this.visit };
  }

  logRound(): number {
    return this.visit + 1;
  }

  override clues(role: Role): SceneClues {
    return role === 'DEAF' ? { r9Labels: [...this.round.order], r9Lights: [...this.round.lights] } : {};
  }

  view(_role: Role, deviceId: string): PanelView | null {
    switch (deviceId) {
      case 'r9_speaker':
        return makeView({
          deviceId,
          title: '迴響喇叭',
          subtitle: '走廊裡迴盪的音型',
          blocks: [{ type: 'text', text: '喇叭重複播放一段節奏。把它和你記得的上一段比較看看。' }],
          tap: rhythm(P09.rhythm[this.round.played], 260),
          clue: true,
        });
      case 'r9_monitor':
        return makeView({
          deviceId,
          title: '循環監視器',
          subtitle: '本輪的走廊狀態',
          blocks: [
            { type: 'table', header: ['位置', '1', '2', '3', '4'], rows: [['門的標籤', ...this.round.order]] },
            { type: 'slots', seq: this.round.lights.map((l) => (l ? 'ON' : 'OFF')), caption: '燈號（位置 1 → 4）' },
          ],
          clue: true,
        });
      case 'r9_switches':
        return makeView({
          deviceId,
          title: '機械開關組',
          subtitle: 'S1～S4',
          blocks: [statusBlock(this.armed ? 'ok' : 'info', this.armed ? '有一個開關卡在扳下的位置。' : '四個開關都在原位。')],
          actions: [1, 2, 3, 4].map((k) => ({ id: `flip_${k}`, label: `扳下 S${k}`, kind: 'neutral' as const })),
        });
      case 'r9_rules':
        return makeView({
          deviceId,
          title: '循環規則',
          blocks: [
            {
              type: 'list',
              items: [
                '喇叭播放的永遠是上一輪的音型；第一輪沒有上一輪，播放待機音型。',
                '每一輪的真實音型都不同；本輪的真實音型要到下一輪才聽得到。',
                '燈號亮在第 k 位，代表本輪被保留的開關是 Sk。',
                '出口只會出現在「前三輪的真實音型都已確認、而本輪的真實音型從未被播放過」的那一輪。',
                '在出口輪：先扳下本輪被保留的開關，再走進門序排在第一位的門。',
                '其他時候扳開關會回報「狀態不相容」；走進任何一扇門，走廊都會重新排列並進入下一輪。',
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
    if (input.targetId !== 'r9_switches') return null;
    const m = /^flip_([1-4])$/.exec(input.actionType);
    if (!m) return null;
    const k = Number(m[1]);
    const t = ANSWERS.p09;
    if (this.armed) return okRes('開關已經卡在定位了。', { tone: 'info' });
    if (this.loop === t.round && k === t.switch && this.roundsSeen >= 3) {
      this.armed = true;
      this.feedback({ targetId: 'r9_switches', sound: 'accept' });
      return okRes(`S${k} 卡入定位，發出一聲沉重的咔嗒。`);
    }
    this.feedback({ targetId: 'r9_switches', sound: 'reject' });
    return this.wrong(role, 'r9_switches', '狀態不相容。開關彈回原位。');
  }

  portal(_role: Role, portalId: string): ActionResult | null {
    const m = /^r9_([1-4])$/.exec(portalId);
    if (!m) return null;
    const slot = Number(m[1]);
    const t = ANSWERS.p09;
    if (this.loop === t.round && this.armed && this.round.order[slot - 1] === t.label) {
      this.finish('d9');
      return okRes('門後的走廊沒有再重新排列。循環停止了。');
    }
    // 走進任何一扇門：進入下一個預定輪次（紀錄保留）
    this.loop = (this.loop % P09.rounds.length) + 1;
    this.armed = false;
    this.visit += 1;
    this.roundsSeen += 1;
    this.api.hooks.teleport('R9', SPOTS);
    this.feedback({ sound: 'shift', visual: 'shift' });
    return okRes('走廊重新排列了。');
  }

  override reset(): void {
    this.loop = 1;
    this.armed = false;
    this.roundsSeen = 1;
    this.visit += 1;
  }

  debug() {
    return {
      answer: `第 ${ANSWERS.p09.round} 輪：扳 S${ANSWERS.p09.switch}，走進位置 ${ANSWERS.p09.slot}（${ANSWERS.p09.label} 門）`,
      conditions: { loop: this.loop, armed: this.armed, roundsSeen: this.roundsSeen, visit: this.visit },
    };
  }

  /** 測試用：目前輪次 */
  get loopIndex(): number {
    return this.loop;
  }
}

