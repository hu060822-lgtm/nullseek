import type { Session } from '../state/store';

const KEY = 'null-protocol.session';

/** 以 sessionStorage 保存重連憑證：只存在這個分頁，不會跨分頁共用，也不會寫進網址或日誌 */
export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.code === 'string' && typeof s.token === 'string' && typeof s.playerId === 'string') {
      return { code: s.code, token: s.token, playerId: s.playerId };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveSession(s: Session): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
