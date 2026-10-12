/**
 * 重連時伺服器告知回聲仍在干擾中（重新整理頁面不會解除干擾）。
 * 網路層只記下時間，遊戲迴圈建立盲區員的系統後再套用（避免網路層直接依賴遊戲迴圈）。
 */
let until = 0;

export function applyEchoJam(ms: number): void {
  until = performance.now() + ms;
}

/** 取出尚未套用的干擾結束時間（0＝沒有） */
export function takeEchoJam(): number {
  const u = until;
  until = 0;
  return u;
}
