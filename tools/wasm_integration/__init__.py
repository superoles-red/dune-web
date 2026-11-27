"""Phase-3 integration layer: generated ``game.wasm`` linked to ``runtime.wasm``.

The emitter in :mod:`tools.wasm_emitter` can already build a real page module,
but it was validated against a *native* C oracle ABI (64-bit pointers) and a JS
port of the runtime helpers.  This package closes the remaining gap:

* ``runtime_abi.py`` reads the ABI descriptor out of the real
  ``runtime/wasm/runtime.wasm`` (through ``runtime/wasm/loader.mjs`` in Node) and
  turns it into an emitter ``CpuAbi``/``MemoryLayout`` -- no native numbers;
* ``build_page_module.py`` emits one real ROM page as ``game.wasm`` against that
  ABI (``env.memory`` + ``env.dune_*`` imports, wasm32 CPU layout);
* ``link_and_run.mjs`` instantiates ``runtime.wasm`` and ``game.wasm`` together,
  installs the game functions into the runtime's funcref table, copies the ROM
  into ``dune_rt_rom_buffer()`` and runs the differential cases through
  ``dune_rt_translated_step`` / ``dune_rt_machine_step``;
* ``check_integration.py`` is the one command that does all of the above plus
  the native C oracle comparison;
* ``build_full_module.py`` emits the single all-pages ``game.wasm`` (48 pages /
  40 382 instructions for Dune USA) with the honest ``translated_z80_step``
  UNTRANSLATED stub -- see ``docs/WASM-FULL-MODULE.md``;
* ``check_full_integration.py`` runs the linked differential of that full module
  across every page (the native C oracle comparison included).

Only stdlib Python and Node are used; no emsdk is required.
"""

from __future__ import annotations

__all__ = []
