/* Virtual SDL window for the standalone path-A runtime (``runtime.wasm`` +
 * JS import mocks).  Included at the end of ``dune_rt_abi.inc``, i.e. after
 * the pinned ``runtime/dune-runtime-v2.c`` preamble and every browser adapter,
 * so it can see the static ``em_cpu``/``em_host``/``em_window`` and the
 * adapter observers without changing the pinned preamble or the ABI layout.
 *
 * Why this exists
 * ---------------
 * The camera/tap/hover adapters (``runtime/adapters/em_web_camera.h``) read
 * the presentation geometry through ``SDL_GetWindowSize`` and
 * ``SDL_GetRendererOutputSize``.  Path A never calls ``run_main()``/
 * ``sdl_host_open()``, so ``em_host.window``/``em_host.renderer`` stay NULL and
 * ``em_web_camera_geometry()`` returns 0 before it ever looks at the frame.
 *
 * SDL2 is compiled *into* runtime.wasm (``-sUSE_SDL=2``); its entry points are
 * ordinary wasm functions, not ``env`` imports, so ``loader.mjs`` cannot mock
 * them from JS.  Instead the build links with
 * ``-Wl,--wrap=SDL_GetWindowSize``/``SDL_GetRendererOutputSize``/
 * ``SDL_SetWindowSize`` (and the high-DPI variants) and the wrappers below
 * answer with the virtual surface size whenever a virtual window is attached.
 * No real SDL window, renderer, texture or GL context is created: only the
 * geometry queries used by the pinned adapters are answered.
 *
 * ABI: this file adds exports only.  It does not add data segments to the ABI
 * descriptor, change ``DuneSaveState`` or touch any game/CPU state, so the
 * descriptor hash (``fb47e138...``) and the DSAV v2 layout are unchanged.
 */
#ifndef DUNE_RT_VIRTUAL_WINDOW_INC
#define DUNE_RT_VIRTUAL_WINDOW_INC

/* The virtual surface starts at the native 320x224 frame size; a host may
   resize it (the frame->CSS mapping is then done by the host itself). */
static int dune_virtual_window_width = 320;
static int dune_virtual_window_height = 224;
static int dune_virtual_window_attached = 0;
/* Non-NULL sentinels; never dereferenced by the wrappers below. */
static int dune_virtual_window_token = 1;
static int dune_virtual_renderer_token = 1;

/* Linker-provided aliases (``-Wl,--wrap=``). */
extern void __real_SDL_GetWindowSize(SDL_Window *window, int *w, int *h);
extern void __real_SDL_GetWindowSizeInPixels(SDL_Window *window, int *w, int *h);
extern void __real_SDL_GetWindowPosition(SDL_Window *window, int *x, int *y);
extern int __real_SDL_GetRendererOutputSize(SDL_Renderer *renderer, int *w, int *h);
extern void __real_SDL_SetWindowSize(SDL_Window *window, int w, int h);

void __wrap_SDL_GetWindowSize(SDL_Window *window, int *w, int *h) {
    if (dune_virtual_window_attached) {
        if (w) *w = dune_virtual_window_width;
        if (h) *h = dune_virtual_window_height;
        return;
    }
    __real_SDL_GetWindowSize(window, w, h);
}

/* SDL >= 2.26; the pinned emsdk SDL2 has it, the adapters do not call it yet,
 * but wrapping it keeps high-DPI builds honest. */
void __wrap_SDL_GetWindowSizeInPixels(SDL_Window *window, int *w, int *h) {
    if (dune_virtual_window_attached) {
        if (w) *w = dune_virtual_window_width;
        if (h) *h = dune_virtual_window_height;
        return;
    }
    __real_SDL_GetWindowSizeInPixels(window, w, h);
}

void __wrap_SDL_GetWindowPosition(SDL_Window *window, int *x, int *y) {
    if (dune_virtual_window_attached) {
        if (x) *x = 0;
        if (y) *y = 0;
        return;
    }
    __real_SDL_GetWindowPosition(window, x, y);
}

