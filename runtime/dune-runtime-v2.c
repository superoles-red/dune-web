/* MC68000 and Genesis bus. Instruction-boundary NTSC/PAL device scheduling. */
#ifndef GENESIS_RUNTIME_H
#define GENESIS_RUNTIME_H
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <inttypes.h>
/* Functional Mode 5 VDP state. Transfers complete synchronously; no renderer. */
#ifndef GENESIS_VDP_STATE_H
#define GENESIS_VDP_STATE_H
typedef struct {
    uint8_t registers[24], vram[65536];
    uint16_t cram[64], vsram[40];
    uint16_t address, bus_value;
    uint8_t code, command_pending, fill_pending;
    uint64_t data_reads, data_writes, dma_bytes;
    uint16_t line, line_clock;
    uint8_t hint_counter, irq_h, irq_v, vint_status, pal;
    uint64_t frames;
    uint8_t frame[320*240*3], render_unsupported;
    uint16_t frame_width, frame_height;
    uint64_t rendered_frames;
} VDP;
#endif

#ifndef GENESIS_Z80_BUS_STATE_H
#define GENESIS_Z80_BUS_STATE_H
typedef struct {
    uint8_t ram[8192];
    uint8_t requested, reset_released;
    uint16_t bank;
    uint64_t ram_writes;
} Z80Bus;
#endif

#ifndef GENESIS_Z80_CPU_STATE_H
#define GENESIS_Z80_CPU_STATE_H
enum { Z_C=1, Z_N=2, Z_PV=4, Z_X=8, Z_H=16, Z_Y=32, Z_Z=64, Z_S=128 };
typedef struct {
    uint8_t r8[6], alternate[6], a, f, a_alt, f_alt, i, r, iff1, iff2, im, halted;
    uint8_t irq_line, ei_delay;
    uint16_t pc, sp, ix, iy, wz;
    int64_t debt;
    uint64_t steps, cycles, interrupts;
} Z80CPU;
#endif

#ifndef GENESIS_PSG_STATE_H
#define GENESIS_PSG_STATE_H
typedef struct {
    uint16_t tone[3];
    uint8_t volume[4], noise, latch;
    uint16_t noise_lfsr;
    uint64_t writes;
    uint16_t counter[4];
    uint8_t polarity;
    uint64_t cursor, next_tick;
    int64_t area;
} PSG;
#endif

#ifndef GENESIS_EEPROM_STATE_H
#define GENESIS_EEPROM_STATE_H
/* EA X24C01: 128 bytes, direct 7-bit address + R/W, four-byte write page. */
enum { EE_IDLE, EE_ADDRESS, EE_ADDRESS_ACK, EE_WRITE, EE_WRITE_ACK, EE_READ, EE_READ_ACK, EE_WAIT };
typedef struct {
    uint8_t data[128], pending[4], dirty, page;
    uint8_t enabled, initialized, sda, scl, output, phase, bits, shift, address, reading, ack_clock, master_ack;
    uint64_t starts, stops, reads, writes;
} EEPROM;
#endif

#ifndef GENESIS_AUDIO_STUB_STATE_H
#define GENESIS_AUDIO_STUB_STATE_H
typedef struct {
    uint8_t address[2], registers[2][256];
    uint64_t writes;
} YM2612Stub;
#endif

#ifndef GENESIS_AUDIO_STATE_H
#define GENESIS_AUDIO_STATE_H
/* C ABI for the optional BSD-licensed ymfm YM2612 sound backend. */
#ifndef GENESIS_AUDIO_BACKEND_H
#define GENESIS_AUDIO_BACKEND_H
#include <stdint.h>
#include <stddef.h>
#ifdef GENESIS_AUDIO
#ifdef __cplusplus
extern "C" {
#endif
void *genesis_ymfm_create(void);
void genesis_ymfm_destroy(void *chip);
void genesis_ymfm_reset(void *chip);
void genesis_ymfm_advance(void *chip, uint64_t master, int32_t stereo[2]);
uint8_t genesis_ymfm_read(void *chip, unsigned port);
void genesis_ymfm_write(void *chip, unsigned port, uint8_t value);
size_t genesis_ymfm_state_size(void *chip);
int genesis_ymfm_save_state(void *chip, uint8_t *bytes, size_t size);
void *genesis_ymfm_load_state(const uint8_t *bytes, size_t size);
#ifdef __cplusplus
}
#endif
#endif
#endif

enum { AUDIO_RATE=48000, AUDIO_RING_FRAMES=4096, AUDIO_WAV_FRAMES=1024 };
typedef struct {
    void *fm;
    FILE *wav;
    uint64_t cursor, next_sample, sample_index, frames, wav_bytes, dropped;
    int32_t previous_input[2], filter[2];
    int16_t ring[AUDIO_RING_FRAMES*2], wav_buffer[AUDIO_WAV_FRAMES*2];
    unsigned read, count, wav_count, peak;
    int initialized, playback, error;
} Audio;
#endif


enum { AUDIO_STRICT=0, AUDIO_STUB=1, AUDIO_MUTE=2, AUDIO_ON=3 };
enum { F_C=1, F_V=2, F_Z=4, F_N=8, F_X=16 };
typedef struct {
    uint32_t d[8], a[8], pc;
    uint32_t usp, ssp;
    uint16_t sr;
    uint8_t ram[65536];
    uint8_t io_data[3], io_control[3], tmss[4];
    uint8_t io_tx[3], io_serial_control[3];
    uint8_t pad_buttons[3];
    VDP vdp;
    Z80Bus z80_bus;
    Z80CPU z80_cpu;
    PSG psg;
    EEPROM eeprom;
    YM2612Stub ym2612_stub;
    Audio audio;
    int audio_mode;
    const uint8_t *rom;
    size_t rom_size;
    uint64_t steps;
    uint64_t cycles, master_cycles, interrupts;
#ifdef GENESIS_DUNE_MOUSE
    uint64_t dune_wait_cycles; /* Host telemetry; no change to console clocks. */
#endif
    unsigned instruction_cycles, z80_divider;
    int halted, fault;
    uint32_t fault_address;
    const char *reason;
} CPU;
static uint16_t vdp_port_read(CPU *c, uint32_t address);
static void vdp_port_write(CPU *c, uint32_t address, uint16_t value);
static void z80_reset(CPU *c);
static void vdp_render(CPU *c);
#include "em_web_audio_levels.h"
static void audio_sync(CPU *c);
static uint8_t audio_fm_read(CPU *c,unsigned port);
static void audio_fm_write(CPU *c,unsigned port,uint8_t value);
static void audio_fm_reset(CPU *c);

static void fail(CPU *c, const char *reason, uint32_t address) {
    if (!c->fault) { c->fault=1; c->reason=reason; c->fault_address=address; }
}
/* Explicit silent debug mode. Register storage only; no YM timers or synthesis. */
#ifndef GENESIS_AUDIO_STUB_H
#define GENESIS_AUDIO_STUB_H
static uint8_t ym2612_stub_read(CPU *c, unsigned port) {
    (void)c; (void)port;
    /* Ready, not busy; no timer overflow. This is a stub status, not FM timing. */
    return 0;
}
static void ym2612_stub_write(CPU *c, unsigned port, uint8_t value) {
    YM2612Stub *y=&c->ym2612_stub;
    unsigned bank=(port>>1)&1;
    if (port&1) y->registers[bank][y->address[bank]]=value;
    else y->address[bank]=value;
    ++y->writes;
}
#endif

/* Functional bus ownership and RAM. Execution resumes in the Z80 scheduler. */
#ifndef GENESIS_Z80_BUS_H
#define GENESIS_Z80_BUS_H
static int z80_bus_address(uint32_t address) {
    return (address>=0xa00000 && address<0xa10000) ||
        (address>=0xa11100 && address<0xa11102) ||
        (address>=0xa11200 && address<0xa11202);
}
static uint8_t z80_bus_read(CPU *c, uint32_t address) {
    Z80Bus *z=&c->z80_bus;
    if (address>=0xa11100 && address<0xa11102)
        return address&1 ? 0:(uint8_t)!z->requested;
    if (address>=0xa11200 && address<0xa11202) {
        fail(c,"read of write-only Z80 reset register",address); return 0;
    }
    if (!z->requested) { fail(c,"Z80 bus has not been granted",address); return 0; }
    if (address<0xa04000) return z->ram[address&0x1fff];
    if (c->audio_mode && address<0xa06000) return audio_fm_read(c,address&3);
    fail(c,"Z80 peripheral read not implemented",address); return 0;
}
static void z80_bus_write(CPU *c, uint32_t address, uint8_t value) {
    Z80Bus *z=&c->z80_bus;
    if (address>=0xa11100 && address<0xa11102) {
        if (address&1) return;
        z->requested=value&1;
        return;
    }
    if (address>=0xa11200 && address<0xa11202) {
        if (address&1) return;
        z->reset_released=value&1;
        if (!z->reset_released) { z80_reset(c); audio_fm_reset(c); }
        return;
    }
    if (!z->requested) { fail(c,"Z80 bus has not been granted",address); return; }
    if (address<0xa04000) { z->ram[address&0x1fff]=value; ++z->ram_writes; return; }
    if (c->audio_mode && address<0xa06000) { audio_fm_write(c,address&3,value); return; }
    if (address>=0xa06000 && address<0xa06100) {
        z->bank=(uint16_t)((z->bank>>1)|((value&1)<<8)); return;
    }
    fail(c,"Z80 peripheral write not implemented",address);
}
#endif

/* Integrated Genesis PSG: three tones and 16-bit periodic/white noise. */
#ifndef GENESIS_PSG_H
#define GENESIS_PSG_H
static void psg_write(CPU *c, uint8_t value) {
    if(c->audio_mode==AUDIO_ON)audio_sync(c);
    PSG *p=&c->psg;
    if (value&0x80) p->latch=(value>>4)&7;
    unsigned channel=p->latch>>1;
    if (p->latch&1) p->volume[channel]=value&15;
    else if (channel==3) { p->noise=value&7; p->noise_lfsr=0x8000; p->counter[3]=(p->noise&3)==3 ? (p->tone[2] ? p->tone[2]:1):(uint16_t)(16u<<(p->noise&3)); }
    else if (value&0x80) p->tone[channel]=(uint16_t)((p->tone[channel]&0x3f0)|(value&15));
    else p->tone[channel]=(uint16_t)((p->tone[channel]&15)|((value&63)<<4));
    ++p->writes;
}
static void psg_audio_init(PSG *p,uint64_t master) {
    for(unsigned i=0;i<4;++i){p->volume[i]=15;p->counter[i]=1;}
    p->counter[3]=16;p->noise_lfsr=0x8000;
    p->cursor=master;p->next_tick=(master/240+1)*240;p->area=0;p->polarity=0;
}
static int32_t psg_audio_level(const PSG *p) {
    // 2 dB attenuation steps. The final entry is hardware silence.
    static const int16_t amplitude[16]={2048,1627,1292,1026,815,648,514,408,325,258,205,163,129,103,81,0};
    int32_t output=0;
    for(unsigned i=0;i<3;++i)output+=em_web_audio_level_sample((p->polarity&(1u<<i) ? 1:-1)*amplitude[p->volume[i]&15],em_web_audio_psg_levels[i]);
    output+=em_web_audio_level_sample((p->noise_lfsr&1 ? 1:-1)*amplitude[p->volume[3]&15],em_web_audio_psg_levels[3]);
    return output;
}
static void psg_audio_advance(PSG *p,uint64_t target) {
    while(p->next_tick<=target){
        p->area+=(int64_t)psg_audio_level(p)*(int64_t)(p->next_tick-p->cursor);
        p->cursor=p->next_tick;p->next_tick+=240; // master / 15 / 16
        for(unsigned i=0;i<3;++i)if(--p->counter[i]==0){
            p->counter[i]=p->tone[i] ? p->tone[i]:1;p->polarity^=(uint8_t)(1u<<i);
        }
        if(--p->counter[3]==0){
            unsigned rate=p->noise&3;
            p->counter[3]=rate==3 ? (p->tone[2] ? p->tone[2]:1):(uint16_t)(16u<<rate);
            p->polarity^=8;
            if(p->polarity&8){
                unsigned feedback=p->noise&4 ? (p->noise_lfsr^(p->noise_lfsr>>3))&1:p->noise_lfsr&1;
                p->noise_lfsr=(uint16_t)((p->noise_lfsr>>1)|(feedback<<15));
            }
        }
    }
    p->area+=(int64_t)psg_audio_level(p)*(int64_t)(target-p->cursor);p->cursor=target;
}
#endif

#ifndef GENESIS_EEPROM_H
#define GENESIS_EEPROM_H
static void eeprom_init(CPU *c) {
    EEPROM *e=&c->eeprom;
    if (e->initialized) return;
    memset(e->data,0xff,sizeof e->data);
    e->initialized=1; e->sda=1; e->scl=1; e->output=1;
}
static uint8_t eeprom_read(CPU *c) {
    eeprom_init(c);
    return (uint8_t)((c->eeprom.sda && c->eeprom.output) ? 0x80:0);
}
static void eeprom_commit(EEPROM *e) {
    for (unsigned i=0;i<4;++i) if (e->dirty&(1u<<i)) e->data[e->page+i]=e->pending[i];
    e->dirty=0;
}
static void eeprom_output_bit(EEPROM *e) {
    e->output=(uint8_t)((e->data[e->address]>>(7-e->bits))&1);
}
static void eeprom_write(CPU *c, uint8_t value) {
    eeprom_init(c);
    EEPROM *e=&c->eeprom;
    uint8_t sda=!!(value&0x80), scl=!!(value&0x40);
    /* START/STOP are host transitions while the clock remains high. */
    if (e->scl && scl && sda!=e->sda) {
        if (!sda) { e->phase=EE_ADDRESS; e->bits=e->shift=0; e->output=1; ++e->starts; }
        else { eeprom_commit(e); e->phase=EE_IDLE; e->output=1; ++e->stops; }
    } else if (!e->scl && scl) {
        if (e->phase==EE_ADDRESS || e->phase==EE_WRITE) {
            e->shift=(uint8_t)((e->shift<<1)|sda);
            if (++e->bits==8) {
                if (e->phase==EE_ADDRESS) {
                    e->address=e->shift>>1; e->reading=e->shift&1;
                    e->phase=EE_ADDRESS_ACK;
                } else {
                    if (!e->dirty) e->page=e->address&0x7c;
                    e->pending[e->address&3]=e->shift; e->dirty|=1u<<(e->address&3);
                    e->address=(uint8_t)((e->address&0x7c)|((e->address+1)&3));
                    e->phase=EE_WRITE_ACK; ++e->writes;
                }
                e->ack_clock=0;
            }
        } else if (e->phase==EE_ADDRESS_ACK || e->phase==EE_WRITE_ACK) {
            e->ack_clock=1;
        } else if (e->phase==EE_READ) {
            if (++e->bits==8) {
                e->phase=EE_READ_ACK; e->ack_clock=0;
                e->address=(e->address+1)&0x7f; ++e->reads;
            }
        } else if (e->phase==EE_READ_ACK) {
            e->master_ack=!sda; e->ack_clock=1;
        }
    } else if (e->scl && !scl) {
        if (e->phase==EE_ADDRESS_ACK || e->phase==EE_WRITE_ACK) {
            if (!e->ack_clock) e->output=0;
            else {
                e->bits=e->shift=0;
                if (e->phase==EE_ADDRESS_ACK && e->reading) {
                    e->phase=EE_READ; eeprom_output_bit(e);
                } else { e->phase=EE_WRITE; e->output=1; }
            }
        } else if (e->phase==EE_READ) eeprom_output_bit(e);
        else if (e->phase==EE_READ_ACK) {
            e->output=1;
            if (e->ack_clock) {
                if (e->master_ack) { e->phase=EE_READ; e->bits=0; eeprom_output_bit(e); }
                else e->phase=EE_WAIT;
            }
        }
    }
    e->sda=sda; e->scl=scl;
}
#endif

/* NTSC/PAL beam timing. Instruction-boundary events; transfers remain synchronous. */
#ifndef GENESIS_VDP_TIMING_H
#define GENESIS_VDP_TIMING_H
#define VDP_LINE_CLOCKS 3420u
#define VDP_NTSC_LINES 262u
static unsigned vdp_frame_lines(const VDP *v) { return v->pal ? 313:VDP_NTSC_LINES; }
static unsigned vdp_master_frequency(const VDP *v) { return v->pal ? 53203424:53693175; }
static unsigned vdp_visible_lines(const VDP *v) { return v->registers[1]&8 ? 240:224; }
static unsigned vdp_vint_clock(const VDP *v) { return v->registers[12]&1 ? 788:770; }
/* The bus read can cross the VINT event while the current instruction is
   finishing, before the CPU acknowledges IRQ6 at the next boundary. */
static int vdp_status_vint(const CPU *c) {
    const VDP *v=&c->vdp;
    if (v->vint_status) return 1;
    unsigned period=vdp_frame_lines(v)*VDP_LINE_CLOCKS;
    unsigned now=v->line*VDP_LINE_CLOCKS+v->line_clock;
    unsigned event=vdp_visible_lines(v)*VDP_LINE_CLOCKS+vdp_vint_clock(v);
    unsigned distance=(event+period-now)%period;
    return distance && distance<=c->instruction_cycles*7;
}
static int vdp_vblank(const VDP *v) {
    return !(v->registers[1]&0x40) || v->line>=vdp_visible_lines(v);
}
static int vdp_hblank(const VDP *v) {
    /* Approximate active/blank boundary; no pixel-fetch or FIFO scheduling. */
    return v->line_clock>=2560;
}
static void vdp_advance(CPU *c, unsigned clocks) {
    VDP *v=&c->vdp;
    while (clocks) {
        unsigned remaining=VDP_LINE_CLOCKS-v->line_clock;
        if (v->line==vdp_visible_lines(v) && v->line_clock<vdp_vint_clock(v))
            remaining=vdp_vint_clock(v)-v->line_clock;
        if (clocks<remaining) { v->line_clock=(uint16_t)(v->line_clock+clocks); break; }
        clocks-=remaining; v->line_clock=(uint16_t)(v->line_clock+remaining);
        if (v->line_clock<VDP_LINE_CLOCKS) {
            v->irq_v=1; v->vint_status=1;
            c->z80_cpu.irq_line=1;
            continue;
        }
        v->line_clock=0;
        c->z80_cpu.irq_line=0;
        if (v->line<vdp_visible_lines(v)) {
            if (v->hint_counter==0) { v->hint_counter=v->registers[10]; v->irq_h=1; }
            else --v->hint_counter;
        } else v->hint_counter=v->registers[10];
        if (++v->line==vdp_visible_lines(v)) {
            if (v->registers[1]&0x40) vdp_render(c);
        }
        if (v->line==vdp_frame_lines(v)) { v->line=0; ++v->frames; v->hint_counter=v->registers[10]; }
    }
}
static unsigned vdp_irq_level(const VDP *v) {
    if (v->irq_v && (v->registers[1]&0x20)) return 6;
    if (v->irq_h && (v->registers[0]&0x10)) return 4;
    return 0;
}
static void vdp_irq_ack(VDP *v, unsigned level) {
    if (level==6) { v->irq_v=0; v->vint_status=0; }
    else if (level==4) v->irq_h=0;
}
static uint16_t vdp_counter(const VDP *v) {
    unsigned vertical=v->line;
    unsigned maximum=v->pal ? (vdp_visible_lines(v)==224 ? 0x102:0x10a):
                             (vdp_visible_lines(v)==224 ? 0xea:0x106);
    if (vertical>maximum) vertical-=vdp_frame_lines(v);
    /* H32 has 171 counter slots; H40 interpolation is approximate because
       its clock divider varies around horizontal blanking. */
    unsigned slots=(v->registers[12]&1) ? 211:171;
    unsigned horizontal=v->line_clock*slots/VDP_LINE_CLOCKS;
    unsigned jump=(slots==211) ? 183:148;
    if (horizontal>=jump) horizontal+=256-slots;
    return (uint16_t)(((vertical&255)<<8)|(horizontal&255));
}
#endif

