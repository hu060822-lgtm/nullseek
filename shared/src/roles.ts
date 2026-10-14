/**
 * 角色定義與感官／語音權限。
 * 前端（呈現限制）與伺服器（實際執行限制）共用同一份規則。
 */

export const ROLES = ['BLIND', 'DEAF', 'MUTE'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleInfo {
  role: Role;
  letter: 'A' | 'B' | 'C';
  name: string;
  en: string;
  /** 能否取得視覺場景資訊 */
  canSee: boolean;
  /** 能否接收遊戲內聲音（環境音、機械聲、語音） */
  canHear: boolean;
  /** 能否透過遊戲內麥克風傳送語音 */
  canSpeak: boolean;
  /** 角色的識別色調（僅限設施色票；介面主要以角色符號區分，不靠顏色） */
  color: string;
  tagline: string;
  senses: string[];
  limits: string[];
  strengths: string[];
}

export const ROLE_INFO: Record<Role, RoleInfo> = {
  BLIND: {
    role: 'BLIND',
    letter: 'A',
    name: '盲區員',
    en: 'BLIND',
    canSee: false,
    canHear: true,
    canSpeak: true,
    color: '#C5A568',
    tagline: '以聲音看世界的機械技師',
    senses: ['可以聽見環境音、機械節奏與隊友語音', '可以使用麥克風說話'],
    limits: [
      '看不見 3D 場景、文件、燈號與圖形符號',
      '按 F 發出回聲：幾秒內看到周圍反白的結構模型（只有形狀，沒有顏色與文字），之後要等冷卻',
      '另外靠空間音訊、聲學地標與設備提示音辨位',
    ],
    strengths: [
      '唯一能辨識機械敲擊節奏與隱藏機械訊號的人',
      '敲擊器、撥桿、機械開關與共振器這類機械設備只有你能操作',
    ],
  },
  DEAF: {
    role: 'DEAF',
    letter: 'B',
    name: '靜默員',
    en: 'DEAF',
    canSee: true,
    canHear: false,
    canSpeak: true,
    color: '#A8AAA5',
    tagline: '盯著螢幕的監控員',
    senses: ['可以看見完整 3D 場景、燈號、符號與文字', '可以使用麥克風說話'],
    limits: [
      '聽不見任何遊戲音效、機械聲與隊友語音',
      '隊友只能用燈號、符號或手勢回應你',
    ],
    strengths: [
      '唯一能閱讀燈號序列與幾何符號排列的人',
      '燈號面板、符號板、方位儀與指令控制台只有你能操作',
    ],
  },
  MUTE: {
    role: 'MUTE',
    letter: 'C',
    name: '失語員',
    en: 'MUTE',
    canSee: true,
    canHear: true,
    canSpeak: false,
    color: '#E8E5DC',
    tagline: '保管所有規則的檔案管理員',
    senses: ['可以看見完整 3D 場景與文件', '可以聽見環境音與隊友語音'],
    limits: [
      '無法使用遊戲內麥克風，也沒有任意文字聊天',
      '只能用敲擊、燈號、符號與手勢這類受限訊號向隊友傳話',
    ],
    strengths: [
      '唯一持有密鑰表、設備說明與通訊協定文件的人',
      '文件與協定盤只有你能操作；按 G 可以標記一台設備給隊友看',
    ],
  },
};

export const canSendVoice = (role: Role): boolean => ROLE_INFO[role].canSpeak;
export const canReceiveVoice = (role: Role): boolean => ROLE_INFO[role].canHear;

/**
 * 語音邊（from → to）是否被允許。
 * 一條語音要成立，發話者必須能說話，且接收者必須能聽。
 *
 * 結果恰好是三條邊：BLIND→MUTE、DEAF→BLIND、DEAF→MUTE。
 * （企劃書 4.3 表格中「失語員→盲區員：是」與 3.3「失語員不能傳送語音」互相矛盾，
 *  本專案以 3.3／4.2 的明確限制為準，詳見 docs/GAME_DESIGN.md。）
 */
export const voiceEdgeAllowed = (from: Role, to: Role): boolean =>
  from !== to && canSendVoice(from) && canReceiveVoice(to);

export const VOICE_EDGES: ReadonlyArray<readonly [Role, Role]> = ROLES.flatMap((from) =>
  ROLES.filter((to) => voiceEdgeAllowed(from, to)).map((to) => [from, to] as const),
);

export const isRole = (v: unknown): v is Role =>
  typeof v === 'string' && (ROLES as readonly string[]).includes(v);
