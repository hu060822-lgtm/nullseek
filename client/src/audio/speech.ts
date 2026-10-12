/**
 * 盲區員的語音播報（瀏覽器內建 speechSynthesis，離線可用，不是生成式 AI）。
 * 只播報「該角色有權知道」的內容：伺服器已依角色過濾後才送到客戶端。
 */
let enabled = false;

export function setSpeechEnabled(v: boolean): void {
  enabled = v;
  if (!v) stopSpeech();
}

export function speak(text: string, opts: { interrupt?: boolean } = {}): void {
  if (!enabled || typeof speechSynthesis === 'undefined' || !text.trim()) return;
  try {
    if (opts.interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch {
    /* 沒有可用的語音引擎時靜默失敗 */
  }
}

export function stopSpeech(): void {
  try {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}