/* Mode 5 progressive frame snapshot, including shadow/highlight. No raster effects. */
#ifndef GENESIS_VDP_RENDER_H
#define GENESIS_VDP_RENDER_H
static uint16_t vdp_word(const VDP *v, unsigned address) {
    return (uint16_t)((v->vram[address&65535]<<8)|v->vram[(address+1)&65535]);
}
static unsigned vdp_pattern(const VDP *v, unsigned tile, unsigned x, unsigned y) {
    unsigned byte=v->vram[(tile*32+y*4+x/2)&65535];
    return x&1 ? byte&15:byte>>4;
}
static unsigned vdp_tile_pixel(const VDP *v, unsigned entry, unsigned x, unsigned y) {
    if (entry&0x0800) x=7-x;
    if (entry&0x1000) y=7-y;
    unsigned nibble=vdp_pattern(v,entry&0x7ff,x,y);
    /* Transparent high-priority plane pixels still select normal intensity
       in shadow/highlight mode, without hiding the other plane or sprites. */
    return nibble ? ((entry>>9)&0x30)|nibble|((entry>>8)&0x80):
                   (v->registers[12]&8 ? (entry>>8)&0x80:0);
}
static unsigned vdp_plane_address(const VDP *v, unsigned plane, unsigned x, unsigned y, unsigned *sx_out, unsigned *sy_out) {
    unsigned wm=v->registers[16]&3, hm=(v->registers[16]>>4)&3;
    unsigned width=32u<<(wm==3 ? 2:wm), height=32u<<(hm==3 ? 2:hm);
    unsigned mode=v->registers[11]&3;
    unsigned row=mode==3 ? y:mode==2 ? y&~7u:0;
    unsigned scroll_base=(v->registers[13]&0x3f)<<10;
    unsigned hscroll=vdp_word(v,scroll_base+row*4+plane*2)&0x3ff;
    unsigned column=(v->registers[11]&4) ? (x/16)*2+plane:plane;
    unsigned vscroll=column<40 ? v->vsram[column]&0x7ff:0;
    unsigned sx=(x-hscroll)&(width*8-1), sy=(y+vscroll)&(height*8-1);
    unsigned base=plane ? (v->registers[4]&7)<<13:(v->registers[2]&0x38)<<10;
    *sx_out=sx; *sy_out=sy;
    return (base+((sy/8)*width+sx/8)*2)&65535;
}
static unsigned vdp_name_pixel(const VDP *v,unsigned at,unsigned x,unsigned y,unsigned px,unsigned py,unsigned layer) {
    (void)px;(void)py;(void)layer;
    return vdp_tile_pixel(v,vdp_word(v,at),x,y);
}
static unsigned vdp_plane_pixel(const VDP *v,unsigned plane,unsigned x,unsigned y) {
    unsigned sx,sy,at=vdp_plane_address(v,plane,x,y,&sx,&sy);
    return vdp_name_pixel(v,at,sx&7,sy&7,x,y,plane ? 2:1);
}
static int vdp_window_at(const VDP *v, unsigned x, unsigned y) {
    unsigned horizontal=(v->registers[17]&31)*16, vertical=(v->registers[18]&31)*8;
    return ((v->registers[17]&0x80) ? x>=horizontal:x<horizontal) ||
           ((v->registers[18]&0x80) ? y>=vertical:y<vertical);
}
static unsigned vdp_window_pixel(const VDP *v, unsigned x, unsigned y, int h40) {
    unsigned base=(v->registers[3]&(h40 ? 0x3c:0x3e))<<10;
    unsigned at=base+((y/8)*(h40 ? 64:32)+x/8)*2;
    return vdp_name_pixel(v,at&65535,x&7,y&7,x,y,1);
}
static void vdp_sprites(const VDP *v, unsigned width, unsigned height, uint8_t *pixels) {
    unsigned base=(v->registers[5]&(width==320 ? 0x7e:0x7f))<<9;
    unsigned link=0, maximum=width==320 ? 80:64;
    uint8_t visited[128]={0};
    for (unsigned n=0;n<maximum;++n) {
        if (link>=maximum || visited[link]) break;
        visited[link]=1;
        unsigned at=base+link*8;
        int top=(int)(vdp_word(v,at)&0x3ff)-128;
        unsigned size_link=vdp_word(v,at+2), entry=vdp_word(v,at+4);
        int left=(int)(vdp_word(v,at+6)&0x1ff)-128;
        unsigned w=((size_link>>10)&3)+1, h=((size_link>>8)&3)+1;
        for (unsigned y=0;y<h*8;++y) for (unsigned x=0;x<w*8;++x) {
            int px=left+(int)x, py=top+(int)y;
            if (px<0 || py<0 || px>=(int)width || py>=(int)height) continue;
            unsigned sx=entry&0x0800 ? w*8-1-x:x, sy=entry&0x1000 ? h*8-1-y:y;
            unsigned tile=(entry&0x7ff)+(sx/8)*h+sy/8;
            unsigned nibble=vdp_pattern(v,tile,sx&7,sy&7);
            size_t offset=(size_t)py*width+(unsigned)px;
            if (nibble && !pixels[offset]) pixels[offset]=(uint8_t)(nibble|((entry>>9)&0x30)|((entry>>8)&0x80));
        }
        link=size_link&127;
        if (!link) break;
    }
}
/* Return palette index plus intensity in bits 6..7: shadow=0, normal=1,
   highlight=2. Background priority and sprite ordering are separate from
   intensity; sprite palette 3 colors E/F act on the background color. */
static unsigned vdp_shadow_pixel(unsigned a, unsigned b, unsigned s, unsigned backdrop) {
    unsigned background=(b&15) ? b:0;
    if ((a&15) && ((a&128) || !(background&128))) background=a;
    unsigned color=(background&15) ? background&63:backdrop;
    unsigned intensity=((a|b)&128) ? 1:0;
    if ((s&15) && ((s&128) || !(background&128))) {
        unsigned sprite=s&63;
        if (sprite==62) ++intensity;
        else if (sprite==63) intensity=0;
        else {
            color=sprite;
            if ((s&128) || (s&15)==14) intensity=1;
        }
    }
    return color|(intensity<<6);
}
static uint8_t vdp_channel(unsigned channel, unsigned intensity) {
    unsigned level=intensity==0 ? channel:intensity==2 ? channel+7:channel*2;
    return (uint8_t)(level*255/14);
}
static void vdp_render_pixels_reference(VDP *v,unsigned width,unsigned height,const uint8_t *sprites,uint8_t *frame) {
    int h40=width==320;

    for (unsigned y=0;y<height;++y) for (unsigned x=0;x<width;++x) {
        unsigned color=v->registers[7]&63;
        unsigned intensity=1;
        if (v->registers[1]&0x40) {
            unsigned b=vdp_plane_pixel(v,1,x,y);
            unsigned a=vdp_window_at(v,x,y) ? vdp_window_pixel(v,x,y,h40):vdp_plane_pixel(v,0,x,y);
            unsigned s=sprites[y*width+x];
            if (v->registers[12]&8) {
                unsigned mixed=vdp_shadow_pixel(a,b,s,color);
                color=mixed&63; intensity=mixed>>6;
            } else {
                if (b && !(b&128)) color=b&63;
                if (a && !(a&128)) color=a&63;
                if (s && !(s&128)) color=s&63;
                if (b&128) color=b&63;
                if (a&128) color=a&63;
                if (s&128) color=s&63;
            }
        }
        unsigned rgb=v->cram[color];
        size_t offset=((size_t)y*width+x)*3;
        frame[offset]=vdp_channel((rgb>>1)&7,intensity);
        frame[offset+1]=vdp_channel((rgb>>5)&7,intensity);
        frame[offset+2]=vdp_channel((rgb>>9)&7,intensity);
    }
}
#include "em_web_raster.h"
#include "em_web_frame.h"
static void vdp_render(CPU *c) {
    VDP *v=&c->vdp;
    /* Unsupported video modes leave the last supported frame intact. */
    if (!(v->registers[1]&4) || (v->registers[12]&6) ||
        (v->registers[16]&3)==2 || ((v->registers[16]>>4)&3)==2 || (v->registers[11]&3)==1) {
        v->render_unsupported=1; return;
    }
    v->render_unsupported=0;
    int h40=v->registers[12]&1;
    unsigned width=h40 ? 320:256, height=vdp_visible_lines(v);
    uint8_t sprites[320*240]={0};
    if (v->registers[1]&0x40) vdp_sprites(v,width,height,sprites);
    v->frame_width=(uint16_t)width; v->frame_height=(uint16_t)height;
    vdp_render_pixels(v,width,height,sprites,v->frame);
    v->frame_width=(uint16_t)width; v->frame_height=(uint16_t)height;
    ++v->rendered_frames;
    em_web_frame_capture(c);
}
#endif

/* Clocked stereo PCM, DC removal, bounded host buffering and little-endian WAV.
   The chip state advances independently of playback and file output. */
#ifndef GENESIS_AUDIO_H
#define GENESIS_AUDIO_H
static void audio_sync(CPU *c);
static void audio_le32(uint8_t *p,uint32_t value) {
    for(unsigned i=0;i<4;++i)p[i]=(uint8_t)(value>>(i*8));
}
static int audio_wav_flush(Audio *a) {
    if(!a->wav || !a->wav_count)return !a->error;
    uint8_t bytes[AUDIO_WAV_FRAMES*4];
    unsigned size=a->wav_count*4;
    if(a->wav_bytes+size>UINT32_MAX-36u){a->error=1;return 0;}
    for(unsigned i=0;i<a->wav_count*2;++i){
        uint16_t sample=(uint16_t)a->wav_buffer[i];
        bytes[i*2]=(uint8_t)sample;bytes[i*2+1]=(uint8_t)(sample>>8);
    }
    if(fwrite(bytes,1,size,a->wav)!=size){a->error=1;return 0;}
    a->wav_bytes+=size;a->wav_count=0;return 1;
}
static int audio_init(CPU *c,const char *wav_path) {
    Audio *a=&c->audio;
    if(a->initialized)return !a->error;
#ifndef GENESIS_AUDIO
    (void)wav_path;fail(c,"sound backend not compiled; rebuild with --sound ymfm",c->pc);return 0;
#else
    a->fm=genesis_ymfm_create();
    if(!a->fm){fail(c,"cannot allocate FM sound state",c->pc);return 0;}
    a->initialized=1;
    a->cursor=c->master_cycles;
    a->sample_index=c->master_cycles*AUDIO_RATE/vdp_master_frequency(&c->vdp)+1;
    a->next_sample=a->sample_index*vdp_master_frequency(&c->vdp)/AUDIO_RATE;
    psg_audio_init(&c->psg,c->master_cycles);
    if(wav_path){
        a->wav=fopen(wav_path,"wb");
        if(!a->wav){fail(c,"cannot open audio WAV",c->pc);return 0;}
        uint8_t header[44]={0};
        memcpy(header,"RIFF",4);memcpy(header+8,"WAVEfmt ",8);
        audio_le32(header+16,16);header[20]=1;header[22]=2;
        audio_le32(header+24,AUDIO_RATE);audio_le32(header+28,AUDIO_RATE*4);
        header[32]=4;header[34]=16;memcpy(header+36,"data",4);
        if(fwrite(header,1,sizeof header,a->wav)!=sizeof header){
            a->error=1;fail(c,"cannot write audio WAV header",c->pc);return 0;
        }
    }
    return 1;
#endif
}
static void audio_sample(CPU *c,const int32_t fm[2],int32_t psg) {
    Audio *a=&c->audio;int16_t stereo[2];
    for(unsigned ch=0;ch<2;++ch){
        int32_t input=fm[ch]*3/4+psg;
        int32_t output=input-a->previous_input[ch]+(int32_t)((int64_t)a->filter[ch]*32717/32768);
        a->previous_input[ch]=input;a->filter[ch]=output;
        if(output>32767)output=32767;
        if(output< -32768)output=-32768;
        unsigned level=(unsigned)(output<0 ? -output:output);if(level>a->peak)a->peak=level;
        stereo[ch]=(int16_t)output;
    }
    ++a->frames;
    if(a->wav && !a->error){
        a->wav_buffer[a->wav_count*2]=stereo[0];a->wav_buffer[a->wav_count*2+1]=stereo[1];
        if(++a->wav_count==AUDIO_WAV_FRAMES)audio_wav_flush(a);
    }
    if(a->playback){
        if(a->count==AUDIO_RING_FRAMES){a->read=(a->read+1)%AUDIO_RING_FRAMES;--a->count;++a->dropped;}
        unsigned at=(a->read+a->count)%AUDIO_RING_FRAMES;
        a->ring[at*2]=stereo[0];a->ring[at*2+1]=stereo[1];++a->count;
    }
}
static void audio_sync(CPU *c) {
    if(c->audio_mode!=AUDIO_ON || c->fault)return;
    Audio *a=&c->audio;
    if(!a->initialized && !audio_init(c,NULL))return;
    em_web_audio_levels_sync(c);
#ifdef GENESIS_AUDIO
    uint64_t target=c->master_cycles;
    if(target<a->cursor){fail(c,"sound clock cannot rewind",c->pc);return;}
    int32_t fm[2];
    while(a->next_sample<=target){
        psg_audio_advance(&c->psg,a->next_sample);
        genesis_ymfm_advance(a->fm,a->next_sample,fm);
        uint64_t width=a->next_sample-a->cursor;
        int32_t psg=width ? (int32_t)(c->psg.area/(int64_t)width):0;
        c->psg.area=0;audio_sample(c,fm,psg);
        a->cursor=a->next_sample;
        ++a->sample_index;a->next_sample=a->sample_index*vdp_master_frequency(&c->vdp)/AUDIO_RATE;
    }
    // Preserve partial PSG integration when a register changes between samples.
    psg_audio_advance(&c->psg,target);genesis_ymfm_advance(a->fm,target,fm);
    if(a->error)fail(c,"cannot write audio WAV",c->pc);
#endif
}
static uint8_t audio_fm_read(CPU *c,unsigned port) {
    if(c->audio_mode!=AUDIO_ON)return ym2612_stub_read(c,port);
    audio_sync(c);
#ifdef GENESIS_AUDIO
    if(!c->fault)return genesis_ymfm_read(c->audio.fm,port);
#endif
    return 0;
}
static void audio_fm_write(CPU *c,unsigned port,uint8_t value) {
    if(c->audio_mode==AUDIO_ON){
        audio_sync(c);
#ifdef GENESIS_AUDIO
        if(c->fault)return;
        genesis_ymfm_write(c->audio.fm,port,value);
#endif
    }
    ym2612_stub_write(c,port,value);
}
static void audio_fm_reset(CPU *c) {
    if(c->audio_mode!=AUDIO_ON)return;
    audio_sync(c);
#ifdef GENESIS_AUDIO
    if(!c->fault)genesis_ymfm_reset(c->audio.fm);
#endif
}
static unsigned audio_pop(CPU *c,int16_t *output,unsigned frames) {
    Audio *a=&c->audio;if(frames>a->count)frames=a->count;
    for(unsigned i=0;i<frames;++i){
        output[i*2]=a->ring[a->read*2];output[i*2+1]=a->ring[a->read*2+1];
        a->read=(a->read+1)%AUDIO_RING_FRAMES;
    }
    a->count-=frames;return frames;
}
static int audio_finish(CPU *c) {
    Audio *a=&c->audio;
    if(a->wav){
        audio_wav_flush(a);
        uint8_t value[4];audio_le32(value,(uint32_t)a->wav_bytes+36);
        if(fseek(a->wav,4,SEEK_SET) || fwrite(value,1,4,a->wav)!=4)a->error=1;
        audio_le32(value,(uint32_t)a->wav_bytes);
        if(fseek(a->wav,40,SEEK_SET) || fwrite(value,1,4,a->wav)!=4)a->error=1;
        if(fclose(a->wav))a->error=1;
        a->wav=NULL;
    }
#ifdef GENESIS_AUDIO
    if(a->fm)genesis_ymfm_destroy(a->fm);
#endif
    a->fm=NULL;a->initialized=0;
    return !a->error;
}
#endif

/* Active-low three-button pad pins, selected by TH; output pins override inputs. */
#ifndef GENESIS_CONTROLLER_H
#define GENESIS_CONTROLLER_H
enum {
    PAD_UP=1, PAD_DOWN=2, PAD_LEFT=4, PAD_RIGHT=8,
    PAD_A=16, PAD_B=32, PAD_C=64, PAD_START=128
};
static uint8_t controller_pins(uint8_t buttons, int th) {
    uint8_t pins=(uint8_t)(th ? 0x7f:0x33);
    pins &= (uint8_t)~(buttons & (th ? 15:3));
    if (buttons & (th ? PAD_B:PAD_A)) pins &= (uint8_t)~0x10;
    if (buttons & (th ? PAD_C:PAD_START)) pins &= (uint8_t)~0x20;
    return pins;
}
#endif

/* Mouse intent for the verified Dune USA ROM; native code still selects and orders. */
#ifndef GENESIS_DUNE_MOUSE_H
#define GENESIS_DUNE_MOUSE_H
#ifdef GENESIS_DUNE_MOUSE
enum { DUNE_CLICK_SELECT=1, DUNE_CLICK_ORDER=2, DUNE_CLICK_CANCEL=3 };
typedef struct { int x,y,action,world,wx,wy; } DuneClick;
typedef struct {
    int enabled,x,y,dirty,stage,context,point_world,wx,wy;
    int camera_hold,pan_x,pan_y;
    int tile_valid,tile_wx,tile_wy;
    unsigned head,count;
    int front_kind;
    uint32_t front_callback,front_source;
    uint64_t front_frame,cooldown;
    uint64_t moves,clicks;
    DuneClick queue[8];
} DuneMouse;
static unsigned dune_word(const CPU *c,unsigned a) {
    return ((unsigned)c->ram[a]<<8)|c->ram[a+1];
}
static uint32_t dune_long(const CPU *c,unsigned a) {
    return (dune_word(c,a)<<16)|dune_word(c,a+2);
}
static void dune_mouse_reset(DuneMouse *m) {
    m->dirty=m->stage=m->point_world=m->camera_hold=m->pan_x=m->pan_y=0;m->head=m->count=0;
    m->tile_valid=0;
}
static int dune_mouse_context(const CPU *c) {
    if(c->fault || !c->vdp.rendered_frames)return 0;
    uint32_t callback=dune_long(c,0xe002);
    if(callback==0x4504){
        uint32_t building=dune_long(c,0xc578);
        if(building>=0xff0000 && building<=0xffffa0){
            unsigned type=c->ram[(building&65535)+2];
            if(type==c->ram[0xbf85] && type>=2 && type<=18 &&
               type!=6 && type!=14)return type==11?3:2;
        }
    }
    if(callback!=0x6092 && callback!=0x6d10)return 0;
    unsigned left=dune_word(c,0xbf1a),top=dune_word(c,0xbf1c);
    unsigned right=dune_word(c,0xbf1e),bottom=dune_word(c,0xbf20);
    return left<right && top<bottom && right<=c->vdp.frame_width &&
           bottom<=c->vdp.frame_height ? 1:0;
}
static int dune_mouse_game(const CPU *c) {return dune_mouse_context(c)==1;}
static int dune_mouse_cell(const CPU *c,int x,int y,int *col,int *row) {
    int starport=dune_mouse_context(c)==3;
    if(x<32 || x>=128 || y<48 || y>=(starport?144:192))return 0;
    *col=(x-32)/32;*row=(y-48)/24;
    return c->ram[(starport?0xbfcc:0xbf8e) + *row*3 + *col]!=(starport?0xff:0x80);
}
/* These are native pad-read continuations, rather than a guess from a title
   image or a callback shared by unrelated screens. */
