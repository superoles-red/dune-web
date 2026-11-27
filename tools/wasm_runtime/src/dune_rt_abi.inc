/* ABI / host-glue layer for the pinned runtime v2 (WASM backend, Phase 1).
 *
 * Included from the generated ``.local/wasm-runtime/runtime.c`` *after* the
 * full pinned preamble, so it can see the static ``em_cpu``, ``em_host``,
 * ``g_dune_state_buffer`` and every static helper (read_mem, write_mem, ...).
 *
 * Responsibilities:
 *   - the versioned ``dune_abi_descriptor()`` (u32 words; see abi_spec.py);
 *   - the player ROM buffer (heap, 1 MiB) and ``dune_rt_init()``;
 *   - the game-module function table and the translated_step dispatcher;
 *   - ABI fail codes (numeric reasons for game.wasm);
 *   - ``dune_*`` helper exports so game.wasm imports the CPU helpers directly.
 *
 * It contains no game data and no translated instructions.
 */

#include "dune_abi_layout.h"

/* The descriptor lives in BSS: 140 words, not a data segment. */
static uint32_t dune_abi_words[DUNE_ABI_WORD_COUNT];
static uint8_t *g_rom_buffer = NULL;
static uint32_t g_page_slots[DUNE_ABI_PAGE_SLOTS_VALUE];
static uint32_t g_z80_slot = 0u;
static int g_game_mode = DUNE_ABI_GAME_MODE_NONE_VALUE;
static int g_last_fail_code = 0;
static int g_rt_initialized = 0;
static int g_abi_ready = 0;

/* Generated: dune_abi_fill(), dune_fail_message(), layout static asserts. */
#include "dune_abi_fill.inc"

/* ------------------------------------------------------------------------- */
/* SHA-256 (descriptor integrity hash; no outside dependency in wasm).       */
/* ------------------------------------------------------------------------- */

typedef struct {
    uint32_t state[8];
    uint64_t bits;
    uint8_t block[64];
    uint32_t used;
} DuneSha256;

