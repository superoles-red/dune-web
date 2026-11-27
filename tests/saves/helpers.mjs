// Shared synthetic fixtures for the save-subsystem tests.
//
// BYOP rule: no ROM bytes, no real save files. Every native payload here is a
// zero-filled buffer with only the DSAV header and the two documented campaign
// RAM words written, built at test time and never stored in the repository.
import { createHash } from 'node:crypto';
import {
  NATIVE_HOUSE_ADDRESS, NATIVE_MISSION_ADDRESS, NATIVE_RAM_OFFSET, NATIVE_SAVE_BASE_BYTES,
  SAVE_FILE_FORMAT, SAVE_FILE_VERSION,
} from '../../web/saves/save-files.mjs';

export const LEGACY_CORE_SHA256 = '6a8da54436ec0946eb5952319fab7cab0b05ca8eced683af24449ce315fb0155';

export const clone = (value) => JSON.parse(JSON.stringify(value));

export const memory = () => {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
};

// Same canonicalisation as the module under test: sorted keys, JSON primitives.
export const canonical = (value) => Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : value !== null && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);

export const checksumOf = (body) => 'sha256-' + createHash('sha256').update(canonical(body)).digest('hex');
export const seal = (body) => ({ ...body, checksum: checksumOf(body) });
export const sealText = (body) => JSON.stringify(seal(body));

// Re-sign an already verified archive after mutating a copy of its body.
export function resigned(archive, mutate) {
  const value = clone(archive);
  delete value.checksum;
  mutate(value);
  return JSON.stringify({ ...value, checksum: checksumOf(value) });
}

// Synthetic DSAV v2 payload: 140056-byte DuneSaveState (zeroed) + optional YM
// tail. `mission` is the 1-based mission; the stored word is mission-1.
export function nativeBytes({ house = 1, mission = 3, ymSize = 0, magic = 0x56415344, version = 2, totalSize, houseWord, missionWord } = {}) {
  const bytes = Buffer.alloc(NATIVE_SAVE_BASE_BYTES + ymSize);
  bytes.writeUInt32LE(magic, 0);
  bytes.writeUInt32LE(version, 4);
  bytes.writeUInt32LE(ymSize, 8);
  bytes.writeUInt32LE(totalSize ?? bytes.length, 12);
  const houseOffset = NATIVE_RAM_OFFSET + NATIVE_HOUSE_ADDRESS;
  const missionOffset = NATIVE_RAM_OFFSET + NATIVE_MISSION_ADDRESS;
  bytes.writeUInt16BE(houseWord ?? house, houseOffset);
  bytes.writeUInt16BE(missionWord ?? (mission - 1), missionOffset);
  return bytes;
}

export const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

export function syntheticPayload(options = {}) {
  return toBase64(nativeBytes(options));
}

// Envelope body in the old port's exact shape (v1, old compatibility object).
export function oldEnvelopeBody({ progress, slot, language = 'ru', createdAt = 1793000000000, engineSha256 = LEGACY_CORE_SHA256, native = {} } = {}) {
  return {
    format: SAVE_FILE_FORMAT,
    version: SAVE_FILE_VERSION,
    compatibility: {
      game: 'dune-sega-usa',
      nativeFormat: 'DSAV',
      nativeVersion: 2,
      nativeBaseBytes: NATIVE_SAVE_BASE_BYTES,
      engineSha256,
    },
    createdAt,
    language,
    progress: clone(progress),
    continue: slot ? { version: 2, house: slot.house, mission: slot.mission, state: slot.state, savedAt: slot.savedAt } : null,
    ...native,
  };
}
