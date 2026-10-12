import { PORTALS, R2_DOORS, portalFront, ROLE_INFO, ZONES, rayDistance, roomRect, type DeviceKind, type R2DoorKey, type Role } from '@null-protocol/shared';
import { audio } from '../audio/engine';
import { speak } from '../audio/speech';
import { closePanel, doAction, emitMark, enterPortal, openDevice, sendMove } from '../net/socket';
import { puzzleOf } from './codes';
import { useStore } from '../state/store';
import { voice } from '../voice/voice';
import {
  clearKeys,
  currentTarget,
  currentZone,
  getColliders,
  look,
  nearestUsable,
  nextMove,
  portalToEnter,
  pose,
  setKey,
  step,
} from './controller';
import { remotes, smooth } from './remote';
import { emit } from './bus';

/** 不同設備種類用不同音高的指引聲，盲區員可以靠音高分辨 */
const KIND_PITCH: Partial<Record<DeviceKind, number>> = {
  tap_source: 330,
  console: 440,
  knobs: 392,
  gauge: 523,
  door_slot: 262,
};

let surface: HTMLElement | null = null;

export function requestLock(): void {
  const el = surface ?? document.body;
  try {
    const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => undefined);
  } catch {
    /* 瀏覽器不支援或剛按過 Esc */
  }
  void audio.init().then(() => audio.startAmbient());
}

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

function role(): Role | null {
  return useStore.getState().me?.role ?? null;
}

export function toggleOverlay(o: 'log' | 'signals' | 'help'): void {
  const st = useStore.getState();
  if (st.panel) return;
  const next = st.overlay === o ? 'none' : o;
  st.set({ overlay: next });
  if (next !== 'none' && document.pointerLockElement) document.exitPointerLock();
  if (next === 'none') requestLock();
}

function interact(): void {
  const r = role();
  if (!r) return;
  const st = useStore.getState();
  if (st.panel) return;
  const t = currentTarget(r);
  if (!t) {
    audio.uiKey();
    return;
  }
  if (!t.usable) {
    st.pushNotice({ tone: 'warn', text: `「${t.device.label}」不是你的設備，你沒有權限操作它。` }, 3500);
    audio.uiWarn();
    speak('這不是你的設備');
    return;
  }
  // 直接互動的設備（例如 P02 的門）：不開面板，直接送出動作
  if (t.device.direct) {
    void doAction(t.device.id, t.device.direct, {});
    return;
  }
  void openDevice(t.device.id);
}

/** 失語員的標記工具：指向注視中的設備（隊友看到標記、聽得見的人聽到方位） */
function mark(): void {
  const r = role();
  if (r !== 'MUTE') return;
  const st = useStore.getState();
  if (st.panel) return;
  const t = currentTarget(r);
  if (!t) {
    st.pushNotice({ tone: 'warn', text: '先注視一台設備，再按 G 標記。' }, 2500);
    return;
  }
  void emitMark(t.device.id).then((err) => {
    if (err) st.pushNotice({ tone: 'warn', text: err }, 2500);
    else st.pushNotice({ tone: 'info', text: `已標記：${t.device.label}` }, 2000);
  });
}

function sonar(): void {
  const r = role();
  if (!r || ROLE_INFO[r].canSee) return; // 回聲定位是盲區員專用
  const cols = getColliders();
  const dir = (a: number) => {
    const yaw = pose.yaw + a;
    return rayDistance(pose.x, pose.z, -Math.sin(yaw), -Math.cos(yaw), cols, 12);
  };
  const reading = { front: dir(0), left: dir(Math.PI / 2), right: dir(-Math.PI / 2), back: dir(Math.PI) };
  audio.sonar(reading);
  emit('echo', reading);
}

export function bindInput(el: HTMLElement): () => void {
  surface = el;
  const onKeyDown = (e: KeyboardEvent): void => {
    const st = useStore.getState();
    if (typing(e.target)) {
      // 在輸入框裡按 Esc：直接關閉面板（不必先離開輸入框）
      if (e.code === 'Escape') {
        (e.target as HTMLElement).blur();
        if (st.panel) closePanel();
        else if (st.overlay !== 'none') st.set({ overlay: 'none' });
      }
      return;
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      toggleOverlay('log');
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyE':
        interact();
        return;
      case 'KeyQ':
        toggleOverlay('signals');
        return;
      case 'KeyH':
        toggleOverlay('help');
        return;
      case 'KeyM':
        if (st.micState === 'on') voice.setMuted(!st.micMuted);
        return;
      case 'KeyF':
        sonar();
        return;
      case 'KeyG':
        mark();
        return;
      case 'Backquote':
        if (st.debug) st.set({ debugOpen: !st.debugOpen });
        if (st.debug && document.pointerLockElement) document.exitPointerLock();
        return;
      case 'Escape':
        if (st.panel) closePanel();
        else if (st.overlay !== 'none') st.set({ overlay: 'none' });
        return;
      default:
        setKey(e.code, true);
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => setKey(e.code, false);
  const onMouse = (e: MouseEvent): void => {
    if (document.pointerLockElement) look(e.movementX, e.movementY, useStore.getState().prefs.sensitivity);
  };
  const onLockChange = (): void => {
    const locked = !!document.pointerLockElement;
    useStore.getState().set({ locked });
    if (!locked) clearKeys();
  };
  const onBlur = (): void => clearKeys();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouse);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onLockChange);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMouse);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('pointerlockchange', onLockChange);
    clearKeys();
    surface = null;
  };
}

