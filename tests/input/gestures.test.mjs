// Unit tests for the ported pointer recognizer and camera inertia (no DOM,
// no host, no game data).

import test from 'node:test';
import assert from 'node:assert/strict';

import { MapGestures, PAN_THRESHOLD_PX, PINCH_MIN_DISTANCE, placementEdgeVelocity } from '../../web/input/gestures.mjs';
import { PanInertia, PAN_INERTIA_DEFAULTS } from '../../web/input/pan-inertia.mjs';
import { approx } from './helpers.mjs';

function recorder() {
  const events = [];
  return {
    events,
    on(name) {
      return (...args) => events.push({ name, args });
    },
    names() {
      return events.map((event) => event.name);
    },
    named(name) {
      return events.filter((event) => event.name === name).map((event) => event.args);
    },
  };
}

test('MapGestures: drag below the 8 px threshold stays pending, then pans', () => {
  const rec = recorder();
  const gestures = new MapGestures({
    canPanAt: () => true,
    tap: rec.on('tap'),
    pan: rec.on('pan'),
    panEnd: rec.on('panEnd'),
    state: rec.on('state'),
  }, PAN_THRESHOLD_PX);
  gestures.down({ id: 1, x: 10, y: 10, kind: 'touch' });
  assert.equal(gestures.mode, 'pending');
  gestures.move({ id: 1, x: 18, y: 10 });
  assert.equal(gestures.mode, 'pending', 'exactly 8 px is not a drag yet');
  gestures.move({ id: 1, x: 20, y: 10 });
  assert.equal(gestures.mode, 'pan');
  assert.deepEqual(rec.named('pan'), [[10, 0]], 'pan starts at the origin, not at the threshold point');
  gestures.move({ id: 1, x: 26, y: 13 });
  assert.deepEqual(rec.named('pan')[1], [6, 3]);
  gestures.up({ id: 1, x: 26, y: 13, kind: 'touch' });
  assert.equal(gestures.mode, 'idle');
  assert.equal(rec.named('tap').length, 0);
  assert.deepEqual(rec.named('panEnd'), [['touch']]);
});

test('MapGestures: release without movement is a tap with the pointer kind', () => {
  const rec = recorder();
  const gestures = new MapGestures({ canPanAt: () => true, tap: rec.on('tap') });
  gestures.down({ id: 7, x: 100, y: 50, kind: 'pen' });
  gestures.up({ id: 7, x: 101, y: 50, kind: 'pen' });
  assert.deepEqual(rec.named('tap'), [[101, 50, 'pen']]);
  assert.equal(gestures.points.size, 0);
});

test('MapGestures: a custom window-unit threshold is honoured', () => {
  const rec = recorder();
  const gestures = new MapGestures({ canPanAt: () => true, pan: rec.on('pan') }, 4);
  gestures.down({ id: 1, x: 0, y: 0, kind: 'touch' });
  gestures.move({ id: 1, x: 3, y: 0 });
  assert.equal(gestures.mode, 'pending');
  gestures.move({ id: 1, x: 5, y: 0 });
  assert.equal(gestures.mode, 'pan');
});

test('MapGestures: minimap drag uses minimap_start/move and never pans the map', () => {
  const rec = recorder();
  const gestures = new MapGestures({
    canPanAt: () => false,
    minimapStart: () => 1,
    minimapMove: rec.on('minimapMove'),
    pan: rec.on('pan'),
    tap: rec.on('tap'),
  });
  gestures.down({ id: 1, x: 270, y: 180, kind: 'touch' });
  assert.equal(gestures.mode, 'minimap');
  gestures.move({ id: 1, x: 260, y: 170 });
  gestures.move({ id: 1, x: 250, y: 160 });
  gestures.up({ id: 1, x: 250, y: 160, kind: 'touch' });
  // The release is also the final move sample, so the last call repeats the point.
  assert.deepEqual(rec.named('minimapMove').slice(0, 2), [[260, 170], [250, 160]]);
  assert.deepEqual(rec.named('minimapMove').at(-1), [250, 160]);
  assert.equal(rec.named('pan').length, 0);
  assert.equal(rec.named('tap').length, 0);
});

