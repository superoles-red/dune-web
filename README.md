# Dune: The Battle for Arrakis — BYOP web port

Неофициальный веб-порт Dune для Sega Genesis (USA). Игра **не поставляется**: вы приносите
свой ROM (1 048 576 байт, USA-версия), ядро игры перекомпилируется **в вашем браузере** и
кэшируется на устройстве. Это не эмулятор: программа Sega статически переводится в WebAssembly
тем же компилятором ReArrakis (MIT), что использовался для прежней сборки.

An unofficial BYOP web port of the USA Sega Genesis release. No game data is shipped: the player
supplies the ROM, and the Sega program is statically recompiled to WebAssembly in the browser.

## Состояние (2026-11-27)

- **Спайк пройден.** ROM игрока → перекомпиляция в браузере (Pyodide + MIT ReArrakis) даёт
  **побайтно эталонное** ядро: 20 412 009 байт, SHA-256 `e3055a76…4ad1578` (базовая версия) /
  подготовленное `d7c84066…ebbd123`; 8,3 с и ~104 МБ WASM heap в Chrome. Отчёт спайка:
  `Порты игр/spikes/dune-recompiler/REPORT.md`.
- **Этап 2 пройден:** ROM → C в браузере побайтно совпадает с подготовленным ядром
  `d7c84066…` (20 417 216 байт), сборка 8,4 с, повтор — из OPFS-кэша; рантайм v2 и сохранения
  готовы; WASM-бэкенд — дизайн и PoC в работе.
- **Сохранения совместимы со старой версией:** новые файлы формата `dune-sega-web-save` v1
  с нативным payload `DSAV v2` принимаются как есть; можно импортировать `*.dune-save.json`
  из старой игры. См. [docs/SAVES.md](docs/SAVES.md).
- **Не готово:** сборка WASM на устройстве без компилятора C (этап 2, см.
  [docs/WASM-BACKEND.md](docs/WASM-BACKEND.md)) и игровая оболочка-рендер (этап 3).

## Как запустить локально

```sh
npm install                       # pyodide 0.28.3 + playwright-core
python3 tools/bundle_web.py       # собрать web/py-package.zip и web/vendor
python3 tools/serve.py --port 4188
# открыть http://127.0.0.1:4188/
```

Сервер отдаёт страницу с COOP/COEP, чтобы работали SharedArrayBuffer-независимые замеры памяти
и WebAssembly. Первая сборка ядра в браузере идёт несколько минут на телефоне; повторная —
из кэша OPFS.

## Проверки

```sh
npm test                    # тесты сохранений (node --test tests/)
npm run smoke               # headless Chrome: ROM → сборка → сверка SHA
```

Проверка точности ядра (нужен внешний `dune-base.c`, в репозиторий не входит):

```sh
python3 tools/build_runtime.py --baseline /path/to/dune-base.c
python3 tools/verify.py --rom /path/to/Dune-USA.gen
```

## Структура

```
profiles/       паспорт поддерживаемого USA-дампа (размер, SHA-256, адреса)
runtime/        точная runtime-преамбула v2 (MIT, без данных игры) и её манифест
tools/          сборка оболочки, проверки, локальный сервер, патч перекомпилятора
web/            BYOP-оболочка: ROM → перекомпиляция → сверка → кэш, сейвы
web/py-src/     драйвер браузерного перекомпилятора (Python, MIT)
vendor/         пинованный ReArrakis (MIT)
tests/          тесты (сохранения, браузерный smoke)
docs/           план, архитектура, сохранения, WASM-бэкенд
```

## Правовая модель

В репозитории только собственный код адаптации и сторонние MIT-компоненты. ROM, сгенерированное
ядро и извлечённые ассеты игры не публикуются: ROM игрок приносит сам, всё остальное живёт в его
браузере (память/OPFS). Оригинальная игра, её графика и звук принадлежат правообладателям;
торговая марка «Dune» — Herbert Limited Partnership. Сторонние лицензии в
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) и [LICENSE-ReArrakis.md](LICENSE-ReArrakis.md).

## Интерфейс

Правило проекта: элементы меню, окна, кнопки и текст игры собираются только из **оригинальной
графики игры** (пиксельные шрифты EN/RU, спрайты интерфейса из ROM) — своих текстур и шрифтов
не рисуем. Служебные страницы (эта установка, паспорт дампа, сохранения) — диагностическая
оболочка, не выдающая себя за игру.
