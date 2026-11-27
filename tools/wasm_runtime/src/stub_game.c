/* Phase-1 stub of the device-generated ``game.wasm``.
 *
 * This is the *game side* of the two-module link: it has no libc, no stack
 * frames worth speaking of, no data segment and no memory of its own.  It
 * imports the shared linear memory plus the runtime helpers it needs, receives
 * the ABI-descriptor pointer from JS and exports a handful of page handlers.
 *
 * It is compiled freestanding (clang --target=wasm32 + wasm-ld) so it stays a
 * code-only module, exactly like the real emitter output will be:
 *
 *   clang --target=wasm32 -O2 -nostdlib -ffreestanding -fno-builtin -c ...
 *   wasm-ld --no-entry --import-memory --allow-undefined \
 *           --global-base=<high> --export=... -o stub_game.wasm
 *
 * Handlers used by tests/wasm_runtime/runtime.test.mjs:
 *
 *   stub_page_00          no-op: cycles=4, pc += 2
 *   stub_page_01          RAM write: [0xFF0010] = 0xA5, cycles=4, pc += 2
 *   stub_page_02          RAM write: [0xFF0011] = 0x5A, cycles=8, pc += 2
 *   stub_page_ff0         RAM page: cycles=6, pc += 4
 *   stub_translated_step  single-dispatcher mode: RAM[0x20] = ROM[0x200]
 *   stub_translated_z80_step  returns 8 Z80 cycles
 *   stub_warmup_all       no-op page warm-up entry point
 *
 * The real emitter will emit C/WASM with identical ABI offsets and helper
 * imports; only the handler bodies change.
 */

#include "dune_abi_layout.h"

typedef unsigned int u32;
typedef struct CPU CPU;

/* Set by stub_game_init() from dune_abi_descriptor(). */
static u32 g_abi = 0u;

__attribute__((import_module("env"), import_name("dune_write_mem")))
extern void dune_write_mem(CPU *c, u32 address, u32 size, u32 value);
__attribute__((import_module("env"), import_name("dune_read_mem")))
extern u32 dune_read_mem(CPU *c, u32 address, u32 size);

#define ABI_WORD(index) (*(volatile u32 *)(g_abi + (u32)(index) * 4u))
#define CPU_ADDR(cpu, index) ((u32)(cpu) + ABI_WORD(index))
#define CPU_FIELD(cpu, index) (*(volatile u32 *)CPU_ADDR(cpu, index))
#define CPU_FIELD8(cpu, index) (*(volatile unsigned char *)CPU_ADDR(cpu, index))

#define GET_PC(cpu) CPU_FIELD(cpu, DUNE_ABI_OFF_PC)
#define SET_PC(cpu, value) (CPU_FIELD(cpu, DUNE_ABI_OFF_PC) = (u32)(value))
#define SET_CYCLES(cpu, value) (CPU_FIELD(cpu, DUNE_ABI_OFF_INSTRUCTION_CYCLES) = (u32)(value))
#define FAULTED(cpu) CPU_FIELD(cpu, DUNE_ABI_OFF_FAULT)

__attribute__((export_name("stub_game_init")))
void stub_game_init(u32 abi_descriptor) {
    g_abi = abi_descriptor;
}

__attribute__((export_name("stub_game_abi")))
u32 stub_game_abi(void) {
    return g_abi;
}

__attribute__((export_name("stub_page_00")))
void stub_page_00(CPU *c) {
    SET_CYCLES(c, 4u);
    SET_PC(c, GET_PC(c) + 2u);
}

__attribute__((export_name("stub_page_01")))
void stub_page_01(CPU *c) {
    SET_CYCLES(c, 4u);
    dune_write_mem(c, 0xFF0010u, 1u, 0xA5u);
    if (FAULTED(c)) return;
    SET_PC(c, GET_PC(c) + 2u);
}

__attribute__((export_name("stub_page_02")))
void stub_page_02(CPU *c) {
    SET_CYCLES(c, 8u);
    dune_write_mem(c, 0xFF0011u, 1u, 0x5Au);
    if (FAULTED(c)) return;
    SET_PC(c, GET_PC(c) + 2u);
}

__attribute__((export_name("stub_page_ff0")))
void stub_page_ff0(CPU *c) {
    SET_CYCLES(c, 6u);
    SET_PC(c, GET_PC(c) + 4u);
}

/* Single-dispatcher mode (the shape docs/WASM-BACKEND.md §4.2 describes):
   the game reads one ROM byte through the helper ABI and mirrors it into RAM. */
__attribute__((export_name("stub_translated_step")))
void stub_translated_step(CPU *c) {
    SET_CYCLES(c, 4u);
    const u32 value = dune_read_mem(c, 0x200u, 1u);
    if (FAULTED(c)) return;
    dune_write_mem(c, 0xFF0020u, 1u, value);
    if (FAULTED(c)) return;
    SET_PC(c, GET_PC(c) + 2u);
}

__attribute__((export_name("stub_translated_z80_step")))
u32 stub_translated_z80_step(CPU *c) {
    (void)c;
    return 8u;
}

__attribute__((export_name("stub_warmup_all")))
void stub_warmup_all(CPU *c) {
    (void)c;
}
