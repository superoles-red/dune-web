import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { CampaignStore, CAMPAIGN_KEY, CONTINUE_KEY, LANGUAGE_KEY, LEGACY_SAVE_KEY, slotKey } from '../../web/saves/campaign-state.mjs';
import {
  ACCEPTED_ENGINE_SHA256S, LEGACY_ENGINE_SHA256S, MAX_NATIVE_SAVE_BYTES, MAX_SAVE_FILE_BYTES,
  NATIVE_HOUSE_ADDRESS, NATIVE_HOUSE_OFFSET, NATIVE_MISSION_ADDRESS, NATIVE_MISSION_OFFSET,
  NATIVE_RAM_OFFSET, NATIVE_SAVE_BASE_BYTES,
  NEW_ENGINE_SHA256, SAVE_COMPATIBILITY, SAVE_FILE_FORMAT, SAVE_FILE_VERSION, SaveFileError,
  commitSaveFile, createSaveFile, parseSaveFile, validateNativeSave,
} from '../../web/saves/save-files.mjs';
import {
  LEGACY_CORE_SHA256, clone, memory, nativeBytes, oldEnvelopeBody, resigned, sealText, syntheticPayload, toBase64,
} from './helpers.mjs';

globalThis.crypto ??= webcrypto;

const HOUSE = 1;
const MISSION = 3;

function populated({ language = 'ru' } = {}) {
  const storage = memory();
  const store = new CampaignStore(storage);
  const payload = syntheticPayload({ house: HOUSE, mission: MISSION });
  assert.equal(store.complete(HOUSE, 1), true);
  assert.equal(store.complete(HOUSE, 2), true);
  assert.equal(store.adoptResume(HOUSE, MISSION), true);
  assert.equal(store.saveSlot(HOUSE, MISSION, payload), true);
  storage.setItem(LANGUAGE_KEY, language);
  return { storage, store, payload };
}

async function rejects(text, code) {
  await assert.rejects(parseSaveFile(text), (error) => error instanceof SaveFileError && error.code === code);
}

test('synthetic DSAV v2 payload validates at the documented ABI offsets', () => {
  // ABI facts verified against the pinned runtime (runtime/manifest.json):
  // natural alignment, no #pragma pack, sizeof==140056, offsetof(ram)==94.
  assert.equal(NATIVE_SAVE_BASE_BYTES, 140056);
  assert.equal(NATIVE_RAM_OFFSET, 94);
  assert.equal(NATIVE_HOUSE_OFFSET, 49874);
  assert.equal(NATIVE_HOUSE_OFFSET, NATIVE_RAM_OFFSET + NATIVE_HOUSE_ADDRESS);
  assert.equal(NATIVE_MISSION_OFFSET, 49326);
  assert.equal(NATIVE_MISSION_OFFSET, NATIVE_RAM_OFFSET + NATIVE_MISSION_ADDRESS);
  const payload = syntheticPayload({ house: HOUSE, mission: MISSION });
  const result = validateNativeSave(payload);
  assert.deepEqual(result, { bytes: NATIVE_SAVE_BASE_BYTES, house: HOUSE, mission: MISSION });
  const bytes = Buffer.from(payload, 'base64');
  assert.equal(bytes.readUInt16BE(NATIVE_HOUSE_OFFSET), HOUSE);
  assert.equal(bytes.readUInt16BE(NATIVE_MISSION_OFFSET) + 1, MISSION);
  assert.equal(bytes.readUInt32LE(0), 0x56415344);
  assert.equal(bytes.readUInt32LE(4), 2);
  // A legit YM2612 tail is allowed; the base struct stays fixed.
  const withYm = validateNativeSave(toBase64(nativeBytes({ house: 0, mission: 9, ymSize: 123 })));
  assert.deepEqual(withYm, { bytes: NATIVE_SAVE_BASE_BYTES + 123, house: 0, mission: 9 });
});

test('pinned runtime savestate manifest matches the save ABI constants', (t) => {
  const url = new URL('../../runtime/manifest.json', import.meta.url);
  if (!existsSync(url)) return t.skip('runtime/manifest.json is not built');
  const manifest = JSON.parse(readFileSync(url, 'utf8'));
  const state = manifest.savestate;
  assert.ok(state, 'manifest records the savestate ABI');
  assert.equal(manifest.runtime_version, 2);
  assert.equal(state.format, 'DSAV');
  assert.equal(state.magic, 0x56415344);
  assert.equal(state.version, 2);
  assert.equal(state.base_bytes, NATIVE_SAVE_BASE_BYTES, 'sizeof(DuneSaveState) must stay 140056');
  assert.equal(state.ram_offset, NATIVE_RAM_OFFSET, 'DuneSaveState.ram must stay at byte 94');
  assert.equal(state.house_offset, NATIVE_HOUSE_OFFSET);
  assert.equal(state.mission_offset, NATIVE_MISSION_OFFSET);
  assert.equal(state.ym_size_field_offset, 8);
  assert.equal(state.total_size_field_offset, 12);
  assert.equal(state.max_buffer_bytes, MAX_NATIVE_SAVE_BYTES);
});

