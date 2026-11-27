// Portable save files for the BYOP port, adapted from the old port:
// "Dune Sega Web/web/save-files.mjs".
//
// The JSON envelope ("dune-sega-web-save" v1) and its checksum algorithm are
// unchanged, so files exported by the old version import as-is. The payload is
// the raw native DSAV v2 byte stream produced by the runtime's own serializer;
// this module never executes or patches game code and no game bytes are bundled.
//
// Compatibility policy for a bring-your-own-ROM port
// --------------------------------------------------
// * The native payload is validated against the DSAV *ABI*:
//   game 'dune-sega-usa', nativeFormat 'DSAV', nativeVersion 2 and
//   nativeBaseBytes (fixed-size DuneSaveState; RAM starts at byte 94).
// * `engineSha256` is a diagnostic build identity, not a decoder key. Old
//   exports keep their historical hashes (the full old allowlist below) and new
//   exports write this port's identity. NEW_ENGINE_SHA256 is a placeholder until
//   the first BYOP runtime build exists: it must be filled with the pinned
//   runtime SHA-256 (after which `null` exports are still accepted, so files
//   exported before the pin remain importable by this port).
// * Compatibility with the old version is one-way: old -> new. The old build
//   only accepts its own allowlist, so a new-port export (new/null hash) is not
//   importable there. This is intentional and documented in docs/SAVES.md.
import { CAMPAIGN_KEY, CONTINUE_KEY, LANGUAGE_KEY, normalizeProgress, validHouse, validMission } from './campaign-state.mjs';

export const SAVE_FILE_FORMAT = 'dune-sega-web-save';
export const SAVE_FILE_VERSION = 1;
export const MAX_SAVE_FILE_BYTES = 512 * 1024;
export const MAX_NATIVE_SAVE_BYTES = 256 * 1024;
// sizeof(DuneSaveState) in the pinned runtime (runtime/dune-runtime-v2.c,
// natural alignment, no #pragma pack). Verified by the runtime tooling and
// recorded in runtime/manifest.json -> savestate.base_bytes.
// Do NOT rebuild the runtime from vendor/rearrakis/genesis_recompiler/
// dune_savestate.h: that header is #pragma pack(push,1) and yields 140027,
// which would break every old save. See docs/SAVES.md §3.
export const NATIVE_SAVE_BASE_BYTES = 140056;
// byte offset of DuneSaveState.ram inside the serialized v2 struct:
// 4 (magic) + 4 (version) + 4 (ym_size) + 4 (total_size) + 8*4 (d) + 8*4 (a)
// + 4 (pc) + 4 (usp) + 4 (ssp) + 2 (sr) = 94; offsetof(sr) == 92.
export const NATIVE_RAM_OFFSET = 94;
// 68000 RAM words written by the original game (big-endian inside the struct).
export const NATIVE_HOUSE_ADDRESS = 0xc274;
export const NATIVE_MISSION_ADDRESS = 0xc050;
// Absolute byte offsets in the DSAV stream (also in runtime/manifest.json):
// house = 94 + 0xC274 = 49874, mission = 94 + 0xC050 = 49326.
export const NATIVE_HOUSE_OFFSET = NATIVE_RAM_OFFSET + NATIVE_HOUSE_ADDRESS;
export const NATIVE_MISSION_OFFSET = NATIVE_RAM_OFFSET + NATIVE_MISSION_ADDRESS;