static int dune_mouse_front_poll(const CPU *c){
    switch(c->pc){
    case 0x4938:return 6; /* house picker */
    case 0x25cb2:return 7; /* YES/NO confirmation */
    case 0x4d4e:{
        unsigned sp=c->a[7]&65535;
        return sp<=65532 && dune_long(c,sp)==0x178d2?5:4;
    }
    case 0x4724:case 0x17d22:case 0x17e96:case 0x17ea6:case 0x17eb6:
        return 4;
    default:return 0;
    }
}
static int dune_mouse_active(const DuneMouse *m,const CPU *c){
    int context=dune_mouse_context(c);
    int front=!c->fault && c->vdp.rendered_frames && m->front_kind &&
        m->front_callback==dune_long(c,0xe002) &&
        c->vdp.frames-m->front_frame<=4?m->front_kind:0;
    if(context==1)return context;
    if(front>=5)return front;
    return context?context:front;
}
static int dune_mouse_point(DuneMouse *m,const CPU *c,int x,int y) {
    if(!m->enabled || !dune_mouse_active(m,c) || x<0 || y<0 ||
       x>=(int)c->vdp.frame_width || y>=(int)c->vdp.frame_height)return 0;
    int context=dune_mouse_active(m,c);
    if(m->context!=context){dune_mouse_reset(m);m->context=context;}
    m->point_world=0;m->x=x;m->y=y;m->dirty=1;
    if(context==1)m->camera_hold=1;
    return 1;
}
static void dune_mouse_click(DuneMouse *m,const CPU *c,int x,int y,int action) {
    if(!dune_mouse_point(m,c,x,y))return;
    if(m->context>=4){
        if(c->vdp.frames<m->cooldown || m->count)return;
        if(m->context==5 && (x<104 || x>=248 || y<156 || y>=184))return;
        if(m->context==6 && (y<32 || y>=208))return;
    }
    int col,row;
    if((m->context==2 || m->context==3) && action==DUNE_CLICK_SELECT &&
       !dune_mouse_cell(c,x,y,&col,&row))return;
    if(m->count==8)return;
    m->queue[(m->head+m->count++)%8]=(DuneClick){x,y,action};
}
static int dune_mouse_world_point(DuneMouse *m,const CPU *c,int wx,int wy){
    if(!m->enabled || dune_mouse_context(c)!=1 || wx<0 || wy<0 || wx>=2048 || wy>=2048)return 0;
    if(m->context!=1){dune_mouse_reset(m);m->context=1;}
    m->point_world=1;m->camera_hold=1;m->wx=wx;m->wy=wy;m->dirty=1;return 1;
}
static void dune_mouse_world_click(DuneMouse *m,const CPU *c,int wx,int wy,int action){
    if(!dune_mouse_world_point(m,c,wx,wy) || m->count==8)return;
    m->queue[(m->head+m->count++)%8]=(DuneClick){.action=action,.world=1,.wx=wx,.wy=wy};
}
static int dune_mouse_world_local(const CPU *c,int wx,int wy,int *x,int *y){
    /* Grid picking adds 16 ($646C); free picking uses the origin ($7002). */
    int inset=dune_long(c,0xe002)==0x6d10?0:16;
    *x=wx-(int)dune_word(c,0xe3ec)-inset;*y=wy-(int)dune_word(c,0xe3ee)-inset;
    /* The pad cursor has a 24px inset, even at the mission's world border.
       Keep its visible position legal; tile picking below retains the exact
       world cell rather than rejecting or selecting the neighbouring cell. */
    if(wx>=(int)dune_word(c,0xe3d2) && wx<(int)dune_word(c,0xe3d4)+(int)c->vdp.frame_width &&
       wy>=(int)dune_word(c,0xe3ce) && wy<(int)dune_word(c,0xe3d0)+(int)c->vdp.frame_height){
        int left=dune_word(c,0xbf1a),right=dune_word(c,0xbf1e),top=dune_word(c,0xbf1c),bottom=dune_word(c,0xbf20);
        int cx=dune_word(c,0xe3ec),cy=dune_word(c,0xe3ee);
        if(*x<left && cx==(int)dune_word(c,0xe400))*x=left;
        if(*x>right && cx==(int)dune_word(c,0xe402))*x=right;
        if(*y<top && cy==(int)dune_word(c,0xe3fc))*y=top;
        if(*y>bottom && cy==(int)dune_word(c,0xe3fe))*y=bottom;
    }
    return *x>=(int)dune_word(c,0xbf1a) && *x<=(int)dune_word(c,0xbf1e) &&
           *y>=(int)dune_word(c,0xbf1c) && *y<=(int)dune_word(c,0xbf20);
}
static void dune_mouse_pan(DuneMouse *m,CPU *c){
    if(c->pc!=0x78d0 || !m->camera_hold || c->pad_buttons[0] || dune_mouse_context(c)!=1)return;
    int queued=m->count && m->queue[m->head].world;
    if(!queued){
        c->d[0]=(c->d[0]&~65535u);
        c->d[1]=(c->d[1]&~65535u);
        return;
    }
    DuneClick *q=&m->queue[m->head];int x,y;
    int visible=dune_mouse_world_local(c,q->wx,q->wy,&x,&y);
    int moved=0;
    for(unsigned axis=0;axis<2;++axis){
        int pos=dune_word(c,0xe3ec+axis*2);
        int target=axis?q->wy-112:q->wx-160;
        unsigned bound=axis?0xe3fc:0xe400;
        int low=(int16_t)dune_word(c,bound),high=(int16_t)dune_word(c,bound+2);
        if(low<=high){if(target<low)target=low;if(target>high)target=high;}
        int delta=visible?0:target-pos;if(delta>7)delta=7;if(delta<-7)delta=-7;
        moved|=delta!=0;
        /* $78D8 stores D0/D1 into the camera delta fields itself. */
        c->d[axis]=(c->d[axis]&~65535u)|(uint16_t)delta;
    }
    /* The original mission camera bounds may exclude a border cell. Do not
       turn an unreachable click into a command at a different coordinate. */
    if(!visible && !moved){m->head=(m->head+1)%8;--m->count;m->stage=0;}
}
static void dune_mouse_warp(DuneMouse *m,CPU *c,int x,int y) {
    int left=dune_word(c,0xbf1a),top=dune_word(c,0xbf1c);
    int right=dune_word(c,0xbf1e),bottom=dune_word(c,0xbf20);
    if(x<left)x=left;if(x>right)x=right;
    if(y<top)y=top;if(y>bottom)y=bottom;
    c->ram[0xbf12]=(uint8_t)(x>>8);c->ram[0xbf13]=(uint8_t)x;
    c->ram[0xbf14]=(uint8_t)(y>>8);c->ram[0xbf15]=(uint8_t)y;
    /* Clear a previous controller delta, not the camera or world position. */
    memset(c->ram+0xbf0e,0,4);++m->moves;
}
static void dune_mouse_pop(DuneMouse *m) {
    m->head=(m->head+1)%8;--m->count;m->stage=0;++m->clicks;
}
static void dune_mouse_observe(DuneMouse *m,CPU *c) {
    if(!m->enabled)return;
    if((c->pc==0x6486 || c->pc==0x701c) && m->tile_valid){
        if(!c->pad_buttons[0] && dune_mouse_context(c)==1){
            unsigned tile=(m->tile_wy/32)*64+m->tile_wx/32;
            c->ram[0xc240]=tile>>8;c->ram[0xc241]=tile;
        }
        m->tile_valid=0;
    }
    dune_mouse_pan(m,c);
    int front=dune_mouse_front_poll(c);
    if(front && (front>=5 || !dune_mouse_context(c))){
        uint32_t callback=dune_long(c,0xe002),source=c->pc;
        if(c->pc==0x4d4e){
            unsigned sp=c->a[7]&65535;
            source=sp<=65532?dune_long(c,sp):0;
        }else if(c->pc==0x17ea6 || c->pc==0x17eb6)source=0x17e96;
        if(m->front_kind!=front || m->front_callback!=callback || m->front_source!=source){
            dune_mouse_reset(m);m->context=front;
        }
        m->front_kind=front;m->front_callback=callback;m->front_source=source;
        m->front_frame=c->vdp.frames;
        if(c->pad_buttons[0]){dune_mouse_reset(m);return;}
        if(!m->dirty && !m->count)return;
        int x=m->count?m->queue[m->head].x:m->x;
        int y=m->count?m->queue[m->head].y:m->y;
        int ready=1;unsigned key=0;
        if(front==5){
            if(x<104 || x>=248 || y<156 || y>=184){m->dirty=0;return;}
            unsigned target=160+8*((y-156)/8),current=dune_word(c,0xd70e);
            if(current!=target){key=current>target?1:2;ready=0;}
        }else if(front==6){
            unsigned target=x<104?32:x<192?120:208,current=dune_word(c,0xbef8);
            if(dune_word(c,0xbf02)){ready=0;}
            else if(current!=target){key=current>target?4:8;ready=0;}
        }else if(front==7){
            unsigned target=y<180?0x128:0x140,current=dune_word(c,0xa62c);
            if(current!=target){key=current>target?1:2;ready=0;}
        }
        if(key){c->d[0]=key;++m->moves;}
        if(ready){
            m->dirty=0;
            if(m->count){
                c->d[0]=0x40;dune_mouse_pop(m);dune_mouse_reset(m);
                m->cooldown=c->vdp.frames+20;
            }
        }
        return;
    }
    if(!m->dirty && !m->count)return;
    if(c->pc!=0x6176 && c->pc!=0x617a && c->pc!=0x6e02 && c->pc!=0x6e06 &&
       c->pc!=0x847e && c->pc!=0x28884 && c->pc!=0x9188 && c->pc!=0x28ac0)return;
    int context=dune_mouse_context(c);
    if(!context || context!=m->context || c->pad_buttons[0]){
        dune_mouse_reset(m);m->context=context;return;
    }
    if(context==2 || context==3){
        int starport=context==3;
        int x=m->count?m->queue[m->head].x:m->x;
        int y=m->count?m->queue[m->head].y:m->y;
        if(m->count && m->queue[m->head].action!=DUNE_CLICK_SELECT){x=48;y=60;}
        int col,row,hit=dune_mouse_cell(c,x,y,&col,&row);
        unsigned current_col=dune_word(c,starport?0xbfc8:0xbf8a);
        unsigned current_row=dune_word(c,starport?0xbfca:0xbf8c);
        if(!hit && !m->count){m->dirty=0;return;}
        if(c->pc==(starport?0x9188:0x847e) && hit && current_col<3 && current_row<(starport?4u:6u)){
            /* Walk through enabled cells: some factories leave holes in the
               grid, so a fixed horizontal-first route can get stuck. */
            unsigned direction=0,base=starport?0xbfcc:0xbf8e;
            int rows=starport?4:6,start=current_row*3+current_col,target=row*3+col;
            int queue[18],prev[18],edge[18],head=0,tail=0;
            for(int i=0;i<18;++i)prev[i]=-1;
            queue[tail++]=start;prev[start]=start;
            while(head<tail && prev[target]<0){
                int at=queue[head++],cx=at%3,cy=at/3;
                const int dx[]={-1,1,0,0},dy[]={0,0,-1,1};
                const unsigned keys[]={PAD_LEFT,PAD_RIGHT,PAD_UP,PAD_DOWN};
                for(int k=0;k<4;++k){
                    int nx=cx+dx[k],ny=cy+dy[k],next=ny*3+nx;
                    if(nx<0 || nx>=3 || ny<0 || ny>=rows || prev[next]>=0 ||
                       c->ram[base+next]==(starport?0xff:0x80))continue;
                    prev[next]=at;edge[next]=keys[k];queue[tail++]=next;
                }
            }
            if(target!=start && prev[target]>=0){
                int next=target;
                while(prev[next]!=start)next=prev[next];
                direction=edge[next];
            }
            /* Original arrow navigation updates highlighting and item details. */
            if(direction){c->a[0]=direction*2;++m->moves;}
            else {m->dirty=0;if(target!=start && m->count)dune_mouse_pop(m);}
        }else if(c->pc==(starport?0x28ac0:0x28884) && m->count){
            if(hit && current_col==(unsigned)col && current_row==(unsigned)row){
                c->d[0]='A';c->ram[0xbf2b]='A';dune_mouse_pop(m);
            }else if(!hit)dune_mouse_pop(m);
        }
        return;
    }
    /* VBlank pad reads cover both map presenters and construction placement.
       Warp first, let native cursor/tile logic run, then send one A/B edge. */
    if(c->pc==0x6176 || c->pc==0x6e02){
        if(m->count){
            DuneClick *q=&m->queue[m->head];
            int x=q->x,y=q->y;
            if(q->world && !dune_mouse_world_local(c,q->wx,q->wy,&x,&y))return;
            if(q->world){m->tile_valid=1;m->tile_wx=q->wx;m->tile_wy=q->wy;}
            /* Native auto-centering can move BF12 between VBlanks. Restore
               the target again on the frame that sends A/B, including borders. */
            dune_mouse_warp(m,c,x,y);if(!m->stage)m->stage=2;
        }else if(!m->count && m->dirty){
            int x=m->x,y=m->y;
            if(!m->point_world || dune_mouse_world_local(c,m->wx,m->wy,&x,&y)){
                dune_mouse_warp(m,c,x,y);
                if(m->point_world){m->tile_valid=1;m->tile_wx=m->wx;m->tile_wy=m->wy;}
            }
            m->dirty=0;
        }
    }else if(c->pc==0x617a || c->pc==0x6e06){
        if(m->stage==2){m->stage=1;return;}
        if(m->stage==1){
            DuneClick q=m->queue[m->head];
            uint32_t selected=dune_long(c,0xc25c);
            unsigned key=q.action==DUNE_CLICK_SELECT ||
                (q.action==DUNE_CLICK_ORDER && selected>=0xff0000 && selected<=0xfffffe)
                ? 0x40:0x10;
            c->d[0]=(c->d[0]&~65535u)|key;dune_mouse_pop(m);
        }
    }
}
#endif
#endif

static uint32_t mask_for(unsigned size) {
    return size==4 ? UINT32_MAX : (1u << (size*8))-1u;
}
static uint32_t sign_extend(uint32_t value, unsigned size) {
    uint32_t sign=1u << (size*8-1), mask=mask_for(size);
    value &= mask;
    return (value ^ sign)-sign;
}
static uint8_t io_read(CPU *c, unsigned reg) {
    /* Overseas hardware, revision 1 (TMSS), with 3-button pads. */
    if (reg==0) return c->vdp.pal ? 0xe1:0xa1;
    if (reg>=1 && reg<=3) {
        unsigned p=reg-1;
        unsigned th=(c->io_control[p]&0x40) ? c->io_data[p]&0x40 : 0x40;
        uint8_t pins=controller_pins(c->pad_buttons[p],!!th);
        unsigned mask=c->io_control[p]|0x80; /* D7 always reads its latch. */
        return (uint8_t)((c->io_data[p]&mask)|(pins&~mask));
    }
    if (reg>=4 && reg<=6) return c->io_control[reg-4];
    if (reg>=7 && reg<=15) {
        unsigned p=(reg-7)/3, kind=(reg-7)%3;
        if (kind==0) return c->io_tx[p];
        if (kind==2) return c->io_serial_control[p];
        return 0; /* No serial peripheral: receive buffer stays empty. */
    }
    fail(c,"invalid I/O register",0xa10000+reg*2); return 0;
}
static void io_write(CPU *c, unsigned reg, uint8_t value) {
    if (reg==0) return; /* Read-only hardware version register. */
    if (reg>=1 && reg<=3) { c->io_data[reg-1]=value; return; }
    if (reg>=4 && reg<=6) { c->io_control[reg-4]=value; return; }
    if (reg>=7 && reg<=15) {
        unsigned p=(reg-7)/3, kind=(reg-7)%3;
        if (kind==0) c->io_tx[p]=value;
        if (kind==2) {
            /* Baud/interrupt configuration is writable; status bits 0..2
             * are read-only. Serial pin operation still needs a UART. */
            c->io_serial_control[p]=value&0xf8;
            if (value&0x30) fail(c,"active serial communication not implemented",0xa10000+reg*2);
        }
        return; /* Receive data is read-only. */
    }
    fail(c,"invalid I/O register",0xa10000+reg*2);
}
static uint8_t read8(CPU *c, uint32_t address) {
    address &= 0xffffff;
    if (c->eeprom.enabled && (address==0x200000 || address==0x200001))
        return address&1 ? eeprom_read(c):0;
    if (address < c->rom_size) return c->rom[address];
    if (address >= 0xe00000) return c->ram[address & 0xffff];
    if (address>=0xa10000 && address<0xa10020) return io_read(c,(address-0xa10000)/2);
    if (z80_bus_address(address)) return z80_bus_read(c,address);
    if (address>=0xc00000 && address<0xc00020) {
        uint16_t value=vdp_port_read(c,address);
        return (uint8_t)(address&1 ? value:value>>8);
    }
    fail(c, "unmapped read / hardware device not implemented", address);
    return 0;
}
static void write8(CPU *c, uint32_t address, uint8_t value) {
    address &= 0xffffff;
    if (c->eeprom.enabled && (address==0x200000 || address==0x200001)) {
        if (address&1) eeprom_write(c,value);
        return;
    }
    if (address >= 0xe00000) {
        c->ram[address & 0xffff]=value;return;
    }
    if (address>=0xa10000 && address<0xa10020) { io_write(c,(address-0xa10000)/2,value); return; }
    if (address>=0xa14000 && address<0xa14004) { c->tmss[address-0xa14000]=value; return; }
    if (z80_bus_address(address)) { z80_bus_write(c,address,value); return; }
    if (address>=0xc00000 && address<0xc00020) {
        /* A 68000 byte write replicates its byte on the VDP's 16-bit bus. */
        vdp_port_write(c,address,(uint16_t)((value<<8)|value)); return;
    }
    fail(c, address<c->rom_size ? "write to ROM" : "unmapped write / hardware device not implemented", address);
}
static uint32_t read_mem(CPU *c, uint32_t address, unsigned size) {
    uint32_t value=0;
    if (size>1 && (address & 1)) { fail(c, "address error on read", address); return 0; }
    uint32_t bus_address=address&0xffffff;
    if (size>1 && bus_address>=0xc00000 && bus_address<0xc00020) {
        for (unsigned i=0; i<size && !c->fault; i+=2) value=(value<<16)|vdp_port_read(c,bus_address+i);
        return value;
    }
    for (unsigned i=0; i<size && !c->fault; ++i) value=(value<<8)|read8(c,address+i);
    return value;
}
static void write_mem(CPU *c, uint32_t address, unsigned size, uint32_t value) {
    if (size>1 && (address & 1)) { fail(c, "address error on write", address); return; }
    uint32_t bus_address=address&0xffffff;
    if (size>1 && bus_address>=0xc00000 && bus_address<0xc00020) {
        for (unsigned i=0; i<size && !c->fault; i+=2) vdp_port_write(c,bus_address+i,(uint16_t)(value>>((size-i-2)*8)));
        return;
    }
    for (unsigned i=0; i<size && !c->fault; ++i) write8(c,address+i,(uint8_t)(value >> ((size-i-1)*8)));
}
/* VDP ports, memory and synchronous DMA. Beam state is advanced by the scheduler. */
#ifndef GENESIS_VDP_H
#define GENESIS_VDP_H

