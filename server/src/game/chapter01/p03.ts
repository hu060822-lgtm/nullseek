import { SYMBOL_GLYPH, type ActionResult, type PanelView, type Role } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { makeView, okRes, parseDigits, statusBlock, warnRes } from '../util';
import { BaseModule } from './base';
import { ANSWERS, P03, eqArr } from './data';

/**
 * P03 逆序檔案。
 * 時間順序只在 BLIND 的敲擊裡（每一下來自哪個位置）；位置上的符號只有 DEAF 看得到；轉換與反向規則在 MUTE 手上。
 */
export class P03ReversedArchive extends BaseModule {
  readonly id = 'P03_REVERSED_ARCHIVE' as const;
  readonly room = 3;
  readonly hints = [
    '靜默員看得到四個位置上的符號，但看不出訊號發生的先後；先後只有盲區員的敲擊聽得出來。',
    '盲區員可以先試聽「位置 1～4」各自的參考音，再播放完整的敲擊，就能說出四下敲擊分別來自哪個位置。',
    '把敲擊的位置順序換成符號、用轉換表換成數字，最後依規則從最後一個訊號往前排。',
  ] as const;

  view(_role: Role, deviceId: string): PanelView | null {
    switch (deviceId) {
      case 'r3_taps':
        return this.tapsView();
      case 'r3_plates':
        return makeView({
          deviceId,
          title: '符號排列板',
          subtitle: '四個固定位置',
          blocks: [
            { type: 'symbols', seq: [...P03.plates], caption: '位置 1 → 位置 4' },
            { type: 'text', text: '四塊符號板都亮著，看不出訊號發生的先後順序。' },
          ],
          clue: true,
        });
      case 'r3_rules':
        return makeView({
          deviceId,
          title: '檔案規則',
          subtitle: '檔案機器輸入程序',
          blocks: [
            { type: 'heading', text: '符號轉換表' },
            { type: 'table', header: ['符號', '數字'], rows: (['TRI', 'CIR', 'DIA', 'SQR'] as const).map((s) => [SYMBOL_GLYPH[s], String(P03.table[s])]) },
            { type: 'heading', text: '輸入順序' },
            { type: 'text', text: '依訊號發生的時間先後轉換成數字後，必須從最後一個訊號開始，依序往前排列。' },
          ],
          clue: true,
        });
      case 'r3_machine':
        return makeView({
          deviceId,
          title: '檔案機器',
          blocks: [statusBlock('info', '插入四位數的檔案序列。')],
          controls: [{ type: 'digits', id: 'code', label: '檔案序列（四位）', minLength: 1, maxLength: 4, min: 0, max: 9 }],
          actions: [{ id: 'submit', label: '送入機器', kind: 'primary' }],
        });
      default:
        return null;
    }
  }

  private tapsView(single?: number): PanelView {
    const full = {
      events: P03.tapOrder.map((pos, i) => ({ at: 200 + P03.tapTimes[i], len: 110, tone: P03.refTones[pos - 1] })),
      durationMs: 200 + P03.tapTimes[P03.tapTimes.length - 1] + 600,
    };
    return makeView({
      deviceId: 'r3_taps',
      title: '機械敲擊器',
      subtitle: '四次敲擊，間隔不均',
      blocks: [{ type: 'text', text: '四個位置各有自己的音高。可以先試聽每個位置的參考音，再聽完整的四下敲擊。' }],
      actions: [
        ...[1, 2, 3, 4].map((n) => ({ id: `ref_${n}`, label: `試聽位置 ${n}`, kind: 'neutral' as const })),
        { id: 'full', label: '播放完整敲擊', kind: 'primary' as const },
      ],
      tap: single ? { events: [{ at: 150, len: 160, tone: P03.refTones[single - 1] }], durationMs: 600 } : full,
      clue: !single,
    });
  }

  act(role: Role, input: ActionInput): ActionResult | null {
    const ref = /^ref_([1-4])$/.exec(input.actionType);
    if (input.targetId === 'r3_taps' && ref) {
      return okRes(`位置 ${ref[1]} 的參考音。`, { tone: 'info', view: this.tapsView(Number(ref[1])) });
    }
    if (input.targetId === 'r3_taps' && input.actionType === 'full') {
      return okRes('完整的四下敲擊。', { tone: 'info', view: this.tapsView() });
    }
    if (input.targetId !== 'r3_machine' || input.actionType !== 'submit') return null;
    const code = parseDigits(input.payload, 'code', { min: 0, max: 9, minLength: 1, maxLength: 4 });
    if (!code) return this.invalid();
    if (code.length < 4) return warnRes('序列不完整。');
    if (!eqArr(code, ANSWERS.p03)) {
      this.feedback({ targetId: 'r3_machine', sound: 'reject', visual: 'flash' });
      return this.wrong(role, 'r3_machine', '機器把卡片退了回來。', { clear: true });
    }
    this.finish('d3');
    return okRes('檔案櫃解鎖。');
  }

  debug() {
    return { answer: ANSWERS.p03.join(''), conditions: {} };
  }
}
