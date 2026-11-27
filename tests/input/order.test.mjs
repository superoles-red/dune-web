// Unit tests for the pure selection/order state machine (no DOM, no host,
// no game data). Mirrors the old shell's typed-input rules.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrderInput,
  DOUBLE_TAP_MS,
  SELECTION_WAIT_MS,
  DOUBLE_TAP_SLOP,
} from '../../web/input/order-input.mjs';

const WORLD = { context: 1, capturesInput: false, own: false, kind: 'none', target: { kind: 'none' } };
const SOURCE_UNIT = { ...WORLD, own: true, kind: 'unit' };
const UNIT_TARGET = { ...WORLD, own: true, kind: 'unit', target: { kind: 'unit' } };

function harness({ state = WORLD, token = 0 } = {}) {
  const calls = [];
  const clock = { value: 1000 };
  const currentToken = { value: token };
  const orders = new OrderInput({
    readState: () => ({ ...state }),
    captureActor: () => {
      calls.push({ name: 'capture' });
      return currentToken.value;
    },
    select: (x, y) => {
      calls.push({ name: 'select', args: [x, y] });
      return 1;
    },
    command: (x, y, commandToken) => {
      calls.push({ name: 'command', args: [x, y, commandToken] });
      return 1;
    },
    now: () => clock.value,
  });
  return {
    orders,
    calls,
    clock,
    token: currentToken,
    named(name) {
      return calls.filter((call) => call.name === name).map((call) => call.args ?? []);
    },
    names() {
      return calls.map((call) => call.name);
    },
  };
}

test('OrderInput: constants match the old build (300 ms / 100 ms / 24 px)', () => {
  assert.equal(DOUBLE_TAP_MS, 300);
  assert.equal(SELECTION_WAIT_MS, 100);
  assert.equal(DOUBLE_TAP_SLOP, 24);
});

test('OrderInput: a single world tap selects and keeps no pending pair', () => {
  const h = harness();
  const result = h.orders.tap(100, 50, 'touch', 0);
  assert.equal(result, 1);
  assert.deepEqual(h.named('select'), [[100, 50]]);
  assert.equal(h.named('command').length, 0);
  assert.equal(h.orders.snapshot().pending, false);
  assert.equal(h.orders.snapshot().lastAction, 'select');
});

test('OrderInput: taps outside the world / while captured are ignored', () => {
  const h = harness({ state: { ...WORLD, context: 2 } });
  assert.equal(h.orders.tap(10, 10, 'touch', 0), 0);
  assert.equal(h.orders.snapshot().lastAction, 'ignored');
  assert.equal(h.named('select').length, 0);

  const captured = harness({ state: { ...WORLD, capturesInput: true } });
  assert.equal(captured.orders.tap(10, 10, 'touch', 0), 0);
  assert.equal(captured.named('select').length, 0);
  assert.equal(captured.named('capture').length, 0);
});

test('OrderInput: double tap captures the actor on tap one and commands with its token on tap two', () => {
  const h = harness({ state: UNIT_TARGET, token: 77 });
  // First tap: a source (own unit) exists and the target is an object, so the
  // selection is deferred and the retained token waits for a possible pair.
  assert.equal(h.orders.tap(100, 100, 'touch', 0), 0);
  assert.equal(h.orders.snapshot().lastAction, 'command-wait');
  assert.equal(h.orders.snapshot().pending, true);
  assert.equal(h.named('capture').length, 1);
  assert.equal(h.named('select').length, 0);

  // Second tap within 300 ms / 24 px -> command with the token from tap one.
  h.clock.value = 1200;
  assert.equal(h.orders.tap(105, 103, 'touch', 0), 1);
  assert.deepEqual(h.named('command'), [[105, 103, 77]]);
  assert.equal(h.named('select').length, 0, 'the pair wins over the deferred selection');
  assert.equal(h.orders.snapshot().pending, false);
  assert.equal(h.orders.snapshot().lastAction, 'command');
});

test('OrderInput: a deferred ordinary selection commits after 100 ms via flush()', () => {
  const h = harness({ state: UNIT_TARGET, token: 9 });
  h.orders.tap(100, 100, 'touch', 0);
  assert.equal(h.orders.flush(1050), 0, 'still inside the 100 ms confirmation window');
  assert.equal(h.named('select').length, 0);
  assert.equal(h.orders.flush(1110), 1, 'age 110 ms commits the ordinary selection');
  assert.deepEqual(h.named('select'), [[100, 100]]);
  assert.equal(h.orders.snapshot().lastAction, 'select');
});