int __wrap_SDL_GetRendererOutputSize(SDL_Renderer *renderer, int *w, int *h) {
    if (dune_virtual_window_attached) {
        if (w) *w = dune_virtual_window_width;
        if (h) *h = dune_virtual_window_height;
        return 0;
    }
    return __real_SDL_GetRendererOutputSize(renderer, w, h);
}

void __wrap_SDL_SetWindowSize(SDL_Window *window, int w, int h) {
    if (dune_virtual_window_attached) {
        if (w > 0 && w <= 8192) dune_virtual_window_width = w;
        if (h > 0 && h <= 8192) dune_virtual_window_height = h;
        return;
    }
    __real_SDL_SetWindowSize(window, w, h);
}

/* Attach a virtual 320x224-equivalent window to the standalone runtime.
 *
 * Call after ``dune_rt_init()`` (which memsets ``em_host``) and after the game
 * module/ROM are installed; ``DuneHost.boot()`` does exactly that.  The pinned
 * adapters then see a non-NULL window/renderer with a valid surface size, so
 * ``dune_web_camera_geometry()`` succeeds and tap/pan/zoom/hover return real
 * context instead of 0.  Nothing is rendered through SDL: the host still owns
 * presentation through ``dune_web_frame_rgb()``.
 *
 * Returns 1.  Calling it again just updates the virtual size. */
