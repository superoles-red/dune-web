/* Native C oracle for the WASM emitter differential test.
 *
 * This file is #included by a generated wrapper *after* the player-supplied
 * dune-base.c (with GENESIS_NO_MAIN).  It therefore sees the exact same static
 * translated_step() and helpers the shipped C core was compiled from, and can
 * call any real instruction handler directly.
 *
 * Modes:
 *   --abi                 print the measured CPU/Z80/VDP layout as JSON
 *   --ram-digest SEED     print the deterministic 64 KiB RAM fill digests
 *   --run CASES OUT       run every 68000 case, write the result records
 *   --run-z80 CASES OUT   run every Z80 case (translated_z80_step), write results
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>

#ifndef DUNE_FAIL_MAP
#error "DUNE_FAIL_MAP must point to the generated fail_map.inc"
#endif
#include DUNE_FAIL_MAP

#define CASE_MAGIC "DWC1"
#define OUT_MAGIC  "DWO1"
#define CASE_VERSION 1u
#define CASE_RECORD 96u
#define OUT_RECORD  116u
#define RAM_SIZE 0x10000u
#define HEADER_SIZE 20u
#define Z80_RAM_SIZE 0x2000u
#define Z80_CASE_MAGIC "DZC1"
#define Z80_OUT_MAGIC  "DZO1"
#define Z80_CASE_RECORD 180u
#define Z80_OUT_RECORD  224u
#define Z80_STATE_WORDS 45u

static uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void wr32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

static void fill_ram(uint8_t *ram, uint32_t seed) {
    uint32_t x = seed ? seed : 0x9E3779B9u;
    for (unsigned i = 0; i < RAM_SIZE; ++i) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        ram[i] = (uint8_t)x;
    }
}

static void ram_digest_size(const uint8_t *ram, unsigned size,
                            uint32_t *h1, uint32_t *h2) {
    uint32_t a = 2166136261u, b = 0x9E3779B9u;
    for (unsigned i = 0; i < size; ++i) {
        a = (a ^ ram[i]) * 16777619u;
        b = (b + ram[i]) * 2246822519u;
    }
    *h1 = a; *h2 = b;
}
static void ram_digest(const uint8_t *ram, uint32_t *h1, uint32_t *h2) {
    ram_digest_size(ram, RAM_SIZE, h1, h2);
}
static void z80_ram_digest(const uint8_t *ram, uint32_t *h1, uint32_t *h2) {
    ram_digest_size(ram, Z80_RAM_SIZE, h1, h2);
}

static void init_base(CPU *base) {
    memset(base, 0, sizeof *base);
    base->rom = rom_data;
    base->rom_size = sizeof rom_data;
    base->sr = 0x2700;
}

static int print_abi(void) {
    printf("{\n");
    printf("  \"pointer_bits\": %d,\n", (int)(sizeof(void *) * 8));
    printf("  \"sizeof_cpu\": %zu,\n", sizeof(CPU));
    printf("  \"sizeof_z80cpu\": %zu,\n", sizeof(Z80CPU));
    printf("  \"sizeof_vdp\": %zu,\n", sizeof(VDP));
    printf("  \"sizeof_z80bus\": %zu,\n", sizeof(Z80Bus));
    printf("  \"offsets\": {\n");
    printf("    \"d\": %zu,\n", offsetof(CPU, d));
    printf("    \"a\": %zu,\n", offsetof(CPU, a));
    printf("    \"pc\": %zu,\n", offsetof(CPU, pc));
    printf("    \"usp\": %zu,\n", offsetof(CPU, usp));
    printf("    \"ssp\": %zu,\n", offsetof(CPU, ssp));
    printf("    \"sr\": %zu,\n", offsetof(CPU, sr));
    printf("    \"ram\": %zu,\n", offsetof(CPU, ram));
    printf("    \"steps\": %zu,\n", offsetof(CPU, steps));
    printf("    \"cycles\": %zu,\n", offsetof(CPU, cycles));
    printf("    \"master_cycles\": %zu,\n", offsetof(CPU, master_cycles));
    printf("    \"instruction_cycles\": %zu,\n", offsetof(CPU, instruction_cycles));
    printf("    \"z80_divider\": %zu,\n", offsetof(CPU, z80_divider));
    printf("    \"halted\": %zu,\n", offsetof(CPU, halted));
    printf("    \"fault\": %zu,\n", offsetof(CPU, fault));
    printf("    \"fault_address\": %zu,\n", offsetof(CPU, fault_address));
    printf("    \"z80_cpu\": %zu,\n", offsetof(CPU, z80_cpu));
    printf("    \"z80_bus\": %zu,\n", offsetof(CPU, z80_bus));
    printf("    \"vdp\": %zu,\n", offsetof(CPU, vdp));
    printf("    \"rom\": %zu,\n", offsetof(CPU, rom));
    printf("    \"rom_size\": %zu\n", offsetof(CPU, rom_size));
    printf("  },\n");
    printf("  \"vdp_offsets\": {\n");
    printf("    \"registers\": %zu,\n", offsetof(VDP, registers));
    printf("    \"vram\": %zu,\n", offsetof(VDP, vram));
    printf("    \"cram\": %zu,\n", offsetof(VDP, cram));
    printf("    \"vsram\": %zu,\n", offsetof(VDP, vsram));
    printf("    \"frame\": %zu,\n", offsetof(VDP, frame));
    printf("    \"frame_width\": %zu,\n", offsetof(VDP, frame_width));
    printf("    \"frame_height\": %zu\n", offsetof(VDP, frame_height));
    printf("  },\n");
    printf("  \"z80bus_offsets\": {\"ram\": %zu},\n", offsetof(Z80Bus, ram));
    printf("  \"z80cpu_offsets\": {\"pc\": %zu, \"sp\": %zu, \"cycles\": %zu}\n",
           offsetof(Z80CPU, pc), offsetof(Z80CPU, sp), offsetof(Z80CPU, cycles));
    printf("}\n");
    return 0;
}

static int run_cases(const char *case_path, const char *out_path) {
    FILE *f = fopen(case_path, "rb");
    if (!f) { fprintf(stderr, "oracle: cannot open %s\n", case_path); return 2; }
    uint8_t header[HEADER_SIZE];
    if (fread(header, 1, sizeof header, f) != sizeof header) {
        fprintf(stderr, "oracle: short case header\n"); fclose(f); return 2;
    }
    if (memcmp(header, CASE_MAGIC, 4) != 0 || rd32(header + 4) != CASE_VERSION ||
        rd32(header + 12) != CASE_RECORD || rd32(header + 16) != RAM_SIZE) {
        fprintf(stderr, "oracle: incompatible case file\n"); fclose(f); return 2;
    }
    uint32_t count = rd32(header + 8);
    size_t cases_bytes = (size_t)count * CASE_RECORD;
    uint8_t *cases = (uint8_t *)malloc(cases_bytes ? cases_bytes : 1);
    uint8_t *out = (uint8_t *)malloc((size_t)count * OUT_RECORD + 1);
    if (!cases || !out) { fprintf(stderr, "oracle: out of memory\n"); fclose(f); return 2; }
    if (fread(cases, 1, cases_bytes, f) != cases_bytes) {
        fprintf(stderr, "oracle: short case body\n"); fclose(f); return 2;
    }
    fclose(f);

    CPU base;
    init_base(&base);
    uint8_t *p = out;
    for (uint32_t index = 0; index < count; ++index) {
        const uint8_t *record = cases + (size_t)index * CASE_RECORD;
        CPU c = base;
        for (unsigned i = 0; i < 8; ++i) c.d[i] = rd32(record + i * 4);
        for (unsigned i = 0; i < 8; ++i) c.a[i] = rd32(record + 32 + i * 4);
        c.pc = rd32(record + 64);
        c.usp = rd32(record + 68);
        c.ssp = rd32(record + 72);
        c.sr = (uint16_t)rd32(record + 76);
        c.instruction_cycles = rd32(record + 80);
        c.halted = (int)rd32(record + 84);
        c.fault = 0;
        c.fault_address = 0;
        c.reason = NULL;
        fill_ram(c.ram, rd32(record + 92));
        uint32_t init_h1, init_h2;
        ram_digest(c.ram, &init_h1, &init_h2);
        translated_step(&c);
        uint32_t final_h1, final_h2;
        ram_digest(c.ram, &final_h1, &final_h2);
        unsigned fail_code = 0;
        if (c.fault) {
            fail_code = dune_fail_code(c.reason);
            if (fail_code == 0xFFFFFFFFu) {
                fprintf(stderr, "oracle: unknown fault reason: %s (pc=%06x)\n",
                        c.reason ? c.reason : "(null)", c.pc);
                return 2;
            }
        }
        uint8_t *o = p + (size_t)index * OUT_RECORD;
        for (unsigned i = 0; i < 8; ++i) wr32(o + i * 4, c.d[i]);
        for (unsigned i = 0; i < 8; ++i) wr32(o + 32 + i * 4, c.a[i]);
        wr32(o + 64, c.pc);
        wr32(o + 68, c.usp);
        wr32(o + 72, c.ssp);
        wr32(o + 76, c.sr);
        wr32(o + 80, c.instruction_cycles);
        wr32(o + 84, (uint32_t)c.halted);
        wr32(o + 88, (uint32_t)c.fault);
        wr32(o + 92, c.fault_address);
        wr32(o + 96, fail_code);
        wr32(o + 100, init_h1);
        wr32(o + 104, init_h2);
        wr32(o + 108, final_h1);
        wr32(o + 112, final_h2);
    }
    FILE *g = fopen(out_path, "wb");
    if (!g) { fprintf(stderr, "oracle: cannot create %s\n", out_path); return 2; }
    uint8_t oh[HEADER_SIZE];
    memset(oh, 0, sizeof oh);
    memcpy(oh, OUT_MAGIC, 4);
    wr32(oh + 4, CASE_VERSION);
    wr32(oh + 8, count);
    wr32(oh + 12, OUT_RECORD);
    wr32(oh + 16, RAM_SIZE);
    fwrite(oh, 1, sizeof oh, g);
    fwrite(out, 1, (size_t)count * OUT_RECORD, g);
    fclose(g);
    free(cases);
    free(out);
    printf("oracle: ran %u cases\n", count);
    return 0;
}


static uint64_t rd64(const uint8_t *p) {
    return (uint64_t)rd32(p) | ((uint64_t)rd32(p + 4) << 32);
}
static void wr64(uint8_t *p, uint64_t value) {
    wr32(p, (uint32_t)value);
    wr32(p + 4, (uint32_t)(value >> 32));
}

/* Run Z80 cases through the real generated ``translated_z80_step``.  The CPU is
 * rebuilt from the case record for every run (zeroed, audio_mode as requested,
 * both RAM images filled deterministically), so cases are independent and the
 * WASM harness can reproduce the same initial state.  The 68000 side is left at
 * PC=0: only the Z80-side bus/audio/register state is under test. */