test('MapGestures: placement drag calls start/move/end and a second finger cancels it', () => {
  const rec = recorder();
  const gestures = new MapGestures({
    canPanAt: () => true,
    placementStart: () => true,
    placementMove: rec.on('placementMove'),
    placementEnd: rec.on('placementEnd'),
    placementCancel: rec.on('placementCancel'),
  });
  gestures.down({ id: 1, x: 100, y: 100, kind: 'touch' });
  gestures.move({ id: 1, x: 115, y: 100 });
  assert.equal(gestures.mode, 'place');
  assert.deepEqual(rec.named('placementMove'), [[115, 100]]);
  gestures.down({ id: 2, x: 200, y: 100, kind: 'touch' });
  assert.deepEqual(rec.named('placementCancel'), [[]]);
  assert.equal(gestures.mode, 'pinch');
  gestures.up({ id: 2, x: 200, y: 100, kind: 'touch' });
  assert.equal(gestures.mode, 'pan');
  gestures.up({ id: 1, x: 115, y: 100, kind: 'touch' });
  assert.equal(gestures.mode, 'idle');
});

test('MapGestures: placement cancel on pointercancel', () => {
  const rec = recorder();
  const gestures = new MapGestures({
    canPanAt: () => true,
    placementStart: () => true,
    placementCancel: rec.on('placementCancel'),
  });
  gestures.down({ id: 1, x: 0, y: 0, kind: 'touch' });
  gestures.move({ id: 1, x: 20, y: 0 });
  assert.equal(gestures.mode, 'place');
  gestures.cancel();
  assert.equal(gestures.mode, 'idle');
  assert.deepEqual(rec.named('placementCancel'), [[]]);
});

test('MapGestures: drag where the map cannot pan becomes blocked, no tap', () => {
  const rec = recorder();
  const gestures = new MapGestures({ canPanAt: () => false, tap: rec.on('tap') });
  gestures.down({ id: 1, x: 10, y: 10, kind: 'touch' });
  gestures.move({ id: 1, x: 30, y: 10 });
  assert.equal(gestures.mode, 'blocked');
  gestures.up({ id: 1, x: 30, y: 10, kind: 'touch' });
  assert.equal(gestures.mode, 'idle');
  assert.equal(rec.named('tap').length, 0);
});

test('MapGestures: pinch sends midpoint pan and distance-ratio zoom', () => {
  const rec = recorder();
  const gestures = new MapGestures({
    canPanAt: () => true,
    pan: rec.on('pan'),
    zoom: rec.on('zoom'),
    panEnd: rec.on('panEnd'),
  });
  gestures.down({ id: 1, x: 100, y: 100, kind: 'touch' });
  gestures.down({ id: 2, x: 200, y: 100, kind: 'touch' });
  assert.equal(gestures.mode, 'pinch');
  assert.equal(PINCH_MIN_DISTANCE, 8);
  gestures.move({ id: 2, x: 240, y: 100 });
  assert.deepEqual(rec.named('pan'), [[20, 0]], 'midpoint moved by 20 px');
  const zoom = rec.named('zoom');
  assert.equal(zoom.length, 1);
  assert.equal(zoom[0][0], 1.4);
  assert.equal(zoom[0][1], 170);
  assert.equal(zoom[0][2], 100);
  gestures.up({ id: 2, x: 240, y: 100, kind: 'touch' });
  assert.equal(gestures.mode, 'pan');
  gestures.up({ id: 1, x: 100, y: 100, kind: 'touch' });
  assert.equal(gestures.mode, 'idle');
  assert.equal(rec.named('panEnd').length, 1);
});

