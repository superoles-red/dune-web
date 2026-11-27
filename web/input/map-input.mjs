/* One DOM input stream owns map gestures.
 *
 * Ported from the old MIT web build (`Dune Sega Web/web/map-input.mjs`): the
 * canvas receives a single PointerEvent stream (capture phase, passive:false),
 * compatibility MouseEvents are only a fallback when Pointer Events do not
 * exist, and every synthesised click/dblclick/touch/context event is stopped so
 * the game never sees a second commit path.  A right mouse button is a command:
 * it is committed on the real pointer release, never through `contextmenu`.
 *
 * Positions are supplied by the owner (`position(event)`), so this module is
 * unit-system agnostic; `index.mjs` passes the CSS -> 320x224 converter.
 */

/** Mouse right-click drag slop in the owner's position unit (old: 8 CSS px). */
export const MOUSE_COMMAND_DRAG_SLOP = 8;

const noop = () => {};

function defaultPosition(canvas) {
  return (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
}

/**
 * Bind the pointer stream.
 * @param {object} canvas canvas-like element (`addEventListener`, optional
 *   `setPointerCapture` / `releasePointerCapture`).
 * @param {object} handlers
 * @param {Function} [handlers.begin] `(id, point, kind) => boolean` (false stops tracking)
 * @param {Function} [handlers.move] `(id, point) => void`
 * @param {Function} [handlers.end] `(id, point) => void`
 * @param {Function} [handlers.cancel] `() => void`
 * @param {Function} [handlers.command] `(point, kind) => void` right click
 * @param {Function} [handlers.hover] `(point, kind) => void`
 * @param {Function} [handlers.position] `(event) => {x,y}|null`
 * @param {object} [options]
 * @param {boolean} [options.pointerEvents] force the PointerEvent branch
 * @returns {{reset:Function, destroy:Function, readonly activeCount:number, readonly pointerEvents:boolean}}
 */
export function bindMapInput(canvas, handlers = {}, options = {}) {
  if (!canvas || typeof canvas.addEventListener !== 'function') {
    throw new TypeError('bindMapInput requires a canvas-like element');
  }
  const begin = handlers.begin ?? (() => true);
  const move = handlers.move ?? noop;
  const end = handlers.end ?? noop;
  const cancel = handlers.cancel ?? noop;
  const command = handlers.command ?? noop;
  const hover = handlers.hover ?? noop;
  const position = handlers.position ?? defaultPosition(canvas);
  const pointerEvents = options.pointerEvents ?? typeof globalThis.PointerEvent === 'function';

  const active = new Map();
  const bindings = [];
  const stop = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const listen = (target, name, handler, extra = {}) => {
    const optionsUsed = { capture: true, passive: false, ...extra };
    target.addEventListener(name, handler, optionsUsed);
    bindings.push({ target, name, handler, optionsUsed });
  };
  const release = (id) => {
    try {
      canvas.releasePointerCapture?.(id);
    } catch {
      /* capture may already be gone */
    }
  };
  const reset = () => {
    const ids = [...active.keys()];
    active.clear();
    if (pointerEvents) for (const id of ids) release(id);
  };
  const abort = () => {
    if (!active.size) return;
    reset();
    cancel();
  };
  const markDrag = (record, point) => {
    if (Math.hypot(point.x - record.origin.x, point.y - record.origin.y) > MOUSE_COMMAND_DRAG_SLOP) {
      record.dragged = true;
    }
  };
  const record = (kind, button, point) => ({ kind, button, origin: point, dragged: false });

  if (pointerEvents) {
    listen(canvas, 'pointerdown', (event) => {
      stop(event);
      const kind = event.pointerType || 'mouse';
      if ((kind === 'mouse' && event.button !== 0 && event.button !== 2) || active.has(event.pointerId)) return;
      const point = position(event);
      if (!point) return;
      active.set(event.pointerId, record(kind, event.button, point));
      if (!(kind === 'mouse' && event.button === 2) && begin(event.pointerId, point, kind) === false) {
        active.delete(event.pointerId);
        return;
      }
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        /* capture is best-effort */
      }
    });

    listen(canvas, 'pointermove', (event) => {
      stop(event);
      // An assistive/AX click can have no held mouse buttons yet receive an
      // unrelated OS hover between down/up. That hover is not a drag. The
      // release still supplies its final position to the gesture recognizer.
      const held = active.get(event.pointerId);
      if (held?.kind === 'mouse' && event.buttons === 0) return;
      const point = position(event);
      if (!point) return;
      if (held?.kind === 'mouse' && held.button === 2) markDrag(held, point);
      else if (held) move(event.pointerId, point);
      else if (event.pointerType === 'mouse' || event.pointerType === 'pen') hover(point, event.pointerType);
    });

    listen(canvas, 'pointerup', (event) => {
      stop(event);
      const held = active.get(event.pointerId);
      if (!held || (held.kind === 'mouse' && event.button !== held.button)) return;
      // Clear ownership before committing/releasing. WebKit may dispatch lost
      // capture before a compatibility mouseup; neither can cancel this tap.
      const point = position(event);
      if (!point) return;
      active.delete(event.pointerId);
      if (held.kind === 'mouse' && held.button === 2) {
        markDrag(held, point);
        if (held.dragged) cancel();
        else command(point, held.kind);
      } else {
        end(event.pointerId, point);
      }
      release(event.pointerId);
    });

    listen(canvas, 'pointercancel', (event) => {
      stop(event);
      if (active.has(event.pointerId)) abort();
    });
    listen(canvas, 'lostpointercapture', (event) => {
      if (active.has(event.pointerId)) abort();
    });
    for (const name of ['mousedown', 'mousemove', 'mouseup']) listen(canvas, name, stop);
  } else {
    listen(canvas, 'mousedown', (event) => {
      stop(event);
      if ((event.button !== 0 && event.button !== 2) || active.has('mouse')) return;
      const point = position(event);
      if (!point) return;
      active.set('mouse', record('mouse', event.button, point));
      if (event.button === 0 && begin('mouse', point, 'mouse') === false) active.delete('mouse');
    });
    listen(canvas, 'mousemove', (event) => {
      stop(event);
      const held = active.get('mouse');
      if (held && event.buttons === 0) return;
      const point = position(event);
      if (!point) return;
      if (held?.button === 2) markDrag(held, point);
      else if (held) move('mouse', point);
      else hover(point, 'mouse');
    });
    listen(canvas, 'mouseup', (event) => {
      stop(event);
      const held = active.get('mouse');
      if (!held || event.button !== held.button) return;
      const point = position(event);
      if (!point) return;
      active.delete('mouse');
      if (held.button === 2) {
        markDrag(held, point);
        if (held.dragged) cancel();
        else command(point, 'mouse');
      } else {
        end('mouse', point);
      }
    });
  }

  for (const name of [
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
  ]) {
    listen(canvas, name, stop);
  }

  const destroy = () => {
    active.clear();
    for (const { target, name, handler, optionsUsed } of bindings) {
      target.removeEventListener(name, handler, optionsUsed);
    }
    bindings.length = 0;
  };

  return {
    reset,
    destroy,
    get activeCount() {
      return active.size;
    },
    pointerEvents,
  };
}
