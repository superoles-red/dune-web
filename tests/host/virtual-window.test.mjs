// Fast Node-level test for the path-A virtual SDL window (no ROM/Chrome needed).
//
// Instantiates the shipped runtime/wasm/runtime.wasm with the loader's
// virtual-window mocks, fakes only the VDP frame size through the versioned ABI
// descriptor, and proves:
//   * dune_web_camera_geometry() flips from "{}" to a real 320x224 projection
//     once dune_web_attach_virtual_window() runs (the SDL_GetWindowSize /
//     SDL_GetRendererOutputSize link wrappers answer the virtual size);
//   * the attach getters and dune_web_resize() track the virtual surface;
//   * a tap is classified by the pinned adapters instead of returning 0;
//   * the expanded-overview export stays unavailable outside the mission map;
//   * the ABI descriptor hash is still fb47e138… (attach is exports only).
//
// The full tap/pan/zoom-on-real-mission behaviour needs the ROM and lives in
// tests/host/touch.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNTIME_DIR = path.join(ROOT, 'runtime', 'wasm');
const RUNTIME_WASM = path.join(RUNTIME_DIR, 'runtime.wasm');
const LOADER = path.join(RUNTIME_DIR, 'loader.mjs');
const MANIFEST = path.join(RUNTIME_DIR, 'manifest.json');
const ABI_JSON = path.join(RUNTIME_DIR, 'abi.json');
const PINNED_ABI_HASH = 'fb47e1386ee5c802a2cb2a58b98ec29367db79e00c7f32b355020abbc4be1db5';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

if (!existsSync(RUNTIME_WASM) || !existsSync(LOADER)) {
  test('virtual SDL window geometry and attach', { skip: 'runtime/wasm artifacts missing (build them first)' }, () => {});
} else {
  const loader = await import(LOADER);
  const manifest = readJson(MANIFEST);
  const runtimeBytes = readFileSync(RUNTIME_WASM);

  test('virtual SDL window geometry and attach', async () => {
    assert.equal(loader.attachVirtualWindow !== undefined, true, 'loader.mjs must export attachVirtualWindow');

    const rt = await loader.loadRuntime({
      wasmBytes: runtimeBytes,
      virtualWindow: { width: 320, height: 224 },
    });
    const abi = loader.initRuntime(rt);
    const view = new DataView(rt.memory.buffer);
    const cpu = abi.fields.ADDR_CPU;
    // Pretend the VDP has produced a 320x224 frame (no game module needed).
    view.setUint32(cpu + abi.fields.OFF_VDP_FRAME_WIDTH, 320, true);
    view.setUint32(cpu + abi.fields.OFF_VDP_FRAME_HEIGHT, 224, true);

    const cameraJson = () => JSON.parse(loader.cString(rt, rt.exports.dune_web_camera_debug()));
    assert.deepEqual(cameraJson(), {}, 'without a window every adapter must bail out with {}');

    for (const name of [
      'dune_web_attach_virtual_window',
      'dune_web_virtual_window_attached',
      'dune_web_virtual_window_width',
      'dune_web_virtual_window_height',
      'dune_web_expanded_frame_rgba',
      'dune_web_expanded_frame_width',
      'dune_web_expanded_frame_height',
      'dune_rt_web_step',
    ]) {
      assert.equal(typeof rt.exports[name], 'function', `missing runtime export ${name}`);
    }
    assert.equal(rt.exports.dune_web_expanded_frame_rgba(), 0, 'expanded overview needs the mission map');

    assert.equal(loader.attachVirtualWindow(rt, 320, 224), 1);
    assert.equal(rt.exports.dune_web_virtual_window_attached(), 1);
    assert.equal(rt.exports.dune_web_virtual_window_width(), 320);
    assert.equal(rt.exports.dune_web_virtual_window_height(), 224);

    const camera = cameraJson();
    assert.equal(camera.width, 320);
    assert.equal(camera.height, 224);
    assert.equal(camera.cssWidth, 320, 'loader CSS mock must report the virtual width');
    assert.equal(camera.cssHeight, 224);
    assert.equal(camera.outputWidth, 320);
    assert.equal(camera.outputHeight, 224);
    assert.equal(camera.scale, 1, 'zoom 100 on a 320x224 surface must be 1:1');
    // No rendered mission frame yet, so the adapters classify this as native UI
    // (context 2) rather than world (1) — but not 0: the virtual window works.
    assert.ok(rt.exports.dune_web_tap_screen(160, 112) > 0, 'tap adapter still returns 0 with a virtual window');
    assert.ok(rt.exports.dune_web_hover_screen(160, 112) > 0, 'hover adapter still returns 0 with a virtual window');

    // dune_web_resize() goes through the wrapped SDL_SetWindowSize and updates
    // the virtual surface; the adapters keep working at the new size.
    assert.equal(rt.exports.dune_web_resize(400, 300), 1);
    assert.equal(rt.exports.dune_web_virtual_window_width(), 400);
    assert.equal(rt.exports.dune_web_virtual_window_height(), 300);
    const resized = cameraJson();
    // The loader CSS mock keeps the page's CSS size; the resized virtual window
    // is the SDL/drawable size the geometry reports as outputWidth/Height.
    assert.equal(resized.cssWidth, 320);
    assert.equal(resized.outputWidth, 400);
    assert.equal(resized.outputHeight, 300);
    assert.equal(rt.exports.dune_web_resize(320, 224), 1);

    // Attach is exports-only: the ABI descriptor and the pinned DSAV numbers hold.
    const abiJson = readJson(ABI_JSON);
    assert.equal(abiJson.runtime_sha256, manifest.wasm.sha256);
    assert.equal(abiJson.runtime_bytes, manifest.wasm.bytes);
    assert.equal(abiJson.abi_hash, PINNED_ABI_HASH);
    assert.equal(manifest.abi.abi_hash, PINNED_ABI_HASH);
    assert.equal(abi.fields.SIZEOF_SAVESTATE, 140056);
    assert.equal(abi.fields.SAVESTATE_VERSION, 2);

    // dune_rt_web_step() runs the input observers and one machine step.  With
    // no game module installed the zeroed PC faults UNTRANSLATED, which is the
    // normal Phase-1 behaviour — the point is that it does not crash while the
    // virtual window is attached.
    rt.exports.dune_rt_set_window(1);
    rt.exports.dune_rt_web_step();
  });
}
