// Unit tests for the contextual B descriptor mapping (old context-action.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { contextAction } from '../../web/input/context-action.mjs';

test('contextAction: no B when placement is active or B is unavailable', () => {
  assert.equal(contextAction({}), null);
  assert.equal(contextAction({ placementActive: true, bAvailable: true, bKind: 'repeat' }), null);
  assert.equal(contextAction({ bAvailable: false, bKind: 'none' }), null);
});

test('contextAction: maps every native B kind to label/aria', () => {
  assert.deepEqual(contextAction({ bAvailable: true, bKind: 'repeat' }), {
    method: 'b',
    kind: 'repeat',
    label: 'REPEAT',
    aria: 'Повторить производство',
  });
  assert.equal(contextAction({ bAvailable: true, bKind: 'confirm-devastator' }).label, 'DETONATE');
  assert.equal(contextAction({ bAvailable: true, bKind: 'confirm-mcv' }).label, 'DEPLOY');
  assert.equal(contextAction({ bAvailable: true, bKind: 'confirm-native' }).label, 'CONFIRM');
  // An unknown/absent kind still yields the generic native confirmation.
  assert.equal(contextAction({ bAvailable: true }).kind, 'confirm-native');
  assert.equal(contextAction({ bAvailable: true, bKind: 'future-kind' }).label, 'ACTION');
});