static void vdp_increment(VDP *v) {
    v->address=(uint16_t)(v->address+v->registers[15]);
}
static uint32_t vdp_dma_length(VDP *v) {
    uint32_t length=v->registers[19]|((uint32_t)v->registers[20]<<8);
    return length ? length:65536;
}
static void vdp_store_word(CPU *c, uint16_t value) {
    VDP *v=&c->vdp;
    switch (v->code&15) {
        case 1:
            v->vram[v->address]=(uint8_t)(value>>8);
            v->vram[v->address^1]=(uint8_t)value;
            break;
        case 3: v->cram[(v->address>>1)&63]=(uint16_t)(value&0x0eee); break;
        case 5: {
            unsigned index=(v->address>>1)&63;
            if (index<40) v->vsram[index]=(uint16_t)(value&0x07ff);
            break;
        }
        default: fail(c,"unsupported VDP data-write access code",0xc00000); return;
    }
    vdp_increment(v);
}
static uint16_t vdp_load_word(CPU *c) {
    VDP *v=&c->vdp; uint16_t value=0;
    switch (v->code&15) {
        case 0: {
            unsigned a=v->address&0xfffe;
            value=(uint16_t)((v->vram[a]<<8)|v->vram[a+1]);
            break;
        }
        case 8: value=v->cram[(v->address>>1)&63]; break;
        case 4: {
            unsigned index=(v->address>>1)&63;
            value=index<40 ? v->vsram[index]:0;
            break;
        }
        default: fail(c,"unsupported VDP data-read access code",0xc00000); return 0;
    }
    vdp_increment(v); return value;
}
static void vdp_start_dma(CPU *c) {
    VDP *v=&c->vdp;
    unsigned mode=v->registers[23]>>6;
    if (mode==2) { v->fill_pending=1; return; }
    uint32_t length=vdp_dma_length(v);
    if (mode==3) {
        uint16_t source=(uint16_t)(v->registers[21]|(v->registers[22]<<8));
        for (uint32_t n=0; n<length; ++n) {
            /* Copy is sequential, so overlapping regions feed later reads. */
            v->vram[v->address^1]=v->vram[source^1];
            ++source; vdp_increment(v); ++v->dma_bytes;
        }
        v->registers[21]=(uint8_t)source; v->registers[22]=(uint8_t)(source>>8);
    } else {
        uint32_t source=(v->registers[21]|((uint32_t)v->registers[22]<<8)|((uint32_t)(v->registers[23]&0x7f)<<16))<<1;
        /* The 68000 DMA source counter wraps within its 128 KiB bank. */
        uint32_t bank=source&0xfe0000;
        for (uint32_t n=0; n<length; ++n) {
            if ((source&0xffffff)>=0xc00000 && (source&0xffffff)<0xc00020) {
                fail(c,"VDP DMA source points to VDP ports",source); return;
            }
            uint16_t word=(uint16_t)read_mem(c,source,2);
            if (c->fault) return;
            vdp_store_word(c,word);
            if (c->fault) return;
            source=bank|((source+2)&0x1ffff); v->dma_bytes+=2;
        }
        source>>=1;
        v->registers[21]=(uint8_t)source; v->registers[22]=(uint8_t)(source>>8);
        v->registers[23]=(uint8_t)(source>>16);
    }
    v->registers[19]=0; v->registers[20]=0;
}
static void vdp_control_write(CPU *c, uint16_t value) {
    VDP *v=&c->vdp;
    v->bus_value=value;
    if (v->command_pending) {
        v->address=(uint16_t)((v->address&0x3fff)|((value&3)<<14));
        v->code=(uint8_t)((v->code&3)|((value>>2)&0x3c));
        v->command_pending=0;
        if ((v->code&0x20) && (v->registers[1]&0x10)) vdp_start_dma(c);
        return;
    }
    if ((value&0xc000)==0x8000) {
        unsigned reg=(value>>8)&31;
        if (reg<24) v->registers[reg]=(uint8_t)value;
        /* Register writes set the access-code low bits to zero. */
        v->code=0;
        return;
    }
    v->address=(uint16_t)((v->address&0xc000)|(value&0x3fff));
    v->code=(uint8_t)((v->code&0x3c)|(value>>14));
    v->command_pending=1;
}
static void vdp_data_write(CPU *c, uint16_t value) {
    VDP *v=&c->vdp;
    v->command_pending=0; v->bus_value=value;
    vdp_store_word(c,value);
    if (c->fault) return;
    ++v->data_writes;
    if (v->fill_pending) {
        v->fill_pending=0;
        if ((v->code&15)!=1) { fail(c,"VDP DMA fill requires VRAM",0xc00000); return; }
        /* The triggering FIFO word is written normally. Fill subsequently
           writes its high byte onto the opposite VRAM byte lane. */
        uint32_t length=vdp_dma_length(v);
        for (uint32_t n=0; n<length; ++n) {
            v->vram[v->address^1]=(uint8_t)(value>>8);
            vdp_increment(v); ++v->dma_bytes;
        }
        v->registers[19]=0; v->registers[20]=0;
    }
}
static uint16_t vdp_port_read(CPU *c, uint32_t address) {
    VDP *v=&c->vdp;
    switch (address&0x1c) {
        case 0: {
            v->command_pending=0;
            uint16_t value=vdp_load_word(c); ++v->data_reads; v->bus_value=value;
            return value;
        }
        case 4:
            v->command_pending=0;
            { uint16_t status=(uint16_t)((v->bus_value&0xfc00)|0x0200|v->pal|
                (vdp_vblank(v) ? 8:0)|(vdp_hblank(v) ? 4:0)|(vdp_status_vint(c) ? 0x80:0));
              return status; }
        case 8: case 12: return vdp_counter(v);
        default: fail(c,"read of write-only VDP/PSG port",address); return 0;
    }
}
static void vdp_port_write(CPU *c, uint32_t address, uint16_t value) {
    if ((address&0x18)==0x10) { psg_write(c,(uint8_t)value); return; }
    switch (address&0x1c) {
        case 0: vdp_data_write(c,value); return;
        case 4: vdp_control_write(c,value); return;
        default: fail(c,"VDP counter/audio port not implemented",address); return;
    }
}
#endif

/* Support for statically translated Z80 operations; no opcode interpreter. */
#ifndef GENESIS_Z80_RUNTIME_H
#define GENESIS_Z80_RUNTIME_H
static unsigned translated_z80_step(CPU *c);
static void z80_reset(CPU *c) {
    Z80CPU *z=&c->z80_cpu;
    z->pc=0; z->wz=0; z->i=0; z->r=0; z->iff1=z->iff2=z->im=z->halted=z->ei_delay=0; z->debt=0;
}
static uint16_t z80_pair(CPU *c, unsigned pair) {
    Z80CPU *z=&c->z80_cpu;
    if (pair<3) return (uint16_t)((z->r8[pair*2]<<8)|z->r8[pair*2+1]);
    if (pair==3) return z->sp;
    if (pair==4) return z->ix;
    if (pair==5) return z->iy;
    return (uint16_t)((z->a<<8)|z->f);
}
static void z80_set_pair(CPU *c, unsigned pair, uint16_t value) {
    Z80CPU *z=&c->z80_cpu;
    if (pair<3) { z->r8[pair*2]=(uint8_t)(value>>8); z->r8[pair*2+1]=(uint8_t)value; }
    else if (pair==3) z->sp=value;
    else if (pair==4) z->ix=value;
    else if (pair==5) z->iy=value;
    else { z->a=(uint8_t)(value>>8); z->f=(uint8_t)value; }
}
static uint8_t z80_read(CPU *c, uint16_t address) {
    if (address<0x4000) return c->z80_bus.ram[address&0x1fff];
    if (c->audio_mode && address<0x6000) return audio_fm_read(c,address&3);
    if (address>=0x8000) return (uint8_t)read_mem(c,((uint32_t)c->z80_bus.bank<<15)|(address&0x7fff),1);
    fail(c,"Z80 peripheral read not implemented",0xa00000+address); return 0;
}
static void z80_write(CPU *c, uint16_t address, uint8_t value) {
    if (address<0x4000) { c->z80_bus.ram[address&0x1fff]=value; return; }
    if (c->audio_mode && address<0x6000) { audio_fm_write(c,address&3,value); return; }
    if (address>=0x6000 && address<0x6100) { c->z80_bus.bank=(uint16_t)((c->z80_bus.bank>>1)|((value&1)<<8)); return; }
    if (address>=0x7f10 && address<0x7f18) { psg_write(c,value); return; }
    if (address>=0x8000) { write_mem(c,((uint32_t)c->z80_bus.bank<<15)|(address&0x7fff),1,value); return; }
    fail(c,"Z80 peripheral write not implemented",0xa00000+address);
}
static uint16_t z80_read16(CPU *c, uint16_t address) {
    uint8_t low=z80_read(c,address); if (c->fault) return 0;
    return (uint16_t)(low|(z80_read(c,(uint16_t)(address+1))<<8));
}
static void z80_write16(CPU *c, uint16_t address, uint16_t value) {
    z80_write(c,address,(uint8_t)value);
    if (!c->fault) z80_write(c,(uint16_t)(address+1),(uint8_t)(value>>8));
}
static uint16_t z80_pop(CPU *c) {
    uint16_t value=z80_read16(c,c->z80_cpu.sp);
    if (!c->fault) c->z80_cpu.sp=(uint16_t)(c->z80_cpu.sp+2);
    return value;
}
static void z80_push(CPU *c, uint16_t value) {
    z80_write(c,--c->z80_cpu.sp,(uint8_t)(value>>8));
    if (!c->fault) z80_write(c,--c->z80_cpu.sp,(uint8_t)value);
}
static uint8_t z80_reg(CPU *c, unsigned reg) {
    return reg<6 ? c->z80_cpu.r8[reg]:reg==6 ? z80_read(c,z80_pair(c,2)):c->z80_cpu.a;
}
static void z80_set_reg(CPU *c, unsigned reg, uint8_t value) {
    if (reg<6) c->z80_cpu.r8[reg]=value;
    else if (reg==6) z80_write(c,z80_pair(c,2),value);
    else c->z80_cpu.a=value;
}
static void z80_m1(CPU *c, unsigned fetches) {
    c->z80_cpu.r=(uint8_t)((c->z80_cpu.r&0x80)|((c->z80_cpu.r+fetches)&0x7f));
}
static uint8_t z80_szxy(uint8_t value) {
    unsigned p=value; p^=p>>4; p^=p>>2; p^=p>>1;
    return (uint8_t)((value&0xa8)|(value==0 ? Z_Z:0)|(!(p&1) ? Z_PV:0));
}
static void z80_alu(CPU *c, unsigned kind, uint8_t src) {
    Z80CPU *z=&c->z80_cpu; uint8_t a=z->a, result, flags;
    if (kind>=4 && kind<=6) {
        result=kind==4 ? a&src:kind==5 ? a^src:a|src;
        flags=(uint8_t)(z80_szxy(result)|(kind==4 ? Z_H:0));
    } else {
        unsigned carry=(kind==1 || kind==3) ? !!(z->f&Z_C):0;
        int sub=kind==2 || kind==3 || kind==7;
        result=(uint8_t)(sub ? a-src-carry:a+src+carry);
        unsigned co=sub ? (unsigned)src+carry>a:(unsigned)a+src+carry>255;
        unsigned ov=!!((sub ? (a^src)&(a^result):~(a^src)&(a^result))&0x80);
        flags=(uint8_t)((z80_szxy(result)&~Z_PV)|(co ? Z_C:0)|(ov ? Z_PV:0)|((a^src^result)&Z_H)|(sub ? Z_N:0));
        if (kind==7) flags=(uint8_t)((flags&~0x28)|(src&0x28));
    }
    z->f=flags; if (kind!=7) z->a=result;
}
static uint8_t z80_inc(CPU *c, uint8_t value, int change) {
    uint8_t result=(uint8_t)(value+change);
    unsigned ov=change<0 ? value==0x80:value==0x7f;
    c->z80_cpu.f=(uint8_t)((c->z80_cpu.f&Z_C)|(z80_szxy(result)&~Z_PV)|((value^result)&Z_H)|(ov ? Z_PV:0)|(change<0 ? Z_N:0));
    return result;
}
static uint8_t z80_rotate(CPU *c, uint8_t value, unsigned kind) {
    unsigned carry=c->z80_cpu.f&Z_C, out;
    uint8_t result;
    if (kind==0 || kind==2 || kind==4 || kind==6) {
        out=value>>7;
        result=(uint8_t)((value<<1)|(kind==0 ? out:kind==2 ? carry:kind==6 ? 1:0));
    } else {
        out=value&1;
        result=(uint8_t)((value>>1)|(kind==1 ? out<<7:kind==3 ? carry<<7:kind==5 ? value&128:0));
    }
    c->z80_cpu.f=(uint8_t)(z80_szxy(result)|out);
    return result;
}
static void z80_add_pair(CPU *c, unsigned pair, uint16_t src) {
    uint16_t hl=z80_pair(c,pair); uint32_t sum=(uint32_t)hl+src;
    c->z80_cpu.wz=(uint16_t)(hl+1);
    c->z80_cpu.f=(uint8_t)((c->z80_cpu.f&(Z_S|Z_Z|Z_PV))|((sum>>8)&0x28)|((hl^src^sum)&0x1000 ? Z_H:0)|(sum>65535 ? Z_C:0));
    z80_set_pair(c,pair,(uint16_t)sum);
}
static void z80_add_hl(CPU *c, uint16_t src) { z80_add_pair(c,2,src); }
static void z80_alu16(CPU *c, uint16_t rhs, int subtract) {
    uint16_t lhs=z80_pair(c,2);
    unsigned carry=c->z80_cpu.f&Z_C;
    uint32_t wide=subtract ? (uint32_t)lhs-rhs-carry:(uint32_t)lhs+rhs+carry;
    uint16_t result=(uint16_t)wide;
    unsigned overflow=(subtract ? lhs^rhs:~(lhs^rhs))&(lhs^result)&0x8000;
    c->z80_cpu.f=(uint8_t)(((result>>8)&0xa8)|(result==0 ? Z_Z:0)|
        ((lhs^rhs^result)&0x1000 ? Z_H:0)|(wide>65535 ? Z_C:0)|
        (overflow ? Z_PV:0)|(subtract ? Z_N:0));
    c->z80_cpu.wz=(uint16_t)(lhs+1);
    z80_set_pair(c,2,result);
}
static void z80_bit(CPU *c, uint8_t value, unsigned bit, uint8_t xy) {
    c->z80_cpu.f=(uint8_t)((c->z80_cpu.f&Z_C)|(xy&0x28)|Z_H|
        (!(value&(1u<<bit)) ? Z_Z|Z_PV:0)|(bit==7 ? value&Z_S:0));
}
static int z80_condition(CPU *c, unsigned condition) {
    uint8_t f=c->z80_cpu.f;
    switch (condition) {
        case 0:return !(f&Z_Z); case 1:return !!(f&Z_Z);
        case 2:return !(f&Z_C); case 3:return !!(f&Z_C);
        case 4:return !(f&Z_PV); case 5:return !!(f&Z_PV);
        case 6:return !(f&Z_S); case 7:return !!(f&Z_S);
    }
    return 0;
}
static int z80_block(CPU *c, int direction, int repeat) {
    uint16_t source=z80_pair(c,2), destination=z80_pair(c,1), count=z80_pair(c,0);
    uint8_t value=z80_read(c,source); if (c->fault) return 0;
    z80_write(c,destination,value); if (c->fault) return 0;
    z80_set_pair(c,2,(uint16_t)(source+direction));
    z80_set_pair(c,1,(uint16_t)(destination+direction));
    z80_set_pair(c,0,--count);
    uint8_t sum=(uint8_t)(c->z80_cpu.a+value);
    c->z80_cpu.f=(uint8_t)((c->z80_cpu.f&(Z_C|Z_Z|Z_S))|(count ? Z_PV:0)|(sum&8)|((sum&2)<<4));
    return repeat && count;
}
static void z80_tick(CPU *c, unsigned quantum) {
    Z80CPU *z=&c->z80_cpu;
    if (c->audio_mode==AUDIO_STUB || c->fault || c->z80_bus.requested || !c->z80_bus.reset_released) return;
    z->debt+=quantum;
    while (z->debt>0 && !c->fault) {
        unsigned cycles;
        if (z->irq_line && z->iff1 && !z->ei_delay) {
            // The Genesis VDP leaves the interrupt-acknowledge data bus at $FF.
            // IM 0 therefore executes RST $38, IM 1 uses its fixed vector.
            z80_m1(c,1);z->iff1=z->iff2=0;z->halted=0;
            z80_push(c,z->pc);if(c->fault)return;
            uint16_t target=z->im==2 ? z80_read16(c,(uint16_t)((z->i<<8)|0xff)):0x38;
            if(c->fault)return;
            z->pc=z->wz=target;cycles=z->im==2 ? 19:13;++z->interrupts;
        } else if (z->halted) { z80_m1(c,1); cycles=4; }
        else {
            cycles=translated_z80_step(c); ++z->steps;
            if(z->ei_delay)--z->ei_delay;
        }
        if (!cycles || c->fault) return;
        z->cycles+=cycles; z->debt-=cycles;
    }
}
#endif

static void logic_flags(CPU *c, uint32_t value, unsigned size) {
    value &= mask_for(size);
    c->sr=(uint16_t)((c->sr & ~15u) | (value==0 ? F_Z:0) | (value & (1u<<(size*8-1)) ? F_N:0));
}
static uint32_t arithmetic(CPU *c, uint32_t dst, uint32_t src, unsigned size, int sub, int compare) {
    uint32_t mask=mask_for(size), sign=1u<<(size*8-1);
    dst &= mask; src &= mask;
    uint32_t result=(sub ? dst-src : dst+src)&mask;
    int carry=sub ? src>dst : (uint64_t)dst+src>mask;
    int overflow=!!((sub ? (dst^src)&(dst^result) : ~(dst^src)&(dst^result)) & sign);
    unsigned flags=(result==0 ? F_Z:0) | (result & sign ? F_N:0) | (carry ? F_C:0) | (overflow ? F_V:0);
    if (compare) c->sr=(uint16_t)((c->sr & ~15u)|flags);
    else c->sr=(uint16_t)((c->sr & ~31u)|flags|(carry ? F_X:0));
    return result;
}
static int64_t signed_bits(uint32_t value, unsigned size) {
    uint64_t range=UINT64_C(1)<<(size*8);
    value &= mask_for(size);
    return value >= range/2 ? (int64_t)value-(int64_t)range : (int64_t)value;
}
static uint32_t extended_arithmetic(CPU *c, uint32_t dst, uint32_t src, unsigned size, int sub) {
    uint32_t mask=mask_for(size), sign=1u<<(size*8-1), x=!!(c->sr&F_X);
    dst &= mask; src &= mask;
    uint32_t result=(uint32_t)(sub ? (uint64_t)dst-src-x : (uint64_t)dst+src+x)&mask;
    int carry=sub ? (uint64_t)src+x>dst : (uint64_t)dst+src+x>mask;
    int64_t mathematical=sub ? signed_bits(dst,size)-signed_bits(src,size)-x : signed_bits(dst,size)+signed_bits(src,size)+x;
    int overflow=mathematical < -(int64_t)sign || mathematical >= sign;
    unsigned flags=(result==0 && (c->sr&F_Z) ? F_Z:0) | (result&sign ? F_N:0) |
        (carry ? F_C|F_X:0) | (overflow ? F_V:0);
    c->sr=(uint16_t)((c->sr&~31u)|flags);
    return result;
}
static uint32_t bcd_arithmetic(CPU *c, uint32_t dst, uint32_t src, int sub) {
    uint32_t x=!!(c->sr&F_X);
    uint32_t low=sub ? (dst&15)-(src&15)-x : (dst&15)+(src&15)+x;
    if (low>9) low=sub ? low-6 : low+6;
    uint32_t decimal=sub ? low+(dst&0xf0)-(src&0xf0) : low+(dst&0xf0)+(src&0xf0);
    unsigned carry=decimal>0x99;
    if (carry) decimal=sub ? decimal+0xa0 : decimal-0xa0;
    uint32_t result=decimal&255;
    /* N/V are undefined by the MC68000 BCD instructions; preserve them. */
    unsigned flags=(result==0 && (c->sr&F_Z) ? F_Z:0)|(carry ? F_C|F_X:0);
    c->sr=(uint16_t)((c->sr&~(F_C|F_X|F_Z))|flags);
    return result;
}
static uint32_t bcd_negate(CPU *c, uint32_t value) {
    value &= 255;
    uint32_t complement=(0x9a-value-!!(c->sr&F_X))&255;
    if (complement==0x9a) {
        c->sr=(uint16_t)(c->sr&~(F_C|F_X));
        return value;
    }
    uint32_t result=((complement&15)==10 ? complement+6:complement)&255;
    unsigned flags=F_C|F_X|(result==0 && (c->sr&F_Z) ? F_Z:0);
    c->sr=(uint16_t)((c->sr&~(F_C|F_X|F_Z))|flags);
    return result;
}
static void set_sr(CPU *c, uint32_t sr) {
    if ((c->sr^sr)&0x2000) {
        if (c->sr&0x2000) { c->ssp=c->a[7]; c->a[7]=c->usp; }
        else { c->usp=c->a[7]; c->a[7]=c->ssp; }
    }
    c->sr=(uint16_t)(sr&0xa71f);
}
/* kind: 0 arithmetic, 1 logical, 2 rotate through X, 3 rotate. */
static uint32_t shift_value(CPU *c, uint32_t value, unsigned count, unsigned size, unsigned kind, int left) {
    uint32_t mask=mask_for(size), sign=1u<<(size*8-1);
    unsigned x=!!(c->sr&F_X), carry=kind==2 ? x:0, overflow=0;
    value &= mask;
    count &= 63;
    for (unsigned n=0; n<count; ++n) {
        unsigned oldsign=!!(value&sign);
        carry=left ? oldsign : value&1;
        uint32_t next=left ? (value<<1)&mask : value>>1;
        if (kind==0 && !left && oldsign) next|=sign;
        if (kind==2) next|=left ? x : (x ? sign:0);
        if (kind==3) next|=left ? carry : (carry ? sign:0);
        if (kind==0 && left && oldsign!=!!(next&sign)) overflow=1;
        if (kind!=3) x=carry;
        value=next;
    }
    unsigned flags=(value==0 ? F_Z:0)|(value&sign ? F_N:0)|(carry ? F_C:0)|(overflow ? F_V:0);
    c->sr=(uint16_t)((c->sr&~31u)|flags|(x ? F_X:0));
    return value;
}
static uint32_t divide_value(CPU *c, uint32_t dividend, uint32_t divisor, int is_signed) {
    divisor &= 0xffff;
    if (!divisor) { fail(c,"division by zero exception not implemented",c->pc); return dividend; }
    int64_t d=is_signed ? signed_bits(dividend,4) : (int64_t)dividend;
    int64_t s=is_signed ? signed_bits(divisor,2) : (int64_t)divisor;
    int64_t quotient=d/s, remainder=d%s;
    if (is_signed ? quotient < -32768 || quotient > 32767 : quotient>65535) {
        c->sr=(uint16_t)((c->sr&~15u)|F_V); return dividend;
    }
    logic_flags(c,(uint32_t)quotient,2);
    return ((uint32_t)remainder&0xffff)<<16 | ((uint32_t)quotient&0xffff);
}
static void movem(CPU *c, unsigned mask, uint32_t address, unsigned mode, unsigned base, unsigned size, int load) {
    uint32_t registers[16];
    for (unsigned r=0; r<8; ++r) { registers[r]=c->d[r]; registers[r+8]=c->a[r]; }
    for (unsigned bit=0; bit<16; ++bit) {
        if (!(mask&(1u<<bit))) continue;
        unsigned reg=!load && mode==4 ? 15-bit:bit;
        if (!load && mode==4) address-=size;
        if (load) {
            uint32_t value=read_mem(c,address,size);
            if (c->fault) return;
            if (size==2) value=sign_extend(value,2);
            if (reg<8) c->d[reg]=value; else c->a[reg-8]=value;
        } else {
            write_mem(c,address,size,registers[reg]);
            if (c->fault) return;
        }
        if (load || mode!=4) address+=size;
    }
    if (mode==3 || mode==4) c->a[base]=address;
}
static int condition(CPU *c, unsigned cond) {
    int n=!!(c->sr&F_N), z=!!(c->sr&F_Z), v=!!(c->sr&F_V), carry=!!(c->sr&F_C);
    switch (cond) {
        case 0:return 1; case 1:return 0;
        case 2:return !carry&&!z; case 3:return carry||z;
        case 4:return !carry; case 5:return carry;
        case 6:return !z; case 7:return z;
        case 8:return !v; case 9:return v;
        case 10:return !n; case 11:return n;
        case 12:return n==v; case 13:return n!=v;
        case 14:return !z&&n==v; case 15:return z||n!=v;
    }
    return 0;
}
static uint32_t index_value(CPU *c, unsigned extension) {
    uint32_t value=extension&0x8000 ? c->a[(extension>>12)&7] : c->d[(extension>>12)&7];
    return extension&0x0800 ? value : sign_extend(value,2);
}
static void push32(CPU *c, uint32_t value) { c->a[7]-=4; write_mem(c,c->a[7],4,value); }
static uint32_t pop32(CPU *c) { uint32_t value=read_mem(c,c->a[7],4); if (!c->fault) c->a[7]+=4; return value; }
/* Defined by the generated translation. */
static void translated_step(CPU *c);
#ifndef GENESIS_SCHEDULER_H
#define GENESIS_SCHEDULER_H
static void machine_advance(CPU *c, unsigned cycles) {
    if (c->fault) return;
    unsigned clocks=cycles*7;
    c->cycles+=cycles; c->master_cycles+=clocks;
    vdp_advance(c,clocks);
    unsigned zclocks=c->z80_divider+clocks;
    c->z80_divider=zclocks%15;
    z80_tick(c,zclocks/15);
    audio_sync(c);
}
static int machine_interrupt(CPU *c) {
    unsigned level=vdp_irq_level(&c->vdp);
    if (!level || level<=((c->sr>>8)&7)) return 0;
    uint16_t saved=c->sr; uint32_t pc=c->pc;
    set_sr(c,(saved|0x2000)&~0x8000u);
    push32(c,pc); if (c->fault) return 1;
    c->a[7]-=2; write_mem(c,c->a[7],2,saved); if (c->fault) return 1;
    c->sr=(uint16_t)((c->sr&~0x700u)|(level<<8));
    uint32_t target=read_mem(c,(24+level)*4,4);
    if (c->fault) return 1;
    c->pc=target&0xffffff; c->halted=0;
    vdp_irq_ack(&c->vdp,level); ++c->interrupts;
    machine_advance(c,44);
    return 1;
}
static void machine_step(CPU *c) {
    if (c->fault) return;
    if (machine_interrupt(c)) return;
    if (c->halted) {
#ifdef GENESIS_DUNE_MOUSE
        c->dune_wait_cycles+=4;
#endif
        machine_advance(c,4); return;
    }
#ifdef GENESIS_DUNE_MOUSE
    uint32_t original_pc=c->pc;
#endif
    c->instruction_cycles=0;
    translated_step(c); ++c->steps;
    unsigned cycles=c->instruction_cycles;
    c->instruction_cycles=0;
#ifdef GENESIS_DUNE_MOUSE
    /* Original wait-for-VBlank loop: CMP $FFE006; BEQ back to CMP. */
    if(original_pc==0xfda || original_pc==0xfde)c->dune_wait_cycles+=cycles;
#endif
    machine_advance(c,cycles);
}
static int machine_can_wake(const CPU *c) {
    unsigned mask=(c->sr>>8)&7;
    return ((c->vdp.registers[1]&0x20) && mask<6) || ((c->vdp.registers[0]&0x10) && mask<4);
}
#endif

