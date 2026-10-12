import type { ActionResult, PanelView, Role } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { makeView, okRes, parseDigits, statusBlock, toneSequence, warnRes } from '../util';
import { BaseModule } from './base';
import { ANSWERS, P06, eqArr, evenParity } from './data';

/**
 * P06 缺失的第七次脈衝。
 * BLIND 聽得到六個脈衝的值（聽不出缺口位置）、DEAF 看得到哪個槽沒有訊號（看不到值）、MUTE 有校驗規則。
 */
export class P06MissingPulse extends BaseModule {
  readonly id = 'P06_MISSING_PULSE' as const;
  readonly room = 6;
  readonly hints = [
    '七個脈衝少了一個。盲區員聽得到其餘六個是短還是長，但聽不出少的是哪一個；靜默員看得到是哪一格沒有訊號，但看不到值。',
    '校驗文件說明了短、長代表的位元，以及「1 的總數必須為偶數」。缺的那一位要讓總數變成偶數。',
    '把盲區員聽到的六個位元依序填進靜默員看到的七個槽位（跳過沒有訊號的那一格），再用偶數校驗補上缺的那一位。',
  ] as const;

  view(_role: Role, deviceId: string): PanelView | null {
    switch (deviceId) {
      case 'r6_pulse': {
        const heard = P06.bits.filter((_, i) => i !== P06.missing);
        return makeView({
          deviceId,
          title: '脈衝監聽器',
          subtitle: '等速的脈衝序列',
          blocks: [{ type: 'text', text: '分析儀收到的脈衝依序播放。每個脈衝有短有長。' }],
          tap: toneSequence(heard.map((b) => ({ len: b === 1 ? 430 : 130, tone: 300 })), 380),
          clue: true,
        });
      }
      case 'r6_slots':
        return makeView({
          deviceId,
          title: '時間槽顯示器',
          subtitle: '七個時間槽',
          blocks: [
            { type: 'slots', seq: P06.bits.map((_, i) => (i === P06.missing ? 'MISSING' : 'RECEIVED')), caption: '■ 有收到脈衝（看不出值）　□ 沒有訊號' },
          ],
          clue: true,
        });
      case 'r6_parity':
        return makeView({
          deviceId,
          title: '校驗文件',
          blocks: [
            { type: 'list', items: ['短脈衝代表 0，長脈衝代表 1。', '原始訊號有七個位元。', '七個位元中，1 的總數必須為偶數。'] },
          ],
          clue: true,
        });
      case 'r6_analyzer':
        return makeView({
          deviceId,
          title: '訊號分析儀',
          blocks: [statusBlock('info', '輸入還原後的完整序列。')],
          controls: [{ type: 'digits', id: 'bits', label: '位元序列', minLength: 1, maxLength: 8, min: 0, max: 1 }],
          actions: [{ id: 'submit', label: '送出序列', kind: 'primary' }],
        });
      default:
        return null;
    }
  }

  act(role: Role, input: ActionInput): ActionResult | null {
    if (input.targetId !== 'r6_analyzer' || input.actionType !== 'submit') return null;
    const bits = parseDigits(input.payload, 'bits', { min: 0, max: 1, minLength: 1, maxLength: 8 });
    if (!bits) return this.invalid();
    if (bits.length !== 7) return warnRes('序列長度不符。', { clear: true });
    if (!evenParity(bits)) {
      this.feedback({ targetId: 'r6_analyzer', sound: 'reject', visual: 'error' });
      return this.wrong(role, 'r6_analyzer', '校驗失敗。', { clear: true });
    }
    if (!eqArr(bits, ANSWERS.p06)) {
      this.feedback({ targetId: 'r6_analyzer', sound: 'reject', visual: 'error' });
      return this.wrong(role, 'r6_analyzer', '訊號內容不符。', { clear: true });
    }
    this.finish('d6');
    return okRes('訊號還原完成。');
  }

  debug() {
    return { answer: ANSWERS.p06.join(''), conditions: { missingSlot: P06.missing + 1 } };
  }
}
