"""On-device WASM emitter for the Dune (Sega Genesis) recompiler.

Pure Python 3.9+ standard library.  The package turns the existing
``genesis_recompiler.decode`` IR (``Program`` / ``Instruction`` / ``EA``) into a
valid WebAssembly module that calls the runtime helpers through imports, exactly
like the C emitter does for the shipped native/browser core.

Public entry points:

* :mod:`tools.wasm_emitter.abi`      -- runtime ABI descriptor and checks;
* :mod:`tools.wasm_emitter.encoder`  -- minimal MVP binary encoder;
* :mod:`tools.wasm_emitter.translate`-- Instruction -> WASM handler bodies;
* :mod:`tools.wasm_emitter.game_module` -- 4 KiB page module assembly;
* :mod:`tools.wasm_emitter.check_page`  -- end-to-end differential CLI.
"""

__all__ = ["abi", "encoder", "translate", "game_module"]
