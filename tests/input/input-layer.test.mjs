// Integration unit tests for `createInputLayer` against a DuneHost-like
// recorder: every native call is captured with its arguments, so these tests
// pin the exact order/arguments of the old shell's touch logic (tap, double
// tap, right click, pan+inertia, pinch, minimap, placement, Palace, context B)
// without a ROM, a browser or a wasm runtime.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInputLayer,
  toWindowPoint,
  cssPixelsToWindow,
  DRAG_THRESHOLD_CSS_PX,
} from '../../web/input/index.mjs';
import {
  createFakeCanvas,
  createFakeHost,
  createPointerHost,
  createClock,
  createRaf,
  dispatchPointer,
  dispatchWheel,
  callsNamed,
  argsOf,
  countNamed,
  indexOfCall,
  assertCallOrder,
  approx,
} from './helpers.mjs';

function setup(config = {}) {
  const canvas = createFakeCanvas(config.canvas || {});
  const host = config.host && config.host.memory !== undefined ? config.host : createFakeHost(config.host || {});
  const clock = createClock(config.start ?? 1000);
  const raf = createRaf(clock);
  const statuses = [];
  const orders = [];
  const layer = createInputLayer({
    host,
    canvas,
    now: clock.now,
    requestFrame: raf.requestFrame,
    cancelFrame: raf.cancelFrame,
    onStatus: (snapshot) => statuses.push(snapshot),
    onOrder: (order) => orders.push(order),
    pointerEvents: true, // Node has no global PointerEvent; the browser does.
    ...(config.layer || {}),
  });
  return { canvas, host, clock, raf, layer, statuses, orders };
}

function down(canvas, options = {}) {
  return dispatchPointer(canvas, 'pointerdown', { buttons: 1, ...options });
}
function move(canvas, options = {}) {
  return dispatchPointer(canvas, 'pointermove', { buttons: 1, ...options });
}
function up(canvas, options = {}) {
  return dispatchPointer(canvas, 'pointerup', { buttons: 0, ...options });
}

const SOURCE_UNIT_TARGET = {
  target: { context: 1, target: { kind: 'unit' }, inputActor: { kind: 'unit', own: true, powerArmed: false } },
};

/* ---------------------------------------------------------------- taps --- */

test('tap: pointerdown/up selects in 320x224 units, after buildExpandedFrame, with one stream', () => {
  const { canvas, host, clock, layer, orders, statuses } = setup();
  const press = down(canvas, { x: 100, y: 60, pointerId: 1, pointerType: 'touch' });
  assert.equal(press.defaultPrevented, true);
  assert.equal(press.propagationStopped, true);
  clock.set(1010);
  const release = up(canvas, { x: 100, y: 60, pointerId: 1, pointerType: 'touch' });

  assert.deepEqual(argsOf(host, 'beginPan'), [[100, 60]], 'host.beginPan gets window coordinates');
  assert.equal(countNamed(host, 'dune_web_select_screen'), 1);
  assert.deepEqual(argsOf(host, 'dune_web_select_screen'), [[100, 60]]);
  assert.equal(countNamed(host, 'dune_web_command_screen'), 0);
  const expanded = indexOfCall(host, 'drawExpandedFrame');
  const select = indexOfCall(host, 'dune_web_select_screen');
  assert.ok(expanded >= 0, 'the expanded overview is built before the tap');
  assert.ok(expanded < select, 'expandedFrame must precede the HUD hit-test');
  assert.ok(indexOfCall(host, 'dune_web_target_screen') < select, 'target_screen classifies before select');
  assert.equal(release.defaultPrevented, true);
  assert.ok(countNamed(host, 'endPan') >= 1);
  assert.equal(layer.snapshot().counters.taps, 1);
  assert.equal(layer.snapshot().lastTap.intent, 'select');
  assert.ok(orders.some((order) => order.type === 'select'), 'onOrder reported the selection');
  assert.ok(statuses.length > 0, 'onStatus reported gesture state');
  assert.equal(host.touch.dragging, false);
});

