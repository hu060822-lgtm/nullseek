import { VOICE_LIMITS } from '@null-protocol/shared';

export type SdpCheck = { ok: true } | { ok: false; reason: string };

const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'] as const;

/**
 * 驗證語音 SDP。
 *
 * 語音只允許「單向、純音訊」的連線：
 *   - offer（發話者 → 接收者）每個媒體區段必須是 a=sendonly
 *   - answer（接收者 → 發話者）每個媒體區段必須是 a=recvonly 或 a=inactive
 *   - 不允許 video、application（DataChannel）等任何非音訊媒體，避免被當成繞過角色限制的隱蔽通道
 *
 * 這讓伺服器不只是「轉發 signaling」，而是真的能拒絕違反角色規則的連線協商。
 */
export function validateAudioSdp(sdp: unknown, expect: 'offer' | 'answer'): SdpCheck {
  if (typeof sdp !== 'string' || sdp.length === 0) return { ok: false, reason: 'SDP 缺失' };
  if (sdp.length > VOICE_LIMITS.maxSdpLength) return { ok: false, reason: 'SDP 過長' };

  const lines = sdp.split(/\r?\n/);
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      current = [line];
      sections.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  if (sections.length === 0) return { ok: false, reason: 'SDP 沒有媒體區段' };

  for (const sec of sections) {
    if (!sec[0].startsWith('m=audio ')) return { ok: false, reason: '只允許音訊媒體' };
    const dirs = sec.filter((l) => DIRECTIONS.some((d) => l.trim() === `a=${d}`)).map((l) => l.trim().slice(2));
    if (dirs.length !== 1) return { ok: false, reason: '媒體方向必須明確且唯一' };
    const dir = dirs[0];
    if (expect === 'offer' && dir !== 'sendonly') return { ok: false, reason: 'offer 必須是 sendonly' };
    if (expect === 'answer' && dir !== 'recvonly' && dir !== 'inactive') {
      return { ok: false, reason: 'answer 必須是 recvonly' };
    }
  }
  return { ok: true };
}

/** ICE candidate 物件的基本檢查（大小與型別） */
export function validateCandidate(c: unknown): boolean {
  if (c === null) return true; // end-of-candidates
  if (typeof c !== 'object') return false;
  const json = JSON.stringify(c);
  return json.length <= 2000;
}
