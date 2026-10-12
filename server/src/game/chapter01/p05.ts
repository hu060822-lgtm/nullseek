import { SYMBOL_GLYPH, SYMBOL_IDS, type ActionResult, type PanelView, type Role, type SymbolId } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { makeView, okRes, parseSelect, statusBlock, warnRes } from '../util';
import { BaseModule } from './base';
import { P05, SIDE_LABEL, SYMBOL_VERB, VERB_LABEL, VERB_SYMBOL, type Side, type Verb } from './data';

const SIDES: readonly Side[] = ['LEFT', 'NONE', 'RIGHT'];

/**
 * P05 失語協定。
 * 指令＝（側向, 動作）。側向只能由 BLIND 的撥桿設定，動作只能由 DEAF 的轉盤（只標符號）設定，
 * 正確順序只在 MUTE 的文件裡；確認音只有聽得見的人聽得到。
 */
export class P05MuteProtocol extends BaseModule {
  readonly id = 'P05_MUTE_PROTOCOL' as const;
  readonly room = 5;
  readonly hints = [
    '每個指令由「側向」和「動作」組成。側向撥桿只有盲區員能扳，動作轉盤只有靜默員能轉，正確的三段指令只有失語員的文件有。',
    '失語員不能說話：可以用信號器的「左／中／右」手勢、敲擊或標記工具告訴兩人該怎麼設。轉盤上只有符號，符號的意義在協定文件裡。',
    '三段指令依序是：左側＋開啟（○）、中＋等待（□）、右側＋重複（◇）。每送出一段，盲區員會聽到接受或拒絕的聲音。',
  ] as const;

  private lever: Side | null = null;
  private slots: Array<{ side: Side; verb: Verb } | null> = [null, null, null];

  private get filled(): number {
    return this.slots.filter(Boolean).length;
  }

  override status(): 'active' | 'ready' {
    return this.filled === 3 ? 'ready' : 'active';
  }

  view(_role: Role, deviceId: string): PanelView | null {
    switch (deviceId) {
      case 'r5_lever':
        return makeView({
          deviceId,
          title: '側向撥桿',
          subtitle: `目前要設定第 ${Math.min(3, this.filled + 1)} 段指令`,
          blocks: [statusBlock('info', this.lever ? `撥桿目前在「${SIDE_LABEL[this.lever]}」。` : '撥桿在原位，尚未設定。')],
          actions: SIDES.map((s) => ({ id: `lever_${s}`, label: `扳到${SIDE_LABEL[s]}`, kind: 'neutral' as const })),
        });
      case 'r5_console':
        return makeView({
          deviceId,
          title: '指令控制台',
          subtitle: '三個指令槽',
          blocks: [
            {
              type: 'list',
              items: this.slots.map((s, i) => `第 ${i + 1} 槽：${s ? '已接受' : i === this.filled ? '等待輸入' : '空'}`),
            },
            statusBlock('info', `側向撥桿：${this.lever ? '已設定' : '未設定'}（由盲區員操作）`),
          ],
          controls:
            this.filled < 3
              ? [{ type: 'select', id: 'dial', label: '動作轉盤', options: SYMBOL_IDS.map((s) => ({ value: s, label: SYMBOL_GLYPH[s] })) }]
              : [],
          actions: [
            ...(this.filled < 3 ? [{ id: 'commit', label: '送出本槽', kind: 'primary' as const }] : []),
            ...(this.filled === 3 ? [{ id: 'final', label: '提交最終序列', kind: 'primary' as const }] : []),
            { id: 'reset_all', label: '全部重置', kind: 'danger' as const, uses: [] },
          ],
        });
      case 'r5_doc':
        return makeView({
          deviceId,
          title: '協定文件',
          subtitle: '控制台操作程序',
          blocks: [
            { type: 'heading', text: '三段指令（依序）' },
            { type: 'list', items: P05.expected.map((e) => `${SIDE_LABEL[e.side]}${VERB_LABEL[e.verb]}`) },
            { type: 'heading', text: '指令符號表' },
            {
              type: 'table',
              header: ['符號', '意義'],
              rows: [
                ...(['OPEN', 'CLOSE', 'WAIT', 'REPEAT'] as Verb[]).map((v) => [SYMBOL_GLYPH[VERB_SYMBOL[v]], VERB_LABEL[v]]),
                ['━', '左側'],
                ['┃', '右側'],
              ],
            },
            { type: 'text', text: '側向由撥桿決定，動作由轉盤決定。你無法說話，但可以用信號器與標記工具（指向設備、確認、否決、請求重複、左右、符號）。' },
          ],
          clue: true,
        });
      default:
        return null;
    }
  }

  act(role: Role, input: ActionInput): ActionResult | null {
    if (input.targetId === 'r5_lever') {
      const m = /^lever_(LEFT|NONE|RIGHT)$/.exec(input.actionType);
      if (!m) return null;
      this.lever = m[1] as Side;
      this.feedback({ targetId: 'r5_lever', sound: 'shift' });
      return okRes(`撥桿扳到了${SIDE_LABEL[this.lever]}。`);
    }
    if (input.targetId !== 'r5_console') return null;

    if (input.actionType === 'reset_all') {
      this.lever = null;
      this.slots = [null, null, null];
      this.api.hooks.reset(this.id, 'slots');
      return okRes('三個指令槽都恢復成初始狀態。');
    }
    if (input.actionType === 'final') {
      if (this.filled < 3) return warnRes('三個指令槽尚未全部完成。');
      this.finish('d5');
      return okRes('控制台接受了完整的指令序列。');
    }
    if (input.actionType !== 'commit') return null;
    if (this.filled >= 3) return warnRes('三個指令槽都已經接受了，請提交最終序列。');
    const sym = parseSelect<SymbolId>(input.payload, 'dial', SYMBOL_IDS);
    if (!sym) return this.invalid('請先轉動動作轉盤。');
    // 協作失敗：自己的操作合法，但另一個人的部分還沒完成
    if (!this.lever) return warnRes('側向撥桿尚未設定。');
    const idx = this.filled;
    const want = P05.expected[idx];
    const got = { side: this.lever, verb: SYMBOL_VERB[sym] };
    this.lever = null; // 不論結果，未提交的撥桿設定都會回到原位
    if (got.side !== want.side || got.verb !== want.verb) {
      this.feedback({ targetId: 'r5_console', sound: 'reject', visual: 'error' });
      return this.wrong(role, 'r5_console', '控制台拒絕執行這個指令。未送出的設定已清空。', { clear: true });
    }
    this.slots[idx] = got;
    this.feedback({ targetId: 'r5_console', sound: 'accept' });
    return okRes(`第 ${idx + 1} 槽的指令已送出。`);
  }

  override reset(): void {
    this.lever = null;
    this.slots = [null, null, null];
  }

  debug() {
    return {
      answer: P05.expected.map((e) => `${e.side}_${e.verb}`).join(' → '),
      conditions: { lever: this.lever, slots: this.slots },
    };
  }
}
