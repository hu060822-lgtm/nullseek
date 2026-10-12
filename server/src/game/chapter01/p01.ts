import { SYMBOL_GLYPH, type ActionResult, type PanelView, type Role, type SceneClues } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { makeView, okRes, parseDigits, statusBlock, toneSequence, warnRes } from '../util';
import { BaseModule } from './base';
import { ANSWERS, P01, P01_COLS, P01_PATTERN_LABEL, P01_ROWS, eqArr, type P01Pattern } from './data';

const GEN_TONES = [330, 440, 554];
const patternTones = (p: P01Pattern, tone: number, last: boolean) => {
  // 每台發生器之間停頓 1.1 秒（組內「短接長」只隔 0.18 秒）；最後一台後留 0.6 秒尾音
  const gapAfter = last ? 600 : 1100;
  if (p === 'S') return [{ len: 130, tone, gapAfter }];
  if (p === 'L') return [{ len: 430, tone, gapAfter }];
  return [
    { len: 130, tone, gapAfter: 180 },
    { len: 430, tone, gapAfter },
  ];
};

/**
 * P01 三種語言。
 * BLIND 聽音型順序、DEAF 看符號順序、MUTE 有「音型 × 符號」交叉表；第 i 位數字＝兩者的交叉格。
 */
export class P01ThreeLanguages extends BaseModule {
  readonly id = 'P01_THREE_LANGUAGES' as const;
  readonly room = 1;
  readonly hints = [
    '三位數密碼的每一位，都同時由一組音型和一個符號決定。音型只有盲區員聽得到，符號只有靜默員看得到，對照表在失語員手上。',
    '協定卡是交叉表：列是音型、欄是符號。第一組音型和第一個亮起的符號決定第一位數字，以此類推。',
    '盲區員把三組音型的順序說給失語員聽；靜默員把三個符號的順序說給失語員聽；失語員查交叉表，再把三位數字用信號器傳給隊友，或自己輸入。',
  ] as const;

  override clues(role: Role): SceneClues {
    return role === 'DEAF' ? { r1Symbols: [...P01.symbols] } : {};
  }

  view(_role: Role, deviceId: string): PanelView | null {
    switch (deviceId) {
      case 'r1_gen':
        return makeView({
          deviceId,
          title: '訊號發生器組',
          subtitle: '三台發生器依序播放',
          blocks: [{ type: 'text', text: '三台發生器輪流發出一組音型，每台之間有較長的停頓。音型由短音與長音組成。' }],
          tap: toneSequence(P01.sounds.flatMap((p, i) => patternTones(p, GEN_TONES[i], i === P01.sounds.length - 1))),
          clue: true,
        });
      case 'r1_lamps':
        return makeView({
          deviceId,
          title: '符號燈',
          subtitle: '三盞燈依序亮起',
          blocks: [
            { type: 'symbols', seq: [...P01.symbols], caption: '亮起的順序（第 1 → 第 3）' },
            { type: 'text', text: '燈沒有發出任何聲音。你看得到符號，但不知道它們代表什麼數字。' },
          ],
          clue: true,
        });
      case 'r1_card':
        return makeView({
          deviceId,
          title: '協定卡',
          subtitle: '音型 × 符號 對照',
          blocks: [
            {
              type: 'table',
              header: ['音型＼符號', ...P01_COLS.map((c) => SYMBOL_GLYPH[c])],
              rows: P01_ROWS.map((r) => [P01_PATTERN_LABEL[r], ...P01_COLS.map((c) => String(P01.grid[r][c]))]),
            },
            { type: 'text', text: '密碼的第 i 位＝第 i 組音型所在的列，與第 i 個亮起的符號所在的欄，交叉的那一格。' },
          ],
          clue: true,
        });
      case 'r1_lock':
        return makeView({
          deviceId,
          title: '密碼輸入器',
          subtitle: '出口的三位數密碼',
          blocks: [statusBlock('info', '輸入三位數字。輸入錯誤時，密碼器會發出失敗聲並閃一下指示燈。')],
          controls: [{ type: 'digits', id: 'code', label: '密碼（三位）', minLength: 1, maxLength: 3, min: 0, max: 9 }],
          actions: [{ id: 'submit', label: '送出密碼', kind: 'primary' }],
        });
      default:
        return null;
    }
  }

  act(role: Role, input: ActionInput): ActionResult | null {
    if (input.targetId !== 'r1_lock' || input.actionType !== 'submit') return null;
    const code = parseDigits(input.payload, 'code', { min: 0, max: 9, minLength: 1, maxLength: 3 });
    if (!code) return this.invalid();
    if (code.length < 3) return warnRes('訊號尚未完整。');
    if (!eqArr(code, ANSWERS.p01)) {
      this.feedback({ targetId: 'r1_lock', sound: 'reject', visual: 'flash' });
      return this.wrong(role, 'r1_lock', '密碼器發出短促的失敗聲，指示燈閃了一下。', { clear: true });
    }
    this.finish('d1');
    return okRes('密碼正確，出口門開啟。');
  }

  debug() {
    return { answer: ANSWERS.p01.join(''), conditions: {} };
  }
}
