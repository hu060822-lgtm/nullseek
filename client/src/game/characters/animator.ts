import { AnimationMixer, LoopOnce, LoopRepeat, MathUtils, Quaternion, Vector3, type AnimationAction, type AnimationClip, type Object3D } from 'three';
import type { PlayerActivity } from '@null-protocol/shared';

/**
 * 角色動畫狀態機（每個角色實例一個）。
 *
 * 輸入只來自「已經同步好的狀態」：隊友的位置與朝向（伺服器權威）、蹲下／操作／受傷（伺服器廣播的身體姿態）。
 * 動畫不會回頭影響位置或碰撞。
 *
 * 狀態：
 *   Idle ─(開始移動)→ StartMoving → Walk ⇄ Run ─(停下)→ StopMoving → Idle
 *   Idle ─(原地轉身)→ Turn
 *   任何 ─(蹲下)→ Crouch → CrouchIdle ⇄ CrouchWalk ─(站起)→ Idle
 *   Idle ─(操作／觀察)→ Interact｜InteractHigh｜Inspect｜Observe
 *   任何 ─(受傷)→ Hurt（播完回到原本的狀態）
 *   Death 只在預覽頁以 force() 播放
 */

export type ActPose = 'low' | 'high' | 'read' | 'observe';

export interface BodyInput {
  /** 水平速度（m/s） */
  speed: number;
  /** 轉身角速度（rad/s，正值＝往左轉） */
  turnRate: number;
  crouch: boolean;
  act: PlayerActivity | null;
  actPose: ActPose;
  /** 受傷累計次數（增加時播放一次受傷反應） */
  hurt: number;
}

const ONCE = new Set(['StartMoving', 'StopMoving', 'Crouch', 'Hurt', 'Death']);
/** 動畫的「原始速度」（m/s）：用來把播放速度對到實際移動速度，減少腳底滑動 */
const WALK_REF = 1.35;
const RUN_REF = 3.0;
const CROUCH_REF = 0.9;
const RUN_FROM = 3.3;

const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();

export class CharacterAnimator {
  readonly mixer: AnimationMixer;
  private readonly actions = new Map<string, AnimationAction>();
  private current: string | null = null;
  private time = 0;
  /** 一次性動畫（開始移動、停下、蹲下、受傷）播放到什麼時候 */
  private onceUntil = 0;
  private onceName: string | null = null;
  private lastHurt: number | null = null;
  private moving = false;
  private crouched = false;
  private lag = 0;
  private forced: string | null = null;
  private readonly chest: Object3D | undefined;
  private readonly head: Object3D | undefined;

  constructor(root: Object3D, clips: Map<string, AnimationClip>) {
    this.mixer = new AnimationMixer(root);
    for (const [name, clip] of clips) {
      const a = this.mixer.clipAction(clip);
      if (ONCE.has(name)) {
        a.setLoop(LoopOnce, 1);
        a.clampWhenFinished = true;
      } else {
        a.setLoop(LoopRepeat, Infinity);
      }
      this.actions.set(name, a);
    }
    this.chest = root.getObjectByName('chest');
    this.head = root.getObjectByName('head');
    this.fadeTo('Idle', 0);
    // 每個實例的待機從不同的時間點開始，三個人不會同步呼吸
    const idle = this.actions.get('Idle');
    if (idle) idle.time = Math.random() * idle.getClip().duration;
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  get state(): string | null {
    return this.current;
  }

  private fadeTo(name: string, fade: number, timeScale = 1): void {
    const target = this.actions.has(name) ? name : this.actions.has('Idle') ? 'Idle' : null;
    if (!target) return;
    const next = this.actions.get(target)!;
    next.setEffectiveTimeScale(timeScale);
    if (this.current === target) return;
    next.reset();
    next.setEffectiveWeight(1);
    next.play();
    const prev = this.current ? this.actions.get(this.current) : undefined;
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev) prev.stop();
    this.current = target;
  }

  private playOnce(name: string, fade: number): void {
    const a = this.actions.get(name);
    if (!a) return;
    if (this.current === name) {
      // 同一個一次性動畫再觸發（例如連續受傷）：從頭播放
      a.reset();
      a.play();
    } else {
      this.fadeTo(name, fade);
    }
    this.onceName = name;
    this.onceUntil = this.time + a.getClip().duration / Math.max(0.01, a.getEffectiveTimeScale());
  }

