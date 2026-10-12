import type { ActionResult, PanelView, Role, TapPattern } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { makeView, okRes, statusBlock } from '../util';
import { BaseModule } from './base';
import { ANSWERS, DISPLAY_LABEL, INSTRUMENTS, INSTRUMENT_LABEL, P08, type Instrument, type Sound } from './data';

const SOUND_TAP: Record<Sound, TapPattern> = {
  INTERMITTENT: {
    events: [0, 170, 720, 840, 1540, 1660, 2300].map((at) => ({ at: 150 + at, len: 90, tone: 72 })),
    durationMs: 2800,
  },
  RUNNING: { events: Array.from({ length: 9 }, (_, i) => ({ at: 150 + i * 260, len: 120, tone: 180 })), durationMs: 2700 },
  HUM: { events: [{ at: 150, len: 2200, tone: 118 }], durationMs: 2600 },
};
const instrumentOf = (deviceId: string): Instrument | null => {
  const m = /^r8_(pressure|temp|flow|volt)$/.exec(deviceId);
  return m ? (m[1] as Instrument) : null;
};

/**
 * P08 會說謊的儀器。
 * 讀數只有 DEAF 看得到、聲紋只有 BLIND 聽得到、診斷規則在 MUTE 手上；任何人都可以校準。
 */
export class P08LyingInstruments extends BaseModule {
  readonly id = 'P08_LYING_INSTRUMENTS' as const;
  readonly room = 8;
  readonly hints = [
    '四台儀器中只有一台故障。讀數只有靜默員看得到，運轉聲只有盲區員聽得到，判斷規則在失語員的診斷規則裡。',
    '只看聲音會有兩台可疑，只看讀數也會有兩台可疑；規則會說明哪些異常其實是正常現象。',
    '找出「讀數正常、卻有間歇震動」的那一台，對它執行校準。',
  ] as const;

  view(role: Role, deviceId: string): PanelView | null {
    const inst = instrumentOf(deviceId);
    if (inst) {
      const blocks = [];
      if (role === 'DEAF') blocks.push({ type: 'status' as const, tone: 'info' as const, text: `讀數：${DISPLAY_LABEL[P08.display[inst]]}` });
      else if (role === 'BLIND') blocks.push({ type: 'text' as const, text: '把耳朵貼近儀器外殼，可以聽見它的運轉聲。' });
      else blocks.push(statusBlock('info', '儀表蓋著防眩玻璃，讀數只輸出到監控權限。'));
      return makeView({
        deviceId,
        title: INSTRUMENT_LABEL[inst],
        subtitle: '校準實驗室',
        blocks,
        tap: role === 'BLIND' ? SOUND_TAP[P08.sound[inst]] : undefined,
        actions: [{ id: 'calibrate', label: '執行校準', kind: 'primary' }],
        clue: role !== 'MUTE',
      });
    }
    if (deviceId === 'r8_rules') {
      return makeView({
        deviceId,
        title: '診斷規則',
        blocks: [
          {
            type: 'list',
            items: [
              '儀器顯示正常，卻持續出現間歇震動：指針卡住，屬於故障。',
              '流量計達到最大值時，泵浦全開，本來就會伴隨間歇震動，屬於正常現象。',
              '溫度過高可以是正常的環境狀態。',
              '穩定的嗡鳴代表電壓計的自檢通過。',
              '同一時間只會有一台儀器故障。',
            ],
          },
        ],
        clue: true,
      });
    }
    return null;
  }

  act(role: Role, input: ActionInput): ActionResult | null {
    const inst = instrumentOf(input.targetId);
    if (!inst || input.actionType !== 'calibrate') return null;
    if (ANSWERS.p08.includes(inst)) {
      this.finish('d8');
      return okRes(`${INSTRUMENT_LABEL[inst]}的指針鬆開，回到正確位置。校準完成。`);
    }
    this.feedback({ targetId: input.targetId, sound: 'selftest', visual: 'selftest' });
    return this.wrong(role, input.targetId, '儀器短暫進入自檢後恢復。校準未改善設備狀態。');
  }

  debug() {
    return { answer: INSTRUMENT_LABEL[ANSWERS.p08[0]], conditions: { instruments: INSTRUMENTS } };
  }
}