test('placementEdgeVelocity: left/right zones, clamped zone, invalid input', () => {
  assert.equal(placementEdgeVelocity(0, 320), -155);
  assert.equal(placementEdgeVelocity(160, 320), 0);
  assert.equal(placementEdgeVelocity(320, 320), 155);
  assert.ok(placementEdgeVelocity(10, 320) < 0);
  assert.ok(placementEdgeVelocity(310, 320) > 0);
  assert.equal(placementEdgeVelocity(Number.NaN, 320), 0);
  assert.equal(placementEdgeVelocity(10, 0), 0);
  // zone shrinks to size/4 for tiny surfaces: a 20 px surface has a 5 px zone.
  assert.equal(placementEdgeVelocity(10, 20), 0);
  assert.ok(approx(placementEdgeVelocity(0, 20), -155));
});

test('PanInertia: shipped defaults are exactly the old tuned values', () => {
  const inertia = new PanInertia();
  assert.deepEqual(PAN_INERTIA_DEFAULTS, {
    tauMs: 220,
    maxSpeed: 1000,
    maxDistance: 220,
    maxDurationMs: 850,
    minSpeed: 90,
    stopSpeed: 18,
  });
  assert.equal(inertia.tauMs, 220);
  assert.equal(inertia.maxSpeed, 1000);
  assert.equal(inertia.maxDistance, 220);
  assert.equal(inertia.maxDurationMs, 850);
  assert.equal(inertia.minSpeed, 90);
  assert.equal(inertia.stopSpeed, 18);
  assert.equal(inertia.active, false);
});

test('PanInertia: only touch/pen may begin tracking', () => {
  const inertia = new PanInertia();
  assert.equal(inertia.begin('mouse', 1000), false);
  assert.equal(inertia.active, false);
  assert.equal(inertia.begin('touch', 1000), true);
  inertia.cancel();
  assert.equal(inertia.begin('pen', 1000), true);
});

test('PanInertia: a fast touch drag coasts with decaying rAF steps', () => {
  const inertia = new PanInertia();
  assert.equal(inertia.begin('touch', 1000), true);
  for (let i = 1; i <= 6; i += 1) {
    assert.equal(inertia.sample(12, 0, 1000 + i * 16), true);
  }
  assert.equal(inertia.release(1100), true);
  assert.equal(inertia.active, true);
  assert.ok(inertia.vx > 0);
  assert.ok(inertia.ends - inertia.started <= 850);
  const first = inertia.step(1116);
  assert.ok(first && first.dx > 0);
  const second = inertia.step(1132);
  assert.ok(second && second.dx > 0);
  assert.ok(second.dx < first.dx, 'exponential decay: the second step is smaller');
  assert.equal(inertia.step(1200) !== null, true);
  // A long stall (resume after pause) cancels instead of jumping.
  inertia.cancel();
  assert.equal(inertia.begin('touch', 2000), true);
  inertia.sample(12, 0, 2010);
  inertia.sample(12, 0, 2020);
  inertia.sample(12, 0, 2030);
  assert.equal(inertia.release(2040), true);
  assert.equal(inertia.step(2200), null);
  assert.equal(inertia.active, false);
});

test('PanInertia: a held finger loses momentum; mouse drags never coast', () => {
  const inertia = new PanInertia();
  inertia.begin('touch', 1000);
  inertia.sample(12, 0, 1016);
  inertia.sample(12, 0, 1032);
  inertia.sample(12, 0, 1048);
  assert.equal(inertia.release(1200), false, 'released >130 ms after the last motion');
  assert.equal(inertia.active, false);
  inertia.cancel();

  inertia.begin('touch', 2000);
  inertia.sample(5, 0, 2016);
  assert.equal(inertia.release(2016), false, 'net travel below 12 px does not coast');
});

test('PanInertia: cancel() clears every field used by the rAF loop', () => {
  const inertia = new PanInertia();
  inertia.begin('touch', 1000);
  inertia.sample(20, 7, 1016);
  inertia.cancel();
  assert.deepEqual(inertia.debug(), {
    phase: 'idle',
    kind: null,
    samples: 0,
    lastSample: 0,
    lastMotion: 0,
    vx: 0,
    vy: 0,
    started: 0,
    ends: 0,
  });
});
