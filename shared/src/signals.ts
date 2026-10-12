import { ROLE_INFO, type Role } from './roles';

/**
 * 信號器（受限通訊）。
 *
 * 失語員不能說話、靜默員聽不到、盲區員看不到，因此三人之間需要一條
 * 「感官限制下的替代通道」。這條通道只有固定詞彙（敲擊、燈號、符號、手勢），
 * 沒有任何自由文字。伺服器依接收者的感官過濾每一個 token：
 *   - 敲擊（audio）：只有聽得到的角色收得到
 *   - 燈號／符號／手勢（visual）：只有看得到的角色收得到
 */

export const SIGNAL_TOKENS = [
  'TAP_S',
  'TAP_L',
  'LIGHT_R',
  'LIGHT_B',
  'LIGHT_G',
  'LIGHT_W',
  'SYM_TRI',
  'SYM_CIR',
  'SYM_SQR',
  'SYM_DIA',
  'GEST_WAIT',
  'GEST_YES',
  'GEST_NO',
  'GEST_GO',
  'GEST_LEFT',
  'GEST_CENTER',
  'GEST_RIGHT',
  'GEST_AGAIN',
  'SYM_H',
  'SYM_V',
] as const;
export type SignalToken = (typeof SIGNAL_TOKENS)[number];

export type SignalClass = 'audio' | 'visual';

export const TOKEN_CLASS: Record<SignalToken, SignalClass> = {
  TAP_S: 'audio',
  TAP_L: 'audio',
  LIGHT_R: 'visual',
  LIGHT_B: 'visual',
  LIGHT_G: 'visual',
  LIGHT_W: 'visual',
  SYM_TRI: 'visual',
  SYM_CIR: 'visual',
  SYM_SQR: 'visual',
  SYM_DIA: 'visual',
  GEST_WAIT: 'visual',
  GEST_YES: 'visual',
  GEST_NO: 'visual',
  GEST_GO: 'visual',
  GEST_LEFT: 'visual',
  GEST_CENTER: 'visual',
  GEST_RIGHT: 'visual',
  GEST_AGAIN: 'visual',
  SYM_H: 'visual',
  SYM_V: 'visual',
};

export const TOKEN_LABEL: Record<SignalToken, string> = {
  TAP_S: '短敲',
  TAP_L: '長敲',
  LIGHT_R: '紅燈',
  LIGHT_B: '藍燈',
  LIGHT_G: '綠燈',
  LIGHT_W: '白燈',
  SYM_TRI: '△',
  SYM_CIR: '○',
  SYM_SQR: '□',
  SYM_DIA: '◇',
  GEST_WAIT: '等待',
  GEST_YES: '是',
  GEST_NO: '否',
  GEST_GO: '開始',
  GEST_LEFT: '左',
  GEST_CENTER: '中',
  GEST_RIGHT: '右',
  GEST_AGAIN: '請重複',
  SYM_H: '━',
  SYM_V: '┃',
};

export const TOKEN_COLOR: Partial<Record<SignalToken, string>> = {
  LIGHT_R: '#C64B3C',
  LIGHT_B: '#4F7A99',
  LIGHT_G: '#6E9466',
  LIGHT_W: '#E8E5DC',
};

export const MAX_SIGNAL_LEN = 6;
export const SIGNAL_COOLDOWN_MS = 1200;

export const isSignalToken = (v: unknown): v is SignalToken =>
  typeof v === 'string' && (SIGNAL_TOKENS as readonly string[]).includes(v);

/** 這個角色是否能感知這個 token */
export function canPerceive(role: Role, token: SignalToken): boolean {
  const info = ROLE_INFO[role];
  return TOKEN_CLASS[token] === 'audio' ? info.canHear : info.canSee;
}

/** 依接收者感官過濾 token 序列 */
export function filterForRole(role: Role, tokens: readonly SignalToken[]): SignalToken[] {
  return tokens.filter((t) => canPerceive(role, t));
}