// Placeholder: fill with the pinned SHA-256 of the new runtime after the first
// BYOP runtime build (runtime/manifest.json). Until then new exports carry null.
export const NEW_ENGINE_SHA256 = null;
// Hashes accepted by the old port, copied verbatim from the old save-files.mjs
// so every previously exported file keeps importing. Informational only.
export const LEGACY_ENGINE_SHA256S = Object.freeze([
  // core shipped by the last old-port build (docs/wasm-build.json)
  '6a8da54436ec0946eb5952319fab7cab0b05ca8eced683af24449ce315fb0155',
  // earlier published cores that share the same DSAV v2 ABI
  'ac28b30373bbdd2373ae6aa2659d65911e845869d7582ad39c14917732d7c99a',
  'c68bbf96ffa9db8f4472acc500deec0b14e6cd22f64c059e61b6f16daf540f27',
  '6c2de7bd4839b9b3d88c465242ac124a280fd261f631577afcbc0d79f99873bf',
  'b1f1e88198c7d4e7b3a1d444227fdc380e928da749f51f7ddc45d38b332437fa',
  '3dbc9ad2ab046948add849cfae6ddf9d84cc31d9a7212b406fe5bd08de42f765',
  '5156b9ee619e6a2c864d908f712f37e912cab713971d67f7fa34303a55e2e03f',
  'e43b28261eb6b9f05c29641cd44b752755e9ef0ffd44c5387e6adbc92ff6ef2e',
  'f4a8cb4fc34845f17652b449e11401c34cfeba6900d76fa16e926f63c0337938',
  '319b76fc26e77cbbe2d0eed808ae72587b4ec1d5fe88ed473561c287610c81d5',
  'd464dfb2ba1407c2a36ad9d2e01c311953db49bdb0d5d7765a10944d69dba953',
  '777d313a36f86b7c46bc5994b1c43507a2ef2a9006bd80648cf4f73c7b534add',
  '4f3a8c75663e87b0f7dbcad2aff11ee36fa434d9d0a82d87a74318700ee64c22',
]);
const acceptedEngineHashes = new Set(LEGACY_ENGINE_SHA256S);
if (NEW_ENGINE_SHA256) acceptedEngineHashes.add(NEW_ENGINE_SHA256);
export const ACCEPTED_ENGINE_SHA256S = Object.freeze([...acceptedEngineHashes]);

// Identity written into every new export. ABI fields are normative; the hash is
// the build label (null while the new runtime hash is not pinned yet).
export const SAVE_COMPATIBILITY = Object.freeze({
  game: 'dune-sega-usa',
  nativeFormat: 'DSAV',
  nativeVersion: 2,
  nativeBaseBytes: NATIVE_SAVE_BASE_BYTES,
  engineSha256: NEW_ENGINE_SHA256,
});

const verifiedArchives = new WeakSet();
const encoder = new TextEncoder();
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const positiveDate = (v) => Number.isSafeInteger(v) && v > 0;
const clone = (v) => JSON.parse(JSON.stringify(v));
const canonical = (v) => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : record(v) ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const equal = (a, b) => canonical(a) === canonical(b);
function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}
export class SaveFileError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'SaveFileError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new SaveFileError(code, message); };
function exactKeys(value, keys, code = 'invalid-format') {
  if (!record(value) || !equal(Object.keys(value).sort(), [...keys].sort())) fail(code, 'This is not a complete Dune save file.');
}
async function digest(value) {
  if (!globalThis.crypto?.subtle) fail('checksum-unavailable', 'Save verification requires a WebCrypto SHA-256 implementation (HTTPS or localhost in browsers).');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(canonical(value)));
  return 'sha256-' + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
