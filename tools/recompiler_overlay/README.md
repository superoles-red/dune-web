# Overlay: patched ReArrakis recompiler modules (MIT)

These two files are patched copies of `vendor/rearrakis/genesis_recompiler/`
(MIT, ReArrakis; see `LICENSE-ReArrakis.md`) and exist for exactly two additive
features required by the BYOP port:

- `emit.py`: `emit(..., runtime_text=None, title=None)` — lets the caller embed a
  pinned, pre-rendered runtime preamble instead of re-composing it from headers,
  and set the window title. Default behaviour (without the new arguments) is
  byte-identical to the vendored module.
- `cli.py`: `--pinned-runtime PATH` and `--window-title TEXT` options that feed
  those arguments.

`tools/bundle_web.py` copies the vendored package into `web/py-src/` and then
overwrites these two files. Nothing else in the recompiler is changed; the
analysis, discovery and code generation are the upstream MIT implementation.
