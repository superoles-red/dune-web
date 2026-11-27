/* Pointer recognition only. Commands, selection and placement rules belong to
 * the game: this module never talks to the runtime, it only turns a pointer
 * stream into pan / pinch / minimap / tap / placement events.
 *
 * Ported from the old MIT web build (`Dune Sega Web/web/gestures.mjs`, 57 lines
 * of recognition logic).  Coordinates here are *virtual-window* pixels
 * (320x224 by default); the owner converts DOM/CSS positions once, so the
 * recognizer is identical to the old one while the runtime only ever sees
 * native frame units.  Thresholds are supplied by the owner because one CSS
 * pixel is not one virtual-window pixel on a phone: `index.mjs` converts the
 * shipped 8 CSS px threshold into window units for the current canvas size.
 */

/** Shipped drag threshold in CSS pixels (old web build). */
export const PAN_THRESHOLD_PX = 8;

/** Minimum pinch radius before distance ratios are trusted (old web build). */
export const PINCH_MIN_DISTANCE = 8;

export class MapGestures {
  /**
   * @param {object} callbacks
   * @param {number} [threshold] drag threshold in the caller's coordinate unit
   * @param {object} [options]
   * @param {number} [options.pinchMinDistance]
   */
  constructor(callbacks = {}, threshold = PAN_THRESHOLD_PX, options = {}) {
    this.callbacks = callbacks && typeof callbacks === 'object' ? callbacks : {};
    this.threshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : PAN_THRESHOLD_PX;
    const min = options.pinchMinDistance;
    this.pinchMinDistance = Number.isFinite(min) && min >= 0 ? min : PINCH_MIN_DISTANCE;
    /** id -> {id,x,y,kind,map} for every active pointer. */
    this.points = new Map();
    this.mode = 'idle';
    this.primary = null;
    this.origin = null;
    this.last = null;
    this.pinch = null;
  }

  get active() {
    return this.points.size > 0;
  }

  snapshot() {
    return {
      mode: this.mode,
      points: [...this.points.values()].map((point) => ({ ...point })),
      primary: this.primary,
    };
  }

  change(mode) {
    this.mode = mode;
    this.callbacks.state?.(mode);
  }

  /** A pointer went down. `point = {id, x, y, kind}`. */
  down(point) {
    if (!point || this.points.has(point.id)) return;
    const p = { ...point, map: !!this.callbacks.canPanAt?.(point.x, point.y) };
    this.points.set(p.id, p);
    if (this.points.size === 1) {
      this.primary = p.id;
      this.origin = { x: p.x, y: p.y };
      this.last = { ...this.origin };
      this.change(this.callbacks.minimapStart?.(p.x, p.y) ? 'minimap' : 'pending');
      return;
    }
    // A second finger always abandons a one-finger placement drag.
    if (this.mode === 'place') this.callbacks.placementCancel?.();
    const pair = [...this.points.values()].slice(0, 2);
    if (!pair.every((q) => q.map)) {
      this.change('blocked');
      return;
    }
    this.pinch = this.geometry(pair);
    this.change('pinch');
  }

  geometry(pair) {
    return {
      x: (pair[0].x + pair[1].x) / 2,
      y: (pair[0].y + pair[1].y) / 2,
      distance: Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y),
    };
  }

  /** A pointer moved. `point = {id, x, y}`. */
  move(point) {
    const p = this.points.get(point.id);
    if (!p) return;
    Object.assign(p, { x: point.x, y: point.y });
    if (this.mode === 'pinch') {
      const pair = [...this.points.values()].slice(0, 2);
      if (pair.length < 2) return;
      const next = this.geometry(pair);
      const before = this.pinch;
      if (before) {
        const dx = next.x - before.x;
        const dy = next.y - before.y;
        if (dx || dy) this.callbacks.pan?.(dx, dy);
        if (before.distance >= this.pinchMinDistance && next.distance >= this.pinchMinDistance) {
          const ratio = next.distance / before.distance;
          if (Number.isFinite(ratio) && ratio > 0) this.callbacks.zoom?.(ratio, next.x, next.y);
        }
      }
      this.pinch = next;
      return;
    }
    if (point.id !== this.primary) return;
    if (this.mode === 'minimap') {
      this.callbacks.minimapMove?.(p.x, p.y);
      return;
    }
    if (this.mode === 'pending' && Math.hypot(p.x - this.origin.x, p.y - this.origin.y) > this.threshold) {
      if (!p.map) this.change('blocked');
      else if (this.callbacks.placementStart?.(this.origin.x, this.origin.y)) this.change('place');
      else this.change('pan');
    }
    if (this.mode === 'place') {
      this.callbacks.placementMove?.(p.x, p.y);
      this.last = { x: p.x, y: p.y };
    }
    if (this.mode === 'pan') {
      const dx = p.x - this.last.x;
      const dy = p.y - this.last.y;
      if (dx || dy) this.callbacks.pan?.(dx, dy);
      this.last = { x: p.x, y: p.y };
    }
  }

  /** A pointer went up. `point = {id, x, y, kind?}`. */
  up(point) {
    if (!this.points.has(point.id)) return;
    this.move(point);
    const mode = this.mode;
    const primary = point.id === this.primary;
    const kind = this.points.get(point.id).kind || 'mouse';
    this.points.delete(point.id);
    if (mode === 'pinch') {
      if (this.points.size >= 2) {
        this.pinch = this.geometry([...this.points.values()].slice(0, 2));
        return;
      }
      if (this.points.size === 1) {
        const p = [...this.points.values()][0];
        this.primary = p.id;
        this.origin = { x: p.x, y: p.y };
        this.last = { ...this.origin };
        this.pinch = null;
        this.change('pan');
        return;
      }
      this.finish();
      return;
    }
    if (!primary) {
      if (!this.points.size) this.finish();
      return;
    }
    if (mode === 'pending') this.callbacks.tap?.(point.x, point.y, kind);
    if (mode === 'place') this.callbacks.placementEnd?.(point.x, point.y);
    if (mode === 'pan') this.callbacks.panEnd?.(kind);
    this.finish();
  }

  finish() {
    this.points.clear();
    this.primary = null;
    this.origin = null;
    this.last = null;
    this.pinch = null;
    this.change('idle');
  }

  /** Abort the whole gesture (pointercancel, lost capture, overlay, destroy). */
  cancel() {
    if (this.mode === 'place') this.callbacks.placementCancel?.();
    this.finish();
  }
}

/** Edge-scroll velocity for placement drags. Same math as the old build.
 *  Units are the caller's screen pixels per second (virtual-window px here). */
export function placementEdgeVelocity(position, size, zone = 42, speed = 155) {
  if (!Number.isFinite(position) || !(size > 0)) return 0;
  zone = Math.min(zone, size / 4);
  if (position < zone) return -speed * Math.min(1, (zone - position) / zone);
  if (position > size - zone) return speed * Math.min(1, (position - size + zone) / zone);
  return 0;
}