static int run_z80_cases(const char *case_path, const char *out_path) {
    FILE *f = fopen(case_path, "rb");
    if (!f) { fprintf(stderr, "oracle: cannot open %s\n", case_path); return 2; }
    uint8_t header[HEADER_SIZE];
    if (fread(header, 1, sizeof header, f) != sizeof header) {
        fprintf(stderr, "oracle: short Z80 case header\n"); fclose(f); return 2;
    }
    if (memcmp(header, Z80_CASE_MAGIC, 4) != 0 || rd32(header + 4) != CASE_VERSION ||
        rd32(header + 12) != Z80_CASE_RECORD) {
        fprintf(stderr, "oracle: incompatible Z80 case file\n"); fclose(f); return 2;
    }
    uint32_t count = rd32(header + 8);
    size_t cases_bytes = (size_t)count * Z80_CASE_RECORD;
    uint8_t *cases = (uint8_t *)malloc(cases_bytes ? cases_bytes : 1);
    uint8_t *out = (uint8_t *)malloc((size_t)count * Z80_OUT_RECORD + 1);
    if (!cases || !out) { fprintf(stderr, "oracle: out of memory\n"); fclose(f); return 2; }
    if (fread(cases, 1, cases_bytes, f) != cases_bytes) {
        fprintf(stderr, "oracle: short Z80 case body\n"); fclose(f); return 2;
    }
    fclose(f);

    CPU base;
    memset(&base, 0, sizeof base);
    base.rom = rom_data;
    base.rom_size = sizeof rom_data;
    base.sr = 0x2700;
    uint8_t *z80ram = (uint8_t *)malloc(Z80_RAM_SIZE);
    if (!z80ram) { fprintf(stderr, "oracle: out of memory\n"); return 2; }

    uint8_t *p = out;
    for (uint32_t index = 0; index < count; ++index) {
        const uint8_t *r = cases + (size_t)index * Z80_CASE_RECORD;
        CPU c = base;
        Z80CPU *z = &c.z80_cpu;
        for (unsigned i = 0; i < 6; ++i) z->r8[i] = (uint8_t)rd32(r + i * 4);
        for (unsigned i = 0; i < 6; ++i) z->alternate[i] = (uint8_t)rd32(r + 24 + i * 4);
        z->a = (uint8_t)rd32(r + 48);
        z->f = (uint8_t)rd32(r + 52);
        z->a_alt = (uint8_t)rd32(r + 56);
        z->f_alt = (uint8_t)rd32(r + 60);
        z->i = (uint8_t)rd32(r + 64);
        z->r = (uint8_t)rd32(r + 68);
        z->iff1 = (uint8_t)rd32(r + 72);
        z->iff2 = (uint8_t)rd32(r + 76);
        z->im = (uint8_t)rd32(r + 80);
        z->halted = (uint8_t)rd32(r + 84);
        z->irq_line = (uint8_t)rd32(r + 88);
        z->ei_delay = (uint8_t)rd32(r + 92);
        z->pc = (uint16_t)rd32(r + 96);
        z->sp = (uint16_t)rd32(r + 100);
        z->ix = (uint16_t)rd32(r + 104);
        z->iy = (uint16_t)rd32(r + 108);
        z->wz = (uint16_t)rd32(r + 112);
        z->debt = (int64_t)rd64(r + 116);
        z->steps = rd64(r + 124);
        z->cycles = rd64(r + 132);
        z->interrupts = rd64(r + 140);
        c.audio_mode = (int)rd32(r + 148);
        c.z80_bus.bank = (uint16_t)rd32(r + 152);
        c.z80_bus.requested = (uint8_t)rd32(r + 156);
        c.z80_bus.reset_released = (uint8_t)rd32(r + 160);
        uint32_t seed_z80 = rd32(r + 164);
        uint32_t seed_ram = rd32(r + 168);

        /* deterministic images, same xorshift32 as the 68000 harness */
        uint32_t x = seed_z80 ? seed_z80 : 0x9E3779B9u;
        for (unsigned i = 0; i < Z80_RAM_SIZE; ++i) {
            x ^= x << 13; x ^= x >> 17; x ^= x << 5;
            z80ram[i] = (uint8_t)x;
        }
        memcpy(c.z80_bus.ram, z80ram, Z80_RAM_SIZE);
        fill_ram(c.ram, seed_ram);
        /* Execute the selected guarded variant: write its bytes at pc&0x1fff. */
        uint32_t patch_len = rd32(r + 172);
        uint32_t patch_bits = rd32(r + 176);
        if (patch_len > 4) { fprintf(stderr, "oracle: bad patch length\n"); return 2; }
        for (uint32_t i = 0; i < patch_len; ++i) {
            c.z80_bus.ram[(z->pc + i) & 0x1FFF] = (uint8_t)(patch_bits >> (8 * i));
        }

        uint32_t z80_h1, z80_h2, ram_h1, ram_h2;
        z80_ram_digest(c.z80_bus.ram, &z80_h1, &z80_h2);
        ram_digest(c.ram, &ram_h1, &ram_h2);
        c.fault = 0;
        c.fault_address = 0;
        c.reason = NULL;

        unsigned cycles = translated_z80_step(&c);
        (void)cycles;

        uint8_t *o = p + (size_t)index * Z80_OUT_RECORD;
        /* echo the input state words, then the final state overwrites them */
        for (unsigned i = 0; i < Z80_STATE_WORDS; ++i) wr32(o + i * 4, rd32(r + i * 4));
        for (unsigned i = 0; i < 6; ++i) wr32(o + i * 4, z->r8[i]);
        for (unsigned i = 0; i < 6; ++i) wr32(o + 24 + i * 4, z->alternate[i]);
        wr32(o + 48, z->a); wr32(o + 52, z->f);
        wr32(o + 56, z->a_alt); wr32(o + 60, z->f_alt);
        wr32(o + 64, z->i); wr32(o + 68, z->r);
        wr32(o + 72, z->iff1); wr32(o + 76, z->iff2);
        wr32(o + 80, z->im); wr32(o + 84, z->halted);
        wr32(o + 88, z->irq_line); wr32(o + 92, z->ei_delay);
        wr32(o + 96, z->pc); wr32(o + 100, z->sp);
        wr32(o + 104, z->ix); wr32(o + 108, z->iy);
        wr32(o + 112, z->wz);
        wr64(o + 116, (uint64_t)z->debt);
        wr64(o + 124, z->steps);
        wr64(o + 132, z->cycles);
        wr64(o + 140, z->interrupts);
        wr32(o + 148, (uint32_t)c.audio_mode);
        wr32(o + 152, c.z80_bus.bank);
        wr32(o + 156, c.z80_bus.requested);
        wr32(o + 160, c.z80_bus.reset_released);
        wr32(o + 164, seed_z80);
        wr32(o + 168, seed_ram);
        unsigned fail_code = 0;
        if (c.fault) {
            fail_code = dune_fail_code(c.reason);
            if (fail_code == 0xFFFFFFFFu) {
                fprintf(stderr, "oracle: unknown Z80 fault reason: %s (pc=%04x)\n",
                        c.reason ? c.reason : "(null)", z->pc);
                return 2;
            }
        }
        wr32(o + 180, (uint32_t)c.fault);
        wr32(o + 184, c.fault_address);
        wr32(o + 188, fail_code);
        wr32(o + 192, z80_h1); wr32(o + 196, z80_h2);
        wr32(o + 200, ram_h1); wr32(o + 204, ram_h2);
        z80_ram_digest(c.z80_bus.ram, &z80_h1, &z80_h2);
        ram_digest(c.ram, &ram_h1, &ram_h2);
        wr32(o + 208, z80_h1); wr32(o + 212, z80_h2);
        wr32(o + 216, ram_h1); wr32(o + 220, ram_h2);
    }
    free(z80ram);
    FILE *g = fopen(out_path, "wb");
    if (!g) { fprintf(stderr, "oracle: cannot create %s\n", out_path); return 2; }
    uint8_t oh[HEADER_SIZE];
    memset(oh, 0, sizeof oh);
    memcpy(oh, Z80_OUT_MAGIC, 4);
    wr32(oh + 4, CASE_VERSION);
    wr32(oh + 8, count);
    wr32(oh + 12, Z80_OUT_RECORD);
    wr32(oh + 16, Z80_RAM_SIZE);
    fwrite(oh, 1, sizeof oh, g);
    fwrite(out, 1, (size_t)count * Z80_OUT_RECORD, g);
    fclose(g);
    free(cases);
    free(out);
    printf("oracle: ran %u Z80 cases\n", count);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--abi") == 0) return print_abi();
    if (argc == 3 && strcmp(argv[1], "--ram-digest") == 0) {
        uint8_t *ram = (uint8_t *)malloc(RAM_SIZE);
        if (!ram) return 2;
        fill_ram(ram, (uint32_t)strtoul(argv[2], NULL, 0));
        uint32_t h1, h2;
        ram_digest(ram, &h1, &h2);
        printf("%u %u\n", h1, h2);
        free(ram);
        return 0;
    }
    if (argc == 4 && strcmp(argv[1], "--run") == 0) return run_cases(argv[2], argv[3]);
    if (argc == 4 && strcmp(argv[1], "--run-z80") == 0) return run_z80_cases(argv[2], argv[3]);
    fprintf(stderr, "usage: %s --abi | --ram-digest SEED | --run CASES OUT | --run-z80 CASES OUT\n", argv[0]);
    return 2;
}
