// Unit tests for the single DOM pointer stream (old `map-input.mjs`):
// pointer-event and legacy mouse branches, right-click command, drag slop,
// pointercancel abort and teardown.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bindMapInput, MOUSE_COMMAND_DRAG_SLOP } from '../../web/input/map-input.mjs';
import { makeEvent } from './helpers.mjs';

function fakeCanvas() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

function recorder() {
  const calls = [];
  return {
    calls,
    handlers: {
      begin: (id, point, kind) => {
        calls.push(['begin', id, point.x, point.y, kind]);
        return true;
      },
      move: (id, point) => calls.push(['move', id, point.x, point.y]),
      end: (id, point) => calls.push(['end', id, point.x, point.y]),
      cancel: () => calls.push(['cancel']),
      command: (point, kind) => calls.push(['command', point.x, point.y, kind]),
      hover: (point, kind) => calls.push(['hover', point.x, point.y, kind]),
      position: (event) => ({ x: event.clientX, y: event.clientY }),
    },
    names() {
      return calls.map((call) => call[0]);
    },
  };
}

function pointEvent(overrides = {}) {
  return makeEvent({
    clientX: 30,
    clientY: 40,
    preventDefault() {
      this.prevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
    ...overrides,
  });
}

test('map-input: pointer stream begin/move/end + hover for mouse moves', () => {
  const canvas = fakeCanvas();
  const rec = recorder();
  const input = bindMapInput(canvas, rec.handlers, { pointerEvents: true });
  assert.equal(input.pointerEvents, true);
  const down = pointEvent({ pointerId: 4, pointerType: 'touch', button: 0, buttons: 1 });
  canvas.dispatch('pointerdown', down);
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  canvas.dispatch('pointermove', pointEvent({ pointerId: 4, pointerType: 'touch', buttons: 1, clientX: 50, clientY: 60 }));
  canvas.dispatch('pointerup', pointEvent({ pointerId: 4, pointerType: 'touch', button: 0, buttons: 0, clientX: 51, clientY: 61 }));
  canvas.dispatch('pointermove', pointEvent({ pointerId: 5, pointerType: 'mouse', buttons: 0 }));
  assert.deepEqual(rec.calls, [
    ['begin', 4, 30, 40, 'touch'],
    ['move', 4, 50, 60],
    ['end', 4, 51, 61],
    ['hover', 30, 40, 'mouse'],
  ]);
  input.destroy();
  assert.equal(canvas.count('pointerdown'), 0);
});

test('map-input: right mouse button commands on release, drag cancels', () => {
  const canvas = fakeCanvas();
  const rec = recorder();
  bindMapInput(canvas, rec.handlers, { pointerEvents: true });
  canvas.dispatch('pointerdown', pointEvent({ pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2 }));
  canvas.dispatch('pointerup', pointEvent({ pointerId: 1, pointerType: 'mouse', button: 2, buttons: 0, clientX: 31, clientY: 41 }));
  assert.deepEqual(rec.calls, [['command', 31, 41, 'mouse']]);

  rec.calls.length = 0;
  canvas.dispatch('pointerdown', pointEvent({ pointerId: 2, pointerType: 'mouse', button: 2, buttons: 2 }));
  canvas.dispatch('pointermove', pointEvent({ pointerId: 2, pointerType: 'mouse', button: 2, buttons: 2, clientX: 60, clientY: 40 }));
  canvas.dispatch('pointerup', pointEvent({ pointerId: 2, pointerType: 'mouse', button: 2, buttons: 0, clientX: 60, clientY: 40 }));
  assert.deepEqual(rec.names(), ['cancel']);
  assert.equal(MOUSE_COMMAND_DRAG_SLOP, 8);
});

test('map-input: pointercancel aborts and reset() clears tracking', () => {
  const canvas = fakeCanvas();
  const rec = recorder();
  const input = bindMapInput(canvas, rec.handlers, { pointerEvents: true });
  canvas.dispatch('pointerdown', pointEvent({ pointerId: 1, pointerType: 'touch' }));
  assert.equal(input.activeCount, 1);
  canvas.dispatch('pointercancel', pointEvent({ pointerId: 1, pointerType: 'touch' }));
  assert.equal(input.activeCount, 0);
  assert.deepEqual(rec.calls.at(-1), ['cancel']);

  canvas.dispatch('pointerdown', pointEvent({ pointerId: 2, pointerType: 'touch' }));
  input.reset();
  assert.equal(input.activeCount, 0);
});

test('map-input: legacy mouse fallback when PointerEvent is unavailable', () => {
  const canvas = fakeCanvas();
  const rec = recorder();
  bindMapInput(canvas, rec.handlers, { pointerEvents: false });
  canvas.dispatch('mousedown', makeEvent({ button: 0, buttons: 1, clientX: 10, clientY: 20 }));
  canvas.dispatch('mousemove', makeEvent({ buttons: 1, clientX: 30, clientY: 20 }));
  canvas.dispatch('mouseup', makeEvent({ button: 0, buttons: 0, clientX: 31, clientY: 20 }));
  assert.deepEqual(rec.calls, [
    ['begin', 'mouse', 10, 20, 'mouse'],
    ['move', 'mouse', 30, 20],
    ['end', 'mouse', 31, 20],
  ]);

  rec.calls.length = 0;
  canvas.dispatch('mousedown', makeEvent({ button: 2, buttons: 2, clientX: 10, clientY: 20 }));
  canvas.dispatch('mouseup', makeEvent({ button: 2, buttons: 0, clientX: 10, clientY: 20 }));
  assert.deepEqual(rec.calls, [['command', 10, 20, 'mouse']]);
});

test('map-input: compatibility mouse/touch/click events are always stopped', () => {
  const canvas = fakeCanvas();
  bindMapInput(canvas, {}, { pointerEvents: true });
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    const event = pointEvent();
    canvas.dispatch(type, event);
    assert.equal(event.prevented, true, `${type} prevented`);
    assert.equal(event.stopped, true, `${type} stopped`);
  }
});