export function startGameLoop(): () => void {
  let raf = 0;
  let last = performance.now();
  let lastBump = 0;
  let nextBeacon = 0;
  let lastZone = currentZone();
  let announcedDevice = '';
  let lastTalk = 0;
  let nextDoorTones = 0;
  let announcedPortal = '';

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const st = useStore.getState();
    const r = st.me?.role ?? null;
    if (!r) return;
    const canSee = ROLE_INFO[r].canSee;

    const enabled = st.locked && !st.panel && st.overlay === 'none' && !!st.world;
    const res = step(dt, enabled);
    if (res.footstep) audio.footstep(null, res.running);
    if (res.blocked && now - lastBump > 450) {
      lastBump = now;
      audio.bump();
      if (!canSee) emit('bump', undefined);
    }
    const m = nextMove(now);
    if (m) sendMove(m);

    // 門洞：走進去就觸發（只有目前進行中的謎題的門洞），伺服器驗證距離後才傳送
    if (!st.panel && st.overlay === 'none' && st.world) {
      const active = st.world.activePuzzle;
      const portal = portalToEnter(now, (p) => !!active && puzzleOf(p.id) === active);
      if (portal) void enterPortal(portal.id);
    }

    // P02：門後的聲音（只有盲區員拿到這項線索）；依門的位置做空間定位，從 A 到 D 依序響起
    const sounds = st.clues.r2Sounds;
    if (sounds && now >= nextDoorTones && currentZone() === 'R2') {
      nextDoorTones = now + 5200;
      const z = roomRect(2).maxZ;
      (Object.keys(R2_DOORS) as R2DoorKey[]).forEach((k, i) => audio.doorTone(sounds[k], [R2_DOORS[k], z], i * 1.0));
    }

    audio.setListener(pose.x, pose.z, pose.yaw);

    smooth(dt, (who, x, z) => audio.footstep([x, z]));
    for (const who of Object.keys(remotes) as Role[]) {
      const rp = remotes[who];
      if (rp) audio.updateVoicePos(who, rp.x, rp.z);
    }

    // 隊友說話中（只有「我真的收得到的語音」才會顯示）
    if (now - lastTalk > 150) {
      lastTalk = now;
      const talking: Partial<Record<Role, boolean>> = {};
      let changed = false;
      for (const who of ['BLIND', 'DEAF', 'MUTE'] as Role[]) {
        if (who === r || !audio.hasVoice(who)) continue;
        const t = audio.voiceLevel(who) > 0.06;
        talking[who] = t;
      }
      const prev = st.talking;
      for (const k of new Set([...Object.keys(prev), ...Object.keys(talking)]) as Set<Role>) {
        if (!!prev[k] !== !!talking[k]) changed = true;
      }
      if (changed) st.set({ talking });
    }

    if (!canSee) {
      // 盲區員的空間指引：最近的可用設備會發出「滴」聲；靠近時用語音報出名稱
      const zone = currentZone();
      if (zone !== lastZone) {
        lastZone = zone;
        const z = ZONES.find((q) => q.id === zone);
        if (z) speak(z.label);
      }
      const near = nearestUsable(r, 9);
      if (near && now >= nextBeacon && st.world && !st.panel) {
        nextBeacon = now + Math.max(320, Math.min(1500, near.dist * 140));
        audio.beacon(near.dx, near.dz, pose.yaw, near.dist, KIND_PITCH[near.device.kind] ?? 400);
      }
      // 靠近門洞時報出門洞標示（門洞上的字，盲區員看不到）
      const portal = PORTALS.find((p) => {
        const [fx, fz] = portalFront(p, 0.5);
        return Math.hypot(pose.x - fx, pose.z - fz) < 1.8;
      });
      const pid = portal?.id ?? '';
      if (pid !== announcedPortal) {
        announcedPortal = pid;
        if (portal) speak(`門洞 ${portal.mark}，往前走進去`);
      }
      const t = currentTarget(r);
      const id = t && t.usable ? t.device.id : '';
      if (id !== announcedDevice) {
        announcedDevice = id;
        if (t && t.usable) {
          speak(`${t.device.label}，按 E 操作`);
          emit('near', undefined);
        }
      }
    }
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