/* Dune's original map descriptors and native sprite traversal, presentation only. */
#ifndef GENESIS_DUNE_VIEW_H
#define GENESIS_DUNE_VIEW_H
#ifdef GENESIS_DUNE_MOUSE
typedef struct {
    CPU *shadow;
    uint8_t *pixels,*ui;
    unsigned zoom,width,height;
    int left,top,cursor_valid,cursor_x,cursor_y,cursor_hidden;
    int camera_valid,camera_x,camera_y,last_camera_x,last_camera_y;
    int pointer_valid,pointer_x,pointer_y;
    uint64_t pan_frame;
    uint64_t frame;
} DuneView;
typedef struct {
    int width,height,world_width,world_height,left,top;
    double ui_scale,world_scale,ui_x,ui_y;
} DuneLayout;
#include "em_web_present.h"
#include "em_web_portrait.h"
static DuneLayout dune_view_layout(const CPU *c,int w,int h,unsigned zoom){
    DuneLayout p={0};p.width=w;p.height=h;
    if(w<=0 || h<=0 || !c->vdp.frame_width || !c->vdp.frame_height)return p;
    if(zoom<50)zoom=50;if(zoom>100)zoom=100;
    p.ui_scale=(double)w/c->vdp.frame_width;
    if((double)h/c->vdp.frame_height<p.ui_scale)p.ui_scale=(double)h/c->vdp.frame_height;
    p.ui_x=(w-c->vdp.frame_width*p.ui_scale)/2;p.ui_y=(h-c->vdp.frame_height*p.ui_scale)/2;
    if(h>w && (dune_mouse_context(c)==2 || dune_mouse_context(c)==3))p.ui_y=h-c->vdp.frame_height*p.ui_scale;
    p.world_scale=p.ui_scale*zoom/100.0;
    if(w/1024.0>p.world_scale)p.world_scale=w/1024.0;
    if(h/768.0>p.world_scale)p.world_scale=h/768.0;
    p.world_width=(int)(w/p.world_scale+0.999);p.world_height=(int)(h/p.world_scale+0.999);
    p.left=(int)dune_word(c,0xe3ec)+160-p.world_width/2;
    p.top=(int)dune_word(c,0xe3ee)+112-p.world_height/2;
    return p;
}
static unsigned dune_view_rom_word(const CPU *c,unsigned a){
    return a+1<c->rom_size?((unsigned)c->rom[a]<<8)|c->rom[a+1]:0;
}
static void dune_view_rgb(const VDP *v,unsigned a,unsigned b,unsigned s,uint8_t *out){
    unsigned color=v->registers[7]&63,intensity=1;
    if(v->registers[12]&8){unsigned mix=vdp_shadow_pixel(a,b,s,color);color=mix&63;intensity=mix>>6;}
    else{
        if(b && !(b&128))color=b&63;if(a && !(a&128))color=a&63;
        if(s && !(s&128))color=s&63;if(b&128)color=b&63;
        if(a&128)color=a&63;if(s&128)color=s&63;
    }
    unsigned rgb=v->cram[color];out[0]=vdp_channel((rgb>>1)&7,intensity);
    out[1]=vdp_channel((rgb>>5)&7,intensity);out[2]=vdp_channel((rgb>>9)&7,intensity);
}
static void dune_view_terrain(const CPU *c,int wx,int wy,unsigned *a,unsigned *b){
    *a=*b=0;if(wx<0 || wy<0 || wx>=2048 || wy>=2048)return;
    unsigned map=0x7d9c+((wy/32)*64+wx/32)*4,word=dune_word(c,map);
    unsigned cell=((wy&31)/8)*8+((wx&31)/8)*2,overlay=(word>>8)&254;
    if(c->ram[0xc198] && overlay>=0x67)overlay=0;
    unsigned ae=dune_view_rom_word(c,0x4adf0+overlay*16+cell);
    unsigned be=dune_view_rom_word(c,0x4adf0+(word&511)*32+cell);
    *a=vdp_tile_pixel(&c->vdp,ae,wx&7,wy&7);*b=vdp_tile_pixel(&c->vdp,be,wx&7,wy&7);
}
#include "em_web_ready.h"
static int dune_view_sprites(DuneView *v,const CPU *source,int left,int top,uint8_t *sprites,int ui){
    CPU *c=v->shadow;memcpy(c,source,sizeof *c);c->audio_mode=AUDIO_STUB;
    if(ui<2 && !em_web_ready_overlay(c,source,em_web_cursor_preview(source))){memcpy(c,source,sizeof *c);c->audio_mode=AUDIO_STUB;}
    unsigned head=dune_word(c,ui>=2?0xf5b4:0xf3ac),at=head;
    for(unsigned n=0;at && n<512;++n){
        if(at>65520)return 0;
        /* Fixed UI is composited separately. Freeze animation counters on the copy. */
        /* BF18 is the screen cursor. BF60 is a separate WORLD order marker;
           moving that marker left the real cursor in the HUD layer. */
        em_web_frame_project_flyover(c,source,at,v->left,v->top,v->width,v->height,ui);
        if(ui>=2){
            /* Keep the original red selection frame on the active menu cell.
             * Ordinary map cursors remain hidden in the separate map path. */
        }else if(at==dune_word(c,0xbf52)){
            c->ram[at+7]|=0x80;
        }else if(at==dune_word(c,0xbf18)){
            if(ui || v->cursor_hidden)c->ram[at+7]|=0x80;
            else{
                int wx=v->cursor_valid?v->cursor_x:dune_word(source,0xe3ec)+dune_word(source,0xbf12);
                int wy=v->cursor_valid?v->cursor_y:dune_word(source,0xe3ee)+dune_word(source,0xbf14);
                /* $6092 is the grid cursor; $6D10 is the free pointer. */
                if(v->cursor_valid && dune_long(source,0xe002)==0x6092){wx&=~31;wy&=~31;}
                write_mem(c,0xff0000+at,4,0xffefa0);
                write_mem(c,0xffefa0,2,wy*8);write_mem(c,0xffefa2,2,wx*8);
                c->ram[at+7]&=(uint8_t)~0x44;
            }
        }else if(!!(c->ram[at+7]&0x40)!=!!ui)c->ram[at+7]|=0x80;
        em_web_ready_freeze_sprite(c,source,at);at=dune_word(c,at+14);
    }
    c->ram[0xe3be]=(uint8_t)(left>>8);c->ram[0xe3bf]=(uint8_t)left;
    c->ram[0xe3c0]=(uint8_t)(top>>8);c->ram[0xe3c1]=(uint8_t)top;
    c->pc=0x1088;c->a[0]=(uint32_t)(int32_t)(int16_t)head;c->sr=0x2700;c->a[7]=0xffef00;
    write_mem(c,c->a[7],4,0xdead00);
    unsigned steps=0;
    while(!c->fault && c->pc!=0xdead00 && steps++<100000)translated_step(c);
    if(c->fault || c->pc!=0xdead00)return 0;
    unsigned sat=(c->vdp.registers[5]&0x7e)<<9;
    for(unsigned i=0;i<640;++i)c->vdp.vram[(sat+i)&65535]=c->ram[0xe428+i];
    memset(sprites,0,320*224);vdp_sprites(&c->vdp,320,224,sprites);return 1;
}
#include "em_web_world_raster.h"
static const uint8_t *em_web_menu_frame(DuneView *v,const CPU *c){
    (void)v;
    return c->vdp.frame;
}
static int dune_view_build(DuneView *v,const CPU *c,const DuneLayout *p){
    if(!p->world_width || !p->world_height)return 0;
    if(!v->shadow)v->shadow=malloc(sizeof *v->shadow);
    if(!v->shadow)return 0;
    if(v->width!=(unsigned)p->world_width || v->height!=(unsigned)p->world_height){
        size_t size=(size_t)p->world_width*p->world_height*4;
        uint8_t *pixels=realloc(v->pixels,size);if(!pixels)return 0;
        v->pixels=pixels;v->width=p->world_width;v->height=p->world_height;
    }
    v->left=p->left;v->top=p->top;
    uint8_t sprites[320*224];
    for(unsigned by=0;by<v->height;by+=192)for(unsigned bx=0;bx<v->width;bx+=256){
        if(!dune_view_sprites(v,c,p->left+(int)bx-32,p->top+(int)by-16,sprites,0))return 0;
        unsigned bw=v->width-bx<256?v->width-bx:256,bh=v->height-by<192?v->height-by:192;
        em_web_world_raster_chunk(c,&v->shadow->vdp,
            p->left+(int)bx,p->top+(int)by,bw,bh,
            sprites+16*320+32,320,v->pixels+((size_t)by*v->width+bx)*4,(size_t)v->width*4);
    }
    if(!v->ui)v->ui=malloc(320*224*4);
    if(!v->ui || !dune_view_sprites(v,c,dune_word(c,0xe3ec),dune_word(c,0xe3ee),sprites,1))return 0;
    /* Alpha alone cannot isolate the HUD: the live framebuffer already has
       the world cursor/placement preview over its opaque minimap pixels. */
    uint8_t clean_ui[320*224*3];
    vdp_render_pixels(&v->shadow->vdp,320,224,sprites,clean_ui);
    int minimap_visible=0;
    for(unsigned y=144;y<208;++y)for(unsigned x=240;x<304;++x)minimap_visible|=sprites[y*320+x]!=0;
    for(unsigned y=0;y<224;++y)for(unsigned x=0;x<320;++x){
        unsigned at=y*320+x;
        memcpy(v->ui+at*4,clean_ui+at*3,3);
        int minimap=minimap_visible && x>=240 && x<304 && y>=144 && y<208;
        v->ui[at*4+3]=(minimap || sprites[at])?255:0;
        /* Keep the original frame pixel-exact in its central world area.
           A virtual cursor outside that area needs the replayed world layer. */
        int xx=(int)dune_word(c,0xe3ec)+(int)x-p->left;
        int yy=(int)dune_word(c,0xe3ee)+(int)y-p->top;
        if(!v->cursor_valid && !v->cursor_hidden && !v->ui[at*4+3] && xx>=0 && yy>=0 && xx<(int)v->width && yy<(int)v->height)
            {uint8_t *out=v->pixels+((unsigned)yy*v->width+(unsigned)xx)*4;memcpy(out,c->vdp.frame+at*3,3);out[3]=255;}
    }
    v->left=p->left;v->top=p->top;v->frame=c->vdp.rendered_frames;return 1;
}
#endif
#endif

/* SDL2 presents the existing RGB renderer and supplies three-button pad input. */
#ifndef GENESIS_SDL_FRONTEND_H
#define GENESIS_SDL_FRONTEND_H
#ifdef GENESIS_SDL2
#include <SDL.h>

#ifndef GENESIS_WINDOW_TITLE
#define GENESIS_WINDOW_TITLE "ReArrakis"
#endif
typedef struct {
    SDL_Window *window;
#ifdef GENESIS_DUNE_MOUSE
    DuneMouse dune_mouse;
    DuneView dune_view;
    SDL_Texture *dune_world,*dune_hud;
    unsigned dune_width,dune_height;
    int dune_window_width,dune_window_height;
    int dune_volume;
    int dune_cpu_overlay,dune_cpu_sample_valid;
    unsigned dune_cpu_percent;
    uint64_t dune_cpu_cycles,dune_cpu_idle,dune_cpu_frame;
#endif
    SDL_Renderer *renderer;
    SDL_Texture *texture;
    SDL_AudioDeviceID audio_device;
    int audio_running;
    unsigned width, height;
    uint64_t last_frame, next_service, origin_master;
    Uint64 origin_counter, frequency;
    int paused, stopped, fast_forward, no_throttle, error;
} SDLHost;

static void sdl_host_close(SDLHost *h) {
#ifdef GENESIS_DUNE_MOUSE
    free(h->dune_view.shadow);free(h->dune_view.pixels);free(h->dune_view.ui);
    SDL_DestroyTexture(h->dune_world);SDL_DestroyTexture(h->dune_hud);
#endif
    if(h->audio_device)SDL_CloseAudioDevice(h->audio_device);
    h->audio_device=0;h->audio_running=0;
    SDL_DestroyTexture(h->texture);
    SDL_DestroyRenderer(h->renderer);
    SDL_DestroyWindow(h->window);
    h->texture=NULL; h->renderer=NULL; h->window=NULL;
    SDL_Quit();
}
static int sdl_host_error(SDLHost *h, const char *operation) {
    fprintf(stderr,"SDL2 %s: %s\n",operation,SDL_GetError());
    h->error=1; return 0;
}
/* Host playback gain for the verified Dune ROM; keeps chip timing untouched. */
#ifndef GENESIS_DUNE_AUDIO_H
#define GENESIS_DUNE_AUDIO_H
#ifdef GENESIS_DUNE_MOUSE
static int dune_audio_volume(const char *text){
 if(!text || !*text)return 100;
 char *end;long value=strtol(text,&end,10);
 return end==text || *end || value<0 || value>200 ? 100:(int)value;
}
static int16_t dune_audio_scale(int16_t sample,int percent){
 int32_t value=(int32_t)sample*4*percent/100;
 int negative=value<0;if(negative)value=-value;
 /* Smooth knee above 24000; bounded below the signed PCM ceiling. */
 if(value>24000){
  int32_t excess=value-24000;
  value=24000+(int32_t)((int64_t)excess*8767/(excess+8767));
 }
 return (int16_t)(negative?-value:value);
}
#endif
#endif

#ifndef GENESIS_DUNE_VIEW_SDL_H
#define GENESIS_DUNE_VIEW_SDL_H
#if defined(GENESIS_DUNE_MOUSE) && defined(GENESIS_SDL2)
/* Approximate original 68000 occupancy, excluding Dune's VBlank wait loop.
   This measures console cycle use, not host CPU use or rendering speed. */
#ifndef GENESIS_DUNE_CPU_SDL_H
#define GENESIS_DUNE_CPU_SDL_H
#if defined(GENESIS_DUNE_MOUSE) && defined(GENESIS_SDL2)
static void dune_cpu_sample(SDLHost *h,const CPU *c){
    if(!h->dune_cpu_sample_valid || c->cycles<h->dune_cpu_cycles ||
       c->dune_wait_cycles<h->dune_cpu_idle || c->vdp.frames<h->dune_cpu_frame){
        h->dune_cpu_cycles=c->cycles;h->dune_cpu_idle=c->dune_wait_cycles;
        h->dune_cpu_frame=c->vdp.frames;h->dune_cpu_sample_valid=1;h->dune_cpu_percent=0;return;
    }
    if(c->vdp.frames-h->dune_cpu_frame<15)return;
    uint64_t total=c->cycles-h->dune_cpu_cycles,idle=c->dune_wait_cycles-h->dune_cpu_idle;
    if(idle>total)idle=total;
    h->dune_cpu_percent=total?(unsigned)(((total-idle)*100+total/2)/total):0;
    h->dune_cpu_cycles=c->cycles;h->dune_cpu_idle=c->dune_wait_cycles;h->dune_cpu_frame=c->vdp.frames;
}
static int dune_cpu_text(SDL_Renderer *r,const char *text,int x,int y){
    static const uint8_t digits[10][5]={{7,5,5,5,7},{2,6,2,2,7},{7,1,7,4,7},{7,1,7,1,7},{5,5,7,1,1},{7,4,7,1,7},{7,4,7,5,7},{7,1,1,1,1},{7,5,7,5,7},{7,5,7,1,7}};
    static const uint8_t k[5]={5,5,6,5,5},colon[5]={0,2,0,2,0},percent[5]={5,1,2,4,5};
    for(;*text;++text,x+=8){
        const uint8_t *glyph=*text>='0' && *text<='9'?digits[*text-'0']:*text=='K'?k:*text==':'?colon:*text=='%'?percent:NULL;
        if(!glyph)continue;
        for(int row=0;row<5;++row)for(int col=0;col<3;++col)if(glyph[row]&(4>>col)){
            SDL_Rect pixel={x+col*2,y+row*2,2,2};if(SDL_RenderFillRect(r,&pixel))return 0;
        }
    }
    return 1;
}
static int dune_cpu_draw(SDLHost *h,const CPU *c){
    if(!h->dune_cpu_overlay)return 1;
    dune_cpu_sample(h,c);
    SDL_BlendMode blend;Uint8 r,g,b,a;
    if(SDL_GetRenderDrawBlendMode(h->renderer,&blend) || SDL_GetRenderDrawColor(h->renderer,&r,&g,&b,&a))return 0;
    SDL_Rect panel={8,8,112,34},bar={12,26,100,8};
    int ok=!SDL_SetRenderDrawBlendMode(h->renderer,SDL_BLENDMODE_BLEND) &&
           !SDL_SetRenderDrawColor(h->renderer,0,0,0,200) && !SDL_RenderFillRect(h->renderer,&panel) &&
           !SDL_SetRenderDrawColor(h->renderer,240,240,240,255);
    char label[16];snprintf(label,sizeof label,"68K: %u%%",h->dune_cpu_percent);
    if(ok)ok=dune_cpu_text(h->renderer,label,12,12) && !SDL_RenderDrawRect(h->renderer,&bar);
    bar.x++;bar.y++;bar.h-=2;bar.w=(int)(98*h->dune_cpu_percent/100);
    if(ok)ok=!SDL_SetRenderDrawColor(h->renderer,h->dune_cpu_percent>=80?255:64,h->dune_cpu_percent>=95?72:220,64,255);
    if(ok && bar.w)ok=!SDL_RenderFillRect(h->renderer,&bar);
    if(SDL_SetRenderDrawBlendMode(h->renderer,blend) || SDL_SetRenderDrawColor(h->renderer,r,g,b,a))ok=0;
    return ok;
}
#endif
#endif