test('native header, size, encoding, house and mission are validated', () => {
  assert.throws(() => validateNativeSave(syntheticPayload({ magic: 0x11111111 })), { code: 'incompatible-payload' });
  assert.throws(() => validateNativeSave(syntheticPayload({ version: 1 })), { code: 'incompatible-payload' });
  assert.throws(() => validateNativeSave(syntheticPayload({ totalSize: NATIVE_SAVE_BASE_BYTES - 1 })), { code: 'invalid-payload' });
  assert.throws(() => validateNativeSave(syntheticPayload({ ymSize: 8, totalSize: NATIVE_SAVE_BASE_BYTES })), { code: 'invalid-payload' });
  assert.throws(() => validateNativeSave(''), { code: 'invalid-payload' });
  assert.throws(() => validateNativeSave(syntheticPayload().slice(0, -2)), { code: 'invalid-payload' });
  assert.throws(() => validateNativeSave('!'.repeat(64)), { code: 'invalid-payload' });
  const short = Buffer.from(nativeBytes());
  short.writeUInt32LE(short.length, 12);
  assert.throws(() => validateNativeSave(toBase64(short.subarray(0, NATIVE_SAVE_BASE_BYTES - 4))), { code: 'invalid-payload' });
  const oversize = Buffer.alloc(MAX_NATIVE_SAVE_BYTES + 4);
  oversize.writeUInt32LE(0x56415344, 0);
  oversize.writeUInt32LE(2, 4);
  oversize.writeUInt32LE(oversize.length - NATIVE_SAVE_BASE_BYTES, 8);
  oversize.writeUInt32LE(oversize.length, 12);
  assert.throws(() => validateNativeSave(toBase64(oversize)), { code: 'invalid-payload' });
  assert.throws(() => validateNativeSave(syntheticPayload({ houseWord: 3 })), { code: 'invalid-payload' });
  assert.throws(() => validateNativeSave(syntheticPayload({ missionWord: 0xffff })), { code: 'invalid-payload' });
  assert.throws(() => validateNativeSave(syntheticPayload({ missionWord: 9 })), { code: 'invalid-payload' });
  const payload = syntheticPayload({ house: HOUSE, mission: MISSION });
  assert.throws(() => validateNativeSave(payload, { house: 0, mission: 1 }), { code: 'mission-mismatch' });
  assert.throws(() => validateNativeSave(payload, { house: HOUSE, mission: MISSION + 1 }), { code: 'mission-mismatch' });
});

test('an old-port envelope imports as-is and commits into a fresh mock store', async () => {
  const { store, payload } = populated();
  const text = sealText(oldEnvelopeBody({ progress: store.progress, slot: store.resumable() }));
  const archive = await parseSaveFile(text);
  assert.equal(archive.format, SAVE_FILE_FORMAT);
  assert.equal(archive.version, SAVE_FILE_VERSION);
  assert.equal(archive.compatibility.engineSha256, LEGACY_CORE_SHA256, 'old build identity is retained, not rewritten');
  assert.equal(archive.compatibility.game, 'dune-sega-usa');
  assert.equal(archive.continue.state, payload);
  assert.equal(archive.language, 'ru');
  assert.equal(archive.checksum, JSON.parse(text).checksum);
  assert(Object.isFrozen(archive));
  assert(Object.isFrozen(archive.progress.houses));

  const targetStorage = memory();
  const target = new CampaignStore(targetStorage);
  const transaction = commitSaveFile({ store: target, archive });
  assert.equal(targetStorage.getItem(LANGUAGE_KEY), 'ru');
  assert.deepEqual(JSON.parse(targetStorage.getItem(CAMPAIGN_KEY)), store.progress);
  assert.deepEqual(JSON.parse(targetStorage.getItem(CONTINUE_KEY)), archive.continue);
  assert.equal(target.resumable().state, payload);
  assert.deepEqual(target.progress, store.progress);
  assert.equal(transaction.language, 'ru');
  assert.equal(transaction.continue.house, HOUSE);
  assert.equal(transaction.continue.mission, MISSION);
  const reopened = new CampaignStore(targetStorage);
  assert.equal(reopened.resumable().state, payload);
  assert.deepEqual(reopened.progress, store.progress);
});