EMSCRIPTEN_KEEPALIVE int dune_web_attach_virtual_window(int width, int height) {
    if (width < 1) width = 320;
    if (height < 1) height = 224;
    if (width > 8192) width = 8192;
    if (height > 8192) height = 8192;
    dune_virtual_window_width = width;
    dune_virtual_window_height = height;
    dune_virtual_window_attached = 1;
    em_window = 1;
    em_host.window = (SDL_Window *)&dune_virtual_window_token;
    em_host.renderer = (SDL_Renderer *)&dune_virtual_renderer_token;
    em_host.stopped = 0;
    em_host.error = 0;
    em_host.audio_device = 0;
    em_host.audio_running = 0;
    em_host.next_service = em_cpu.master_cycles;
    em_host.last_frame = UINT64_MAX;
#ifdef GENESIS_DUNE_MOUSE
    /* sdl_host_open() normally does this; without it every mouse helper is a
       no-op even though the geometry is valid. */
    em_host.dune_mouse.enabled = 1;
    if (!em_host.dune_view.zoom) em_host.dune_view.zoom = 100;
    em_host.dune_view.frame = UINT64_MAX;
    em_host.dune_view.camera_valid = 0;
    em_host.dune_view.pointer_valid = 0;
    em_host.dune_view.pan_frame = em_cpu.vdp.rendered_frames;
#endif
    /* Reuse the pinned resize hook: it invalidates the presentation frame and
       notifies the (wrapped) SDL window about the new surface size. */
    dune_web_resize(width, height);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int dune_web_virtual_window_attached(void) {
    return dune_virtual_window_attached ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int dune_web_virtual_window_width(void) {
    return dune_virtual_window_width;
}

EMSCRIPTEN_KEEPALIVE int dune_web_virtual_window_height(void) {
    return dune_virtual_window_height;
}

/* ------------------------------------------------------------------------- */
/* Software expanded mission overview (no SDL renderer)                     */
/* ------------------------------------------------------------------------- */
/* Path B draws the expanded camera view through SDL textures in
 * ``dune_view_draw()``.  Path A has no renderer, but the same world traversal
 * (``dune_view_build()``) is pure C and writes RGBA buffers into memory.
 *
 * This export composites that software view back into a 320x224 (virtual
 * window sized) RGBA frame exactly like ``dune_view_draw()``: the world is
 * scaled by ``layout.world_scale`` (the zoomed-out overview), then the native
 * 320x224 HUD overlay is alpha-blended on top at ``ui_scale``.  It lets the JS
 * host show the camera's pan/zoom result while rendering stays software.
 *
 * Presentation only: no game state is written; the world traversal runs on a
 * shadow CPU copied from ``em_cpu`` (as in path B).
 */
static uint8_t *dune_expanded_frame = NULL;
static size_t dune_expanded_frame_capacity = 0;
static unsigned dune_expanded_frame_width = 0;
static unsigned dune_expanded_frame_height = 0;

static void dune_expanded_black(uint8_t *dst, size_t pixels) {
    memset(dst, 0, pixels * 4u);
    for (size_t i = 0; i < pixels; ++i) dst[i * 4u + 3u] = 255u;
}

/* Nearest-neighbour copy of an RGB(A) source region into an RGBA destination
 * rect using doubles, the same scaling SDL_RenderCopyF applies. */
static void dune_expanded_world(uint8_t *dst, int w, int h, const uint8_t *src, int sw, int sh,
                                double scale) {
    if (!(scale > 0.0)) return;
    for (int y = 0; y < h; ++y) {
        int sy = (int)((double)y / scale);
        if (sy < 0 || sy >= sh) continue;
        for (int x = 0; x < w; ++x) {
            int sx = (int)((double)x / scale);
            if (sx < 0 || sx >= sw) continue;
            size_t s = ((size_t)sy * (size_t)sw + (size_t)sx) * 4u;
            size_t d = ((size_t)y * (size_t)w + (size_t)x) * 4u;
            dst[d] = src[s];
            dst[d + 1u] = src[s + 1u];
            dst[d + 2u] = src[s + 2u];
        }
    }
}

static void dune_expanded_hud(uint8_t *dst, int w, int h, const uint8_t *ui,
                              int src_x, int src_y, int src_w, int src_h,
                              double dst_x, double dst_y, double dst_w, double dst_h) {
    if (!(dst_w > 0.0) || !(dst_h > 0.0)) return;
    int x0 = (int)dst_x; if (x0 < 0) x0 = 0;
    int y0 = (int)dst_y; if (y0 < 0) y0 = 0;
    int x1 = (int)(dst_x + dst_w); if (x1 > w) x1 = w;
    int y1 = (int)(dst_y + dst_h); if (y1 > h) y1 = h;
    for (int y = y0; y < y1; ++y) {
        int v = src_y + (int)(((double)y - dst_y) * (double)src_h / dst_h);
        if (v < 0 || v >= src_y + src_h || v >= 224) continue;
        for (int x = x0; x < x1; ++x) {
            int u = src_x + (int)(((double)x - dst_x) * (double)src_w / dst_w);
            if (u < 0 || u >= src_x + src_w || u >= 320) continue;
            size_t s = ((size_t)v * 320u + (size_t)u) * 4u;
            unsigned alpha = ui[s + 3u];
            if (!alpha) continue;
            size_t d = ((size_t)y * (size_t)w + (size_t)x) * 4u;
            if (alpha == 255u) {
                dst[d] = ui[s];
                dst[d + 1u] = ui[s + 1u];
                dst[d + 2u] = ui[s + 2u];
            } else {
                unsigned inv = 255u - alpha;
                dst[d] = (uint8_t)((ui[s] * alpha + dst[d] * inv) / 255u);
                dst[d + 1u] = (uint8_t)((ui[s + 1u] * alpha + dst[d + 1u] * inv) / 255u);
                dst[d + 2u] = (uint8_t)((ui[s + 2u] * alpha + dst[d + 2u] * inv) / 255u);
            }
        }
    }
}

EMSCRIPTEN_KEEPALIVE const uint8_t *dune_web_expanded_frame_rgba(void) {
    if (!em_window || !em_host.window || !em_host.renderer ||
        !em_cpu.vdp.frame_width || !em_cpu.vdp.frame_height) return NULL;
    int w = dune_virtual_window_width;
    int h = dune_virtual_window_height;
    if (w <= 0 || h <= 0 || w > 2048 || h > 2048) return NULL;
    DuneLayout layout = dune_view_host_layout(&em_host, &em_cpu, w, h);
    if (!layout.world_width || !layout.world_height) return NULL;
    DuneView *view = &em_host.dune_view;
    /* The SDL presentation path (dune_view_draw) publishes the native cursor
       state before building the view.  Path A called dune_view_build directly,
       so the engine always rendered its default square cursor.  Replicate the
       SDL setup: the ordinary map cursor is hidden, only the carried-building
       placement preview may show it. */
    if (dune_view_map(&em_cpu)) dune_view_pointer(&em_host, &em_cpu);
    view->cursor_hidden = !em_web_cursor_preview(&em_cpu);
    view->cursor_valid = em_host.dune_mouse.point_world;
    view->cursor_x = em_host.dune_mouse.wx;
    view->cursor_y = em_host.dune_mouse.wy;
    if (!dune_view_build(view, &em_cpu, &layout)) return NULL;
    if (!view->pixels || !view->ui || !view->width || !view->height) return NULL;
    size_t bytes = (size_t)w * (size_t)h * 4u;
    if (dune_expanded_frame_capacity < bytes) {
        uint8_t *grown = (uint8_t *)realloc(dune_expanded_frame, bytes);
        if (!grown) return NULL;
        dune_expanded_frame = grown;
        dune_expanded_frame_capacity = bytes;
    }
    dune_expanded_black(dune_expanded_frame, (size_t)w * (size_t)h);
    dune_expanded_world(dune_expanded_frame, w, h, view->pixels,
                        (int)view->width, (int)view->height, layout.world_scale);
    /* Same placement as dune_view_draw(): HUD top 144px and bottom 80px. */
    double hud_w = 320.0 * layout.ui_scale;
    double hud_x = (double)w - hud_w;
    dune_expanded_hud(dune_expanded_frame, w, h, view->ui, 0, 0, 320, 144,
                      hud_x, 0.0, hud_w, 144.0 * layout.ui_scale);
    dune_expanded_hud(dune_expanded_frame, w, h, view->ui, 0, 144, 320, 80,
                      hud_x, (double)h - 80.0 * layout.ui_scale, hud_w, 80.0 * layout.ui_scale);
    dune_expanded_frame_width = (unsigned)w;
    dune_expanded_frame_height = (unsigned)h;
    return dune_expanded_frame;
}

EMSCRIPTEN_KEEPALIVE int dune_web_expanded_frame_width(void) {
    return (int)dune_expanded_frame_width;
}

EMSCRIPTEN_KEEPALIVE int dune_web_expanded_frame_height(void) {
    return (int)dune_expanded_frame_height;
}

/* One native machine step with the browser input observers that
   ``em_web_main_loop_work()`` normally runs before each instruction.  Path A
   drives the CPU from JS through ``dune_rt_machine_step()``, which does not
   observe queued mouse/tap/menu/campaign input; this export restores the
   path-B ordering exactly (same conditionals, same calls) for hosts that want
   programmatic touch input to reach the original game code.  Pure emulation
   (tests, differential runs) keeps using ``dune_rt_machine_step()``. */
EMSCRIPTEN_KEEPALIVE void dune_rt_web_step(void) {
#if defined(GENESIS_DUNE_MOUSE) && defined(GENESIS_SDL2)
    if (em_window && !em_cpu.fault) {
#ifdef EM_WEB_MODERN_INPUT
        if (!em_web_campaign_observe(&em_cpu)) {
            em_web_selection_observe();
            if (!em_web_menus_observe(&em_host.dune_mouse, &em_cpu) &&
                !em_web_menu_select_observe(&em_host.dune_mouse, &em_cpu))
                dune_mouse_observe(&em_host.dune_mouse, &em_cpu);
        }
#else
        dune_mouse_observe(&em_host.dune_mouse, &em_cpu);
#endif
    }
#endif
    machine_step(&em_cpu);
}

#endif /* DUNE_RT_VIRTUAL_WINDOW_INC */