static int dune_view_map(const CPU *c){return !c->fault && dune_mouse_context(c)==1 && c->vdp.frame_width==320 && c->vdp.frame_height==224;}
static DuneLayout dune_view_host_layout(SDLHost *h,const CPU *c,int w,int height){
    DuneView *v=&h->dune_view;DuneMouse *m=&h->dune_mouse;
    int cx=dune_word(c,0xe3ec),cy=dune_word(c,0xe3ee);
    if(!v->camera_valid){v->camera_x=cx;v->camera_y=cy;v->last_camera_x=cx;v->last_camera_y=cy;v->camera_valid=1;}
    /* Internal camera movement makes the original game able to pick an
       offscreen target. It must not move the player's expanded overview. */
    if(0){
        v->camera_x+=cx-v->last_camera_x;v->camera_y+=cy-v->last_camera_y;
    }else if(0){
        uint64_t elapsed=c->vdp.rendered_frames-v->pan_frame;if(elapsed>4)elapsed=4;
        v->camera_x+=m->pan_x*(int)elapsed;v->camera_y+=m->pan_y*(int)elapsed;
        int minx=dune_word(c,0xe400),maxx=dune_word(c,0xe402),miny=dune_word(c,0xe3fc),maxy=dune_word(c,0xe3fe);
        if(v->camera_x<minx)v->camera_x=minx;if(v->camera_x>maxx)v->camera_x=maxx;
        if(v->camera_y<miny)v->camera_y=miny;if(v->camera_y>maxy)v->camera_y=maxy;
    }
    v->pan_frame=c->vdp.rendered_frames;
    v->last_camera_x=cx;v->last_camera_y=cy;
    DuneLayout p=dune_view_layout(c,w,height,v->zoom);
    p.left+=v->camera_x-cx;p.top+=v->camera_y-cy;return p;
}
/* The map covers the drawable. The top HUD alone avoids the status bar. */
static double em_web_map_hud_top_ratio;
static double em_web_map_hud_top(int drawable_height){
    return drawable_height*em_web_map_hud_top_ratio;
}
static int dune_view_mouse(SDLHost *h,const CPU *c,int mx,int my,int *x,int *y,int *world){
    *world=0;*x=mx;*y=my;if(!h->renderer)return 1;
    int ww,wh,w,hg;SDL_GetWindowSize(h->window,&ww,&wh);
    if(ww<=0 || wh<=0 || SDL_GetRendererOutputSize(h->renderer,&w,&hg))return 0;
    if(mx<0 || my<0 || mx>=ww || my>=wh)return 0;
    double px=(double)mx*w/ww,py=(double)my*hg/wh;
    DuneLayout p=dune_view_map(c)?dune_view_host_layout(h,c,w,hg):dune_view_layout(c,w,hg,h->dune_view.zoom);
    if(!p.ui_scale)return 0;
    if(!dune_view_map(c)){
        EmWebPortraitLayout portrait;
        if(em_web_portrait_layout(dune_mouse_context(c),ww,wh,w,hg,&portrait))return em_web_portrait_hit(&portrait,px,py,x,y);
        *x=(int)((px-p.ui_x)/p.ui_scale);*y=(int)((py-p.ui_y)/p.ui_scale);
        return px>=p.ui_x && py>=p.ui_y && *x<(int)c->vdp.frame_width && *y<(int)c->vdp.frame_height;
    }
    double ux=(px-(w-320*p.ui_scale))/p.ui_scale,uy=(py-em_web_map_hud_top(hg))/p.ui_scale;
    double bottom_y=(py-(hg-224*p.ui_scale))/p.ui_scale;
    int top_hit=0;
    int bottom_hit=ux>=240 && ux<304 && bottom_y>=144 && bottom_y<208;
    if(h->dune_view.ui && ux>=0 && ux<320){
        if(uy>=0 && uy<144 && h->dune_view.ui[((int)uy*320+(int)ux)*4+3])top_hit=1;
        if(bottom_y>=144 && bottom_y<224 && h->dune_view.ui[((int)bottom_y*320+(int)ux)*4+3])bottom_hit=1;
    }
    if(top_hit || bottom_hit){*x=(int)ux;*y=(int)(bottom_hit?bottom_y:uy);return 1;}
    *world=1;*x=p.left+(int)(px/p.world_scale);*y=p.top+(int)(py/p.world_scale);
    return *x>=0 && *y>=0 && *x<2048 && *y<2048;
}
static void dune_view_pointer(SDLHost *h,const CPU *c){
    DuneView *v=&h->dune_view;DuneMouse *m=&h->dune_mouse;
    if(!v->pointer_valid){
        m->pan_x=0;m->pan_y=0;
        return;
    }
    int x,y,world;
    if(!dune_view_mouse(h,c,v->pointer_x,v->pointer_y,&x,&y,&world)){
        if(dune_view_map(c)){m->camera_hold=1;}
        m->pan_x=0;m->pan_y=0;
        return;
    }
    if(world)dune_mouse_world_point(m,c,x,y);else dune_mouse_point(m,c,x,y);
    m->pan_x=m->pan_y=0;
    /* No edge-hover scrolling. Drag/pinch own presentation movement. */

}
static int dune_view_event(SDLHost *h,CPU *c,const SDL_Event *e){
    if(!h->dune_view.zoom)h->dune_view.zoom=100;
    if(!h->paused && !h->stopped && dune_view_map(c) &&
       e->type==SDL_MOUSEBUTTONDOWN && e->button.button==SDL_BUTTON_LEFT){
        int x,y,world;
        if(dune_view_mouse(h,c,e->button.x,e->button.y,&x,&y,&world) &&
           !world && x>=240 && x<304 && y>=144 && y<208){
            /* One minimap pixel represents one 32px world cell. Center the
               independent overview; do not send A/B or change unit selection. */
            DuneView *v=&h->dune_view;
            v->camera_x=(x-240)*32+16-160;
            v->camera_y=(y-144)*32+16-112;
            int minx=dune_word(c,0xe400),maxx=dune_word(c,0xe402);
            int miny=dune_word(c,0xe3fc),maxy=dune_word(c,0xe3fe);
            if(v->camera_x<minx)v->camera_x=minx;if(v->camera_x>maxx)v->camera_x=maxx;
            if(v->camera_y<miny)v->camera_y=miny;if(v->camera_y>maxy)v->camera_y=maxy;
            v->camera_valid=1;v->last_camera_x=dune_word(c,0xe3ec);v->last_camera_y=dune_word(c,0xe3ee);
            v->pan_frame=c->vdp.rendered_frames;v->frame=UINT64_MAX;
            v->pointer_valid=1;v->pointer_x=e->button.x;v->pointer_y=e->button.y;
            dune_mouse_reset(&h->dune_mouse);h->dune_mouse.camera_hold=1;
            dune_view_pointer(h,c);return 1;
        }
    }
    if(!h->paused && !h->stopped && dune_view_map(c) && e->type==SDL_MOUSEWHEEL){
        int w,height;if(SDL_GetRendererOutputSize(h->renderer,&w,&height) || w<=0 || height<=0)return 0;
        DuneLayout old=dune_view_host_layout(h,c,w,height);
        int ax,ay,world=0;
        int anchor=h->dune_view.pointer_valid && dune_view_mouse(h,c,h->dune_view.pointer_x,h->dune_view.pointer_y,&ax,&ay,&world) && world;
        int delta=e->wheel.y;if(delta>20)delta=20;if(delta<-20)delta=-20;
        if(e->wheel.direction==SDL_MOUSEWHEEL_FLIPPED)delta=-delta;
        int zoom=(int)h->dune_view.zoom+delta*10;if(zoom<60)zoom=60;if(zoom>100)zoom=100;
        h->dune_view.zoom=zoom;
        if(anchor){
            int ww,wh;SDL_GetWindowSize(h->window,&ww,&wh);
            double px=(double)h->dune_view.pointer_x*w/ww,py=(double)h->dune_view.pointer_y*height/wh;
            DuneLayout next=dune_view_host_layout(h,c,w,height);
            h->dune_view.camera_x+=(int)(old.left+px/old.world_scale-next.left-px/next.world_scale);
            h->dune_view.camera_y+=(int)(old.top+py/old.world_scale-next.top-py/next.world_scale);
        }
        dune_mouse_reset(&h->dune_mouse);dune_view_pointer(h,c);return !!delta;
    }
    if(e->type==SDL_KEYDOWN && !e->key.repeat && e->key.keysym.sym==SDLK_F3){
        h->dune_cpu_overlay=!h->dune_cpu_overlay;h->dune_cpu_sample_valid=0;return 1;
    }
    if(e->type==SDL_KEYDOWN && !e->key.repeat && e->key.keysym.sym==SDLK_0){
        h->dune_view.zoom=100;dune_mouse_reset(&h->dune_mouse);dune_view_pointer(h,c);return 1;
    }
    if(e->type==SDL_KEYDOWN && !e->key.repeat && e->key.keysym.sym==SDLK_F11 && h->window){
        Uint32 flag=SDL_GetWindowFlags(h->window)&SDL_WINDOW_FULLSCREEN_DESKTOP;
        if(SDL_SetWindowFullscreen(h->window,flag?0:SDL_WINDOW_FULLSCREEN_DESKTOP))return 0;
        dune_mouse_reset(&h->dune_mouse);return 1;
    }
    if(e->type==SDL_WINDOWEVENT && e->window.event==SDL_WINDOWEVENT_SIZE_CHANGED)dune_mouse_reset(&h->dune_mouse);
    return 0;
}
static int em_web_original_video;
static int em_web_campaign_world_visible(const CPU *c);
static int em_web_campaign_battle_presentation(const CPU *c);
static int em_web_campaign_world_hold(const CPU *c);
static SDLHost *em_web_last_world_host;static DuneLayout em_web_last_world_layout;
static int em_web_last_world_w,em_web_last_world_h;
static int dune_view_draw(SDLHost *h,CPU *c){
    VDP *v=&c->vdp;if(!h->dune_view.zoom)h->dune_view.zoom=100;
    int window_w,window_h;SDL_GetWindowSize(h->window,&window_w,&window_h);
    if(window_w!=h->dune_window_width || window_h!=h->dune_window_height){
        /* SDL's software renderer refreshes its window surface lazily. Flush
           once on resize before querying pixels and resetting the viewport. */
        if(SDL_RenderSetLogicalSize(h->renderer,0,0) || SDL_RenderSetScale(h->renderer,1,1) ||
           SDL_RenderSetViewport(h->renderer,NULL) || SDL_RenderClear(h->renderer) ||
           SDL_RenderFlush(h->renderer))return sdl_host_error(h,"Dune resize failed");
        h->dune_window_width=window_w;h->dune_window_height=window_h;
    }
    int w,hg;if(SDL_GetRendererOutputSize(h->renderer,&w,&hg))return sdl_host_error(h,"Dune output size failed");
    if(w<=0 || hg<=0 || !v->frame_width || !v->frame_height)return 1;
    if(SDL_RenderSetLogicalSize(h->renderer,0,0) || SDL_RenderSetScale(h->renderer,1,1) ||
       SDL_RenderSetViewport(h->renderer,NULL))return sdl_host_error(h,"Dune viewport failed");
    if(!em_web_original_video && !em_web_campaign_world_visible(c)){
        if(SDL_SetRenderDrawColor(h->renderer,0,0,0,255) || SDL_RenderClear(h->renderer))return sdl_host_error(h,"Dune UI transition clear failed");
        if(em_web_campaign_world_hold(c)&&em_web_last_world_host==h&&h->dune_world&&h->dune_hud&&em_web_last_world_w>0&&em_web_last_world_h>0){
            DuneLayout *last=&em_web_last_world_layout;float sx=(float)w/em_web_last_world_w,sy=(float)hg/em_web_last_world_h;
            SDL_FRect world={0,0,(float)(h->dune_width*last->world_scale)*sx,(float)(h->dune_height*last->world_scale)*sy};
            SDL_Rect top={0,0,320,144},bottom={0,144,320,80};
            SDL_FRect t={(float)(em_web_last_world_w-320*last->ui_scale)*sx,(float)em_web_map_hud_top(hg),(float)(320*last->ui_scale)*sx,(float)(144*last->ui_scale)*sy};
            SDL_FRect b={t.x,(float)(em_web_last_world_h-80*last->ui_scale)*sy,t.w,(float)(80*last->ui_scale)*sy};
            if(SDL_RenderCopyF(h->renderer,h->dune_world,NULL,&world)||SDL_RenderCopyF(h->renderer,h->dune_hud,&top,&t)||SDL_RenderCopyF(h->renderer,h->dune_hud,&bottom,&b))return sdl_host_error(h,"Dune held world draw failed");
        }
        h->last_frame=v->rendered_frames;SDL_RenderPresent(h->renderer);return 1;
    }
    int adapted=dune_view_map(c)||(!em_web_original_video&&em_web_campaign_battle_presentation(c));
    DuneLayout p=adapted?dune_view_host_layout(h,c,w,hg):dune_view_layout(c,w,hg,h->dune_view.zoom);
    if(SDL_RenderClear(h->renderer))return sdl_host_error(h,"Dune clear failed");
    if(!adapted){
        if(dune_mouse_active(&h->dune_mouse,c)>=4)h->dune_view.camera_valid=0;
        if(!h->texture || h->width!=v->frame_width || h->height!=v->frame_height){
            SDL_DestroyTexture(h->texture);h->texture=SDL_CreateTexture(h->renderer,SDL_PIXELFORMAT_RGB24,SDL_TEXTUREACCESS_STREAMING,v->frame_width,v->frame_height);
            if(!h->texture)return sdl_host_error(h,"Dune native texture failed");
            h->width=v->frame_width;h->height=v->frame_height;
        }
        SDL_FRect to={(float)p.ui_x,(float)p.ui_y,(float)(v->frame_width*p.ui_scale),(float)(v->frame_height*p.ui_scale)};
        if(SDL_UpdateTexture(h->texture,NULL,em_web_menu_frame(&h->dune_view,c),v->frame_width*3))return sdl_host_error(h,"Dune native upload failed");
        EmWebPortraitLayout portrait;
        if(em_web_portrait_layout(dune_mouse_context(c),window_w,window_h,w,hg,&portrait)){
            for(int i=0;i<portrait.count;++i){
                EmWebPortraitRegion *r=&portrait.regions[i];
                SDL_Rect from={r->src.x,r->src.y,r->src.w,r->src.h};
                SDL_FRect dest={(float)r->dst.x,(float)r->dst.y,(float)r->dst.w,(float)r->dst.h};
                if(SDL_RenderCopyF(h->renderer,h->texture,&from,&dest))return sdl_host_error(h,"Dune portrait draw failed");
            }
        }else if(SDL_RenderCopyF(h->renderer,h->texture,NULL,&to))return sdl_host_error(h,"Dune native draw failed");
    }else{
        DuneView *d=&h->dune_view;
        if(dune_view_map(c))dune_view_pointer(h,c);
        int hide_cursor=!em_web_cursor_preview(c);
        if(d->cursor_hidden!=hide_cursor)d->frame=UINT64_MAX;
        d->cursor_hidden=hide_cursor;
        if(d->cursor_valid!=h->dune_mouse.point_world || d->cursor_x!=h->dune_mouse.wx || d->cursor_y!=h->dune_mouse.wy)d->frame=UINT64_MAX;
        d->cursor_valid=h->dune_mouse.point_world;d->cursor_x=h->dune_mouse.wx;d->cursor_y=h->dune_mouse.wy;
        /* Replay is bounded and skipped on expose events for an unchanged frame/layout. */
        if(d->frame!=v->rendered_frames || d->width!=(unsigned)p.world_width || d->height!=(unsigned)p.world_height || d->left!=p.left || d->top!=p.top){
            if(!dune_view_build(d,c,&p))return sdl_host_error(h,"Dune world traversal failed");
            if(!h->dune_world || h->dune_width!=d->width || h->dune_height!=d->height){
                SDL_DestroyTexture(h->dune_world);h->dune_world=SDL_CreateTexture(h->renderer,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_STREAMING,d->width,d->height);
                if(!h->dune_world || SDL_SetTextureBlendMode(h->dune_world,SDL_BLENDMODE_NONE))return sdl_host_error(h,"Dune world texture failed");
                h->dune_width=d->width;h->dune_height=d->height;
            }
            if(!h->dune_hud){h->dune_hud=SDL_CreateTexture(h->renderer,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_STREAMING,320,224);
                if(!h->dune_hud || SDL_SetTextureBlendMode(h->dune_hud,SDL_BLENDMODE_BLEND))return sdl_host_error(h,"Dune HUD texture failed");}
            if(SDL_UpdateTexture(h->dune_world,NULL,d->pixels,d->width*4) || SDL_UpdateTexture(h->dune_hud,NULL,d->ui,320*4))return sdl_host_error(h,"Dune world upload failed");
        }
        SDL_FRect to={0,0,(float)(d->width*p.world_scale),(float)(d->height*p.world_scale)};
        if(SDL_RenderCopyF(h->renderer,h->dune_world,NULL,&to))return sdl_host_error(h,"Dune world draw failed");
        SDL_Rect top={0,0,320,144},bottom={0,144,320,80};
        SDL_FRect t={(float)(w-320*p.ui_scale),(float)em_web_map_hud_top(hg),(float)(320*p.ui_scale),(float)(144*p.ui_scale)};
        SDL_FRect b={t.x,(float)(hg-80*p.ui_scale),t.w,(float)(80*p.ui_scale)};
        if(SDL_RenderCopyF(h->renderer,h->dune_hud,&top,&t) || SDL_RenderCopyF(h->renderer,h->dune_hud,&bottom,&b))return sdl_host_error(h,"Dune HUD draw failed");
    }
    if(adapted){em_web_last_world_host=h;em_web_last_world_layout=p;em_web_last_world_w=w;em_web_last_world_h=hg;}
    if(dune_view_map(c)){
        EmWebMinimap m=em_web_native_minimap(c);
        if(m.visible){
            EmWebMiniRect r=em_web_minimap_view(m,p.left,p.top,p.world_width,p.world_height);
            float scale=(float)p.ui_scale;
            float x=(float)(w-320*p.ui_scale)+(float)(m.x+r.x)*scale;
            float y=(float)(hg-224*p.ui_scale)+(float)(m.y+r.y)*scale;
            float thick=scale<1?1:scale;
            float rw=(float)r.w*scale,rh=(float)r.h*scale;
            float cw=fminf(3*scale,(rw+thick)/2),ch=fminf(3*scale,(rh+thick)/2);
            SDL_FRect lines[8]={{x,y,cw,thick},{x+rw-cw,y,cw,thick},
                {x,y+rh-thick,cw,thick},{x+rw-cw,y+rh-thick,cw,thick},
                {x,y,thick,ch},{x+rw-thick,y,thick,ch},
                {x,y+rh-ch,thick,ch},{x+rw-thick,y+rh-ch,thick,ch}};
            SDL_SetRenderDrawColor(h->renderer,220,228,240,255);
            if(SDL_RenderFillRectsF(h->renderer,lines,8))return sdl_host_error(h,"Dune minimap viewport failed");
            SDL_SetRenderDrawColor(h->renderer,0,0,0,255);
        }
    }
    if(!dune_cpu_draw(h,c))return sdl_host_error(h,"Dune CPU overlay failed");
    h->last_frame=v->rendered_frames;SDL_RenderPresent(h->renderer);return 1;
}
#endif
#endif

