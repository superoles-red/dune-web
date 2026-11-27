import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadSave, isAppleMobile, pickSaveFile } from '../../web/saves/browser-files.mjs';

// Minimal fake DOM: only what the two helpers touch.
function fakeDoc() {
  const body = {
    children: [],
    append(node) { this.children.push(node); },
  };
  const anchors = [];
  const doc = {
    body,
    anchors,
    createElement(tag) {
      if (tag === 'a') {
        const anchor = {
          tag, style: {}, clickCount: 0, removed: false,
          click() { this.clickCount += 1; },
          remove() { this.removed = true; body.children = body.children.filter((node) => node !== this); },
        };
        anchors.push(anchor);
        return anchor;
      }
      if (tag === 'input') {
        const listeners = new Map();
        return {
          tag, style: {}, files: null, clickCount: 0, removed: false,
          addEventListener(type, fn) { listeners.set(type, fn); },
          remove() { this.removed = true; body.children = body.children.filter((node) => node !== this); },
          click() { this.clickCount += 1; },
          fire(type) { listeners.get(type)?.(); },
        };
      }
      throw Error('unexpected element ' + tag);
    },
  };
  return doc;
}

test('downloadSave falls back to an anchor download with a JSON blob', async () => {
  const doc = fakeDoc();
  const blobs = [], revoked = [];
  const url = {
    createObjectURL(blob) { blobs.push(blob); return 'blob:save'; },
    revokeObjectURL(href) { revoked.push(href); },
  };
  const ok = await downloadSave({ text: '{"format":"dune-sega-web-save"}', filename: 'dune-test.dune-save.json' }, {
    nav: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, doc, url,
  });
  assert.equal(ok, true);
  assert.equal(blobs.length, 1);
  assert(blobs[0] instanceof Blob);
  assert.equal(blobs[0].type, 'application/json');
  const anchor = doc.anchors[0];
  assert.equal(anchor.href, 'blob:save');
  assert.equal(anchor.download, 'dune-test.dune-save.json');
  assert.equal(anchor.style.display, 'none');
  assert.equal(anchor.clickCount, 1);
  assert.equal(anchor.removed, true);
  assert.equal(doc.body.children.length, 0);
  assert.deepEqual(revoked, [], 'object URL is revoked only after the grace period');
});

test('downloadSave uses the iOS share sheet when a save file can be shared', async () => {
  const doc = fakeDoc();
  let shared = null;
  const nav = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone', maxTouchPoints: 5,
    canShare({ files }) { return files.length === 1 && files[0].name === 'dune-test.dune-save.json'; },
    async share(payload) { shared = payload; },
  };
  const ok = await downloadSave({ text: '{}', filename: 'dune-test.dune-save.json' }, {
    nav, doc, url: { createObjectURL() { throw Error('must not download'); } },
  });
  assert.equal(ok, true);
  assert.equal(shared.title, 'Dune save');
  assert.equal(shared.files[0].name, 'dune-test.dune-save.json');
  assert.equal(doc.anchors.length, 0);
});

test('a cancelled iOS share returns false without an anchor download', async () => {
  const doc = fakeDoc();
  let downloads = 0;
  const nav = {
    userAgent: 'iPhone',
    canShare: () => true,
    async share() { const error = Error('cancelled'); error.name = 'AbortError'; throw error; },
  };
  const ok = await downloadSave({ text: '{}', filename: 'x.json' }, {
    nav, doc, url: { createObjectURL() { downloads += 1; return 'blob:x'; }, revokeObjectURL() {} },
  });
  assert.equal(ok, false);
  assert.equal(downloads, 0);
});

test('a failed iOS share falls back to a normal download', async () => {
  const doc = fakeDoc();
  let downloads = 0;
  const nav = {
    userAgent: 'iPhone',
    canShare: () => true,
    async share() { throw Error('share denied'); },
  };
  const ok = await downloadSave({ text: '{}', filename: 'x.json' }, {
    nav, doc, url: { createObjectURL() { downloads += 1; return 'blob:x'; }, revokeObjectURL() {} },
  });
  assert.equal(ok, true);
  assert.equal(downloads, 1);
});

test('pickSaveFile opens the picker immediately and delivers the chosen file once', () => {
  const doc = fakeDoc();
  const seen = [];
  const input = pickSaveFile((file) => seen.push(file), { doc });
  assert.equal(input.type, 'file');
  assert.equal(input.accept, '.json,.dune-save,application/json');
  assert.equal(input.style.display, 'none');
  assert.equal(input.clickCount, 1);
  assert.equal(doc.body.children.length, 1);
  const file = { name: 'dune-test.dune-save.json' };
  input.files = [file];
  input.fire('change');
  assert.deepEqual(seen, [file]);
  assert.equal(input.removed, true);
});

test('cancelling the picker removes the input without calling back', () => {
  const doc = fakeDoc();
  let called = 0;
  const input = pickSaveFile(() => { called += 1; }, { doc });
  input.fire('cancel');
  assert.equal(input.removed, true);
  assert.equal(called, 0);
});

test('isAppleMobile recognises iOS and touch Macs', () => {
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' }), true);
  assert.equal(isAppleMobile({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isAppleMobile({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), false);
  assert.equal(isAppleMobile(undefined), false);
});