test('OrderInput: an armed Palace keeps the full 300 ms window before selecting', () => {
  const h = harness({ state: { ...UNIT_TARGET, powerArmed: true }, token: 5 });
  h.orders.tap(100, 100, 'touch', 0);
  assert.equal(h.orders.snapshot().lastAction, 'power-wait');
  assert.equal(h.orders.flush(1200), 0, 'Palace waits the whole pair window (age 200 ms)');
  assert.equal(h.named('select').length, 0);
  assert.equal(h.orders.flush(1320), 1, 'past 300 ms the lone Palace tap selects');
  assert.equal(h.named('select').length, 1);
});

test('OrderInput: two taps beyond slop are two separate selections', () => {
  const h = harness({ state: UNIT_TARGET, token: 3 });
  h.orders.tap(100, 100, 'touch', 0);
  h.clock.value = 1200;
  assert.equal(h.orders.tap(130, 100, 'touch', 0), 0, '30 px > 24 px slop: no pair');
  assert.equal(h.named('command').length, 0);
  // The overdue deferred selection commits first (old tap); the new tap is
  // itself deferred because the target is an object -> two selections.
  assert.deepEqual(h.named('select'), [[100, 100]]);
  h.clock.value = 1350;
  assert.equal(h.orders.flush(1350), 1);
  assert.deepEqual(h.named('select'), [[100, 100], [130, 100]]);
});

test('OrderInput: right click commands immediately with a captured token', () => {
  const h = harness({ state: WORLD, token: 42 });
  assert.equal(h.orders.rightTap(200, 120, 'mouse'), 1);
  assert.deepEqual(h.named('capture'), [[]]);
  assert.deepEqual(h.named('command'), [[200, 120, 42]]);
  assert.equal(h.named('select').length, 0);
  assert.equal(h.orders.snapshot().lastAction, 'command');
});

test('OrderInput: right click without a token is ignored, no select', () => {
  const h = harness({ state: WORLD, token: 0 });
  assert.equal(h.orders.rightTap(200, 120, 'mouse'), 0);
  assert.equal(h.orders.snapshot().lastAction, 'ignored');
  assert.equal(h.named('command').length, 0);
  assert.equal(h.named('select').length, 0);
});

test('OrderInput: armed Palace right double click keeps the first token for the second click', () => {
  const h = harness({ state: { ...WORLD, powerArmed: true }, token: 11 });
  assert.equal(h.orders.rightTap(100, 100, 'mouse'), 0);
  assert.equal(h.orders.snapshot().lastAction, 'power-wait');
  assert.equal(h.orders.snapshot().power, true);
  assert.equal(h.named('command').length, 0);
  h.clock.value = 1250;
  assert.equal(h.orders.rightTap(104, 100, 'mouse'), 1);
  assert.deepEqual(h.named('command'), [[104, 100, 11]]);
});

test('OrderInput: cancel() drops the pending pair and the next tap starts fresh', () => {
  const h = harness({ state: UNIT_TARGET, token: 8 });
  h.orders.tap(100, 100, 'touch', 0);
  assert.equal(h.orders.snapshot().pending, true);
  h.orders.cancel();
  assert.equal(h.orders.snapshot().pending, false);
  assert.equal(h.orders.snapshot().lastAction, 'cancelled');
  h.clock.value = 1100;
  // A fresh tap after cancel must select again, not command with the stale token.
  assert.equal(h.orders.tap(100, 100, 'touch', 0), 0);
  assert.equal(h.named('command').length, 0);
});

test('OrderInput: left mouse tap selects but never opens a mobile command pair', () => {
  const h = harness({ state: UNIT_TARGET, token: 77 });
  assert.equal(h.orders.tap(100, 100, 'mouse', 0), 1, 'a lone mouse click selects immediately');
  assert.equal(h.orders.snapshot().lastAction, 'select');
  assert.equal(h.orders.snapshot().pending, false, 'desktop clicks do not retain a command token');
  // The click still queued the native selection immediately.
  assert.deepEqual(h.named('select'), [[100, 100]]);
});

test('OrderInput: the 300 ms double-tap boundary is inclusive', () => {
  const h = harness({ state: UNIT_TARGET, token: 77 });
  h.orders.tap(100, 100, 'touch', 0);
  h.clock.value = 1000 + 300;
  assert.equal(h.orders.tap(100, 100, 'touch', 0), 1, 'age exactly 300 ms still pairs');
  assert.deepEqual(h.named('command'), [[100, 100, 77]]);
  assert.equal(h.orders.snapshot().pending, false);
});

test('OrderInput: invalid coordinates/kind/time are ignored and clear the pair', () => {
  const h = harness({ state: WORLD, token: 0 });
  assert.equal(h.orders.tap(Number.NaN, 10, 'touch', 0), 0);
  assert.equal(h.orders.snapshot().lastAction, 'ignored');
  assert.equal(h.orders.tap(10, 10, 'gamepad', 0), 0);
  assert.equal(h.orders.snapshot().lastAction, 'ignored');
});
