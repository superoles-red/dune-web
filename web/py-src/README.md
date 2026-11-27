# Драйвер браузерного перекомпилятора (Python, MIT)

Эти файлы попадают в `web/py-package.zip` и исполняются в Pyodide внутри Web Worker:

- `dune_build.py` — порт `tools/build_dune.py` из ReArrakis (MIT, andvolodko/dune2-sega-web
  @56c6a6da10): Z80-образы из ROM, discovery точек входа, аргументы `genesis_recompiler`,
  вызов CLI в процессе (без `subprocess`), фазы времени и прогресс.
- `driver.py` — точка входа `driver.run()`: читает `/work/rom.gen`, запускает сборку, проверяет
  SHA-256 результата против эталона из `reference.json`, возвращает JSON.

Что не хранится здесь и появляется при `python3 tools/bundle_web.py`:

- `genesis_recompiler/` — пинованный MIT-пакет из `vendor/rearrakis/` + оверлей
  `tools/recompiler_overlay/`;
- `dune-runtime.c` — точная runtime-преамбула v2 из `runtime/`;
- `profile.json`, `reference.json` — паспорт дампа и эталонный SHA.

Игровых данных здесь нет и быть не должно: ROM приходит из файлового поля игрока.