test('tap: while isInputCaptured() nothing reaches the host', () => {
  let captured = false;
  const { canvas, host, layer } = setup({ layer: { isInputCaptured: () => captured } });
  down(canvas, { x: 100, y: 60 });
  up(canvas, { x: 100, y: 60 });
  assert.equal(countNamed(host, 'dune_web_select_screen'), 1);
  captured = true;
  const beginBefore = countNamed(host, 'beginPan');
  down(canvas, { x: 120, y: 80 });
  up(canvas, { x: 120, y: 80 });
  assert.equal(countNamed(host, 'beginPan'), beginBefore, 'no pan begins while an overlay owns input');
  assert.equal(countNamed(host, 'dune_web_select_screen'), 1);
  assert.equal(layer.snapshot().ready, false);
});

test('double tap: actor_capture token from tap one feeds command_screen on tap two', () => {
  const { canvas, host, clock } = setup({
    host: { ...SOURCE_UNIT_TARGET, numeric: { dune_web_actor_capture: 77 } },
  });
  clock.set(1000);
  down(canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  up(canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.equal(countNamed(host, 'dune_web_actor_capture'), 1);
  assert.equal(countNamed(host, 'dune_web_select_screen'), 0, 'deferred selection waits for the pair');

  clock.set(1200);
  down(canvas, { x: 105, y: 103, pointerId: 2, pointerType: 'touch' });
  up(canvas, { x: 105, y: 103, pointerId: 2, pointerType: 'touch' });
  assertCallOrder(assert, host, ['dune_web_actor_capture', 'dune_web_command_screen']);
  assert.deepEqual(argsOf(host, 'dune_web_command_screen'), [[105, 103, 77]]);
  assert.equal(countNamed(host, 'dune_web_select_screen'), 0);
});

test('deferred selection: the rAF flush commits the single tap after 100 ms', () => {
  const { canvas, host, raf } = setup({
    host: { ...SOURCE_UNIT_TARGET, numeric: { dune_web_actor_capture: 77 } },
  });
  down(canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  up(canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.equal(countNamed(host, 'dune_web_select_screen'), 0);
  raf.step(16); // t=1016
  assert.equal(countNamed(host, 'dune_web_select_screen'), 0, 'age 16 ms < 100 ms');
  raf.step(100); // t=1116
  assert.deepEqual(argsOf(host, 'dune_web_select_screen'), [[100, 100]]);
  assert.equal(countNamed(host, 'dune_web_command_screen'), 0);
});

test('right click: mouse button 2 commands with a fresh actor token, never selects', () => {
  const { canvas, host } = setup({ host: { numeric: { dune_web_actor_capture: 42 } } });
  down(canvas, { x: 200, y: 120, pointerId: 3, pointerType: 'mouse', button: 2, buttons: 2 });
  up(canvas, { x: 200, y: 120, pointerId: 3, pointerType: 'mouse', button: 2, buttons: 0 });
  assert.equal(countNamed(host, 'beginPan'), 0, 'right button does not start a pan');
  assert.deepEqual(argsOf(host, 'dune_web_actor_capture'), [[]]);
  assert.deepEqual(argsOf(host, 'dune_web_command_screen'), [[200, 120, 42]]);
  assert.equal(countNamed(host, 'dune_web_select_screen'), 0);
});

test('right click: a right-button drag cancels instead of issuing a command', () => {
  const { canvas, host } = setup({ host: { numeric: { dune_web_actor_capture: 42 } } });
  down(canvas, { x: 200, y: 120, pointerId: 3, pointerType: 'mouse', button: 2, buttons: 2 });
  move(canvas, { x: 220, y: 120, pointerId: 3, pointerType: 'mouse', button: 2, buttons: 2 });
  up(canvas, { x: 220, y: 120, pointerId: 3, pointerType: 'mouse', button: 2, buttons: 0 });
  assert.equal(countNamed(host, 'dune_web_command_screen'), 0);
  assert.ok(countNamed(host, 'endPan') >= 1);
});

test('pan: a camera drag cancels the pending double-tap pair (no stale order)', () => {
  const ctx = setup({
    host: { ...SOURCE_UNIT_TARGET, numeric: { dune_web_actor_capture: 77 } },
  });
  ctx.clock.set(1000);
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  up(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.equal(ctx.layer.snapshot().orders.pending, true);

  ctx.clock.set(1050);
  down(ctx.canvas, { x: 60, y: 60, pointerId: 2, pointerType: 'touch' });
  ctx.clock.set(1066);
  move(ctx.canvas, { x: 80, y: 60, pointerId: 2, pointerType: 'touch' });
  ctx.clock.set(1082);
  up(ctx.canvas, { x: 80, y: 60, pointerId: 2, pointerType: 'touch' });
  assert.equal(countNamed(ctx.host, 'dune_web_command_screen'), 0);

  // A tap soon after the pan must not reuse the token captured before the pan.
  ctx.clock.set(1150);
  down(ctx.canvas, { x: 100, y: 100, pointerId: 3, pointerType: 'touch' });
  up(ctx.canvas, { x: 100, y: 100, pointerId: 3, pointerType: 'touch' });
  assert.equal(countNamed(ctx.host, 'dune_web_command_screen'), 0);
});

/* -------------------------------------------------------- pan / inertia --- */

test('pan: begin/panCamera/endPan plus touch inertia stepped from rAF', () => {
  const ctx = setup();
  ctx.clock.set(1000);
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 112, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1032);
  move(ctx.canvas, { x: 124, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1048);
  move(ctx.canvas, { x: 136, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1060);
  up(ctx.canvas, { x: 140, y: 100, pointerId: 1, pointerType: 'touch' });

  assert.deepEqual(argsOf(ctx.host, 'beginPan'), [[100, 100]]);
  assert.deepEqual(argsOf(ctx.host, 'panCamera'), [[12, 0], [12, 0], [12, 0], [4, 0]]);
  assert.equal(countNamed(ctx.host, 'endPan'), 0, 'a coasting pan is not ended on release');
  assert.equal(ctx.layer.snapshot().inertia.phase, 'coast');
  assert.equal(ctx.layer.snapshot().mode, 'idle');

  ctx.raf.step(16); // t=1076, inertia step
  const panCalls = argsOf(ctx.host, 'panCamera');
  assert.equal(panCalls.length, 5);
  assert.ok(panCalls[4][0] > 0 && panCalls[4][0] < 12, 'the coast delta decays');
  assert.ok(countNamed(ctx.host, 'refreshPresentation') >= 1, 'presentation is refreshed once per frame');

  ctx.raf.step(2000); // long stall -> cancel, no camera jump
  assert.equal(ctx.layer.snapshot().inertia.phase, 'idle');
  assert.ok(countNamed(ctx.host, 'endPan') >= 1, 'the native drag is ended after the coast');
});

test('pan: mouse dragging never coasts', () => {
  const ctx = setup();
  ctx.clock.set(1000);
  down(ctx.canvas, { x: 100, y: 100, pointerId: 9, pointerType: 'mouse' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 120, y: 100, pointerId: 9, pointerType: 'mouse' });
  ctx.clock.set(1032);
  up(ctx.canvas, { x: 130, y: 100, pointerId: 9, pointerType: 'mouse' });
  assert.equal(ctx.layer.snapshot().inertia.phase, 'idle');
  assert.ok(countNamed(ctx.host, 'endPan') >= 1);
  const panCalls = countNamed(ctx.host, 'panCamera');
  ctx.raf.step(16);
  assert.equal(countNamed(ctx.host, 'panCamera'), panCalls, 'no extra coast after release');
});

/* ------------------------------------------------------------- pinch ----- */

test('pinch: midpoint pan + distance-ratio zoomCamera in virtual-window units', () => {
  const ctx = setup();
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  down(ctx.canvas, { x: 200, y: 100, pointerId: 2, pointerType: 'touch' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 240, y: 100, pointerId: 2, pointerType: 'touch' });
  assert.deepEqual(argsOf(ctx.host, 'panCamera'), [[20, 0]]);
  const zoom = argsOf(ctx.host, 'zoomCamera');
  assert.ok(zoom.length >= 1);
  assert.ok(approx(zoom[0][0], 1.4), 'distance grew 100 -> 140');
  assert.deepEqual([zoom[0][1], zoom[0][2]], [170, 100]);
  assert.equal(countNamed(ctx.host, 'dune_web_minimap_move'), 0);

  up(ctx.canvas, { x: 240, y: 100, pointerId: 2, pointerType: 'touch' });
  assert.equal(ctx.layer.snapshot().mode, 'pan');
  up(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.equal(ctx.layer.snapshot().mode, 'idle');
  assert.ok(countNamed(ctx.host, 'endPan') >= 1);
});

/* ----------------------------------------------------------- minimap ----- */

test('minimap drag uses minimap_begin/move and ends with endPan, never panCamera', () => {
  const ctx = setup({
    host: { numeric: { dune_web_gesture_query: 2, dune_web_minimap_begin: 1 } },
  });
  down(ctx.canvas, { x: 270, y: 180, pointerId: 1, pointerType: 'touch' });
  assert.deepEqual(argsOf(ctx.host, 'dune_web_minimap_begin'), [[270, 180]]);
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 260, y: 170, pointerId: 1, pointerType: 'touch' });
  up(ctx.canvas, { x: 260, y: 170, pointerId: 1, pointerType: 'touch' });
  const moved = argsOf(ctx.host, 'dune_web_minimap_move');
  assert.ok(moved.length >= 1);
  assert.deepEqual(moved.at(-1), [260, 170]);
  assert.equal(countNamed(ctx.host, 'panCamera'), 0);
  assert.ok(countNamed(ctx.host, 'endPan') >= 1);
  assert.equal(countNamed(ctx.host, 'dune_web_select_screen'), 0);
});

/* --------------------------------------------------------- placement ----- */

test('placement drag: second finger cancels it and switches to pinch', () => {
  const ctx = setup({
    host: {
      numeric: {
        dune_web_gesture_query: 1,
        dune_web_placement_begin: 1,
        dune_web_placement_end: 1,
        dune_web_placement_cancel: 1,
      },
    },
  });
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 115, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.deepEqual(argsOf(ctx.host, 'dune_web_placement_begin'), [[100, 100]]);
  assert.equal(ctx.layer.snapshot().mode, 'place');

  down(ctx.canvas, { x: 200, y: 100, pointerId: 2, pointerType: 'touch' });
  assert.equal(countNamed(ctx.host, 'dune_web_placement_cancel'), 1);
  assert.equal(ctx.layer.snapshot().mode, 'pinch');
  up(ctx.canvas, { x: 200, y: 100, pointerId: 2, pointerType: 'touch' });
  up(ctx.canvas, { x: 115, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.equal(countNamed(ctx.host, 'dune_web_placement_end'), 0, 'cancel wins over end');
  assert.equal(countNamed(ctx.host, 'dune_web_select_screen'), 0);
});

test('placement drag: begin -> move -> placement_end on release', () => {
  const ctx = setup({
    host: {
      numeric: {
        dune_web_gesture_query: 1,
        dune_web_placement_begin: 1,
        dune_web_placement_end: 1,
      },
    },
  });
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 116, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1032);
  move(ctx.canvas, { x: 130, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1040);
  up(ctx.canvas, { x: 130, y: 100, pointerId: 1, pointerType: 'touch' });

  assert.deepEqual(argsOf(ctx.host, 'dune_web_placement_begin'), [[100, 100]]);
  assert.deepEqual(argsOf(ctx.host, 'dune_web_placement_end'), [[130, 100]]);
  assert.ok(countNamed(ctx.host, 'dune_web_placement_move') >= 2);
  assert.equal(countNamed(ctx.host, 'panCamera'), 0, 'a placement drag does not pan the camera');
  assert.equal(ctx.layer.snapshot().counters.placementDrags, 1);
  assert.equal(ctx.layer.snapshot().dragPlacement, false);
  assert.equal(countNamed(ctx.host, 'dune_web_select_screen'), 0);
});

test('placement drag: a non-ready origin (placement_begin=0) falls back to a camera pan', () => {
  const ctx = setup({ host: { numeric: { dune_web_gesture_query: 1, dune_web_placement_begin: 0 } } });
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 120, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.deepEqual(argsOf(ctx.host, 'panCamera'), [[20, 0]]);
  assert.equal(countNamed(ctx.host, 'dune_web_placement_begin'), 1);
});

/* ------------------------------------------- persistent ready-yard place -- */

function readyYardHost() {
  return {
    target: {
      context: 1,
      tile: 2 * 64 + 3, // world 112,80 on the fake 1:1 camera
      target: { kind: 'building', pointer: 4120, id: 5, own: true, ready: true },
      selected: { kind: 'none' },
      inputActor: { kind: 'none' },
    },
    actions: {
      selected: { kind: 'building', pointer: 4120, id: 5, own: 1, type: 8 },
      readyYard: 1,
      placementActive: 0,
      operation: 0,
      phase: 0,
      special: { armed: false },
    },
    numeric: {
      dune_web_gesture_query: 1,
      dune_web_placement_begin_world: 1,
      dune_web_placement_move: 1,
      dune_web_placement_confirm: 1,
      dune_web_placement_cancel: 1,
    },
  };
}

test('ready-yard placement: tap selects, poll starts begin_world, tap moves, confirm/cancel', () => {
  const ctx = setup({ host: readyYardHost() });
  down(ctx.canvas, { x: 50, y: 50, pointerId: 1, pointerType: 'touch' });
  up(ctx.canvas, { x: 50, y: 50, pointerId: 1, pointerType: 'touch' });
  assert.deepEqual(ctx.layer.snapshot().pendingReadyYard?.world, { x: 112, y: 80 });

  ctx.raf.step(16); // poll: selected ready yard matches -> persistent placement
  assert.deepEqual(argsOf(ctx.host, 'dune_web_placement_begin_world'), [[112, 80]]);
  assert.equal(ctx.layer.snapshot().placement.active, true);
  assert.equal(ctx.layer.snapshot().placement.mode, 'placement');

  down(ctx.canvas, { x: 220, y: 120, pointerId: 2, pointerType: 'touch' });
  up(ctx.canvas, { x: 220, y: 120, pointerId: 2, pointerType: 'touch' });
  assert.deepEqual(argsOf(ctx.host, 'dune_web_placement_move'), [[220, 120]]);
  assert.equal(ctx.layer.snapshot().placement.canConfirm, true);

  assert.equal(ctx.layer.confirm(), true);
  assert.equal(countNamed(ctx.host, 'dune_web_placement_confirm'), 1);
  assert.equal(ctx.layer.snapshot().placement.active, false);
  assert.ok(ctx.orders.some((order) => order.type === 'placement-confirm'));

  // Repeat the tap -> poll -> begin, then cancel through the public button API.
  down(ctx.canvas, { x: 50, y: 50, pointerId: 3, pointerType: 'touch' });
  up(ctx.canvas, { x: 50, y: 50, pointerId: 3, pointerType: 'touch' });
  ctx.raf.step(60); // the 20 Hz state poll (last poll was <50 ms ago)
  assert.equal(ctx.layer.snapshot().placement.active, true);
  assert.equal(ctx.layer.cancelTarget(), true);
  assert.equal(countNamed(ctx.host, 'dune_web_placement_cancel'), 1);
  assert.equal(ctx.layer.snapshot().placement.active, false);
  assert.ok(ctx.orders.some((order) => order.type === 'placement-cancel'));
});

/* ------------------------------------------------------------- Palace ---- */

function palaceHost() {
  return {
    actions: {
      selected: { kind: 'building', pointer: 4120, id: 2, owner: 1, type: 2 },
      readyYard: 0,
      placementActive: 0,
      bAvailable: 0,
      special: { armed: true, ready: true },
    },
    numeric: {
      dune_web_gesture_query: 1,
      dune_web_actor_capture: 9,
      dune_web_command_world: 1,
      dune_web_clear_selection: 1,
    },
  };
}

test('Palace: armed special starts target mode, tap moves, confirm captures and commands world', () => {
  const ctx = setup({ host: palaceHost() });
  assert.equal(ctx.layer.snapshot().placement.mode, 'power', 'the poll arms the Palace target');
  down(ctx.canvas, { x: 220, y: 120, pointerId: 1, pointerType: 'touch' });
  up(ctx.canvas, { x: 220, y: 120, pointerId: 1, pointerType: 'touch' });
  assert.deepEqual(ctx.layer.snapshot().placement.target, { x: 208, y: 112 });

  assert.equal(ctx.layer.confirm(), true);
  assertCallOrder(assert, ctx.host, ['dune_web_actor_capture', 'dune_web_command_world']);
  assert.deepEqual(argsOf(ctx.host, 'dune_web_command_world'), [[208, 112, 9]]);
  assert.equal(ctx.layer.snapshot().placement.active, false);
  assert.equal(ctx.layer.snapshot().placement.powerPending, true);
  assert.ok(ctx.orders.some((order) => order.type === 'power-command'));

  // powerPending prevents an automatic re-arm while the native cooldown runs.
  const begins = countNamed(ctx.host, 'dune_web_actor_capture');
  ctx.raf.step(16);
  assert.equal(countNamed(ctx.host, 'dune_web_actor_capture'), begins);
  assert.equal(ctx.layer.snapshot().placement.active, false);
});

test('Palace: cancelTarget clears the target through dune_web_clear_selection', () => {
  const ctx = setup({ host: palaceHost() });
  assert.equal(ctx.layer.snapshot().placement.active, true);
  assert.equal(ctx.layer.cancelTarget(), true);
  assert.equal(countNamed(ctx.host, 'dune_web_clear_selection'), 1);
  assert.equal(ctx.layer.snapshot().placement.active, false);
  assert.equal(ctx.layer.snapshot().placement.powerPending, true);
  assert.ok(ctx.orders.some((order) => order.type === 'power-cancel'));
});

/* ------------------------------------------------------ context action --- */

test('context action: B descriptor from actions_debug, action() calls dune_web_action_b', () => {
  const ctx = setup({
    host: {
      actions: {
        selected: { kind: 'building', pointer: 1, id: 2, own: 1 },
        bAvailable: 1,
        bKind: 'repeat',
        special: { armed: false },
      },
    },
  });
  assert.deepEqual(ctx.layer.snapshot().context, {
    method: 'b',
    kind: 'repeat',
    label: 'REPEAT',
    aria: 'Повторить производство',
  });
  assert.equal(ctx.layer.action(), true);
  assert.equal(countNamed(ctx.host, 'dune_web_action_b'), 1);
  assert.ok(ctx.orders.some((order) => order.type === 'context'));
  assert.equal(ctx.layer.snapshot().counters.bRequests, 1);

  // Placement hides the context action, and action() refuses to invent one.
  ctx.host.set({ actions: { placementActive: 1 } });
  ctx.layer.sync();
  assert.equal(ctx.layer.snapshot().context, null);
  assert.equal(ctx.layer.action(), false);
  assert.equal(countNamed(ctx.host, 'dune_web_action_b'), 1);
});

/* -------------------------------------------------------- hover / wheel -- */

test('hover: mouse moves call hoverScreen, throttled to 40 ms', () => {
  const ctx = setup();
  ctx.clock.set(1000);
  move(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'mouse', buttons: 0 });
  ctx.clock.set(1010);
  move(ctx.canvas, { x: 101, y: 100, pointerId: 1, pointerType: 'mouse', buttons: 0 });
  ctx.clock.set(1050);
  move(ctx.canvas, { x: 102, y: 100, pointerId: 1, pointerType: 'mouse', buttons: 0 });
  assert.deepEqual(argsOf(ctx.host, 'hoverScreen'), [[100, 100], [102, 100]]);
});

test('wheel: zoomCamera(exp(-delta*0.002), x, y) on the map only, event stopped', () => {
  const ctx = setup();
  const event = dispatchWheel(ctx.canvas, { x: 160, y: 112, deltaY: 100 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  const zoom = argsOf(ctx.host, 'zoomCamera');
  assert.equal(zoom.length, 1);
  assert.ok(approx(zoom[0][0], Math.exp(-0.2)));
  assert.deepEqual([zoom[0][1], zoom[0][2]], [160, 112]);
  ctx.raf.step(16);
  assert.ok(countNamed(ctx.host, 'refreshPresentation') >= 1);

  const before = countNamed(ctx.host, 'zoomCamera');
  ctx.host.set({ numeric: { dune_web_gesture_query: 2 } });
  dispatchWheel(ctx.canvas, { x: 160, y: 112, deltaY: 100 });
  assert.equal(countNamed(ctx.host, 'zoomCamera'), before, 'no camera zoom over the minimap/HUD');
});

/* ------------------------------------------------------- coordinates ----- */

test('coordinates: stretch and contain (letterbox) CSS -> 320x224 conversion', () => {
  const stretched = createFakeCanvas({ left: 10, top: 20, width: 640, height: 448 });
  assert.deepEqual(
    toWindowPoint({ clientX: 10 + 320, clientY: 20 + 224 }, stretched),
    { x: 160, y: 112 },
  );

  const letterboxed = createFakeCanvas({ left: 0, top: 0, width: 800, height: 448 });
  // 320:224 content is scaled x2 (640x448) and centred: 80 px bars left/right.
  assert.deepEqual(
    toWindowPoint({ clientX: 80 + 160 * 2, clientY: 112 * 2 }, letterboxed, { fit: 'contain' }),
    { x: 160, y: 112 },
  );
  assert.deepEqual(
    toWindowPoint({ clientX: 20, clientY: 100 }, letterboxed, { fit: 'contain' }),
    { x: -30, y: 50 },
  );
  assert.equal(toWindowPoint({ clientX: 0, clientY: 0 }, createFakeCanvas({ width: 0, height: 0 })), null);
  assert.equal(DRAG_THRESHOLD_CSS_PX, 8);
  assert.equal(cssPixelsToWindow(stretched, 8), 4);
  assert.equal(cssPixelsToWindow(letterboxed, 8, { fit: 'contain' }), 4);
});

test('threshold: "8 CSS px" is converted to window units for a stretched canvas', () => {
  const ctx = setup({ canvas: { width: 640, height: 448 } });
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 103, y: 100, pointerId: 1, pointerType: 'touch' }); // 3 win px = 6 CSS px
  assert.equal(countNamed(ctx.host, 'panCamera'), 0, '6 CSS px is below the shipped threshold');
  ctx.clock.set(1032);
  move(ctx.canvas, { x: 105, y: 100, pointerId: 1, pointerType: 'touch' }); // 5 win px = 10 CSS px
  assert.deepEqual(argsOf(ctx.host, 'panCamera'), [[5, 0]]);
});

/* --------------------------------------------------- cancel / teardown --- */

test('cancel(): a public cancel ends the native drag and drops pending state', () => {
  const ctx = setup();
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.clock.set(1016);
  move(ctx.canvas, { x: 120, y: 100, pointerId: 1, pointerType: 'touch' });
  ctx.layer.cancel();
  assert.ok(countNamed(ctx.host, 'endPan') >= 1);
  assert.equal(ctx.layer.snapshot().mode, 'idle');
  assert.equal(ctx.layer.snapshot().inertia.phase, 'idle');
  assert.equal(ctx.layer.snapshot().orders.pending, false);
});

test('destroy(): listens are removed and the rAF loop is cancelled', () => {
  const ctx = setup();
  down(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  up(ctx.canvas, { x: 100, y: 100, pointerId: 1, pointerType: 'touch' });
  assert.ok(ctx.canvas.listenerCount('pointerdown') > 0);
  ctx.layer.destroy();
  assert.equal(ctx.layer.destroyed, true);
  assert.equal(ctx.canvas.listenerCount('pointerdown'), 0);
  assert.equal(ctx.canvas.listenerCount('wheel'), 0);
  const callsBefore = ctx.host.calls.length;
  down(ctx.canvas, { x: 100, y: 100 });
  up(ctx.canvas, { x: 100, y: 100 });
  ctx.raf.step(16);
  assert.equal(ctx.host.calls.length, callsBefore, 'no input or polling after destroy');
});

/* --------------------------------------- compatibility / host variants --- */

test('input stream: synthesised click/dblclick/contextmenu/touch events are stopped', () => {
  const ctx = setup();
  for (const type of ['click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend']) {
    const event = { preventDefault() {}, stopImmediatePropagation() {}, defaultPrevented: false, propagationStopped: false };
    const effective = {
      ...event,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.propagationStopped = true;
      },
    };
    ctx.canvas.dispatch(type, effective);
    assert.equal(effective.defaultPrevented, true, `${type} must be prevented`);
    assert.equal(effective.propagationStopped, true, `${type} must not reach the game`);
  }
});

test('host variants: JSON debug results are decoded from call() text or wasm memory pointers', () => {
  const viaCall = setup({
    host: {
      debugViaCall: true,
      camera: { map: 1, width: 320, height: 224, cssWidth: 320, cssHeight: 224, scale: 1, scaleY: 1, left: 0, top: 0 },
      actions: { selected: { kind: 'none' }, bAvailable: 0, special: { armed: false } },
    },
  });
  assert.equal(viaCall.layer.snapshot().camera.map, 1);
  down(viaCall.canvas, { x: 100, y: 100 });
  up(viaCall.canvas, { x: 100, y: 100 });
  assert.equal(countNamed(viaCall.host, 'dune_web_select_screen'), 1);

  const pointerHost = createPointerHost({
    camera: { map: 1, width: 320, height: 224, cssWidth: 320, cssHeight: 224, scale: 1, scaleY: 1, left: 0, top: 0, minimap: { visible: 0 } },
    actions: { selected: { kind: 'none' }, bAvailable: 0, special: { armed: false } },
  });
  const canvas = createFakeCanvas();
  const clock = createClock(1000);
  const raf = createRaf(clock);
  const layer = createInputLayer({ host: pointerHost, canvas, now: clock.now, requestFrame: raf.requestFrame, cancelFrame: raf.cancelFrame, pointerEvents: true });
  assert.equal(layer.snapshot().camera.map, 1);
  down(canvas, { x: 100, y: 60 });
  up(canvas, { x: 100, y: 60 });
  assert.deepEqual(argsOf(pointerHost, 'dune_web_select_screen'), [[100, 60]]);
  layer.destroy();
});
