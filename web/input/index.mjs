/* Touch / pointer input layer for the BYOP web host (path A).
 *
 * This is the shell.js glue of the old MIT web build, re-pointed at `DuneHost`
 * instead of emscripten's `Module._dune_web_*` exports.  Everything native is
 * reached through `host.call(name, ...)`, so no emscripten JS glue, no `Module`
 * and no `_`-prefixed symbols are involved.
 *
 * Coordinates: every adapter in the new runtime speaks virtual-window pixels
 * (320x224, `docs/WASM-TOUCH.md`).  The canvas is often stretched by CSS on a
 * phone, so this layer converts DOM/CSS positions exactly once:
 *
 *   x = (clientX - rect.left) * 320 / rect.width
 *   y = (clientY - rect.top)  * 224 / rect.height
 *
 * `fit: 'contain'` is available for a letterboxed canvas (the 320:224 content
 * is centred inside a larger CSS box); the default is the documented stretch.
 *
 * Order of native calls for one gesture (mirrors the old shell.js):
 *
 *   pointerdown (touch/pen/mouse):
 *     isInputCaptured? -> ignore
 *     stopPanMotion()                       // a new touch kills inertia
 *     touch/pen -> panInertia.begin(kind, now)
 *     first point -> host.beginPan(x, y)    // dune_web_begin
 *     gestures.down(...)
 *       canPanAt = dune_web_gesture_query(x,y) === 1
 *       minimap_begin(x,y) === 1 ? 'minimap' : 'pending'
 *       second finger: placementCancel(); both on map ? 'pinch' : 'blocked'
 *
 *   pointermove:
 *     pending + >threshold -> placement_begin(x,y) ? 'place'
 *                             : 'pan' (panCamera(dx,dy) + inertia sample)
 *     minimap -> minimap_move(x,y)
 *     place   -> placement_move(x,y) (+ edge scroll each rAF)
 *     pinch   -> panCamera(midDx,midDy) + zoomCamera(ratio,midX,midY)
 *     hover   -> hover_screen(x,y) throttled (mouse/pen only)
 *
 *   pointerup:
 *     pending -> drawExpandedFrame(); target_screen(); select_screen()/command
 *     pan     -> panInertia.release() ? coast from rAF : endPan()
 *     place   -> placement_end(x,y)
 *     minimap -> endPan() (dune_web_end)
 *
 *   rAF: orders.flush() (deferred selection), inertia step, placement edge
 *        scroll, throttled camera/actions poll + placement target sync.
 */

import { PanInertia } from './pan-inertia.mjs';
import { MapGestures, placementEdgeVelocity } from './gestures.mjs';
import { OrderInput } from './order-input.mjs';
import { PlacementMode, placementWorldToScreen } from './placement-mode.mjs';
import { contextAction } from './context-action.mjs';
import { bindMapInput } from './map-input.mjs';

/** Native frame / virtual SDL window size used by every host adapter. */
export const VIRTUAL_WIDTH = 320;
export const VIRTUAL_HEIGHT = 224;
/** Native hover throttling from the old shell (ms). */
export const HOVER_THROTTLE_MS = 40;
/** Old shell polled camera/actions/scene at 20 Hz; keep that cadence. */
export const STATE_POLL_MS = 50;
/** Shipped drag threshold in CSS pixels (pointer recognition, old build). */
export const DRAG_THRESHOLD_CSS_PX = 8;
/** Placement edge scroll zone/speed (old build: 42 px / 155 px/s). */
export const PLACEMENT_EDGE_ZONE = 42;
export const PLACEMENT_EDGE_SPEED = 155;

/**
 * Convert a DOM/CSS pointer position to virtual-window pixels.
 * @param {{clientX:number, clientY:number}} event
 * @param {object|DOMRect} canvas canvas element (or a rect directly)
 * @param {object} [options]
 * @param {number} [options.width] virtual width (default 320)
 * @param {number} [options.height] virtual height (default 224)
 * @param {'stretch'|'contain'} [options.fit] default 'stretch'
 * @returns {{x:number, y:number}|null}
 */
