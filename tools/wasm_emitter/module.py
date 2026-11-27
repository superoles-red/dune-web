"""Low-level WASM module assembly API.

The binary encoder lives in :mod:`wasm_emitter.encoder`; the game-module builder
(imports, page functions, ``br_table`` dispatch, funcref table, exports) lives in
:mod:`wasm_emitter.game_module` -- it is large and tested there.  This module is
the documented entry point for callers that only need to assemble a module:

    from tools.wasm_emitter import abi, game_module, module

    module.ModuleBuilder(abi_desc, memory).build(handlers, variants)
    module.build_page_module(program, 0x13, abi_desc, memory)
    module.build_module(program, instructions, abi_desc, memory)

Keeping the facade separate matches the design document's file layout
(``abi.py`` / ``module.py`` / ``translate.py`` / ``game_module.py``) without
duplicating the builder.
"""

from __future__ import annotations

from .encoder import Code, Func, Module, I32
from .game_module import (
    CHUNKS_PER_PAGE,
    ModuleBuilder,
    PAGE_SHIFT,
    PAGE_SIZE,
    RAM_PAGE_BASE,
    RAM_PAGE_COUNT,
    SLOTS_PER_CHUNK,
    SLOTS_PER_PAGE,
    WARMUP_PC,
    build_module,
    build_page_module,
    page_of,
    slot_of,
    unsupported_ops,
)

__all__ = [
    "Code",
    "Func",
    "Module",
    "I32",
    "ModuleBuilder",
    "build_module",
    "build_page_module",
    "unsupported_ops",
    "slot_of",
    "page_of",
    "PAGE_SHIFT",
    "PAGE_SIZE",
    "SLOTS_PER_PAGE",
    "SLOTS_PER_CHUNK",
    "CHUNKS_PER_PAGE",
    "RAM_PAGE_BASE",
    "RAM_PAGE_COUNT",
    "WARMUP_PC",
]