static int sdl_host_open(SDLHost *h) {
#ifdef GENESIS_DUNE_MOUSE
    h->dune_mouse.enabled=1;h->dune_view.zoom=100;
    h->dune_volume=dune_audio_volume(getenv("DUNE_VOLUME"));
#endif
    if (SDL_Init(SDL_INIT_VIDEO|SDL_INIT_EVENTS)) return sdl_host_error(h,"initialization failed");
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY,"nearest");
    int initial_width=960,initial_height=672;
#ifdef GENESIS_DUNE_MOUSE
    SDL_Rect usable;
    if(!SDL_GetDisplayUsableBounds(0,&usable)){
        if(initial_width>usable.w-32)initial_width=usable.w-32;
        if(initial_height>usable.h-64)initial_height=usable.h-64;
        if(initial_width<320)initial_width=320;if(initial_height<224)initial_height=224;
    }
#endif
    h->window=SDL_CreateWindow(GENESIS_WINDOW_TITLE,SDL_WINDOWPOS_CENTERED,SDL_WINDOWPOS_CENTERED,
        initial_width,initial_height,SDL_WINDOW_RESIZABLE|SDL_WINDOW_ALLOW_HIGHDPI);
    if (!h->window) return sdl_host_error(h,"window creation failed");
    h->renderer=SDL_CreateRenderer(h->window,-1,SDL_RENDERER_ACCELERATED);
    if (!h->renderer) h->renderer=SDL_CreateRenderer(h->window,-1,SDL_RENDERER_SOFTWARE);
    if (!h->renderer) return sdl_host_error(h,"renderer creation failed");
    SDL_SetRenderDrawColor(h->renderer,0,0,0,255);
    if (SDL_RenderClear(h->renderer)) return sdl_host_error(h,"clear failed");
    SDL_RenderPresent(h->renderer);
    h->frequency=SDL_GetPerformanceFrequency(); h->origin_counter=SDL_GetPerformanceCounter();
    return 1;
}
static void sdl_host_audio_open(SDLHost *h,CPU *c) {
    if(SDL_InitSubSystem(SDL_INIT_AUDIO)) {
        fprintf(stderr,"SDL2 audio unavailable: %s; video continues\n",SDL_GetError());return;
    }
    SDL_AudioSpec desired={0},obtained={0};
    desired.freq=AUDIO_RATE;desired.format=AUDIO_S16SYS;desired.channels=2;
#ifdef __EMSCRIPTEN__
    desired.samples=2048;
#else
    desired.samples=512;
#endif
    h->audio_device=SDL_OpenAudioDevice(NULL,0,&desired,&obtained,0);
    if(!h->audio_device) {
        fprintf(stderr,"SDL2 audio device unavailable: %s; video continues\n",SDL_GetError());return;
    }
    c->audio.playback=1;
}
static int sdl_host_audio_service(SDLHost *h,CPU *c) {
    if(!h->audio_device)return 1;
    int playing=!h->paused && !h->stopped && !c->fault && !h->fast_forward && !h->no_throttle;
    c->audio.playback=playing;
    if(!playing) {
        SDL_PauseAudioDevice(h->audio_device,1);SDL_ClearQueuedAudio(h->audio_device);
        h->audio_running=0;c->audio.read=0;c->audio.count=0;return 1;
    }
    // Bound latency even when a host cannot keep up. Never change chip clocks.
    Uint32 queued=SDL_GetQueuedAudioSize(h->audio_device);
#ifdef __EMSCRIPTEN__
    if(queued>AUDIO_RATE*4/2){
        c->audio.dropped+=queued/4;SDL_ClearQueuedAudio(h->audio_device);h->audio_running=0;
    }
#else
    if(queued>AUDIO_RATE*4/10){
        c->audio.dropped+=queued/4;SDL_ClearQueuedAudio(h->audio_device);h->audio_running=0;
    }
#endif
    int16_t buffer[1024*2];unsigned count;
    while((count=audio_pop(c,buffer,1024))!=0) {
#ifdef GENESIS_DUNE_MOUSE
        for(unsigned i=0;i<count*2;++i)buffer[i]=dune_audio_scale(buffer[i],h->dune_volume);
#endif
        if(SDL_QueueAudio(h->audio_device,buffer,count*4))return sdl_host_error(h,"audio queue failed");
    }
    // A small preroll keeps the first callback from immediately underrunning.
    if(!h->audio_running && SDL_GetQueuedAudioSize(h->audio_device)>=AUDIO_RATE*4/50) {
        SDL_PauseAudioDevice(h->audio_device,0);h->audio_running=1;
    }
    return 1;
}
static uint8_t sdl_pad_key(SDL_Keycode key) {
    switch (key) {
        case SDLK_UP: return PAD_UP; case SDLK_DOWN: return PAD_DOWN;
        case SDLK_LEFT: return PAD_LEFT; case SDLK_RIGHT: return PAD_RIGHT;
        case SDLK_z: return PAD_A; case SDLK_x: return PAD_B; case SDLK_c: return PAD_C;
        case SDLK_RETURN: return PAD_START;
        default: return 0;
    }
}
#ifndef GENESIS_DUNE_MOUSE_SDL_H
#define GENESIS_DUNE_MOUSE_SDL_H
#if defined(GENESIS_DUNE_MOUSE) && defined(GENESIS_SDL2)
static void dune_mouse_event(SDLHost *h,CPU *c,const SDL_Event *e) {
    DuneMouse *m=&h->dune_mouse;
    if(h->paused || h->stopped) {dune_mouse_reset(m);return;}
    /* Dune uses drawable pixels for its adaptive world and a fixed HUD. */
    if(e->type==SDL_MOUSEMOTION) {
        h->dune_view.pointer_valid=1;h->dune_view.pointer_x=e->motion.x;h->dune_view.pointer_y=e->motion.y;
        int x,y,world;
        if(!dune_view_mouse(h,c,e->motion.x,e->motion.y,&x,&y,&world) ||
           !(world?dune_mouse_world_point(m,c,x,y):dune_mouse_point(m,c,x,y))){
            dune_mouse_reset(m);
            h->dune_view.pointer_valid=0;m->pan_x=0;m->pan_y=0;
        }
        dune_view_pointer(h,c);
    } else if(e->type==SDL_MOUSEBUTTONDOWN) {
        h->dune_view.pointer_valid=1;h->dune_view.pointer_x=e->button.x;h->dune_view.pointer_y=e->button.y;
        int action=e->button.button==SDL_BUTTON_LEFT ? DUNE_CLICK_SELECT:
                   e->button.button==SDL_BUTTON_RIGHT ? DUNE_CLICK_ORDER:
                   e->button.button==SDL_BUTTON_MIDDLE ? DUNE_CLICK_CANCEL:0;
        int x,y,world;
        if(action && dune_view_mouse(h,c,e->button.x,e->button.y,&x,&y,&world)){
            if(world)dune_mouse_world_click(m,c,x,y,action);
            else dune_mouse_click(m,c,x,y,action);
        }
        dune_view_pointer(h,c);
    } else if((e->type==SDL_WINDOWEVENT &&
               (e->window.event==SDL_WINDOWEVENT_FOCUS_LOST ||
                e->window.event==SDL_WINDOWEVENT_LEAVE)) ||
              (e->type==SDL_KEYDOWN && sdl_pad_key(e->key.keysym.sym))) {
        h->dune_view.pointer_valid=0;m->pan_x=0;m->pan_y=0;dune_mouse_reset(m);
        if(e->type==SDL_WINDOWEVENT && dune_view_map(c))m->camera_hold=1;
    }
}
#endif
#endif

static void sdl_host_rebase(SDLHost *h, const CPU *c) {
    h->origin_counter=SDL_GetPerformanceCounter(); h->origin_master=c->master_cycles;
}
static int sdl_host_draw(SDLHost *h, const VDP *v) {
    if (!v->rendered_frames) {
        return 1;
    }
    unsigned presentation_width=v->frame_width;
    int texture_changed=!h->texture || h->width!=presentation_width || h->height!=v->frame_height;
    if (texture_changed) {
        SDL_DestroyTexture(h->texture);
        h->texture=SDL_CreateTexture(h->renderer,SDL_PIXELFORMAT_RGB24,SDL_TEXTUREACCESS_STREAMING,
            presentation_width,v->frame_height);
        if (!h->texture) return sdl_host_error(h,"texture creation failed");
        h->width=presentation_width; h->height=v->frame_height;
        if (SDL_RenderSetLogicalSize(h->renderer,(int)h->width,(int)h->height))
            return sdl_host_error(h,"logical size failed");
    }
    int upload=texture_changed || h->last_frame!=v->rendered_frames;
    if (upload) {
        const uint8_t *pixels=v->frame;
        if (SDL_UpdateTexture(h->texture,NULL,pixels,presentation_width*3))
            return sdl_host_error(h,"texture upload failed");
        h->last_frame=v->rendered_frames;
    }
    if (SDL_RenderSetLogicalSize(h->renderer,(int)h->width,(int)h->height) ||
        SDL_RenderClear(h->renderer) || SDL_RenderCopy(h->renderer,h->texture,NULL,NULL))
        return sdl_host_error(h,"presentation failed");
    SDL_RenderPresent(h->renderer); return 1;
}
static void sdl_host_stop(SDLHost *h, const CPU *c) {
    if (h->stopped) return;
    h->stopped=1;
    char title[256];
    if (c->fault) {
        snprintf(title,sizeof title,GENESIS_WINDOW_TITLE " - stopped: %s",c->reason);
        fprintf(stderr,"execution stopped at %06" PRIx32 ": %s\n",c->fault_address,c->reason);
    } else snprintf(title,sizeof title,GENESIS_WINDOW_TITLE " - CPU halted");
    SDL_SetWindowTitle(h->window,title);
}
static int em_web_canvas_presentable(void);
__attribute__((noinline, used)) int sdl_host_service(SDLHost *h, CPU *c) {
    int redraw=0;
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
#ifdef GENESIS_DUNE_MOUSE
        if(dune_view_event(h,c,&event)){redraw=1;continue;}
        dune_mouse_event(h,c,&event);
#endif
        if (event.type==SDL_QUIT) return 0;
        if (event.type==SDL_WINDOWEVENT) {
            if (event.window.event==SDL_WINDOWEVENT_CLOSE) return 0;
            if (event.window.event==SDL_WINDOWEVENT_FOCUS_LOST) {
                c->pad_buttons[0]=0; h->fast_forward=0; sdl_host_rebase(h,c);
            }
            if (event.window.event==SDL_WINDOWEVENT_EXPOSED || event.window.event==SDL_WINDOWEVENT_SIZE_CHANGED)
                redraw=1;
        }
        if (event.type==SDL_KEYDOWN || event.type==SDL_KEYUP) {
            int down=event.type==SDL_KEYDOWN;
            SDL_Keycode key=event.key.keysym.sym;
            if (down && key==SDLK_ESCAPE) {
                return 0;
            }
            uint8_t button=sdl_pad_key(key);
            if (down) c->pad_buttons[0]|=button; else c->pad_buttons[0]&=(uint8_t)~button;
            if (key==SDLK_TAB) { h->fast_forward=down; sdl_host_rebase(h,c); }
            if (down && !event.key.repeat && key==SDLK_SPACE && !h->stopped) {
                h->paused=!h->paused; sdl_host_rebase(h,c);
                SDL_SetWindowTitle(h->window,h->paused ? GENESIS_WINDOW_TITLE " - paused":GENESIS_WINDOW_TITLE);
            }
        }
    }
    if (em_web_canvas_presentable() && (redraw || h->last_frame!=c->vdp.rendered_frames)){
        if(!sdl_host_audio_service(h,c))return 0;
#ifdef GENESIS_DUNE_MOUSE
        if(!dune_view_draw(h,c))return 0;
#else
        if (!sdl_host_draw(h,&c->vdp)) return 0;
#endif
    }
    if(!sdl_host_audio_service(h,c))return 0;
    /* Service input every ~1 ms of modeled console time, even before video is enabled.
       Throttling uses emulated clocks, never changing the CPU/device scheduling. */
    h->next_service=c->master_cycles+vdp_master_frequency(&c->vdp)/1000;
    if (!h->paused && !h->stopped && !h->fast_forward && !h->no_throttle
    ) {
        double simulated_ms=(double)(c->master_cycles-h->origin_master)*1000.0/vdp_master_frequency(&c->vdp);
        double elapsed_ms=(double)(SDL_GetPerformanceCounter()-h->origin_counter)*1000.0/(double)h->frequency;
        double ahead=simulated_ms-elapsed_ms;
#ifndef __EMSCRIPTEN__
        if (ahead>=1.0) SDL_Delay((Uint32)(ahead>10.0 ? 10.0:ahead));
#endif
    }
    return 1;
}
#endif
#endif


#ifndef GENESIS_NO_MAIN
static int parse_number(const char *s, uint64_t *out) {
    char *end;
    if (!*s || *s=='-') return 0;
    errno=0;
    unsigned long long value=strtoull(s,&end,0);
    if (errno || *end) return 0;
    *out=(uint64_t)value; return 1;
}
#ifdef __EMSCRIPTEN__
#include <emscripten.h>

static CPU em_cpu;
static void em_web_menu_select_reset_state(void);
static void em_web_campaign_after_load(CPU *c);
static void em_web_audio_flush(void);
static SDLHost em_host;
static int em_window = 0;

#define DUNE_SAVESTATE_MAGIC 0x56415344
#define DUNE_SAVESTATE_VERSION 2

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t ym_size;
    uint32_t total_size;

    uint32_t d[8], a[8], pc, usp, ssp;
    uint16_t sr;
    uint8_t ram[65536];
    uint8_t io_data[3], io_control[3], tmss[4];
    uint8_t io_tx[3], io_serial_control[3];
    uint8_t pad_buttons[3];

    uint8_t vdp_registers[24];
    uint8_t vdp_vram[65536];
    uint16_t vdp_cram[64];
    uint16_t vdp_vsram[40];
    uint16_t vdp_address, vdp_bus_value;
    uint8_t vdp_code, vdp_command_pending, vdp_fill_pending;
    uint64_t vdp_data_reads, vdp_data_writes, vdp_dma_bytes;
    uint16_t vdp_line, vdp_line_clock;
    uint8_t vdp_hint_counter, vdp_irq_h, vdp_irq_v, vdp_vint_status, vdp_pal;
    uint64_t vdp_frames;

    uint8_t z80_ram[8192];
    uint8_t z80_requested, z80_reset_released;
    uint16_t z80_bank;
    uint64_t z80_ram_writes;

    uint8_t z80_r8[6], z80_alternate[6], z80_a, z80_f, z80_a_alt, z80_f_alt;
    uint8_t z80_i, z80_r, z80_iff1, z80_iff2, z80_im, z80_halted;
    uint8_t z80_irq_line, z80_ei_delay;
    uint16_t z80_pc, z80_sp, z80_ix, z80_iy, z80_wz;
    int64_t z80_debt;
    uint64_t z80_steps, z80_cycles, z80_interrupts;

    PSG psg;
    EEPROM eeprom;

    uint64_t steps, cycles, master_cycles, interrupts;
    unsigned instruction_cycles, z80_divider;
    int halted;
} DuneSaveState;

static uint8_t g_dune_state_buffer[256 * 1024];

EMSCRIPTEN_KEEPALIVE uint8_t *dune_get_save_buffer(void) {
    return g_dune_state_buffer;
}

EMSCRIPTEN_KEEPALIVE int dune_save_state_to_buffer(void) {
    if (!em_window) return 0;
    DuneSaveState *s = (DuneSaveState *)g_dune_state_buffer;
    memset(s, 0, sizeof(*s));

    s->magic = DUNE_SAVESTATE_MAGIC;
    s->version = DUNE_SAVESTATE_VERSION;

    memcpy(s->d, em_cpu.d, sizeof(s->d));
    memcpy(s->a, em_cpu.a, sizeof(s->a));
    s->pc = em_cpu.pc;
    s->usp = em_cpu.usp;
    s->ssp = em_cpu.ssp;
    s->sr = em_cpu.sr;
    memcpy(s->ram, em_cpu.ram, sizeof(s->ram));
    memcpy(s->io_data, em_cpu.io_data, sizeof(s->io_data));
    memcpy(s->io_control, em_cpu.io_control, sizeof(s->io_control));
    memcpy(s->tmss, em_cpu.tmss, sizeof(s->tmss));
    memcpy(s->io_tx, em_cpu.io_tx, sizeof(s->io_tx));
    memcpy(s->io_serial_control, em_cpu.io_serial_control, sizeof(s->io_serial_control));
    memcpy(s->pad_buttons, em_cpu.pad_buttons, sizeof(s->pad_buttons));

    memcpy(s->vdp_registers, em_cpu.vdp.registers, sizeof(s->vdp_registers));
    memcpy(s->vdp_vram, em_cpu.vdp.vram, sizeof(s->vdp_vram));
    memcpy(s->vdp_cram, em_cpu.vdp.cram, sizeof(s->vdp_cram));
    memcpy(s->vdp_vsram, em_cpu.vdp.vsram, sizeof(s->vdp_vsram));
    s->vdp_address = em_cpu.vdp.address;
    s->vdp_bus_value = em_cpu.vdp.bus_value;
    s->vdp_code = em_cpu.vdp.code;
    s->vdp_command_pending = em_cpu.vdp.command_pending;
    s->vdp_fill_pending = em_cpu.vdp.fill_pending;
    s->vdp_data_reads = em_cpu.vdp.data_reads;
    s->vdp_data_writes = em_cpu.vdp.data_writes;
    s->vdp_dma_bytes = em_cpu.vdp.dma_bytes;
    s->vdp_line = em_cpu.vdp.line;
    s->vdp_line_clock = em_cpu.vdp.line_clock;
    s->vdp_hint_counter = em_cpu.vdp.hint_counter;
    s->vdp_irq_h = em_cpu.vdp.irq_h;
    s->vdp_irq_v = em_cpu.vdp.irq_v;
    s->vdp_vint_status = em_cpu.vdp.vint_status;
    s->vdp_pal = em_cpu.vdp.pal;
    s->vdp_frames = em_cpu.vdp.frames;

    memcpy(s->z80_ram, em_cpu.z80_bus.ram, sizeof(s->z80_ram));
    s->z80_requested = em_cpu.z80_bus.requested;
    s->z80_reset_released = em_cpu.z80_bus.reset_released;
    s->z80_bank = em_cpu.z80_bus.bank;
    s->z80_ram_writes = em_cpu.z80_bus.ram_writes;

    memcpy(s->z80_r8, em_cpu.z80_cpu.r8, sizeof(s->z80_r8));
    memcpy(s->z80_alternate, em_cpu.z80_cpu.alternate, sizeof(s->z80_alternate));
    s->z80_a = em_cpu.z80_cpu.a;
    s->z80_f = em_cpu.z80_cpu.f;
    s->z80_a_alt = em_cpu.z80_cpu.a_alt;
    s->z80_f_alt = em_cpu.z80_cpu.f_alt;
    s->z80_i = em_cpu.z80_cpu.i;
    s->z80_r = em_cpu.z80_cpu.r;
    s->z80_iff1 = em_cpu.z80_cpu.iff1;
    s->z80_iff2 = em_cpu.z80_cpu.iff2;
    s->z80_im = em_cpu.z80_cpu.im;
    s->z80_halted = em_cpu.z80_cpu.halted;
    s->z80_irq_line = em_cpu.z80_cpu.irq_line;
    s->z80_ei_delay = em_cpu.z80_cpu.ei_delay;
    s->z80_pc = em_cpu.z80_cpu.pc;
    s->z80_sp = em_cpu.z80_cpu.sp;
    s->z80_ix = em_cpu.z80_cpu.ix;
    s->z80_iy = em_cpu.z80_cpu.iy;
    s->z80_wz = em_cpu.z80_cpu.wz;
    s->z80_debt = em_cpu.z80_cpu.debt;
    s->z80_steps = em_cpu.z80_cpu.steps;
    s->z80_cycles = em_cpu.z80_cpu.cycles;
    s->z80_interrupts = em_cpu.z80_cpu.interrupts;

    s->psg = em_cpu.psg;
    s->eeprom = em_cpu.eeprom;

    s->steps = em_cpu.steps;
    s->cycles = em_cpu.cycles;
    s->master_cycles = em_cpu.master_cycles;
    s->interrupts = em_cpu.interrupts;
    s->instruction_cycles = em_cpu.instruction_cycles;
    s->z80_divider = em_cpu.z80_divider;
    s->halted = em_cpu.halted;

    uint32_t ym_size = 0;
#ifdef GENESIS_AUDIO
    if (em_cpu.audio_mode == AUDIO_ON && em_cpu.audio.fm) {
        ym_size = (uint32_t)genesis_ymfm_state_size(em_cpu.audio.fm);
        if (ym_size > 0 && sizeof(*s) + ym_size <= sizeof(g_dune_state_buffer)) {
            if (genesis_ymfm_save_state(em_cpu.audio.fm, g_dune_state_buffer + sizeof(*s), ym_size)) {
                s->ym_size = ym_size;
            } else {
                s->ym_size = 0;
            }
        }
    }
#endif
    s->total_size = sizeof(*s) + s->ym_size;
    return (int)s->total_size;
}