test('create -> parse round-trip preserves native bytes, progress and language without touching storage', async () => {
  const { storage, store, payload } = populated();
  const before = [...storage.values];
  const result = await createSaveFile({ store, language: 'ru', now: 1793730000123 });
  assert.match(result.filename, /^dune-2026-11-03T.*\.dune-save\.json$/);
  assert.ok(result.text.endsWith('\n'));
  assert.deepEqual([...storage.values], before, 'export must not mutate local saves');
  const archive = await parseSaveFile(result.text);
  assert.equal(archive.continue.state, payload);
  assert.equal(archive.language, 'ru');
  assert.equal(archive.createdAt, 1793730000123);
  assert.deepEqual(archive.progress, store.progress);
  assert.equal(archive.checksum, result.archive.checksum);
});

test('new exports carry the new port identity and are accepted by our own parser', async () => {
  const { store } = populated();
  const { archive, text } = await createSaveFile({ store, language: 'en' });
  assert.deepEqual(archive.compatibility, SAVE_COMPATIBILITY);
  assert.equal(archive.compatibility.engineSha256, NEW_ENGINE_SHA256);
  assert.equal(archive.compatibility.game, 'dune-sega-usa');
  assert.equal(archive.compatibility.nativeFormat, 'DSAV');
  assert.equal(archive.compatibility.nativeVersion, 2);
  assert.equal(archive.compatibility.nativeBaseBytes, NATIVE_SAVE_BASE_BYTES);
  assert.deepEqual(ACCEPTED_ENGINE_SHA256S, [...LEGACY_ENGINE_SHA256S, ...(NEW_ENGINE_SHA256 ? [NEW_ENGINE_SHA256] : [])]);
  const reparsed = await parseSaveFile(text);
  assert.deepEqual(reparsed.compatibility, SAVE_COMPATIBILITY);
  // A new-port export made before the runtime hash is pinned carries null; it
  // must stay importable by this port after NEW_ENGINE_SHA256 is filled in.
  const pendingText = resigned(archive, (value) => { value.compatibility.engineSha256 = null; });
  const pending = await parseSaveFile(pendingText);
  assert.equal(pending.compatibility.engineSha256, null);
});

test('every hash in the copied old allowlist imports and re-exports with the new identity', async () => {
  const { store } = populated();
  assert.ok(LEGACY_ENGINE_SHA256S.length >= 13, 'old allowlist was copied completely');
  for (const engineSha256 of LEGACY_ENGINE_SHA256S) {
    const text = sealText(oldEnvelopeBody({ progress: store.progress, slot: store.resumable(), engineSha256 }));
    const archive = await parseSaveFile(text);
    assert.equal(archive.compatibility.engineSha256, engineSha256);
    assert.equal(archive.checksum, JSON.parse(text).checksum);
    const target = new CampaignStore(memory());
    commitSaveFile({ store: target, archive });
    assert.equal(target.resumable().state, store.resumable().state);
    const reexport = (await createSaveFile({ store: target, language: 'ru' })).archive;
    assert.deepEqual(reexport.compatibility, SAVE_COMPATIBILITY);
    assert.deepEqual(reexport.progress, archive.progress);
  }
});

test('ABI mismatches, unknown engine hashes and malformed compatibility are rejected', async () => {
  const { store } = populated();
  const { archive } = await createSaveFile({ store });
  const mutations = [
    (value) => { value.compatibility.nativeVersion = 3; },
    (value) => { value.compatibility.nativeBaseBytes += 1; },
    (value) => { value.compatibility.game = 'dune-sega-eur'; },
    (value) => { value.compatibility.nativeFormat = 'DSAV2'; },
    (value) => { value.compatibility.engineSha256 = '0'.repeat(64); },
    (value) => { value.compatibility.engineSha256 = 'abc'; },
    (value) => { value.compatibility.publisher = 'x'; },
    (value) => { delete value.compatibility.nativeBaseBytes; },
  ];
  for (const mutate of mutations) await rejects(resigned(archive, mutate), 'incompatible-engine');
});

