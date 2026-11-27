// Unit tests for the pure placement/Palace targeting state and the camera
// projection helpers (no DOM, no host, no game data).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PlacementMode,
  placementWorldToScreen,
  placementPointVisible,
  placementScreenToWorld,
} from '../../web/input/placement-mode.mjs';

const CAMERA = {
  map: 1,
  left: 100,
  top: 50,
  scale: 2,
  scaleY: 2,
  width: 320,
  height: 224,
  cssWidth: 320,
  cssHeight: 224,
  minimap: { visible: 0 },
};

function harness({ state = {}, camera = CAMERA } = {}) {
  const native = { map: true, blocked: false, placementActive: false, powerArmed: false, ...state };
  const calls = [];
  const changes = [];
  const mode = new PlacementMode({
    readState: () => native,
    screenToWorld: placementScreenToWorld,
    worldToScreen: placementWorldToScreen,
    beginPlacement: (x, y, world) => {
      calls.push({ name: 'beginPlacement', args: [x, y, world] });
      return 1;
    },
    movePlacement: (x, y, world) => {
      calls.push({ name: 'movePlacement', args: [x, y, world] });
      return 1;
    },
    confirmPlacement: (x, y, world) => {
      calls.push({ name: 'confirmPlacement', args: [x, y, world] });
      return 1;
    },
    cancelPlacement: (world) => {
      calls.push({ name: 'cancelPlacement', args: [world] });
    },
    confirmPower: (x, y, identity, world) => {
      calls.push({ name: 'confirmPower', args: [x, y, identity, world] });
      return 1;
    },
    cancelPower: (identity, world) => {
      calls.push({ name: 'cancelPower', args: [identity, world] });
    },
    onChange: (snapshot) => changes.push(snapshot),
  });
  mode.sync(camera, native);
  return { mode, native, calls, changes, camera };
}

test('placement projection: world <-> screen and visibility vs minimap', () => {
  assert.deepEqual(placementWorldToScreen({ x: 200, y: 150 }, CAMERA), { x: 200, y: 200 });
  assert.deepEqual(placementScreenToWorld(200, 200, CAMERA), { x: 200, y: 150 });
  assert.equal(placementPointVisible({ x: 0, y: 0 }, CAMERA), true);
  assert.equal(placementPointVisible({ x: -1, y: 10 }, CAMERA), false);
  assert.equal(placementPointVisible({ x: 320, y: 10 }, CAMERA), false);
  assert.equal(placementPointVisible({ x: 10, y: 224 }, CAMERA), false);
  const withMinimap = { ...CAMERA, minimap: { visible: 1, x: 250, y: 150, width: 60, height: 60 } };
  assert.equal(placementPointVisible({ x: 260, y: 160 }, withMinimap), false, 'minimap area is not a world target');
  assert.equal(placementScreenToWorld(260, 160, withMinimap), null);
  assert.equal(placementWorldToScreen({ x: 1, y: 1 }, null), null);
  assert.equal(placementScreenToWorld(10, 10, null), null);
  assert.equal(placementWorldToScreen({ x: 1, y: 1 }, { ...CAMERA, scale: 0 }), null);
});

test('PlacementMode: begin -> tap -> confirm for a ready building', () => {
  const h = harness();
  assert.equal(h.mode.beginPlacement(200, 200), true);
  assert.equal(h.mode.active, true);
  assert.deepEqual(h.calls[0], { name: 'beginPlacement', args: [200, 200, { x: 200, y: 150 }] });
  let snapshot = h.mode.snapshot();
  assert.equal(snapshot.mode, 'placement');
  assert.deepEqual(snapshot.screen, { x: 200, y: 200 });
  assert.equal(snapshot.canConfirm, true);

  assert.equal(h.mode.tap(240, 120), true);
  assert.deepEqual(h.calls[1], { name: 'movePlacement', args: [240, 120, { x: 220, y: 110 }] });
  snapshot = h.mode.snapshot();
  assert.deepEqual(snapshot.target, { x: 220, y: 110 });
  assert.deepEqual(snapshot.screen, { x: 240, y: 120 });

  assert.equal(h.mode.confirm(), true);
  assert.deepEqual(h.calls[2], { name: 'confirmPlacement', args: [240, 120, { x: 220, y: 110 }] });
  assert.equal(h.mode.active, false);
  assert.equal(h.mode.snapshot().reason, 'confirmed');
});

