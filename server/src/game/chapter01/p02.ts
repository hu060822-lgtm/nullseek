import { R2_DOORS, type ActionResult, type PanelView, type R2DoorKey, type Role, type SceneClues } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { failRes, makeView, okRes } from '../util';
import { BaseModule } from './base';
import { ANSWERS, P02 } from './data';

const RATTLE_DEBOUNCE_MS = 1500;

/**
 * P02 聽見不存在的門。
 * 門後聲音只傳給 BLIND（空間音訊）、門燈只傳給 DEAF、維修規則在 MUTE 手上。
 */
export class P02PhantomDoor extends BaseModule {
  readonly id = 'P02_PHANTOM_DOOR' as const;
  readonly room = 2;
  readonly hints = [
    '四扇門看起來一樣。聲音只有盲區員聽得到，指示燈只有靜默員看得到，判斷規則在失語員的維修文件裡。',
    '維修文件有三個條件，聲音要同時符合兩個、燈號要符合一個。只靠聲音或只靠燈號，都會剩下不只一扇門。',
    '盲區員找出「低頻震動、音高下降」的門（會有兩扇）；靜默員說出哪幾扇是白燈；兩者重疊的那一扇就是出口。',
  ] as const;

  private lastPush = new Map<string, number>();

  override clues(role: Role): SceneClues {
    if (role === 'DEAF') return { r2Lamps: { ...P02.lamps } };
    if (role === 'BLIND') return { r2Sounds: { ...P02.sounds } };
    return {};
  }

  view(_role: Role, deviceId: string): PanelView | null {
    if (deviceId !== 'r2_manual') return null;
    return makeView({
      deviceId,
      title: '維修文件',
      subtitle: '走廊出口判定',
      blocks: [
        { type: 'text', text: '走廊上的聲音會沿著牆內管線傳導，聽見聲音不代表聲源就在眼前那扇門後。真正的出口必須同時符合：' },
        { type: 'list', items: ['聲源具有低頻震動。', '最後一段音型呈現下降的音高。', '門上的出口指示燈是白色。'] },
      ],
      clue: true,
    });
  }

  act(role: Role, input: ActionInput): ActionResult | null {
    const m = /^r2_door_([ABCD])$/.exec(input.targetId);
    if (!m || input.actionType !== 'push') return null;
    const key = m[1] as R2DoorKey;
    if (ANSWERS.p02.includes(key)) {
      this.finish('d2');
      return okRes(`${key} 門的門鎖鬆開了。`);
    }
    // 同一扇門在短時間內重複推，只算一次完整操作
    const now = this.api.now();
    const prev = this.lastPush.get(key) ?? 0;
    this.lastPush.set(key, now);
    this.feedback({ targetId: input.targetId, sound: 'thud', visual: 'shake' });
    if (now - prev < RATTLE_DEBOUNCE_MS) return failRes('門把還在震動。');
    this.api.attempt();
    return failRes('門鎖發出低沉的阻擋聲，門把短暫震動了一下。');
  }

  override reset(): void {
    this.lastPush.clear();
  }

  debug() {
    return { answer: ANSWERS.p02.join(''), conditions: { doors: Object.keys(R2_DOORS) } };
  }
}