EMSCRIPTEN_KEEPALIVE int dune_load_state_from_buffer(int size) {
    if (!em_window || size < (int)sizeof(DuneSaveState) || size > (int)sizeof(g_dune_state_buffer)) return 0;
    const DuneSaveState *s = (const DuneSaveState *)g_dune_state_buffer;
    if (s->magic != DUNE_SAVESTATE_MAGIC || s->version != DUNE_SAVESTATE_VERSION) return 0;
    if (s->total_size != (uint32_t)size || s->ym_size > sizeof(g_dune_state_buffer)-sizeof(*s) || sizeof(*s)+s->ym_size != (size_t)size) return 0;

    memcpy(em_cpu.d, s->d, sizeof(s->d));
    memcpy(em_cpu.a, s->a, sizeof(s->a));
    em_cpu.pc = s->pc;
    em_cpu.usp = s->usp;
    em_cpu.ssp = s->ssp;
    em_cpu.sr = s->sr;
    memcpy(em_cpu.ram, s->ram, sizeof(s->ram));
    memcpy(em_cpu.io_data, s->io_data, sizeof(s->io_data));
    memcpy(em_cpu.io_control, s->io_control, sizeof(s->io_control));
    memcpy(em_cpu.tmss, s->tmss, sizeof(s->tmss));
    memcpy(em_cpu.io_tx, s->io_tx, sizeof(s->io_tx));
    memcpy(em_cpu.io_serial_control, s->io_serial_control, sizeof(s->io_serial_control));
    memcpy(em_cpu.pad_buttons, s->pad_buttons, sizeof(s->pad_buttons));

    memcpy(em_cpu.vdp.registers, s->vdp_registers, sizeof(s->vdp_registers));
    memcpy(em_cpu.vdp.vram, s->vdp_vram, sizeof(s->vdp_vram));
    memcpy(em_cpu.vdp.cram, s->vdp_cram, sizeof(s->vdp_cram));
    memcpy(em_cpu.vdp.vsram, s->vdp_vsram, sizeof(s->vdp_vsram));
    em_cpu.vdp.address = s->vdp_address;
    em_cpu.vdp.bus_value = s->vdp_bus_value;
    em_cpu.vdp.code = s->vdp_code;
    em_cpu.vdp.command_pending = s->vdp_command_pending;
    em_cpu.vdp.fill_pending = s->vdp_fill_pending;
    em_cpu.vdp.data_reads = s->vdp_data_reads;
    em_cpu.vdp.data_writes = s->vdp_data_writes;
    em_cpu.vdp.dma_bytes = s->vdp_dma_bytes;
    em_cpu.vdp.line = s->vdp_line;
    em_cpu.vdp.line_clock = s->vdp_line_clock;
    em_cpu.vdp.hint_counter = s->vdp_hint_counter;
    em_cpu.vdp.irq_h = s->vdp_irq_h;
    em_cpu.vdp.irq_v = s->vdp_irq_v;
    em_cpu.vdp.vint_status = s->vdp_vint_status;
    em_cpu.vdp.pal = s->vdp_pal;
    em_cpu.vdp.frames = s->vdp_frames;

    memcpy(em_cpu.z80_bus.ram, s->z80_ram, sizeof(s->z80_ram));
    em_cpu.z80_bus.requested = s->z80_requested;
    em_cpu.z80_bus.reset_released = s->z80_reset_released;
    em_cpu.z80_bus.bank = s->z80_bank;
    em_cpu.z80_bus.ram_writes = s->z80_ram_writes;

    memcpy(em_cpu.z80_cpu.r8, s->z80_r8, sizeof(s->z80_r8));
    memcpy(em_cpu.z80_cpu.alternate, s->z80_alternate, sizeof(s->z80_alternate));
    em_cpu.z80_cpu.a = s->z80_a;
    em_cpu.z80_cpu.f = s->z80_f;
    em_cpu.z80_cpu.a_alt = s->z80_a_alt;
    em_cpu.z80_cpu.f_alt = s->z80_f_alt;
    em_cpu.z80_cpu.i = s->z80_i;
    em_cpu.z80_cpu.r = s->z80_r;
    em_cpu.z80_cpu.iff1 = s->z80_iff1;
    em_cpu.z80_cpu.iff2 = s->z80_iff2;
    em_cpu.z80_cpu.im = s->z80_im;
    em_cpu.z80_cpu.halted = s->z80_halted;
    em_cpu.z80_cpu.irq_line = s->z80_irq_line;
    em_cpu.z80_cpu.ei_delay = s->z80_ei_delay;
    em_cpu.z80_cpu.pc = s->z80_pc;
    em_cpu.z80_cpu.sp = s->z80_sp;
    em_cpu.z80_cpu.ix = s->z80_ix;
    em_cpu.z80_cpu.iy = s->z80_iy;
    em_cpu.z80_cpu.wz = s->z80_wz;
    em_cpu.z80_cpu.debt = s->z80_debt;
    em_cpu.z80_cpu.steps = s->z80_steps;
    em_cpu.z80_cpu.cycles = s->z80_cycles;
    em_cpu.z80_cpu.interrupts = s->z80_interrupts;

    em_cpu.psg = s->psg;
    em_cpu.eeprom = s->eeprom;

    em_cpu.steps = s->steps;
    em_cpu.cycles = s->cycles;
    em_cpu.master_cycles = s->master_cycles;
    em_cpu.interrupts = s->interrupts;
    em_cpu.instruction_cycles = s->instruction_cycles;
    em_cpu.z80_divider = s->z80_divider;
    em_cpu.halted = s->halted;
    em_cpu.fault = 0;
    em_cpu.reason = NULL;

#ifdef GENESIS_AUDIO
    if (em_cpu.audio_mode == AUDIO_ON && em_cpu.audio.fm) {
        if (s->ym_size > 0 && sizeof(*s) + s->ym_size <= (size_t)size) {
            void *new_fm = genesis_ymfm_load_state(g_dune_state_buffer + sizeof(*s), s->ym_size);
            if (new_fm) {
                genesis_ymfm_destroy(em_cpu.audio.fm);
                em_cpu.audio.fm = new_fm;
            } else {
                genesis_ymfm_reset(em_cpu.audio.fm);
            }
        } else {
            genesis_ymfm_reset(em_cpu.audio.fm);
        }
    }
#endif
    em_cpu.audio.read = 0;
    em_cpu.audio.count = 0;
    em_cpu.audio.cursor = em_cpu.master_cycles;
    em_cpu.audio.sample_index=em_cpu.master_cycles*AUDIO_RATE/vdp_master_frequency(&em_cpu.vdp)+1;
    em_cpu.audio.next_sample=em_cpu.audio.sample_index*vdp_master_frequency(&em_cpu.vdp)/AUDIO_RATE;

    sdl_host_rebase(&em_host, &em_cpu);
    em_host.next_service = em_cpu.master_cycles;
    em_host.last_frame = UINT64_MAX;
    em_host.stopped = 0;
    if(em_host.audio_device)SDL_ClearQueuedAudio(em_host.audio_device);
    em_host.audio_running = 0;
    em_web_audio_flush();
    dune_mouse_reset(&em_host.dune_mouse);
    em_web_menu_select_reset_state();
    em_web_campaign_after_load(&em_cpu);
    em_host.dune_view.camera_valid = 0;
    em_host.dune_view.frame = UINT64_MAX;
    return 1;
}

EMSCRIPTEN_KEEPALIVE void dune_mouse_leave(void) {
    if (!em_window) return;
    em_host.dune_view.pointer_valid = 0;
    em_host.dune_mouse.pan_x = 0;
    em_host.dune_mouse.pan_y = 0;
    dune_mouse_reset(&em_host.dune_mouse);
    if (dune_view_map(&em_cpu)) {
        em_host.dune_mouse.camera_hold = 1;
        em_cpu.ram[0xbf12] = 0;
        em_cpu.ram[0xbf13] = 160;
        em_cpu.ram[0xbf14] = 0;
        em_cpu.ram[0xbf15] = 112;
        memset(em_cpu.ram + 0xbf0e, 0, 4);
    }
}

#define EM_WEB_MODERN_INPUT 1
static void em_web_selection_observe(void);
static int em_web_menus_observe(DuneMouse *m,CPU *c);
static int em_web_menu_select_observe(DuneMouse *m,CPU *c);
static int em_web_campaign_observe(CPU *c);
#include "em_web_host.h"
EMSCRIPTEN_KEEPALIVE int dune_web_audio_levels(int music,int sound){return em_web_audio_levels_set(music,sound);}
#include "em_web_camera.h"
#include "em_web_selection.h"
#include "em_web_menus.h"
#include "em_web_menu_select.h"
#include "em_web_building_ui.h"
#include "em_web_training.h"
#include "em_web_campaign.h"

#endif

__attribute__((noinline, used)) int run_main(int argc, char **argv, const uint8_t *rom, size_t size, int ea_eeprom) {
#ifdef __EMSCRIPTEN__
    uint64_t limit=UINT64_MAX, peek=0; int have_peek=0, trace=0, audio_mode=AUDIO_ON;
    int window=1, limit_set=1, user_closed=0, host_error=0, no_throttle=0, pal=0;
#else
    uint64_t limit=UINT64_MAX, peek=0; int have_peek=0, trace=0, audio_mode=AUDIO_ON;
    int window=1, limit_set=1, user_closed=0, host_error=0, no_throttle=0, pal=0;
#endif
    const char *vram_dump=NULL, *z80_dump=NULL, *frame_dump=NULL, *audio_dump=NULL;
    for (int i=1; i<argc; ++i) {
        if (!strcmp(argv[i],"--limit") && i+1<argc) {
            if (!parse_number(argv[++i],&limit)) goto usage;
            limit_set=1;
        } else if (!strcmp(argv[i],"--peek") && i+1<argc) {
            if (!parse_number(argv[++i],&peek) || peek>0xffffff) goto usage;
            have_peek=1;
        } else if (!strcmp(argv[i],"--trace")) trace=1;
        else if (!strcmp(argv[i],"--region") && i+1<argc) {
            const char *region=argv[++i];
            if (!strcmp(region,"ntsc")) pal=0;
            else if (!strcmp(region,"pal")) pal=1;
            else goto usage;
        }
        else if (!strcmp(argv[i],"--audio") && i+1<argc) {
            const char *mode=argv[++i];
            if (!strcmp(mode,"stub")) audio_mode=AUDIO_STUB;
            else if (!strcmp(mode,"strict")) audio_mode=AUDIO_STRICT;
            else if (!strcmp(mode,"mute")) audio_mode=AUDIO_MUTE;
            else if (!strcmp(mode,"on")) audio_mode=AUDIO_ON;
            else goto usage;
        }
        else if (!strcmp(argv[i],"--window")) {
#ifdef GENESIS_SDL2
            window=1;
#else
            fprintf(stderr,"window support is not compiled in; rebuild with --frontend sdl2\n");
            return 64;
#endif
        }
        else if (!strcmp(argv[i],"--headless")) window=0;
        else if (!strcmp(argv[i],"--no-throttle")) no_throttle=1;
        else if (!strcmp(argv[i],"--dump-audio") && i+1<argc) audio_dump=argv[++i];
        else if (!strcmp(argv[i],"--resources-dir") && i+1<argc) {
#ifdef GENESIS_EXTERNAL_RESOURCES
            if(!argv[++i][0])goto usage;
#else
            fprintf(stderr,"this binary has embedded resources; rebuild with --resources-dir\n");return 64;
#endif
        }
        else if (!strcmp(argv[i],"--dump-vram") && i+1<argc) vram_dump=argv[++i];
        else if (!strcmp(argv[i],"--dump-z80") && i+1<argc) z80_dump=argv[++i];
        else if (!strcmp(argv[i],"--dump-frame") && i+1<argc) frame_dump=argv[++i];
        else goto usage;
    }
    if (no_throttle && !window) goto usage;
    if (audio_dump && audio_mode!=AUDIO_ON) goto usage;
#ifndef GENESIS_AUDIO
    if (audio_mode==AUDIO_ON) {
        fprintf(stderr,"sound support is not compiled in; rebuild with --sound ymfm\n");return 64;
    }
#endif
    if (window && !limit_set) limit=UINT64_MAX;
    CPU c={0}; c.rom=rom; c.rom_size=size; c.sr=0x2700;
    c.io_tx[0]=c.io_tx[1]=0xff; c.io_tx[2]=0xfb;
    c.vdp.pal=(uint8_t)pal;
    c.eeprom.enabled=(uint8_t)ea_eeprom;
    c.audio_mode=audio_mode;
    if(audio_mode==AUDIO_ON && !audio_init(&c,audio_dump)) {
        fprintf(stderr,"audio initialization failed: %s\n",c.reason ? c.reason:"cannot write WAV header");
        audio_finish(&c);return 1;
    }
    c.a[7]=read_mem(&c,0,4); c.ssp=c.a[7]; c.pc=read_mem(&c,4,4)&0xffffff;
#ifdef GENESIS_SDL2
    SDLHost host={0};
    host.no_throttle=no_throttle;
    if (window && !sdl_host_open(&host)) { sdl_host_close(&host); audio_finish(&c); return 1; }
    if (window && audio_mode==AUDIO_ON) sdl_host_audio_open(&host,&c);
#endif
#ifdef __EMSCRIPTEN__
    if (window) {
        em_cpu = c;
        em_host = host;
        em_window = window;
        emscripten_set_main_loop(em_main_loop_iter, 0, 0);
        return 0;
    }
#endif
    while (c.steps<limit) {
#ifdef GENESIS_SDL2
        if (window) {
            int stopped=c.fault || (c.halted && !machine_can_wake(&c));
            if (c.master_cycles>=host.next_service || host.paused || stopped) {
                if (!sdl_host_service(&host,&c)) { user_closed=!host.error; host_error=host.error; break; }
            }
            stopped=c.fault || (c.halted && !machine_can_wake(&c));
            if (stopped && !limit_set) { sdl_host_stop(&host,&c); SDL_Delay(10); continue; }
            if (host.paused) { SDL_Delay(10); continue; }
        }
#endif
        if (c.fault) break;
        if (c.halted && !machine_can_wake(&c)) break;
#if defined(GENESIS_DUNE_MOUSE) && defined(GENESIS_SDL2)
        if(window)dune_mouse_observe(&host.dune_mouse,&c);
#endif
        if (trace) fprintf(stderr,"step=%" PRIu64 " pc=%06" PRIx32 " sr=%04x D0=%08" PRIx32 " A7=%08" PRIx32 "\n",c.steps,c.pc,c.sr,c.d[0],c.a[7]);
        machine_step(&c);
    }
#ifdef GENESIS_SDL2
    if (window) sdl_host_close(&host);
#endif
    if(!audio_finish(&c))fail(&c,"cannot finalize audio WAV",c.pc);
    int terminal_halt=c.halted && !machine_can_wake(&c);
    printf("status=%s steps=%" PRIu64 " pc=%06" PRIx32 " sr=%04x\n", c.fault || host_error ? "fault" : user_closed ? "closed" : terminal_halt ? "halted" : "budget",c.steps,c.pc,c.sr);
    for (unsigned i=0; i<8; ++i) printf("D%u=%08" PRIx32 " A%u=%08" PRIx32 "\n",i,c.d[i],i,c.a[i]);
    printf("timing cycles=%" PRIu64 " master=%" PRIu64 " frames=%" PRIu64 " line=%u clock=%u interrupts=%" PRIu64 "\n",c.cycles,c.master_cycles,c.vdp.frames,c.vdp.line,c.vdp.line_clock,c.interrupts);
    if (pal) printf("console region=pal master_hz=%u lines_per_frame=%u\n",vdp_master_frequency(&c.vdp),vdp_frame_lines(&c.vdp));
    if (audio_mode!=AUDIO_STRICT) printf("audio mode=%s z80_execution=%s ym_writes=%" PRIu64 "\n",audio_mode==AUDIO_STUB ? "stub":audio_mode==AUDIO_MUTE ? "mute":"on",audio_mode==AUDIO_STUB ? "disabled":"enabled",c.ym2612_stub.writes);
    if(audio_mode==AUDIO_ON)printf("sound samples=%" PRIu64 " rate=%u channels=2 peak=%u dropped=%" PRIu64 "\n",c.audio.frames,AUDIO_RATE,c.audio.peak,c.audio.dropped);
    if (have_peek) printf("mem[%06" PRIx64 "]=%08" PRIx32 "\n",peek,read_mem(&c,(uint32_t)peek,4));
    if (c.fault) fprintf(stderr,"fault at %06" PRIx32 ": %s\n",c.fault_address,c.reason);
    if (vram_dump) {
        FILE *f=fopen(vram_dump,"wb");
        if (!f) { fprintf(stderr,"cannot open VRAM dump: %s\n",strerror(errno)); return 1; }
        size_t written=fwrite(c.vdp.vram,1,sizeof c.vdp.vram,f);
        int closed=fclose(f);
        if (written!=sizeof c.vdp.vram || closed) { fprintf(stderr,"cannot write VRAM dump\n"); return 1; }
        printf("vdp data_writes=%" PRIu64 " dma_bytes=%" PRIu64 " address=%04x\n",c.vdp.data_writes,c.vdp.dma_bytes,c.vdp.address);
    }
    if (z80_dump) {
        FILE *f=fopen(z80_dump,"wb");
        if (!f) { fprintf(stderr,"cannot open Z80 dump: %s\n",strerror(errno)); return 1; }
        size_t written=fwrite(c.z80_bus.ram,1,sizeof c.z80_bus.ram,f);
        int closed=fclose(f);
        if (written!=sizeof c.z80_bus.ram || closed) { fprintf(stderr,"cannot write Z80 dump\n"); return 1; }
        printf("z80 ram_writes=%" PRIu64 " bus_request=%u reset_released=%u\n",c.z80_bus.ram_writes,c.z80_bus.requested,c.z80_bus.reset_released);
        printf("z80 steps=%" PRIu64 " cycles=%" PRIu64 " pc=%04x sp=%04x psg_writes=%" PRIu64 "\n",c.z80_cpu.steps,c.z80_cpu.cycles,c.z80_cpu.pc,c.z80_cpu.sp,c.psg.writes);
        printf("z80 interrupts=%" PRIu64 " ei_delay=%u irq_line=%u\n",c.z80_cpu.interrupts,c.z80_cpu.ei_delay,c.z80_cpu.irq_line);
    }
    if (frame_dump) {
        if (!c.vdp.rendered_frames) { fprintf(stderr,"no supported visible frame has been rendered\n"); return 1; }
        FILE *f=fopen(frame_dump,"wb");
        if (!f) { fprintf(stderr,"cannot open frame dump: %s\n",strerror(errno)); return 1; }
        int header=fprintf(f,"P6\n%u %u\n255\n",c.vdp.frame_width,c.vdp.frame_height);
        size_t bytes=(size_t)c.vdp.frame_width*c.vdp.frame_height*3;
        size_t written=fwrite(c.vdp.frame,1,bytes,f); int closed=fclose(f);
        if (header<0 || written!=bytes || closed) { fprintf(stderr,"cannot write frame dump\n"); return 1; }
        printf("video rendered_frames=%" PRIu64 " size=%ux%u unsupported_mode=%u\n",c.vdp.rendered_frames,c.vdp.frame_width,c.vdp.frame_height,c.vdp.render_unsupported);
    }
    return c.fault || host_error ? 1 : user_closed || terminal_halt ? 0 : 2;
usage:
    fprintf(stderr,"usage: %s [--window|--headless] [--no-throttle] [--region ntsc|pal] [--limit instruction-count] [--peek address] [--trace] [--audio strict|stub|mute|on] [--dump-audio file.wav] [--resources-dir directory] [--dump-vram file] [--dump-z80 file] [--dump-frame file.ppm]\n",argv[0]); return 64;
}
#endif
#endif