test('checksum, envelope, format and metadata refusals', async () => {
  const { store } = populated();
  const { text, archive } = await createSaveFile({ store });
  await rejects('{', 'invalid-json');
  await rejects('null', 'invalid-format');
  await rejects('{}', 'invalid-format');
  await rejects('[]', 'invalid-format');
  await rejects(' '.repeat(MAX_SAVE_FILE_BYTES + 1), 'too-large');
  await rejects('я'.repeat(MAX_SAVE_FILE_BYTES / 2 + 1), 'too-large');
  await rejects(text.replace('dune-sega-usa', 'dune-sega-eur'), 'checksum-mismatch');
  const tampered = JSON.parse(text);
  tampered.checksum = 'sha256-' + '0'.repeat(64);
  await rejects(JSON.stringify(tampered), 'checksum-mismatch');
  tampered.checksum = 'nope';
  await rejects(JSON.stringify(tampered), 'invalid-checksum');
  const extra = JSON.parse(text);
  extra.extra = true;
  await rejects(JSON.stringify(extra), 'invalid-format');
  await rejects(resigned(archive, (value) => { value.format = 'other-game'; }), 'wrong-game');
  await rejects(resigned(archive, (value) => { value.version = 99; }), 'incompatible-version');
  await rejects(resigned(archive, (value) => { value.language = 'de'; }), 'invalid-format');
  await rejects(resigned(archive, (value) => { value.createdAt = 0; }), 'invalid-format');
});

test('native payload corruption, size, house/mission and Continue mismatches are rejected', async () => {
  const { store, payload } = populated();
  const { archive } = await createSaveFile({ store });
  const bytes = Buffer.from(payload, 'base64');
  const badMagic = Buffer.from(bytes);
  badMagic.writeUInt32LE(0x11111111, 0);
  await rejects(resigned(archive, (value) => { value.continue.state = toBase64(badMagic); }), 'incompatible-payload');
  const badVersion = Buffer.from(bytes);
  badVersion.writeUInt32LE(1, 4);
  await rejects(resigned(archive, (value) => { value.continue.state = toBase64(badVersion); }), 'incompatible-payload');
  const badYm = Buffer.from(bytes);
  badYm.writeUInt32LE(16, 8);
  await rejects(resigned(archive, (value) => { value.continue.state = toBase64(badYm); }), 'invalid-payload');
  const badTotal = Buffer.from(bytes);
  badTotal.writeUInt32LE(0, 12);
  await rejects(resigned(archive, (value) => { value.continue.state = toBase64(badTotal); }), 'invalid-payload');
  await rejects(resigned(archive, (value) => { value.continue.state = toBase64(bytes.subarray(0, bytes.length - 4)); }), 'invalid-payload');
  const badHouse = Buffer.from(bytes);
  badHouse.writeUInt16BE(3, NATIVE_RAM_OFFSET + NATIVE_HOUSE_ADDRESS);
  await rejects(resigned(archive, (value) => { value.continue.state = toBase64(badHouse); }), 'invalid-payload');
  const badMission = Buffer.from(bytes);
  badMission.writeUInt16BE(9, NATIVE_RAM_OFFSET + NATIVE_MISSION_ADDRESS);
  await rejects(resigned(archive, (value) => { value.continue.state = toBase64(badMission); }), 'invalid-payload');
  await rejects(resigned(archive, (value) => { value.continue.house = (HOUSE + 1) % 3; }), 'mission-mismatch');
  await rejects(resigned(archive, (value) => { value.continue.mission = MISSION + 1; }), 'mission-mismatch');
  await rejects(resigned(archive, (value) => { value.continue.house = 3; }), 'invalid-continue');
  await rejects(resigned(archive, (value) => { value.continue.savedAt = 0; }), 'invalid-continue');
  await rejects(resigned(archive, (value) => { value.progress.lastRun = null; }), 'invalid-continue');
  await rejects(resigned(archive, (value) => { value.progress.houses[0].unlocked = 10; }), 'invalid-progress');
  await rejects(resigned(archive, (value) => { value.progress.houses.push(value.progress.houses[0]); }), 'invalid-progress');
  await rejects(resigned(archive, (value) => { value.progress.houses[HOUSE].completed = [2, 1]; }), 'invalid-progress');
  // A completion date for a mission that is not marked completed is inconsistent.
  await rejects(resigned(archive, (value) => { value.progress.houses[HOUSE].completedAt[MISSION] = value.continue.savedAt; }), 'invalid-progress');
  await rejects(resigned(archive, (value) => { value.progress.lastHouse = 7; }), 'invalid-progress');
});

