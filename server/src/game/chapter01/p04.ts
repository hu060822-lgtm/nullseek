import { roomRect, type ActionResult, type PanelView, type Role, type SceneClues, type TapPattern } from '@null-protocol/shared';
import type { ActionInput } from '../types';
import { failRes, makeView, okRes, parseSelect, statusBlock } from '../util';
import { BaseModule } from './base';
import {
  DIR_LABEL,
  ECHO_LABEL,
  LANDMARK_LABEL,
  P04,
  PORTAL_MARKS,
  p04Transition,
  type Dir,
  type EchoId,
  type MazeNode,
  type PortalMark,
} from './data';

const ECHO_TAP: Record<EchoId, TapPattern> = {
  LONG_ECHO: {
    events: [
      { at: 150, len: 60, tone: 1200 },
      { at: 420, len: 320, tone: 620 },
      { at: 900, len: 420, tone: 420 },
      { at: 1500, len: 500, tone: 300 },
    ],
    durationMs: 2200,
  },
  SHORT_ECHO: {
    events: [
      { at: 150, len: 60, tone: 1200 },
      { at: 300, len: 110, tone: 900 },
    ],
    durationMs: 900,
  },
  LOW_HUM: { events: [{ at: 150, len: 1600, tone: 62 }], durationMs: 2000 },
  TRIPLE_KNOCK: {
    events: [0, 1, 2].map((i) => ({ at: 150 + i * 170, len: 70, tone: 260 })),
    durationMs: 900,
  },
};
const ECHO_IDS = Object.keys(ECHO_LABEL) as EchoId[];

const R4 = roomRect(4);
const ZC = (R4.minZ + R4.maxZ) / 2;
const SPOTS = {
  BLIND: { x: -1.4, z: ZC - 0.6, yaw: Math.PI },
  DEAF: { x: 0, z: ZC - 1.4, yaw: Math.PI },
  MUTE: { x: 1.4, z: ZC - 0.6, yaw: Math.PI },
};

/**
 * P04 沒有地圖的房間。
 * 伺服器維護節點圖：BLIND 在回音探測器確認節點後門洞才解鎖；DEAF 的方位儀告訴大家哪個門洞是哪個方位；
 * MUTE 有路線規則。錯誤出口一律回到起點（局部重置），不會軟鎖。
 */
export class P04MaplessRoom extends BaseModule {
  readonly id = 'P04_MAPLESS_ROOM' as const;
  readonly room = 4;
  readonly hints = [
    '每個房間看起來都一樣，連方位也會轉動。地標看得見、回音聽得見、方位只有靜默員的方位儀知道、路線規則只有失語員有。',
    '每到一個新節點，盲區員要先在回音探測器確認回音，門洞才會解鎖。走錯會回到起點（長回音、沒有地標）。',
    '依序：起點往東 → 三角形吊燈往北 → 懸吊的圓柱往西 → 方形地板往北。方位對應到哪個門洞（I～IV），每次都要看方位儀。',
  ] as const;

  private node: MazeNode = 'START';
  private confirmed = false;
  private visit = 0;
  private progress = 0;

  override stage() {
    return { visit: this.visit };
  }

  logRound(): number {
    return this.visit + 1;
  }

  override clues(role: Role): SceneClues {
    // 地標是環境中的公開視覺資訊：看得見的人都會收到
    return role === 'BLIND' ? {} : { r4Landmark: P04.landmark[this.node] };
  }

  view(_role: Role, deviceId: string): PanelView | null {
    switch (deviceId) {
      case 'r4_echo':
        return makeView({
          deviceId,
          title: '回音探測器',
          subtitle: '確認目前的節點',
          blocks: [
            statusBlock(this.confirmed ? 'ok' : 'info', this.confirmed ? '這個節點已經確認，門洞已解鎖。' : '聆聽回音，選出它的特徵並確認。確認之前，四個門洞都是封住的。'),
          ],
          controls: this.confirmed
            ? []
            : [{ type: 'select', id: 'echo', label: '回音特徵', options: ECHO_IDS.map((e) => ({ value: e, label: ECHO_LABEL[e] })) }],
          actions: this.confirmed ? [] : [{ id: 'confirm', label: '確認節點', kind: 'primary' }],
          tap: ECHO_TAP[P04.echo[this.node]],
          clue: true,
        });
      case 'r4_compass': {
        const c = P04.compass[this.node];
        return makeView({
          deviceId,
          title: '方位儀',
          subtitle: '門洞與方位的對應（每到一個節點都會改變）',
          blocks: [{ type: 'table', header: ['方位', '門洞'], rows: (['N', 'E', 'S', 'W'] as Dir[]).map((d) => [DIR_LABEL[d], c[d]]) }],
          clue: true,
        });
      }
      case 'r4_route':
        return makeView({
          deviceId,
          title: '路線規則',
          subtitle: '無窗迷宮通行程序',
          blocks: [
            { type: 'table', header: ['所在節點', '前往方位'], rows: P04.nodes.map((n) => [LANDMARK_LABEL[P04.landmark[n]] + (n === 'START' ? '（起點）' : ''), DIR_LABEL[P04.route[n]]]) },
            {
              type: 'list',
              items: [
                '每到一個節點，必須先由盲區員在回音探測器確認回音特徵，門洞才會解鎖。',
                '回音特徵：起點＝長回音、三角形＝短回音、圓柱＝連續低頻震動、方形＝三次短促敲擊。',
                '方位與門洞的對應每次都不同，請以方位儀為準。',
                '走錯方向會被送回起點。',
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
    if (input.targetId !== 'r4_echo' || input.actionType !== 'confirm') return null;
    if (this.confirmed) return okRes('這個節點已經確認過了。');
    const echo = parseSelect(input.payload, 'echo', ECHO_IDS);
    if (!echo) return this.invalid('請先選擇回音特徵。');
    if (echo !== P04.echo[this.node]) return this.wrong(role, 'r4_echo', '回音特徵與這個節點不符，探測器拒絕確認。');
    this.confirmed = true;
    this.feedback({ targetId: 'r4_echo', sound: 'accept' });
    return okRes('節點確認，門洞的封條鬆開了。');
  }

  portal(_role: Role, portalId: string): ActionResult | null {
    const mark = portalId.replace('r4_', '') as PortalMark;
    if (!PORTAL_MARKS.includes(mark)) return null;
    if (!this.confirmed) return failRes('門洞被封住了：這個節點還沒有確認。');
    const next = p04Transition(this.node, mark);
    if (next === 'EXIT') {
      this.progress = 4;
      this.finish('d4');
      return okRes('門洞後面是真正的出口。');
    }
    this.progress = next === 'START' ? 0 : this.progress + 1;
    this.node = next;
    this.confirmed = false;
    this.visit += 1;
    this.api.hooks.teleport('R4', SPOTS);
    this.feedback({ sound: 'shift', visual: 'shift' });
    // 不論走對走錯，回饋都一樣：玩家要從地標與回音判斷自己在哪裡
    return okRes('你穿過門洞，走進了另一個一模一樣的房間。');
  }

  override reset(): void {
    this.node = 'START';
    this.confirmed = false;
    this.progress = 0;
    this.visit += 1;
  }

  debug() {
    return {
      answer: 'START→東 / TRIANGLE→北 / CYLINDER→西 / SQUARE→北',
      conditions: { node: this.node, confirmed: this.confirmed, progress: this.progress, visit: this.visit },
    };
  }
}
