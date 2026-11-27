// Shared fakes for the input-layer unit tests: a canvas-like element, a
// DuneHost-like recorder (all native calls recorded with their arguments), a
// deterministic clock and a manually stepped requestAnimationFrame queue.
//
// No DOM, no Chrome, no ROM: the tests exercise the JS port only.

export const VIRTUAL_WIDTH = 320;
export const VIRTUAL_HEIGHT = 224;

/** Canvas-like element: listener bookkeeping + CSS box + pointer capture. */
export function createFakeCanvas({ left = 0, top = 0, width = VIRTUAL_WIDTH, height = VIRTUAL_HEIGHT } = {}) {
  const listeners = new Map();
  const canvas = {
    left,
    top,
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    captured: null,
    focused: 0,
    getBoundingClientRect() {
      return {
        left: this.left,
        top: this.top,
        width: this.width,
        height: this.height,
        right: this.left + this.width,
        bottom: this.top + this.height,
      };
    },
    addEventListener(type, handler, options) {
      const list = listeners.get(type) ?? [];
      list.push({ handler, options });
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.findIndex((entry) => entry.handler === handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      for (const { handler } of [...(listeners.get(type) ?? [])]) handler(event);
    },
    setPointerCapture(id) {
      this.captured = id;
    },
    releasePointerCapture(id) {
      if (this.captured === id) this.captured = null;
    },
    focus() {
      this.focused += 1;
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
    hasListener(type, handler) {
      return (listeners.get(type) ?? []).some((entry) => entry.handler === handler);
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
      this.clientWidth = width;
      this.clientHeight = height;
    },
  };
  return canvas;
}

/** DOM event stub with the cancellation API the layer uses. */
export function makeEvent(options = {}) {
  return {
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    buttons: 1,
    clientX: 0,
    clientY: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.propagationStopped = true;
    },
    ...options,
  };
}

/** Dispatch a pointer event whose logical position is given in window pixels. */
export function dispatchPointer(canvas, type, options = {}) {
  const { x, y, clientX, clientY, ...rest } = options;
  const rect = canvas.getBoundingClientRect();
  const event = makeEvent({
    clientX: clientX ?? rect.left + (x ?? 0) * (rect.width / VIRTUAL_WIDTH),
    clientY: clientY ?? rect.top + (y ?? 0) * (rect.height / VIRTUAL_HEIGHT),
    ...rest,
  });
  canvas.dispatch(type, event);
  return event;
}

/** Dispatch a wheel event with a logical window position. */
export function dispatchWheel(canvas, options = {}) {
  const { x, y, ...rest } = options;
  const rect = canvas.getBoundingClientRect();
  const event = makeEvent({
    clientX: rect.left + (x ?? VIRTUAL_WIDTH / 2) * (rect.width / VIRTUAL_WIDTH),
    clientY: rect.top + (y ?? VIRTUAL_HEIGHT / 2) * (rect.height / VIRTUAL_HEIGHT),
    ...rest,
  });
  canvas.dispatch('wheel', event);
  return event;
}

/** Deterministic clock for the input layer (`options.now`). */
export function createClock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    set(next) {
      value = next;
    },
    advance(ms) {
      value += ms;
      return value;
    },
  };
}

/** Manually stepped requestAnimationFrame queue. */
export function createRaf(clock) {
  let queue = [];
  const requestFrame = (callback) => {
    queue.push(callback);
    return queue.length;
  };
  const cancelFrame = () => {
    queue = [];
  };
  const step = (ms = 16) => {
    const time = clock.advance(ms);
    const run = queue;
    queue = [];
    for (const callback of run) callback(time);
    return time;
  };
  return {
    requestFrame,
    cancelFrame,
    step,
    pending: () => queue.length,
  };
}

const DEFAULT_NUMERIC = {
  dune_web_gesture_query: 1,
  dune_web_minimap_begin: 0,
  dune_web_minimap_move: 1,
  dune_web_actor_capture: 0,
  dune_web_command_screen: 1,
  dune_web_command_world: 1,
  dune_web_select_screen: 1,
  dune_web_placement_begin: 0,
  dune_web_placement_begin_world: 0,
  dune_web_placement_move: 1,
  dune_web_placement_end: 1,
  dune_web_placement_confirm: 1,
  dune_web_placement_cancel: 1,
  dune_web_action_b: 1,
  dune_web_clear_selection: 1,
  dune_web_hover_screen: 1,
  dune_web_world_x: 0,
  dune_web_world_y: 0,
};

const DEFAULT_ACTIONS = {
  selected: { kind: 'none' },
  bAvailable: 0,
  bKind: 'none',
  readyYard: 0,
  placementActive: 0,
  special: { armed: false },
};