test('commit requires a checksum-verified immutable archive', async () => {
  const { store } = populated();
  const { archive } = await createSaveFile({ store });
  const target = new CampaignStore(memory());
  assert.throws(() => commitSaveFile({ store: target, archive: clone(archive) }), { code: 'unverified' });
  assert.throws(() => commitSaveFile({ archive }), { code: 'unverified' });
  assert.throws(() => commitSaveFile({ store: target }), { code: 'unverified' });
  assert.throws(() => { archive.continue.house = 99; }, TypeError);
});

test('failed persistent write restores exact old keys and leaves memory unchanged', async () => {
  const { store: origin } = populated();
  const { archive } = await createSaveFile({ store: origin, language: 'ru' });
  const storage = memory();
  storage.setItem(CAMPAIGN_KEY, JSON.stringify({ version: 1, houses: [] }));
  storage.setItem(CONTINUE_KEY, 'previous-invalid-but-recoverable');
  storage.setItem(LANGUAGE_KEY, 'en');
  storage.setItem(LEGACY_SAVE_KEY, 'untouched');
  const target = new CampaignStore(storage);
  const prior = { progress: target.progress, current: target.current, legacyAllowed: target.legacyAllowed };
  const before = [...storage.values];
  const set = storage.setItem;
  let attempts = 0;
  storage.setItem = (key, value) => {
    if (++attempts === 2) throw Error('quota');
    return set(key, value);
  };
  assert.throws(() => commitSaveFile({ store: target, archive }), { code: 'storage-write-failed' });
  assert.deepEqual([...storage.values], before);
  assert.equal(target.progress, prior.progress);
  assert.equal(target.current, prior.current);
  assert.equal(target.legacyAllowed, prior.legacyAllowed);
});

test('explicit rollback after a native-loading failure restores keys and in-memory state', async () => {
  const { store: origin } = populated();
  const { archive } = await createSaveFile({ store: origin, language: 'ru' });
  const storage = memory();
  storage.setItem(LANGUAGE_KEY, 'en');
  storage.setItem(LEGACY_SAVE_KEY, 'recoverable');
  const target = new CampaignStore(storage);
  const oldProgress = target.progress, oldContinue = target.current;
  const before = [...storage.values];
  const transaction = commitSaveFile({ store: target, archive });
  assert.equal(target.resumable().state, origin.resumable().state);
  assert.deepEqual(transaction.rollback(), { language: 'en' });
  assert.deepEqual([...storage.values], before);
  assert.equal(target.progress, oldProgress);
  assert.equal(target.current, oldContinue);
  assert.equal(target.legacyAllowed, true);
  assert.deepEqual(transaction.rollback(), { language: 'en' }, 'rollback is idempotent');
});

test('importing a progress-only backup writes a Continue tombstone and never resurrects legacy slots', async () => {
  const original = new CampaignStore(memory());
  original.complete(0, 1);
  const { text } = await createSaveFile({ store: original });
  const archive = await parseSaveFile(text);
  assert.equal(archive.continue, null);
  const storage = memory();
  storage.setItem(LEGACY_SAVE_KEY, 'old');
  storage.setItem(slotKey(1), JSON.stringify({ version: 1, house: 1, mission: 1, state: 'AQID', savedAt: 100 }));
  const store = new CampaignStore(storage);
  commitSaveFile({ store, archive });
  assert.equal(store.resumable(), null);
  assert.equal(new CampaignStore(storage).resumable(), null);
  assert.equal(store.legacy(), null);
  assert.equal(storage.getItem(LEGACY_SAVE_KEY), 'old');
  assert.ok(storage.getItem(slotKey(1)), 'migration slots are preserved for recovery');
  assert.equal(store.progress.houses[0].unlocked, 2);
});

test('storage read failure causes no writes; rollback failure is reported distinctly', async () => {
  const { store: origin } = populated();
  const { archive } = await createSaveFile({ store: origin });
  let writes = 0;
  const storage = memory();
  const target = new CampaignStore(storage);
  storage.getItem = () => { throw Error('disabled'); };
  storage.setItem = () => { writes += 1; };
  assert.throws(() => commitSaveFile({ store: target, archive }), { code: 'storage-unavailable' });
  assert.equal(writes, 0);
  const blocked = memory();
  const other = new CampaignStore(blocked);
  const set = blocked.setItem;
  let n = 0;
  blocked.setItem = (key, value) => {
    if (++n === 2) throw Error('quota');
    set(key, value);
  };
  blocked.removeItem = () => { throw Error('blocked rollback'); };
  assert.throws(() => commitSaveFile({ store: other, archive }), { code: 'storage-rollback-failed' });
});