test('PlacementMode: cancel reports the world target to the native cancel', () => {
  const h = harness();
  h.mode.beginPlacement(200, 200);
  h.mode.tap(240, 120);
  assert.equal(h.mode.cancel('reset'), true);
  assert.deepEqual(h.calls.at(-1), { name: 'cancelPlacement', args: [{ x: 220, y: 110 }] });
  assert.equal(h.mode.active, false);
  assert.equal(h.mode.lastReason, 'reset');
});

test('PlacementMode: begin is refused outside the map / while blocked', () => {
  const blocked = harness({ state: { blocked: true } });
  assert.equal(blocked.mode.beginPlacement(200, 200), false);
  assert.equal(blocked.calls.length, 0);
  const noMap = harness({ state: { map: false } });
  assert.equal(noMap.mode.beginPlacement(200, 200), false);
  const outside = harness();
  assert.equal(outside.mode.beginPlacement(-10, 10), false);
});

test('PlacementMode: sync clears on map loss, run change and placement end', () => {
  const lost = harness();
  lost.mode.beginPlacement(200, 200);
  lost.native.map = false;
  lost.mode.sync(CAMERA, lost.native);
  assert.equal(lost.mode.active, false);
  assert.equal(lost.mode.lastReason, 'context');

  const runChanged = harness({ state: { runId: 'atreides:1', outcomeSeq: 4 } });
  runChanged.mode.beginPlacement(200, 200);
  runChanged.native.runId = 'harkonnen:2';
  runChanged.mode.sync(CAMERA, runChanged.native);
  assert.equal(runChanged.mode.active, false);
  assert.equal(runChanged.mode.lastReason, 'runId');

  const ended = harness({ state: { placementActive: true } });
  ended.mode.beginPlacement(200, 200);
  ended.native.placementActive = false;
  ended.mode.sync(CAMERA, ended.native);
  assert.equal(ended.mode.active, false);
  assert.equal(ended.mode.lastReason, 'placement-ended');
});

test('PlacementMode: panning the camera moves only the overlay, not the world anchor', () => {
  const h = harness();
  h.mode.beginPlacement(200, 200);
  h.mode.tap(240, 120);
  const before = h.mode.snapshot();
  const moved = { ...CAMERA, left: 140 };
  h.mode.sync(moved, h.native);
  const after = h.mode.snapshot();
  assert.deepEqual(after.target, before.target, 'the chosen point belongs to the world');
  assert.equal(after.screen.x, before.screen.x - 80, '(220-140)*2 instead of (220-100)*2');
});

test('PlacementMode: Palace power begin -> target -> confirm -> powerPending', () => {
  const actor = { pointer: 101, id: 7, owner: 1, type: 2 };
  const h = harness({ state: { powerArmed: true } });
  assert.equal(h.mode.beginPower(null, 160, 112), false, 'identity is required');
  assert.equal(h.mode.beginPower(actor, 160, 112), true);
  assert.equal(h.mode.snapshot().mode, 'power');
  h.mode.tap(240, 120);
  assert.equal(h.mode.snapshot().canConfirm, true);
  assert.equal(h.mode.confirm(), true);
  assert.deepEqual(h.calls.at(-1), {
    name: 'confirmPower',
    args: [240, 120, actor, { x: 220, y: 110 }],
  });
  assert.equal(h.mode.active, false);
  assert.equal(h.mode.powerPending, true, 'an executed power is not re-armed automatically');
  assert.equal(h.mode.beginPower(actor, 160, 112), false, 'powerPending blocks a repeat');
  h.native.powerArmed = false;
  h.mode.sync(CAMERA, h.native);
  assert.equal(h.mode.powerPending, false, 'disarming clears the pending Palace');
});

test('PlacementMode: Palace cancel reports identity/target and keeps the cooldown guard', () => {
  const actor = { pointer: 101, id: 7, owner: 1, type: 2 };
  const h = harness({ state: { powerArmed: true } });
  h.mode.beginPower(actor, 160, 112);
  h.mode.tap(240, 120);
  assert.equal(h.mode.cancel('reset'), true);
  assert.deepEqual(h.calls.at(-1), {
    name: 'cancelPower',
    args: [actor, { x: 220, y: 110 }],
  });
  assert.equal(h.mode.powerPending, true);
});

test('PlacementMode: rejected confirm keeps the target active', () => {
  const h = harness();
  let reject = true;
  h.mode.callbacks.confirmPlacement = () => (reject ? 0 : 1);
  h.mode.beginPlacement(200, 200);
  assert.equal(h.mode.confirm(), false);
  assert.equal(h.mode.active, true);
  assert.equal(h.mode.snapshot().reason, 'confirm-rejected');
  reject = false;
  assert.equal(h.mode.confirm(), true);
  assert.equal(h.mode.active, false);
});