const DEFAULT_CAMERA = {
  map: 1,
  left: 0,
  top: 0,
  scale: 1,
  scaleY: 1,
  width: VIRTUAL_WIDTH,
  height: VIRTUAL_HEIGHT,
  cssWidth: VIRTUAL_WIDTH,
  cssHeight: VIRTUAL_HEIGHT,
  worldWidth: VIRTUAL_WIDTH,
  worldHeight: VIRTUAL_HEIGHT,
  zoom: 100,
  minimap: { visible: 0 },
};

const DEFAULT_TARGET = {
  context: 1,
  worldX: 0,
  worldY: 0,
  tile: 0,
  busy: false,
  target: { kind: 'none' },
  selected: { kind: 'none' },
  inputActor: { kind: 'none', own: false, powerArmed: false },
};

/**
 * DuneHost-like recorder. Every method/native call appends `{name, args}` to
 * `calls`; JSON debug exports return plain JS objects (real DuneHost parsed
 * those already) unless `debugViaCall` is set (then `call()` returns JSON text,
 * exercising the library's own decoder).
 */
export function createFakeHost(config = {}) {
  const calls = [];
  const state = {
    camera: config.camera ? { ...DEFAULT_CAMERA, ...config.camera } : { ...DEFAULT_CAMERA },
    actions: config.actions ? { ...DEFAULT_ACTIONS, ...config.actions } : { ...DEFAULT_ACTIONS },
    campaign: config.campaign ? { ...config.campaign } : {},
    target: config.target ? { ...DEFAULT_TARGET, ...config.target } : { ...DEFAULT_TARGET },
    targetScreen: config.targetScreen ?? null,
    dragging: false,
    lastQuery: null,
  };
  const numeric = { ...DEFAULT_NUMERIC, ...(config.numeric || {}) };
  const handlers = config.handlers || {};
  const debugViaCall = !!config.debugViaCall;

  const resolveNumeric = (name, args) => {
    const custom = handlers[name];
    if (typeof custom === 'function') return custom(...args);
    if (custom !== undefined) return custom;
    const value = numeric[name];
    if (typeof value === 'function') return value(...args);
    // Screen unit == world unit in the default fake camera (left/top 0, scale 1)
    // so the recognizer's tile snapping is easy to assert. Tests can override
    // these numerically when a non-identity projection is needed.
    if (name === 'dune_web_world_x') {
      return state.lastQuery ? state.lastQuery.x : 0;
    }
    if (name === 'dune_web_world_y') {
      return state.lastQuery ? state.lastQuery.y : 0;
    }
    return value;
  };

  const host = {
    calls,
    memory: null,
    touch: {
      get dragging() {
        return state.dragging;
      },
      attached: true,
      width: VIRTUAL_WIDTH,
      height: VIRTUAL_HEIGHT,
    },
    call(name, ...args) {
      calls.push({ name, args });
      if (name === 'dune_web_gesture_query') state.lastQuery = { x: args[0], y: args[1] };
      if (name === 'dune_web_target_screen') {
        if (typeof state.targetScreen === 'function') return JSON.stringify(state.targetScreen(...args));
        return JSON.stringify(state.targetScreen ?? state.target);
      }
      if (name === 'dune_web_actions_debug') {
        return debugViaCall ? JSON.stringify(state.actions) : state.actions;
      }
      if (name === 'dune_web_camera_debug') {
        return debugViaCall ? JSON.stringify(state.camera) : state.camera;
      }
      if (name === 'dune_web_campaign_json') {
        return debugViaCall ? JSON.stringify(state.campaign) : state.campaign;
      }
      if (Object.prototype.hasOwnProperty.call(numeric, name) || handlers[name] !== undefined) {
        return resolveNumeric(name, args);
      }
      return 0;
    },
    beginPan(x, y) {
      calls.push({ name: 'beginPan', args: [x, y] });
      state.dragging = true;
      const custom = handlers.beginPan;
      if (typeof custom === 'function') return custom(x, y);
      return custom ?? 1;
    },
    panCamera(dx, dy) {
      calls.push({ name: 'panCamera', args: [dx, dy] });
      const custom = handlers.panCamera;
      if (typeof custom === 'function') return custom(dx, dy);
      return custom ?? 1;
    },
    endPan() {
      calls.push({ name: 'endPan', args: [] });
      state.dragging = false;
      return 1;
    },
    zoomCamera(factor, x, y) {
      calls.push({ name: 'zoomCamera', args: [factor, x, y] });
      const custom = handlers.zoomCamera;
      if (typeof custom === 'function') return custom(factor, x, y);
      return custom ?? 80;
    },
    hoverScreen(x, y) {
      calls.push({ name: 'hoverScreen', args: [x, y] });
      return 1;
    },
    drawExpandedFrame() {
      calls.push({ name: 'drawExpandedFrame', args: [] });
      return { width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT };
    },
    refreshPresentation() {
      calls.push({ name: 'refreshPresentation', args: [] });
      return 'expanded';
    },
    cameraDebug() {
      calls.push({ name: 'cameraDebug', args: [] });
      return state.camera;
    },
    selectionDebug() {
      calls.push({ name: 'selectionDebug', args: [] });
      return state.actions;
    },
    /** Mutate fake native state between gestures (e.g. after a selection). */
    set(partial = {}) {
      if (partial.camera) Object.assign(state.camera, partial.camera);
      if (partial.actions) Object.assign(state.actions, partial.actions);
      if (partial.campaign) Object.assign(state.campaign, partial.campaign);
      if (partial.target) Object.assign(state.target, partial.target);
      if (partial.targetScreen !== undefined) state.targetScreen = partial.targetScreen;
      if (partial.numeric) Object.assign(numeric, partial.numeric);
      if (partial.dragging !== undefined) state.dragging = partial.dragging;
    },
    get state() {
      return state;
    },
  };

  // Real DuneHost has parsed-JSON convenience methods; debugViaCall fakes an
  // older/lean host whose only access is call() (exercises the JSON decoder).
  if (debugViaCall) {
    delete host.cameraDebug;
    delete host.selectionDebug;
  }
  return host;
}