static const uint32_t dune_sha256_k[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static uint32_t dune_rotr32(uint32_t value, unsigned shift) {
    return (value >> shift) | (value << (32u - shift));
}

static void dune_sha256_init(DuneSha256 *ctx) {
    static const uint32_t initial[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
    };
    memcpy(ctx->state, initial, sizeof initial);
    ctx->bits = 0u;
    ctx->used = 0u;
}

static void dune_sha256_block(DuneSha256 *ctx, const uint8_t *p) {
    uint32_t w[64];
    for (unsigned i = 0; i < 16u; ++i) {
        w[i] = ((uint32_t)p[i * 4u] << 24) | ((uint32_t)p[i * 4u + 1u] << 16) |
               ((uint32_t)p[i * 4u + 2u] << 8) | (uint32_t)p[i * 4u + 3u];
    }
    for (unsigned i = 16u; i < 64u; ++i) {
        uint32_t s0 = dune_rotr32(w[i - 15u], 7) ^ dune_rotr32(w[i - 15u], 18) ^ (w[i - 15u] >> 3);
        uint32_t s1 = dune_rotr32(w[i - 2u], 17) ^ dune_rotr32(w[i - 2u], 19) ^ (w[i - 2u] >> 10);
        w[i] = w[i - 16u] + s0 + w[i - 7u] + s1;
    }
    uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
    uint32_t e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
    for (unsigned i = 0; i < 64u; ++i) {
        uint32_t s1 = dune_rotr32(e, 6) ^ dune_rotr32(e, 11) ^ dune_rotr32(e, 25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = h + s1 + ch + dune_sha256_k[i] + w[i];
        uint32_t s0 = dune_rotr32(a, 2) ^ dune_rotr32(a, 13) ^ dune_rotr32(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = s0 + maj;
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d;
    ctx->state[4] += e; ctx->state[5] += f; ctx->state[6] += g; ctx->state[7] += h;
}

static void dune_sha256_update(DuneSha256 *ctx, const uint8_t *data, size_t size) {
    ctx->bits += (uint64_t)size * 8u;
    while (size) {
        uint32_t space = 64u - ctx->used;
        uint32_t take = space < size ? space : (uint32_t)size;
        memcpy(ctx->block + ctx->used, data, take);
        ctx->used += take;
        data += take;
        size -= take;
        if (ctx->used == 64u) {
            dune_sha256_block(ctx, ctx->block);
            ctx->used = 0u;
        }
    }
}

static void dune_sha256_final(DuneSha256 *ctx, uint8_t out[32]) {
    uint64_t bits = ctx->bits;
    uint8_t tail[128];
    memset(tail, 0, sizeof tail);
    memcpy(tail, ctx->block, ctx->used);
    tail[ctx->used] = 0x80u;
    uint32_t total = ctx->used < 56u ? 64u : 128u;
    for (unsigned i = 0; i < 8u; ++i) tail[total - 1u - i] = (uint8_t)(bits >> (8u * i));
    dune_sha256_block(ctx, tail);
    if (total == 128u) dune_sha256_block(ctx, tail + 64);
    for (unsigned i = 0; i < 8u; ++i) {
        out[i * 4u] = (uint8_t)(ctx->state[i] >> 24);
        out[i * 4u + 1u] = (uint8_t)(ctx->state[i] >> 16);
        out[i * 4u + 2u] = (uint8_t)(ctx->state[i] >> 8);
        out[i * 4u + 3u] = (uint8_t)ctx->state[i];
    }
}

/* ------------------------------------------------------------------------- */
/* Descriptor                                                                */
/* ------------------------------------------------------------------------- */

static void dune_abi_refresh(void) {
    memset(dune_abi_words, 0, sizeof dune_abi_words);
    dune_abi_fill(dune_abi_words);
    dune_abi_words[DUNE_ABI_SIZE] = DUNE_ABI_WORD_COUNT;

    DuneSha256 ctx;
    dune_sha256_init(&ctx);
    for (unsigned r = 0; r < 2u; ++r) {
        /* Two structural ranges; the eight hash words stay zero meanwhile. */
        const unsigned from = r == 0u ? 0u : DUNE_ABI_AFTER_HASH_WORDS;
        const unsigned to = r == 0u ? DUNE_ABI_HASH_FIRST_WORD : DUNE_ABI_LAYOUT_END;
        dune_sha256_update(&ctx, (const uint8_t *)(dune_abi_words + from),
                           (size_t)(to - from) * sizeof(uint32_t));
    }
    uint8_t digest[32];
    dune_sha256_final(&ctx, digest);
    memcpy(dune_abi_words + DUNE_ABI_HASH_FIRST_WORD, digest, sizeof digest);
    g_abi_ready = 1;
}

EMSCRIPTEN_KEEPALIVE uint32_t *dune_abi_descriptor(void) {
    if (!g_abi_ready) dune_abi_refresh();
    return dune_abi_words;
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_abi_word_count(void) {
    return DUNE_ABI_WORD_COUNT;
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_abi_version(void) {
    return DUNE_ABI_VERSION_VALUE;
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_abi_helper_version(void) {
    return DUNE_ABI_HELPER_ABI_VERSION_VALUE;
}

EMSCRIPTEN_KEEPALIVE const uint32_t *dune_abi_hash(void) {
    if (!g_abi_ready) dune_abi_refresh();
    return dune_abi_words + DUNE_ABI_HASH_FIRST_WORD;
}

/* ``hash`` points at eight u32 words; JS compares them with the pinned copy.
   Returns 1 when version + hash match, 0 otherwise. */
EMSCRIPTEN_KEEPALIVE int dune_abi_selfcheck(uint32_t version, const uint32_t *hash) {
    if (!hash || version != DUNE_ABI_VERSION_VALUE) return 0;
    if (!g_abi_ready) dune_abi_refresh();
    return memcmp(hash, dune_abi_words + DUNE_ABI_HASH_FIRST_WORD,
                  DUNE_ABI_HASH_WORD_COUNT * sizeof(uint32_t)) == 0;
}

/* ------------------------------------------------------------------------- */
/* Translated-code dispatch                                                  */
/* ------------------------------------------------------------------------- */

static void dune_fail_code(CPU *c, uint32_t code, uint32_t address) {
    g_last_fail_code = (int)code;
    fail(c, dune_fail_message(code), address);
}

EMSCRIPTEN_KEEPALIVE void dune_fail(uint32_t cpu, uint32_t reason, uint32_t address) {
    dune_fail_code((CPU *)(uintptr_t)cpu, reason, address);
}

EMSCRIPTEN_KEEPALIVE int dune_rt_last_fail_code(void) {
    return g_last_fail_code;
}

EMSCRIPTEN_KEEPALIVE const char *dune_rt_fail_reason(uint32_t code) {
    return dune_fail_message(code);
}

/* Replaces the two forward declarations inside the pinned preamble. */
static void translated_step(CPU *c) {
    const uint32_t pc = c->pc;
    if (pc > 0x00FFFFFFu) { dune_fail_code(c, DUNE_FAIL_BAD_PC, pc); return; }
    if (pc & 1u) { dune_fail_code(c, DUNE_FAIL_ODD_PC, pc); return; }
    if (g_game_mode == DUNE_ABI_GAME_MODE_SINGLE_VALUE) {
        const uint32_t slot = g_page_slots[0];
        if (!slot) { dune_fail_code(c, DUNE_FAIL_UNTRANSLATED, pc); return; }
        ((void (*)(CPU *))(uintptr_t)slot)(c);
        return;
    }
    if (g_game_mode == DUNE_ABI_GAME_MODE_PAGES_VALUE) {
        const uint32_t slot = g_page_slots[pc >> DUNE_ABI_PAGE_SHIFT_VALUE];
        if (!slot) { dune_fail_code(c, DUNE_FAIL_UNTRANSLATED, pc); return; }
        ((void (*)(CPU *))(uintptr_t)slot)(c);
        return;
    }
    dune_fail_code(c, DUNE_FAIL_UNTRANSLATED, pc);
}

static unsigned translated_z80_step(CPU *c) {
    if (!g_z80_slot) {
        dune_fail_code(c, DUNE_FAIL_UNTRANSLATED, c->z80_cpu.pc);
        return 0u;
    }
    return ((unsigned (*)(CPU *))(uintptr_t)g_z80_slot)(c);
}

/* ------------------------------------------------------------------------- */
/* Game module table API                                                     */
/* ------------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE uint32_t *dune_rt_game_table(void) {
    return g_page_slots;
}

EMSCRIPTEN_KEEPALIVE int dune_rt_game_mode(void) {
    return g_game_mode;
}

EMSCRIPTEN_KEEPALIVE int dune_rt_game_table_capacity(void) {
    return (int)DUNE_ABI_PAGE_SLOTS_VALUE;
}

/* count == 2: single dispatcher (game.wasm exports translated_step and
   translated_z80_step).  count == 256 or 4096: per-page handlers, where the
   runtime itself dispatches by pc>>12.  Zero slots mean "no handler". */
EMSCRIPTEN_KEEPALIVE int dune_rt_set_game_table(const uint32_t *table, int count) {
    if (!table) return -1;
    if (count == 2) {
        g_page_slots[0] = table[0];
        g_z80_slot = table[1];
        g_game_mode = DUNE_ABI_GAME_MODE_SINGLE_VALUE;
        return 0;
    }
    if (count != (int)DUNE_ABI_ROM_PAGES_VALUE && count != (int)DUNE_ABI_PAGE_SLOTS_VALUE) return -1;
    if (table == g_page_slots) {
        /* JS filled the runtime-owned table in place: only clear the tail. */
        if (count < (int)DUNE_ABI_PAGE_SLOTS_VALUE) {
            memset(g_page_slots + count, 0,
                   (size_t)((int)DUNE_ABI_PAGE_SLOTS_VALUE - count) * sizeof(uint32_t));
        }
    } else {
        memset(g_page_slots, 0, sizeof g_page_slots);
        for (int i = 0; i < count; ++i) g_page_slots[i] = table[i];
    }
    g_game_mode = DUNE_ABI_GAME_MODE_PAGES_VALUE;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int dune_set_game_steps(uint32_t step_slot, uint32_t z80_slot) {
    g_page_slots[0] = step_slot;
    g_z80_slot = z80_slot;
    g_game_mode = step_slot ? DUNE_ABI_GAME_MODE_SINGLE_VALUE : DUNE_ABI_GAME_MODE_NONE_VALUE;
    return 0;
}

EMSCRIPTEN_KEEPALIVE void dune_rt_set_z80_step(uint32_t slot) {
    g_z80_slot = slot;
}

EMSCRIPTEN_KEEPALIVE void dune_rt_clear_game_table(void) {
    memset(g_page_slots, 0, sizeof g_page_slots);
    g_z80_slot = 0u;
    g_game_mode = DUNE_ABI_GAME_MODE_NONE_VALUE;
}

/* ------------------------------------------------------------------------- */
/* Runtime lifecycle / host-side accessors                                   */
/* ------------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE void dune_rt_init(void) {
    if (!g_rom_buffer) {
        g_rom_buffer = (uint8_t *)malloc((size_t)DUNE_ABI_ROM_CAPACITY_VALUE);
    }
    if (g_rom_buffer) memset(g_rom_buffer, 0, (size_t)DUNE_ABI_ROM_CAPACITY_VALUE);
    memset(&em_cpu, 0, sizeof em_cpu);
    memset(&em_host, 0, sizeof em_host);
    em_window = 0;
    em_cpu.rom = g_rom_buffer;
    em_cpu.rom_size = g_rom_buffer ? (size_t)DUNE_ABI_ROM_CAPACITY_VALUE : 0u;
    em_cpu.sr = 0x2700u;
    em_cpu.io_tx[0] = em_cpu.io_tx[1] = 0xffu;
    em_cpu.io_tx[2] = 0xfbu;
    em_cpu.audio_mode = AUDIO_STUB;
    g_game_mode = DUNE_ABI_GAME_MODE_NONE_VALUE;
    memset(g_page_slots, 0, sizeof g_page_slots);
    g_z80_slot = 0u;
    g_last_fail_code = 0;
    g_rt_initialized = 1;
    dune_abi_refresh();
}

EMSCRIPTEN_KEEPALIVE int dune_rt_initialized(void) {
    return g_rt_initialized;
}

EMSCRIPTEN_KEEPALIVE uint8_t *dune_rt_rom_buffer(void) {
    return g_rom_buffer;
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_rt_rom_capacity(void) {
    return DUNE_ABI_ROM_CAPACITY_VALUE;
}

EMSCRIPTEN_KEEPALIVE uint8_t *dune_rom_ptr(void) {
    return g_rom_buffer;
}

EMSCRIPTEN_KEEPALIVE CPU *dune_cpu_ptr(void) {
    return &em_cpu;
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_rt_save_buffer_capacity(void) {
    return DUNE_ABI_SAVE_BUFFER_BYTES_VALUE;
}

/* Phase-1 host hook: the real emcc host sets em_window from run_main(window=1).
   Tests use it to exercise the DSAV v2 exports without opening a window. */
EMSCRIPTEN_KEEPALIVE void dune_rt_set_window(int enabled) {
    em_window = enabled ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void dune_rt_machine_step(void) {
    machine_step(&em_cpu);
}

EMSCRIPTEN_KEEPALIVE void dune_rt_translated_step(uint32_t cpu) {
    translated_step((CPU *)(uintptr_t)cpu);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_rt_translated_z80_step(uint32_t cpu) {
    return translated_z80_step((CPU *)(uintptr_t)cpu);
}

/* ------------------------------------------------------------------------- */
/* Helper ABI for game.wasm (docs/WASM-BACKEND.md §4.1 / appendix A).        */
/* game.wasm imports these directly; no JS on the instruction path.          */
/* ------------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE uint32_t dune_read_mem(uint32_t cpu, uint32_t address, uint32_t size) {
    return read_mem((CPU *)(uintptr_t)cpu, address, size);
}

EMSCRIPTEN_KEEPALIVE void dune_write_mem(uint32_t cpu, uint32_t address, uint32_t size,
                                         uint32_t value) {
    write_mem((CPU *)(uintptr_t)cpu, address, size, value);
}

EMSCRIPTEN_KEEPALIVE void dune_push32(uint32_t cpu, uint32_t value) {
    push32((CPU *)(uintptr_t)cpu, value);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_pop32(uint32_t cpu) {
    return pop32((CPU *)(uintptr_t)cpu);
}

EMSCRIPTEN_KEEPALIVE void dune_movem(uint32_t cpu, uint32_t mask, uint32_t address,
                                     uint32_t mode, uint32_t base, uint32_t size,
                                     uint32_t load) {
    movem((CPU *)(uintptr_t)cpu, mask, address, mode, base, size, (int)load);
}

EMSCRIPTEN_KEEPALIVE void dune_set_sr(uint32_t cpu, uint32_t sr) {
    set_sr((CPU *)(uintptr_t)cpu, sr);
}

EMSCRIPTEN_KEEPALIVE void dune_logic_flags(uint32_t cpu, uint32_t value, uint32_t size) {
    logic_flags((CPU *)(uintptr_t)cpu, value, size);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_arithmetic(uint32_t cpu, uint32_t dst, uint32_t src,
                                              uint32_t size, uint32_t sub,
                                              uint32_t compare) {
    return arithmetic((CPU *)(uintptr_t)cpu, dst, src, size, (int)sub, (int)compare);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_extended_arithmetic(uint32_t cpu, uint32_t dst,
                                                       uint32_t src, uint32_t size,
                                                       uint32_t sub) {
    return extended_arithmetic((CPU *)(uintptr_t)cpu, dst, src, size, (int)sub);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_bcd_arithmetic(uint32_t cpu, uint32_t dst, uint32_t src,
                                                  uint32_t sub) {
    return bcd_arithmetic((CPU *)(uintptr_t)cpu, dst, src, (int)sub);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_bcd_negate(uint32_t cpu, uint32_t value) {
    return bcd_negate((CPU *)(uintptr_t)cpu, value);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_shift_value(uint32_t cpu, uint32_t value, uint32_t count,
                                               uint32_t size, uint32_t kind,
                                               uint32_t left) {
    return shift_value((CPU *)(uintptr_t)cpu, value, count, size, kind, (int)left);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_divide_value(uint32_t cpu, uint32_t dividend,
                                                uint32_t divisor, uint32_t is_signed) {
    return divide_value((CPU *)(uintptr_t)cpu, dividend, divisor, (int)is_signed);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_condition(uint32_t cpu, uint32_t cond) {
    return condition((CPU *)(uintptr_t)cpu, cond);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_index_value(uint32_t cpu, uint32_t extension) {
    return index_value((CPU *)(uintptr_t)cpu, extension);
}

/* Z80 helpers. */
EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_pair(uint32_t cpu, uint32_t pair) {
    return z80_pair((CPU *)(uintptr_t)cpu, pair);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_set_pair(uint32_t cpu, uint32_t pair, uint32_t value) {
    z80_set_pair((CPU *)(uintptr_t)cpu, pair, (uint16_t)value);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_reg(uint32_t cpu, uint32_t reg) {
    return z80_reg((CPU *)(uintptr_t)cpu, reg);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_set_reg(uint32_t cpu, uint32_t reg, uint32_t value) {
    z80_set_reg((CPU *)(uintptr_t)cpu, reg, (uint8_t)value);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_read(uint32_t cpu, uint32_t address) {
    return z80_read((CPU *)(uintptr_t)cpu, (uint16_t)address);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_write(uint32_t cpu, uint32_t address, uint32_t value) {
    z80_write((CPU *)(uintptr_t)cpu, (uint16_t)address, (uint8_t)value);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_read16(uint32_t cpu, uint32_t address) {
    return z80_read16((CPU *)(uintptr_t)cpu, (uint16_t)address);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_write16(uint32_t cpu, uint32_t address, uint32_t value) {
    z80_write16((CPU *)(uintptr_t)cpu, (uint16_t)address, (uint16_t)value);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_pop(uint32_t cpu) {
    return z80_pop((CPU *)(uintptr_t)cpu);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_push(uint32_t cpu, uint32_t value) {
    z80_push((CPU *)(uintptr_t)cpu, (uint16_t)value);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_m1(uint32_t cpu, uint32_t fetches) {
    z80_m1((CPU *)(uintptr_t)cpu, fetches);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_szxy(uint32_t value) {
    return z80_szxy((uint8_t)value);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_alu(uint32_t cpu, uint32_t kind, uint32_t src) {
    z80_alu((CPU *)(uintptr_t)cpu, kind, (uint8_t)src);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_alu16(uint32_t cpu, uint32_t rhs, uint32_t subtract) {
    z80_alu16((CPU *)(uintptr_t)cpu, (uint16_t)rhs, (int)subtract);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_inc(uint32_t cpu, uint32_t value, uint32_t delta) {
    return z80_inc((CPU *)(uintptr_t)cpu, (uint8_t)value, (int)delta);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_add_pair(uint32_t cpu, uint32_t pair, uint32_t value) {
    z80_add_pair((CPU *)(uintptr_t)cpu, pair, (uint16_t)value);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_add_hl(uint32_t cpu, uint32_t value) {
    z80_add_hl((CPU *)(uintptr_t)cpu, (uint16_t)value);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_condition(uint32_t cpu, uint32_t cond) {
    return z80_condition((CPU *)(uintptr_t)cpu, cond);
}

EMSCRIPTEN_KEEPALIVE void dune_z80_bit(uint32_t cpu, uint32_t value, uint32_t bit,
                                       uint32_t xy) {
    z80_bit((CPU *)(uintptr_t)cpu, (uint8_t)value, bit, (uint8_t)xy);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_block(uint32_t cpu, uint32_t direction,
                                             uint32_t repeat) {
    return (uint32_t)z80_block((CPU *)(uintptr_t)cpu, (int)direction, (int)repeat);
}

EMSCRIPTEN_KEEPALIVE uint32_t dune_z80_rotate(uint32_t cpu, uint32_t value, uint32_t kind) {
    return z80_rotate((CPU *)(uintptr_t)cpu, (uint8_t)value, kind);
}