function checkedProgress(value) {
  exactKeys(value, ['version', 'lastHouse', 'houses', 'lastRun'], 'invalid-progress');
  if (value.version !== 1 || !validHouse(value.lastHouse) || !Array.isArray(value.houses) || value.houses.length !== 3) fail('invalid-progress', 'Mission progress is invalid.');
  for (const h of value.houses) {
    exactKeys(h, ['unlocked', 'completed', 'completedAt'], 'invalid-progress');
    if (!validMission(h.unlocked) || !Array.isArray(h.completed) || !record(h.completedAt)) fail('invalid-progress', 'Mission progress is invalid.');
    if (h.completed.some((m) => !validMission(m)) || h.completed.length > 9) fail('invalid-progress', 'Mission progress is invalid.');
    if (Object.entries(h.completedAt).some(([m, at]) => !h.completed.includes(Number(m)) || String(Number(m)) !== m || !Number.isSafeInteger(at) || at < 0)) fail('invalid-progress', 'Mission history is invalid.');
  }
  if (value.lastRun !== null) {
    exactKeys(value.lastRun, ['house', 'mission'], 'invalid-progress');
    if (!validHouse(value.lastRun.house) || !validMission(value.lastRun.mission)) fail('invalid-progress', 'Active mission is invalid.');
  }
  const normalized = normalizeProgress(value);
  if (!equal(value, normalized)) fail('invalid-progress', 'Mission progress is inconsistent.');
  return normalized;
}
// The native payload is authoritative: DSAV v2 ABI and the two campaign RAM
// words must agree with the envelope labels. game/nativeFormat/nativeVersion
// are validated structurally by checkedCompatibility(), not per-byte here.
export function validateNativeSave(state, { house, mission } = {}) {
  if (typeof state !== 'string' || !state.length || state.length % 4 !== 0 || state.length > Math.ceil(MAX_NATIVE_SAVE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(state)) fail('invalid-payload', 'The native save is invalid.');
  let binary;
  try { binary = atob(state); } catch { fail('invalid-payload', 'The native save is invalid.'); }
  if (btoa(binary) !== state) fail('invalid-payload', 'The native save encoding is invalid.');
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytes.length < NATIVE_SAVE_BASE_BYTES || bytes.length > MAX_NATIVE_SAVE_BYTES) fail('invalid-payload', 'The native save has an invalid size.');
  const view = new DataView(bytes.buffer), ymBytes = view.getUint32(8, true);
  if (view.getUint32(0, true) !== 0x56415344 || view.getUint32(4, true) !== 2) fail('incompatible-payload', 'This native save format is not supported.');
  if (view.getUint32(12, true) !== bytes.length || NATIVE_SAVE_BASE_BYTES + ymBytes !== bytes.length) fail('invalid-payload', 'The native save is incomplete.');
  // DuneSaveState.ram starts at byte 94 in the shipped little-endian v2 ABI.
  // Original 68000 words within RAM retain big-endian order (campaign adapter).
  // Absolute offsets: house=49874 ($C274), mission=49326 ($C050); the stored
  // mission word is mission-1.
  const nativeHouse = view.getUint16(NATIVE_HOUSE_OFFSET, false);
  const nativeMission = view.getUint16(NATIVE_MISSION_OFFSET, false) + 1;
  if (!validHouse(nativeHouse) || !validMission(nativeMission)) fail('invalid-payload', 'The native save is not an active campaign mission.');
  if (house !== undefined && (house !== nativeHouse || mission !== nativeMission)) fail('mission-mismatch', 'The save label does not match its original mission.');
  return { bytes: bytes.length, house: nativeHouse, mission: nativeMission };
}
function checkedCompatibility(value) {
  exactKeys(value, ['game', 'nativeFormat', 'nativeVersion', 'nativeBaseBytes', 'engineSha256'], 'incompatible-engine');
  const abi = SAVE_COMPATIBILITY;
  if (value.game !== abi.game || value.nativeFormat !== abi.nativeFormat || value.nativeVersion !== abi.nativeVersion || value.nativeBaseBytes !== abi.nativeBaseBytes) fail('incompatible-engine', 'This save belongs to a different game core.');
  const hash = value.engineSha256;
  // null = export from the new port before NEW_ENGINE_SHA256 was pinned.
  // Everything else must be a hash the old port ever shipped (old files) or the
  // new runtime hash. The hash does not affect how payload bytes are read; the
  // DSAV ABI check above is what actually guarantees compatibility.
  if (hash !== null && (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) fail('incompatible-engine', 'This save belongs to a different game core.');
  if (hash !== null && !acceptedEngineHashes.has(hash)) fail('incompatible-engine', 'This save belongs to a different game core.');
  return { ...value };
}
function checkedContinue(value, progress) {
  if (value === null) return null;
  exactKeys(value, ['version', 'house', 'mission', 'state', 'savedAt'], 'invalid-continue');
  if (value.version !== 2 || !validHouse(value.house) || !validMission(value.mission) || !positiveDate(value.savedAt)) fail('invalid-continue', 'Continue is invalid.');
  validateNativeSave(value.state, value);
  if (progress.houses[value.house].unlocked < value.mission || value.savedAt <= (progress.houses[value.house].completedAt[value.mission] || 0) || !equal(progress.lastRun, { house: value.house, mission: value.mission })) fail('invalid-continue', 'Continue does not match mission progress.');
  return { version: 2, house: value.house, mission: value.mission, state: value.state, savedAt: value.savedAt };
}
function checkedBody(value) {
  exactKeys(value, ['format', 'version', 'compatibility', 'createdAt', 'language', 'progress', 'continue']);
  if (value.format !== SAVE_FILE_FORMAT) fail('wrong-game', 'This is not a Dune Sega web save.');
  if (value.version !== SAVE_FILE_VERSION) fail('incompatible-version', 'This save file version is not supported.');
  const compatibility = checkedCompatibility(value.compatibility);
  if (!positiveDate(value.createdAt) || !['en', 'ru'].includes(value.language)) fail('invalid-format', 'Save metadata is invalid.');
  const progress = checkedProgress(value.progress), current = checkedContinue(value.continue, progress);
  // Retain the original accepted compatibility object, so an imported archive
  // still matches its original checksum. A fresh export records this port's
  // identity instead (see createSaveFile).
  return { format: SAVE_FILE_FORMAT, version: SAVE_FILE_VERSION, compatibility, createdAt: value.createdAt, language: value.language, progress, continue: current };
}
function verified(value) {
  deepFreeze(value);
  verifiedArchives.add(value);
  return value;
}

export async function createSaveFile({ store, language = 'en', now = Date.now() } = {}) {
  if (!store) fail('no-store', 'Save storage is unavailable.');
  const progress = clone(store.progress), slot = store.resumable();
  const current = slot ? { version: 2, house: slot.house, mission: slot.mission, state: slot.state, savedAt: slot.savedAt } : null;
  const body = checkedBody({ format: SAVE_FILE_FORMAT, version: SAVE_FILE_VERSION, compatibility: { ...SAVE_COMPATIBILITY }, createdAt: now, language, progress, continue: current });
  const archive = verified({ ...body, checksum: await digest(body) }), text = JSON.stringify(archive, null, 2) + '\n';
  if (encoder.encode(text).length > MAX_SAVE_FILE_BYTES) fail('too-large', 'The save file is too large.');
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return { archive, text, filename: 'dune-' + stamp + '.dune-save.json' };
}
export async function parseSaveFile(text) {
  if (typeof text !== 'string' || text.length > MAX_SAVE_FILE_BYTES || encoder.encode(text).length > MAX_SAVE_FILE_BYTES) fail('too-large', 'The save file is too large.');
  let value;
  try { value = JSON.parse(text); } catch { fail('invalid-json', 'The save file could not be read.'); }
  exactKeys(value, ['format', 'version', 'compatibility', 'createdAt', 'language', 'progress', 'continue', 'checksum']);
  const { checksum, ...rawBody } = value;
  if (typeof checksum !== 'string' || !/^sha256-[0-9a-f]{64}$/.test(checksum)) fail('invalid-checksum', 'The save checksum is missing or invalid.');
  if (await digest(rawBody) !== checksum) fail('checksum-mismatch', 'The save file is damaged or has been edited.');
  return verified({ ...checkedBody(rawBody), checksum });
}
export function commitSaveFile({ store, archive } = {}) {
  if (!store || !verifiedArchives.has(archive)) fail('unverified', 'Verify the save file before importing it.');
  const storage = store.storage;
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) fail('storage-unavailable', 'The browser cannot safely replace local saves.');
  const current = archive.continue ? clone(archive.continue) : { version: 2, state: null, savedAt: 0 };
  const progress = clone(archive.progress), updates = [
    [CAMPAIGN_KEY, JSON.stringify(progress)], [CONTINUE_KEY, JSON.stringify(current)], [LANGUAGE_KEY, archive.language],
  ];
  const previous = { progress: store.progress, current: store.current, legacyAllowed: store.legacyAllowed, error: store.error };
  let before;
  try { before = new Map(updates.map(([key]) => [key, storage.getItem(key)])); } catch (error) { throw new SaveFileError('storage-unavailable', 'The browser cannot read local saves.', error); }
  const written = [];
  try {
    for (const [key, value] of updates) { storage.setItem(key, value); written.push(key); }
  } catch (error) {
    const rollbackErrors = [];
    for (const key of written.reverse()) {
      try {
        const old = before.get(key);
        if (old === null) storage.removeItem(key); else storage.setItem(key, old);
      } catch (e) { rollbackErrors.push(e); }
    }
    if (rollbackErrors.length) throw new SaveFileError('storage-rollback-failed', 'Local storage failed while restoring the previous save. Keep your exported backup.', new AggregateError([error, ...rollbackErrors]));
    throw new SaveFileError('storage-write-failed', 'The browser could not import the save. Previous saves were kept.', error);
  }
  // In-memory state changes only after all persistent writes succeed. Historic
  // migration slots are retained; the authoritative Continue key supersedes them.
  store.progress = progress;
  store.current = current;
  store.legacyAllowed = false;
  store.error = null;
  let committed = true;
  const rollback = () => {
    if (!committed) return { language: before.get(LANGUAGE_KEY) };
    const errors = [];
    for (const [key] of [...updates].reverse()) {
      try {
        const old = before.get(key);
        if (old === null) storage.removeItem(key); else storage.setItem(key, old);
      } catch (e) { errors.push(e); }
    }
    Object.assign(store, previous);
    committed = false;
    if (errors.length) throw new SaveFileError('storage-rollback-failed', 'The browser could not restore the previous local save. Keep your exported backup.', new AggregateError(errors));
    return { language: before.get(LANGUAGE_KEY) };
  };
  return { language: archive.language, continue: archive.continue ? clone(archive.continue) : null, progress: clone(progress), rollback };
}