/**
 * Host with a real WebAssembly-Memory-like buffer: JSON debug exports return a
 * pointer, so the input layer must decode the C string itself.
 */
export function createPointerHost({ actions = {}, camera = {}, campaign = {} } = {}) {
  const buffer = new ArrayBuffer(64 * 1024);
  const bytes = new Uint8Array(buffer);
  const calls = [];
  let cursor = 64;
  const encoder = new TextEncoder();
  const write = (text) => {
    const encoded = encoder.encode(text);
    bytes.set(encoded, cursor);
    bytes[cursor + encoded.length] = 0;
    const pointer = cursor;
    cursor += encoded.length + 8;
    return pointer;
  };
  const lastQuery = { x: 0, y: 0 };
  const memory = { buffer };
  return {
    memory,
    calls,
    call(name, ...args) {
      calls.push({ name, args });
      if (name === 'dune_web_actions_debug') return write(JSON.stringify(actions));
      if (name === 'dune_web_camera_debug') return write(JSON.stringify(camera));
      if (name === 'dune_web_campaign_json') return write(JSON.stringify(campaign));
      if (name === 'dune_web_target_screen') {
        return write(JSON.stringify({ context: 1, target: { kind: 'none' }, inputActor: { kind: 'none' } }));
      }
      if (name === 'dune_web_gesture_query') {
        lastQuery.x = args[0];
        lastQuery.y = args[1];
        return 1;
      }
      if (name === 'dune_web_world_x') return lastQuery.x * 2;
      if (name === 'dune_web_world_y') return lastQuery.y * 2;
      if (name === 'dune_web_select_screen') return 1;
      if (name === 'dune_web_actor_capture') return 0;
      return 0;
    },
  };
}

/* ------------------------------------------------------------ assertions -- */

export function callsNamed(host, name) {
  return host.calls.filter((entry) => entry.name === name);
}

export function argsOf(host, name) {
  return callsNamed(host, name).map((entry) => entry.args);
}

export function nativeCallNames(host) {
  return host.calls.filter((entry) => entry.name.startsWith('dune_web_') || !entry.name.startsWith('set')).map((entry) => entry.name);
}

export function countNamed(host, name) {
  return callsNamed(host, name).length;
}

export function indexOfCall(host, name, from = 0) {
  for (let i = from; i < host.calls.length; i += 1) {
    if (host.calls[i].name === name) return i;
  }
  return -1;
}

/** Assert the given calls appear in this relative order (each after the previous). */
export function assertCallOrder(assert, host, names) {
  let from = 0;
  for (const name of names) {
    const index = indexOfCall(host, name, from);
    assert.ok(index >= 0, `expected call ${name} after index ${from}; got: ${host.calls.map((c) => c.name).join(', ')}`);
    from = index + 1;
  }
}

export function approx(actual, expected, epsilon = 1e-6) {
  return Math.abs(actual - expected) <= epsilon;
}

/** Create a layer with the shared fakes. */
export function createHarness({ hostConfig = {}, canvasOptions = {}, layerOptions = {} } = {}) {
  const canvas = createFakeCanvas(canvasOptions);
  const host = createFakeHost(hostConfig);
  const clock = createClock(1000);
  const raf = createRaf(clock);
  return { canvas, host, clock, raf, layerOptions };
}