  /** 預覽頁：固定播放某個動畫（null＝回到狀態機） */
  force(name: string | null, fade = 0.2): void {
    this.forced = name;
    if (!name) return;
    if (ONCE.has(name)) this.playOnce(name, fade);
    else this.fadeTo(name, fade);
  }

  /** 預覽／截圖：把目前的動畫停在某個比例（0–1） */
  pose(name: string, t: number): void {
    this.forced = name;
    for (const a of this.actions.values()) a.stop();
    const a = this.actions.get(name);
    if (!a) return;
    a.reset();
    a.setEffectiveWeight(1);
    a.play();
    a.paused = true;
    a.time = MathUtils.clamp(t, 0, 0.999) * a.getClip().duration;
    this.current = name;
    this.mixer.update(0);
  }

  private desired(i: BodyInput): { name: string; scale: number } {
    if (this.crouched) {
      return this.moving ? { name: 'CrouchWalk', scale: MathUtils.clamp(i.speed / CROUCH_REF, 0.6, 1.8) } : { name: 'CrouchIdle', scale: 1 };
    }
    if (this.moving) {
      return i.speed >= RUN_FROM
        ? { name: 'Run', scale: MathUtils.clamp(i.speed / RUN_REF, 0.8, 1.7) }
        : { name: 'Walk', scale: MathUtils.clamp(i.speed / WALK_REF, 0.7, 1.75) };
    }
    if (i.act) {
      const name = i.actPose === 'high' ? 'InteractHigh' : i.actPose === 'read' ? 'Inspect' : i.actPose === 'observe' ? 'Observe' : 'Interact';
      return { name: this.actions.has(name) ? name : 'Interact', scale: 1 };
    }
    if (Math.abs(i.turnRate) > 1.1) return { name: 'Turn', scale: MathUtils.clamp(Math.abs(i.turnRate) / 2.5, 0.7, 1.6) };
    return { name: 'Idle', scale: 1 };
  }

  update(dt: number, i: BodyInput): void {
    this.time += dt;
    if (this.forced) {
      this.mixer.update(dt);
      return;
    }
    // 移動判定有遲滯，避免網路抖動造成走／停來回切換
    const wasMoving = this.moving;
    this.moving = this.moving ? i.speed > 0.2 : i.speed > 0.4;
    const wasCrouched = this.crouched;
    this.crouched = i.crouch;

    const hurtNow = this.lastHurt !== null && i.hurt > this.lastHurt;
    this.lastHurt = i.hurt;

    const once = this.time < this.onceUntil ? this.onceName : null;
    const want = this.desired(i);

    if (hurtNow) {
      this.playOnce('Hurt', 0.05);
    } else if (this.crouched && !wasCrouched) {
      this.playOnce('Crouch', 0.15);
    } else if (!this.crouched && this.moving && !wasMoving && (this.current === 'Idle' || this.current === 'Turn' || this.current === 'StopMoving')) {
      this.playOnce('StartMoving', 0.12);
    } else if (!this.crouched && !this.moving && wasMoving && (this.current === 'Walk' || this.current === 'Run')) {
      this.playOnce('StopMoving', 0.18);
    } else if (once) {
      // 一次性動畫播放中：只有狀態已經不成立時才提早結束（受傷一定播完）
      const invalid =
        (once === 'StartMoving' && !this.moving) ||
        (once === 'StopMoving' && this.moving) ||
        (once === 'Crouch' && !this.crouched);
      if (invalid) {
        this.onceUntil = 0;
        this.fadeTo(want.name, 0.2, want.scale);
      }
    } else {
      const fade = wasCrouched !== this.crouched ? 0.4 : want.name === 'Run' || this.current === 'Run' ? 0.2 : 0.3;
      this.fadeTo(want.name, fade, want.scale);
    }

    this.mixer.update(dt);

    // 轉身時上半身與頭部稍微延遲跟隨（疊加在動畫上，不寫回動畫資料）
    const target = MathUtils.clamp(-i.turnRate * 0.09, -0.32, 0.32);
    this.lag = MathUtils.damp(this.lag, target, 7, dt);
    if (Math.abs(this.lag) > 0.002) {
      this.chest?.quaternion.premultiply(tmpQ.setFromAxisAngle(UP, this.lag * 0.45));
      this.head?.quaternion.premultiply(tmpQ.setFromAxisAngle(UP, this.lag * 0.7));
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}
