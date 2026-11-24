/* ============================================================================
 * rangeGesture — decide whether a touch on an <input type="range"> was a
 * deliberate adjustment or an accident while scrolling.
 *
 * On Android Chrome, touching a range input's track jumps the thumb to the
 * touch point. Our sliders commit on touch end, so a scroll swipe that happens
 * to start on a slider (or a tap to stop a fling) silently set it — e.g. the
 * Ground effect slider landing at 140% from a right-thumb scroll. Only a
 * mostly-horizontal drag counts as an adjustment; anything else reverts.
 * No DOM, no React: unit-testable.
 * ========================================================================== */

export const RANGE_DRAG_MIN_PX = 8;   // horizontal travel needed to count as a drag
export const RANGE_MOUSE_AFTER_TOUCH_MS = 800; // ignore emulated mouse events after a touch

/**
 * Should a touch gesture on a range input commit its value?
 * @param {number} dx - max horizontal travel during the touch (px, ≥ 0)
 * @param {number} dy - max vertical travel during the touch (px, ≥ 0)
 */
export function rangeTouchCommits(dx, dy) {
  return dx >= RANGE_DRAG_MIN_PX && dx > dy;
}
