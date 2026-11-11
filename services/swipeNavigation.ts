import type { Mode } from './initialRouteState';

export type SwipeDirection = 'next' | 'prev';

/** 页面顺序与顶部标签一致；滑动只在这个顺序里前后移动，不首尾回环。 */
export const MODE_ORDER: readonly Mode[] = ['send', 'receive', 'screen'];

/**
 * 判定阈值参考 Ionic Gestures 的默认值（起始阈值 10px、横向夹角上限 40°），
 * 再按「移动端误触」的方向收紧了三条：
 * 1. 纵向为主的拖动一律不认（夹角 > 34° 直接判成滚动）；
 * 2. 慢速滑动必须走够屏宽的 18%（窄屏也有 56px 下限），轻拂/斜着蹭不会翻页；
 * 3. 左右边缘 24px 是死区，留给浏览器的返回手势（iOS Safari 的边缘返回不走
 *    touch-action，只能靠这个躲开）。
 */
export const SWIPE_TUNING = {
  /** 手指移动超过该值才锁定方向，之前只当作点击/长按 */
  axisLockPx: 10,
  /** |dx| 至少是 |dy| 的 1.5 倍（约 34°）才认作横向滑动 */
  horizontalDominance: 1.5,
  /** 慢速滑动的最小行程（px），与屏宽比取大值 */
  minDistancePx: 56,
  /** 慢速滑动的最小行程占屏宽比例 */
  distanceViewportRatio: 0.18,
  /** 快速甩动：位移 24px 以上、速度 0.5px/ms 以上、总时长 400ms 以内 */
  flingMinDistancePx: 24,
  flingVelocityPxPerMs: 0.5,
  flingMaxDurationMs: 400,
  /** 左右边缘死区 */
  edgeDeadZonePx: 24,
} as const;

export interface SwipeStartInput {
  pointerType: string;
  clientX: number;
  clientY: number;
  timeStamp: number;
  viewportWidth: number;
}

/**
 * 一次滑动手势的判定状态机。只做纯计算，不碰 DOM 和 React，
 * 便于在 Node 测试里覆盖「误触」的各种组合。
 */
export class SwipeTracker {
  private start: SwipeStartInput | null = null;
  private axis: 'pending' | 'horizontal' | 'aborted' = 'pending';

  /** 返回 false 表示这次按下不该被当成滑动（鼠标、边缘、异常事件）。 */
  begin(input: SwipeStartInput): boolean {
    this.reset();
    if (input.pointerType !== 'touch' && input.pointerType !== 'pen') return false;
    const edge = SWIPE_TUNING.edgeDeadZonePx;
    if (input.clientX <= edge || input.clientX >= input.viewportWidth - edge) return false;
    this.start = input;
    return true;
  }

  /** 方向锁定后不再改判：横向手势不会因为手抖变成滚动，反之亦然。 */
  move(clientX: number, clientY: number): void {
    if (!this.start || this.axis !== 'pending') return;
    const dx = clientX - this.start.clientX;
    const dy = clientY - this.start.clientY;
    if (Math.abs(dx) < SWIPE_TUNING.axisLockPx && Math.abs(dy) < SWIPE_TUNING.axisLockPx) return;
    this.axis =
      Math.abs(dx) >= Math.abs(dy) * SWIPE_TUNING.horizontalDominance ? 'horizontal' : 'aborted';
  }

  get isTracking(): boolean {
    return this.start !== null;
  }

  /** 方向已锁定为横向：此时才值得抢指针，之前的阶段不能影响点击与滚动。 */
  get isHorizontal(): boolean {
    return this.axis === 'horizontal';
  }

  /** 滑动方向只在横向成立且行程/速度达标时给出，其余一律 null。 */
  end(clientX: number, timeStamp: number): SwipeDirection | null {
    const start = this.start;
    const axis = this.axis;
    this.reset();
    if (!start || axis !== 'horizontal') return null;

    const dx = clientX - start.clientX;
    const duration = Math.max(1, timeStamp - start.timeStamp);
    const distance = Math.abs(dx);
    const velocity = distance / duration;
    const slowDistance = Math.max(
      SWIPE_TUNING.minDistancePx,
      start.viewportWidth * SWIPE_TUNING.distanceViewportRatio
    );
    const isSlowSwipe = distance >= slowDistance;
    const isFling =
      distance >= SWIPE_TUNING.flingMinDistancePx &&
      velocity >= SWIPE_TUNING.flingVelocityPxPerMs &&
      duration <= SWIPE_TUNING.flingMaxDurationMs;
    if (!isSlowSwipe && !isFling) return null;

    // 手指向左推 = 看右边的页面 = 下一个标签
    return dx < 0 ? 'next' : 'prev';
  }

  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.start = null;
    this.axis = 'pending';
  }
}

export function resolveSwipeTarget(current: Mode, direction: SwipeDirection): Mode | null {
  const index = MODE_ORDER.indexOf(current);
  if (index === -1) return null;
  const targetIndex = direction === 'next' ? index + 1 : index - 1;
  return MODE_ORDER[targetIndex] ?? null;
}