export function toWindowPoint(event, canvas, options = {}) {
  const width = options.width ?? VIRTUAL_WIDTH;
  const height = options.height ?? VIRTUAL_HEIGHT;
  const rect = canvas && typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : canvas;
  if (!event || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  if ((options.fit ?? 'stretch') === 'contain') {
    const scale = Math.min(rect.width / width, rect.height / height);
    if (!(scale > 0)) return null;
    const offsetX = (rect.width - width * scale) / 2;
    const offsetY = (rect.height - height * scale) / 2;
    return { x: (localX - offsetX) / scale, y: (localY - offsetY) / scale };
  }
  return { x: (localX * width) / rect.width, y: (localY * height) / rect.height };
}

/**
 * CSS pixels -> virtual-window pixels for the current canvas size.
 * Used to turn the shipped 8 CSS px drag threshold into window units.
 * @param {object} canvas
 * @param {number} cssPx
 * @param {object} [options] same `width/height/fit` as `toWindowPoint`
 */
export function cssPixelsToWindow(canvas, cssPx, options = {}) {
  const width = options.width ?? VIRTUAL_WIDTH;
  const height = options.height ?? VIRTUAL_HEIGHT;
  const rect = canvas && typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : canvas;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return cssPx;
  const scale = (options.fit ?? 'stretch') === 'contain'
    ? Math.min(rect.width / width, rect.height / height)
    : rect.width / width;
  return scale > 0 ? cssPx / scale : cssPx;
}

/**
 * Create the input layer.
 *
 * @param {object} options
 * @param {object} options.host `DuneHost`-compatible object (`call`, `memory`,
 *   `beginPan`/`panCamera`/`endPan`/`zoomCamera`/`hoverScreen`/
 *   `drawExpandedFrame`/`refreshPresentation`/`cameraDebug`/`selectionDebug`).
 * @param {object} options.canvas canvas-like element.
 * @param {(snapshot:object)=>void} [options.onStatus] called on gesture changes
 *   and on the 20 Hz state poll (render HUD/overlays from this).
 * @param {(order:object)=>void} [options.onOrder] select/command/placement/
 *   context notifications.
 * @param {()=>boolean} [options.isInputCaptured] true while an HTML screen owns
 *   input (pause/saves/setup); all gestures are ignored and pending ones cancel.
 * @param {()=>number} [options.now] clock (tests inject a fake).
 * @param {(cb:(time:number)=>void)=>any} [options.requestFrame] rAF (tests).
 * @param {(handle:any)=>void} [options.cancelFrame] rAF cancel (tests).
 * @param {number} [options.thresholdCssPx=8]
 * @param {number} [options.pollMs=50]
 * @param {number} [options.hoverThrottleMs=40]
 * @param {'stretch'|'contain'} [options.fit='stretch']
 * @param {{width:number,height:number}} [options.virtualWindow]
 * @param {boolean} [options.placementEdgeScroll=true]
 * @param {boolean} [options.drawExpandedOnTap=true]
 * @param {boolean} [options.wheelZoom=true]
 * @param {boolean} [options.pointerEvents] force the PointerEvent stream
 *   (default: feature-detect `globalThis.PointerEvent`, mouse fallback).
 * @param {PanInertia|object} [options.inertia] instance or PanInertia options.
 */
export function createInputLayer(options = {}) {
  const host = options.host ?? null;
  const canvas = options.canvas ?? null;
  if (!canvas || typeof canvas.addEventListener !== 'function') {
    throw new TypeError('createInputLayer requires a canvas-like element');
  }
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const onOrder = typeof options.onOrder === 'function' ? options.onOrder : () => {};
  const isInputCaptured = typeof options.isInputCaptured === 'function' ? options.isInputCaptured : () => false;
  const now = typeof options.now === 'function'
    ? options.now
    : () => (globalThis.performance?.now?.() ?? Date.now());
  const requestFrame = typeof options.requestFrame === 'function'
    ? options.requestFrame
    : (callback) => (typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame(callback)
      : setTimeout(() => callback(now()), 16));
  const cancelFrame = typeof options.cancelFrame === 'function'
    ? options.cancelFrame
    : (handle) => {
      if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle);
      else clearTimeout(handle);
    };
  const virtualWindow = {
    width: Number.isFinite(options.virtualWindow?.width) ? options.virtualWindow.width : VIRTUAL_WIDTH,
    height: Number.isFinite(options.virtualWindow?.height) ? options.virtualWindow.height : VIRTUAL_HEIGHT,
  };
  const fit = options.fit === 'contain' ? 'contain' : 'stretch';
  const thresholdCssPx = Number.isFinite(options.thresholdCssPx) ? options.thresholdCssPx : DRAG_THRESHOLD_CSS_PX;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(0, options.pollMs) : STATE_POLL_MS;
  const hoverThrottleMs = Number.isFinite(options.hoverThrottleMs) ? options.hoverThrottleMs : HOVER_THROTTLE_MS;
  const placementEdgeScroll = options.placementEdgeScroll !== false;
  const drawExpandedOnTap = options.drawExpandedOnTap !== false;
  const wheelZoom = options.wheelZoom !== false;
  const panInertia = options.inertia && typeof options.inertia.step === 'function'
    ? options.inertia
    : new PanInertia(options.inertia || {});

  // Keep one mutable object: the window can change with orientation, and every
  // event maps through the current size (no layer rebuild needed).
  const windowOptions = virtualWindow;
  windowOptions.fit = fit;
  const positionMapper = (event) => toWindowPoint(event, canvas, windowOptions);

  let destroyed = false;
  let rafHandle = 0;
  let lastPollAt = Number.NEGATIVE_INFINITY;
  let lastHoverAt = Number.NEGATIVE_INFINITY;
  let edgeLastTime = 0;
  let refreshPending = false;
  let mapInput = null;
  let globalPointerDownTarget = null;
  let latestCamera = {};
  let latestActions = {};
  let lastPointerPoint = null;
  let lastPointerKind = 'mouse';
  let lastGesture = 'idle';
  let lastTap = null;
  let lastOrder = null;
  let pendingReadyYard = null;
  let targetRunId = '';
  let targetOutcomeSeq = 0;
  let panMayCoast = false;
  let inertialCameraHeld = false;
  let dragPlacement = false;
  const counters = {
    taps: 0,
    selectRequests: 0,
    commandRequests: 0,
    panEvents: 0,
    zooms: 0,
    placementDrags: 0,
    edgePans: 0,
    bRequests: 0,
  };

  /* ------------------------------------------------------------ host glue -- */

  const safeCall = (name, ...args) => {
    if (!host || typeof host.call !== 'function') return 0;
    try {
      const value = host.call(name, ...args);
      return value === undefined || value === null ? 0 : value;
    } catch {
      return 0;
    }
  };
  const decodePointerText = (pointer) => {
    if (typeof pointer === 'string') return pointer;
    if (!pointer) return '';
    if (typeof host?.readCString === 'function') {
      try {
        const text = host.readCString(pointer);
        if (typeof text === 'string') return text;
      } catch {
        /* fall through to memory */
      }
    }
    const memory = host?.memory;
    const buffer = memory && (memory.buffer ?? memory);
    if (!buffer) return '';
    try {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const start = Number(pointer) >>> 0;
      if (start >= bytes.length) return '';
      let end = start;
      const limit = Math.min(bytes.length, start + 65536);
      while (end < limit && bytes[end] !== 0) end += 1;
      if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes.subarray(start, end));
      let text = '';
      for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i]);
      return text;
    } catch {
      return '';
    }
  };
  const callJson = (name, ...args) => {
    const raw = safeCall(name, ...args);
    if (raw && typeof raw === 'object') return raw;
    const text = decodePointerText(raw);
    if (!text) return {};
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };
  const readActions = () => {
    if (typeof host?.selectionDebug === 'function') {
      try {
        const value = host.selectionDebug();
        if (value && typeof value === 'object' && Object.keys(value).length) return value;
      } catch {
        /* fall through to call() */
      }
    }
    return callJson('dune_web_actions_debug');
  };
  const readCamera = () => {
    if (typeof host?.cameraDebug === 'function') {
      try {
        const value = host.cameraDebug();
        if (value && typeof value === 'object' && Object.keys(value).length) return value;
      } catch {
        /* fall through to call() */
      }
    }
    return callJson('dune_web_camera_debug');
  };
  const beginHostPan = (x, y) => (typeof host?.beginPan === 'function'
    ? host.beginPan(x, y)
    : safeCall('dune_web_begin', x, y));
  const panHost = (dx, dy) => (typeof host?.panCamera === 'function'
    ? host.panCamera(dx, dy)
    : safeCall('dune_web_pan', dx, dy));
  const endHostPan = () => {
    if (typeof host?.endPan === 'function') {
      try {
        host.endPan();
      } catch {
        /* teardown order */
      }
      return;
    }
    safeCall('dune_web_end');
  };
  const zoomHost = (factor, x, y) => (typeof host?.zoomCamera === 'function'
    ? host.zoomCamera(factor, x, y)
    : safeCall('dune_web_zoom', factor, x, y));
  const hoverHost = (x, y) => (typeof host?.hoverScreen === 'function'
    ? host.hoverScreen(x, y)
    : safeCall('dune_web_hover_screen', x, y));
  const drawExpanded = () => {
    if (typeof host?.drawExpandedFrame !== 'function') return null;
    try {
      return host.drawExpandedFrame();
    } catch {
      return null;
    }
  };
  const requestRefresh = () => {
    refreshPending = true;
  };
  const flushRefresh = () => {
    if (!refreshPending) return;
    refreshPending = false;
    if (typeof host?.refreshPresentation !== 'function') return;
    try {
      host.refreshPresentation();
    } catch {
      /* presentation is optional */
    }
  };
  const captured = () => destroyed || !!isInputCaptured();
  const emitStatus = () => {
    try {
      onStatus(snapshot());
    } catch {
      /* a UI callback must not break input */
    }
  };
  const notifyOrder = (order) => {
    lastOrder = { ...order, at: now() };
    try {
      onOrder(lastOrder);
    } catch {
      /* a UI callback must not break input */
    }
  };

  /* --------------------------------------------------------- native state -- */

  const gestureQuery = (x, y) => safeCall('dune_web_gesture_query', x, y);
  const screenWorld = (x, y) => {
    if (captured()) return null;
    if (safeCall('dune_web_gesture_query', x, y) !== 1) return null;
    const wx = safeCall('dune_web_world_x');
    const wy = safeCall('dune_web_world_y');
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
    return { x: Math.floor(wx / 32) * 32 + 16, y: Math.floor(wy / 32) * 32 + 16 };
  };
  const powerIdentity = (actions = latestActions) => {
    const selected = actions.selected;
    return selected?.kind === 'building' && actions.special?.armed
      ? { pointer: selected.pointer, id: selected.id, owner: selected.owner, type: selected.type }
      : null;
  };
  const samePower = (left, right) =>
    !!left && !!right && ['pointer', 'id', 'owner', 'type'].every((key) => left[key] === right[key]);

  const readTargetState = (x, y) => {
    const hit = callJson('dune_web_target_screen', x, y);
    return {
      ...(hit.inputActor || {}),
      target: hit.target,
      context: hit.context,
      capturesInput: captured(),
    };
  };

  function selectMapObject(x, y) {
    const hit = callJson('dune_web_target_screen', x, y);
    const previous = pendingReadyYard;
    pendingReadyYard = null;
    counters.selectRequests += 1;
    const result = safeCall('dune_web_select_screen', x, y) ?? 0;
    if (result > 0 && hit.context === 1 && hit.target?.own && hit.target?.ready && Number.isFinite(hit.tile)) {
      pendingReadyYard = {
        world: { x: (hit.tile % 64) * 32 + 16, y: Math.floor(hit.tile / 64) * 32 + 16 },
        yard: hit.target.pointer,
        id: hit.target.id,
        waitPair: !!hit.inputActor?.powerArmed || (!!hit.inputActor?.own && hit.inputActor.kind === 'unit'),
      };
    }
    if (!result && previous && hit.target?.ready && hit.target.own
      && hit.target.pointer === previous.yard && hit.target.id === previous.id) {
      pendingReadyYard = previous;
    }
    if (result > 0) notifyOrder({ type: 'select', x, y, hit, result });
    return result;
  }

  const orders = new OrderInput({
    readState: readTargetState,
    captureActor: () => safeCall('dune_web_actor_capture') || 0,
    select: selectMapObject,
    command: (x, y, token) => {
      pendingReadyYard = null;
      counters.commandRequests += 1;
      const result = safeCall('dune_web_command_screen', x, y, token) ?? 0;
      notifyOrder({ type: 'command', x, y, token, result });
      return result;
    },
    now,
  });

  const targetState = () => ({
    map: !!latestCamera.map,
    blocked: captured(),
    placementActive: !!latestActions.placementActive,
    powerArmed: !!latestActions.special?.armed,
    runId: targetRunId,
    outcomeSeq: targetOutcomeSeq,
  });

  const targetMode = new PlacementMode({
    readState: targetState,
    screenToWorld: screenWorld,
    beginPlacement: (x, y, world) => safeCall('dune_web_placement_begin_world', world.x, world.y),
    movePlacement: (x, y) => safeCall('dune_web_placement_move', x, y),
    confirmPlacement: () => safeCall('dune_web_placement_confirm'),
    cancelPlacement: () => {
      safeCall('dune_web_placement_cancel');
    },
    confirmPower: (x, y, identity, world) => {
      const fresh = readActions();
      if (!samePower(identity, powerIdentity(fresh))) return 0;
      const token = safeCall('dune_web_actor_capture');
      if (!token) return 0;
      counters.commandRequests += 1;
      const result = safeCall('dune_web_command_world', world.x, world.y, token) ?? 0;
      notifyOrder({ type: 'power-command', x, y, token, world, result });
      return result;
    },
    cancelPower: () => safeCall('dune_web_clear_selection'),
    onChange: () => emitStatus(),
  });

  /* ------------------------------------------------------------ gestures -- */

  function stopPanMotion() {
    const held = inertialCameraHeld;
    panInertia.cancel();
    panMayCoast = false;
    inertialCameraHeld = false;
    if (held) endHostPan();
    return held;
  }

  function cancelGesture() {
    pendingReadyYard = null;
    dragPlacement = false;
    try {
      mapInput?.reset();
    } catch {
      /* teardown order */
    }
    gestures.cancel();
    orders.cancel();
    const ended = stopPanMotion();
    if (!ended) endHostPan();
    requestRefresh();
    emitStatus();
  }

  function beginPointer(id, point, kind) {
    if (captured()) return false;
    lastPointerPoint = { x: point.x, y: point.y };
    lastPointerKind = kind;
    stopPanMotion();
    panMayCoast = gestures.points.size === 0 && (kind === 'touch' || kind === 'pen');
    if (panMayCoast) panInertia.begin(kind, now());
    gestures.threshold = cssPixelsToWindow(canvas, thresholdCssPx, windowOptions);
    if (!gestures.points.size) beginHostPan(point.x, point.y);
    gestures.down({ id, x: point.x, y: point.y, kind });
    return true;
  }

  function endPointer(id, point) {
    gestures.up({ id, x: point.x, y: point.y });
    if (!gestures.points.size && !inertialCameraHeld) endHostPan();
  }

  function beginDragPlacement(x, y) {
    if (captured() || targetMode.active) return false;
    const result = safeCall('dune_web_placement_begin', x, y);
    if (!result) return false;
    dragPlacement = true;
    counters.placementDrags += 1;
    notifyOrder({ type: 'placement-drag-begin', x, y });
    return true;
  }

  function endDragPlacement(x, y) {
    if (!dragPlacement) return;
    dragPlacement = false;
    const result = safeCall('dune_web_placement_end', x, y) ?? 0;
    notifyOrder({ type: 'placement-drag-end', x, y, result });
    requestRefresh();
  }

  function mapTap(x, y, kind = 'mouse', button = 0) {
    if (captured()) return 0;
    counters.taps += 1;
    lastPointerKind = kind;
    lastPointerPoint = { x, y };
    endHostPan();
    // The expanded overview fills the HUD/minimap layer that `tap_screen`/
    // `gesture_query` hit-test, so build it before classifying the tap.
    if (drawExpandedOnTap) drawExpanded();
    if (targetMode.active) {
      const moved = targetMode.tap(x, y);
      if (kind === 'mouse' && button === 0 && moved) confirmTarget();
      requestRefresh();
      return moved ? 1 : 0;
    }
    let result = 0;
    let intent = 'ignored';
    if (gestureQuery(x, y) === 2) {
      pendingReadyYard = null;
      orders.cancel();
      result = button === 0 ? safeCall('dune_web_select_screen', x, y) ?? 0 : 0;
      intent = 'native-ui';
    } else {
      result = orders.tap(x, y, kind, button);
      intent = orders.snapshot().lastAction;
    }
    lastTap = { x, y, kind, button, intent, result };
    if (pendingReadyYard && !pendingReadyYard.waitPair) orders.cancel();
    requestRefresh();
    return result;
  }

  function onHover(point, kind) {
    if (captured()) return;
    lastPointerPoint = { x: point.x, y: point.y };
    lastPointerKind = kind;
    if (targetMode.active) {
      if (kind === 'mouse') targetMode.tap(point.x, point.y);
      return;
    }
    const stamp = now();
    if (stamp - lastHoverAt < hoverThrottleMs) return;
    lastHoverAt = stamp;
    if (gestureQuery(point.x, point.y) === 1) hoverHost(point.x, point.y);
  }

  const gestures = new MapGestures({
    canPanAt: (x, y) => gestureQuery(x, y) === 1,
    minimapStart: (x, y) => safeCall('dune_web_minimap_begin', x, y),
    minimapMove: (x, y) => {
      safeCall('dune_web_minimap_move', x, y);
    },
    tap: (x, y, kind) => mapTap(x, y, kind),
    pan: (dx, dy) => {
      if (captured()) return;
      if (panMayCoast && gestures.mode === 'pan') panInertia.sample(dx, dy, now());
      counters.panEvents += 1;
      panHost(dx, dy);
      requestRefresh();
    },
    panEnd: () => {
      inertialCameraHeld = panMayCoast && panInertia.release(now());
      panMayCoast = false;
    },
    zoom: (factor, x, y) => {
      if (captured()) return;
      counters.zooms += 1;
      zoomHost(factor, x, y);
      requestRefresh();
    },
    placementStart: (x, y) => beginDragPlacement(x, y),
    placementMove: (x, y) => {
      safeCall('dune_web_placement_move', x, y);
    },
    placementEnd: (x, y) => endDragPlacement(x, y),
    placementCancel: () => {
      dragPlacement = false;
      safeCall('dune_web_placement_cancel');
    },
    state: (mode) => {
      lastGesture = mode;
      if (['pan', 'pinch', 'place', 'minimap', 'blocked'].includes(mode)) {
        pendingReadyYard = null;
        orders.cancel();
      }
      if (['pinch', 'place', 'minimap', 'blocked'].includes(mode)) stopPanMotion();
      emitStatus();
    },
  });
  gestures.threshold = cssPixelsToWindow(canvas, thresholdCssPx, windowOptions);

  /* ------------------------------------------------------- target actions -- */

  function confirmTarget() {
    if (captured() || !targetMode.active) return false;
    const mode = targetMode.snapshot().mode;
    stopPanMotion();
    const confirmed = targetMode.confirm();
    if (confirmed) notifyOrder({ type: mode === 'power' ? 'power-confirm' : 'placement-confirm' });
    requestRefresh();
    emitStatus();
    return confirmed;
  }

  function cancelTarget(reason = 'reset') {
    if (!targetMode.active) return false;
    const mode = targetMode.snapshot().mode;
    cancelGesture();
    const cancelled = targetMode.cancel(reason);
    if (cancelled) notifyOrder({ type: mode === 'power' ? 'power-cancel' : 'placement-cancel' });
    requestRefresh();
    emitStatus();
    return cancelled;
  }

  function performContextAction() {
    const action = contextAction(latestActions);
    if (!action || captured()) return false;
    cancelGesture();
    counters.bRequests += 1;
    const result = safeCall('dune_web_action_b') ?? 0;
    notifyOrder({ type: 'context', action, result });
    requestRefresh();
    emitStatus();
    return !!result;
  }

  /* ---------------------------------------------------------- state poll -- */

  function poll() {
    latestCamera = readCamera();
    latestActions = readActions();
    const campaign = callJson('dune_web_campaign_json');
    targetRunId = [campaign.houseId, campaign.mission, campaign.activeRunHouse, campaign.activeRunMission]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .join(':');
    targetOutcomeSeq = Number.isFinite(campaign.outcomeSeq) ? campaign.outcomeSeq : 0;
    if (captured()) {
      orders.cancel();
      stopPanMotion();
    }
    targetMode.sync(latestCamera, targetState());
    // A shipped tap on a ready Construction Yard opens the persistent placement
    // target exactly like the old shell: world anchor from `__dune_web_target_screen`.
    if (pendingReadyYard && !targetMode.active && !captured() && latestCamera.map) {
      const pending = pendingReadyYard;
      const selected = latestActions.selected;
      if (!pending.waitPair || !orders.snapshot().pending) {
        const screen = placementWorldToScreen(pending.world, latestCamera);
        if (selected?.kind === 'building'
          && selected.pointer === pending.yard
          && selected.id === pending.id
          && latestActions.readyYard
          && screen) {
          if (targetMode.beginPlacement(screen.x, screen.y)) {
            pendingReadyYard = null;
            orders.cancel();
            if (lastPointerKind === 'mouse' && lastPointerPoint) {
              targetMode.tap(lastPointerPoint.x, lastPointerPoint.y);
            }
          }
        } else if (!latestActions.operation && !latestActions.phase
          && selected?.kind === 'building' && selected.pointer !== pending.yard) {
          pendingReadyYard = null;
        }
      }
    }
    // Armed Palace power waits for its target touch; start on the current
    // pointer position (or the view centre for keyboard/touchless entry).
    if (!targetMode.active && !targetMode.powerPending && latestActions.special?.armed
      && !captured() && latestCamera.map) {
      const identity = powerIdentity();
      const center = { x: virtualWindow.width / 2, y: virtualWindow.height / 2 };
      const point = lastPointerPoint && screenWorld(lastPointerPoint.x, lastPointerPoint.y)
        ? lastPointerPoint
        : center;
      if (identity && targetMode.beginPower(identity, point.x, point.y)) orders.cancel();
    }
    emitStatus();
  }

  /* ------------------------------------------------------- presentation -- */

  function onWheel(event) {
    if (!wheelZoom) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopPanMotion();
    const point = positionMapper(event);
    if (!point || captured()) return;
    if (gestureQuery(point.x, point.y) !== 1 || gestures.points.size) return;
    pendingReadyYard = null;
    orders.cancel();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (canvas.clientHeight || virtualWindow.height) : 1;
    const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.006 : 0.002));
    counters.zooms += 1;
    zoomHost(factor, point.x, point.y);
    requestRefresh();
    emitStatus();
  }

  function onGlobalPointerDown() {
    stopPanMotion();
  }

  /* ---------------------------------------------------------------- rAF -- */

  function tick(time) {
    if (destroyed) return;
    rafHandle = requestFrame(tick);
    const stamp = Number.isFinite(time) ? time : now();
    orders.flush(stamp);
    if (panInertia.active) {
      if (captured() || gestures.points.size) {
        stopPanMotion();
      } else {
        const delta = panInertia.step(stamp);
        if (delta) {
          orders.cancel();
          const result = panHost(delta.dx, delta.dy);
          if (result !== 1) stopPanMotion();
          requestRefresh();
        }
        if (!panInertia.active) stopPanMotion();
      }
    }
    if (placementEdgeScroll && gestures.mode === 'place') {
      const point = gestures.points.get(gestures.primary);
      if (point) {
        const dt = edgeLastTime ? Math.min(0.05, (stamp - edgeLastTime) / 1000) : 0;
        const vx = placementEdgeVelocity(point.x, virtualWindow.width, PLACEMENT_EDGE_ZONE, PLACEMENT_EDGE_SPEED);
        const vy = placementEdgeVelocity(point.y, virtualWindow.height, PLACEMENT_EDGE_ZONE, PLACEMENT_EDGE_SPEED);
        if (dt && (vx || vy)) {
          panHost(-vx * dt, -vy * dt);
          counters.edgePans += 1;
          requestRefresh();
        }
        safeCall('dune_web_placement_move', point.x, point.y);
      }
    }
    edgeLastTime = stamp;
    if (stamp - lastPollAt >= pollMs) {
      lastPollAt = stamp;
      poll();
    }
    flushRefresh();
  }

  /* ------------------------------------------------------------ snapshot -- */

  function snapshot() {
    return {
      ready: !captured(),
      inputCaptured: captured(),
      mode: gestures.mode,
      lastGesture,
      pointer: {
        kind: lastPointerKind,
        point: lastPointerPoint ? { ...lastPointerPoint } : null,
      },
      points: gestures.snapshot().points,
      inertia: panInertia.debug(),
      orders: orders.snapshot(),
      placement: targetMode.snapshot(),
      pendingReadyYard: pendingReadyYard
        ? { ...pendingReadyYard, world: { ...pendingReadyYard.world } }
        : null,
      context: contextAction(latestActions),
      lastTap: lastTap ? { ...lastTap } : null,
      lastOrder: lastOrder ? { ...lastOrder } : null,
      camera: latestCamera,
      actions: latestActions,
      counters: { ...counters },
      dragPlacement,
    };
  }

  /* ------------------------------------------------------------- wiring --- */

  mapInput = bindMapInput(canvas, {
    begin: beginPointer,
    move: (id, point) => gestures.move({ id, x: point.x, y: point.y }),
    end: endPointer,
    cancel: cancelGesture,
    hover: onHover,
    command: (point, kind) => mapTap(point.x, point.y, kind, 2),
    position: positionMapper,
  }, { pointerEvents: options.pointerEvents });
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });
  if (typeof globalThis.addEventListener === 'function') {
    globalPointerDownTarget = globalThis;
    globalThis.addEventListener('pointerdown', onGlobalPointerDown, { capture: true, passive: true });
  }
  rafHandle = requestFrame(tick);
  poll();
  emitStatus();

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (rafHandle) cancelFrame(rafHandle);
    rafHandle = 0;
    try {
      mapInput?.destroy();
    } catch {
      /* already torn down */
    }
    try {
      canvas.removeEventListener('wheel', onWheel, { capture: true });
    } catch {
      /* no wheel support */
    }
    if (globalPointerDownTarget) {
      try {
        globalPointerDownTarget.removeEventListener('pointerdown', onGlobalPointerDown, { capture: true });
      } catch {
        /* already torn down */
      }
      globalPointerDownTarget = null;
    }
    try {
      host?.endPan?.();
    } catch {
      /* host already gone */
    }
  };

  const cancel = () => {
    cancelGesture();
    if (targetMode.active) targetMode.cancel('cancel');
    requestRefresh();
    emitStatus();
  };

  /** Update the virtual window size after an orientation/resize change. */
  function setVirtualWindow(width, height) {
    if (!(width > 0) || !(height > 0)) return false;
    virtualWindow.width = Math.round(width);
    virtualWindow.height = Math.round(height);
    return true;
  }

  return {
    destroy,
    cancel,
    snapshot,
    setVirtualWindow, get currentVirtualWindow() {
      return { width: virtualWindow.width, height: virtualWindow.height };
    },
    /** Confirm the active placement/Palace target (old PLACE button). */
    confirm: () => confirmTarget(),
    /** Cancel the active placement/Palace target (old CLEAR button). */
    cancelTarget: (reason = 'reset') => cancelTarget(reason),
    /** Invoke the available original B action (old ACTION button). */
    action: () => performContextAction(),
    /** Force the camera/actions/target poll (tests and scene transitions). */
    sync: () => {
      poll();
      return snapshot();
    },
    /** Pending deferred selection flush (also runs from rAF). */
    flush: (time = now()) => orders.flush(time),
    get stream() {
      return mapInput;
    },
    get inertia() {
      return panInertia;
    },
    get gestures() {
      return gestures;
    },
    get orders() {
      return orders;
    },
    get placement() {
      return targetMode;
    },
    get destroyed() {
      return destroyed;
    },
    get mode() {
      return gestures.mode;
    },
  };
}

export { contextAction } from './context-action.mjs';
export { DOUBLE_TAP_MS, SELECTION_WAIT_MS, DOUBLE_TAP_SLOP } from './order-input.mjs';
