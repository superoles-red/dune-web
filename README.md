# Dune: The Battle for Arrakis — BYOP web port

[**Открыть тестовую сборку**](https://superoles-red.github.io/dune-web/) ·
[CI](https://github.com/superoles-red/dune-web/actions) ·
[Issues](https://github.com/superoles-red/dune-web/issues)

Неофициальный веб-порт Dune для Sega Genesis (USA). Игра **не поставляется**: вы приносите
свой ROM (1 048 576 байт, USA-версия), ядро игры перекомпилируется **в вашем браузере** и
кэшируется на устройстве. Это не эмулятор: программа Sega статически переводится в WebAssembly
тем же компилятором ReArrakis (MIT), что использовался для прежней сборки.

An unofficial BYOP web port of the USA Sega Genesis release. No game data is shipped: the player
supplies the ROM, and the Sega program is statically recompiled to WebAssembly in the browser.

## Как проверить на телефоне или ПК

1. Откройте [superoles-red.github.io/dune-web](https://superoles-red.github.io/dune-web/) в
   Chrome/Safari и выберите свой ROM `Dune - The Battle for Arrakis (USA).gen`
   (1 048 576 байт). Файл не покидает устройство.
2. Нажмите «Собрать ядро» и дождитесь вердикта: SHA ядра должен совпасть с эталоном
   `d7c84066…` (20 417 216 байт). Первая сборка — несколько минут на телефоне, повторная —
   из кэша.
3. В разделе «Сохранения» импортируйте файл из старой версии (`*.dune-save.json`, выгружается
   в старой игре через `FILES & OFFLINE` → `DOWNLOAD SAVE`) и проверьте, что дом, миссия и
   прогресс определились.

Подробный чек-лист для проверки на телефоне и ПК: [docs/TESTING.md](docs/TESTING.md).

**Это осознанно промежуточный этап:** сейчас проверяются сборка ядра из ROM и перенос сохранений.
Сама игра пока не рендерится — игровая оболочка (тач/зум/меню) следующий этап. Сломанной сборкой
это не является; на странице тот же статус написан явно.

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
- **Опубликовано для тестирования:** https://superoles-red.github.io/dune-web/ (CI и Pages
  зелёные; в артефакт деплоя игровые данные не попадают).
- **Этап 3, Phase 1 готов:** `runtime.wasm` собран (894 968 B, детерминирован, ABI 140 слов,
  save API, диспетчеризация) — [docs/WASM-RUNTIME.md](docs/WASM-RUNTIME.md); эмиттер реальных
  страниц сверен с C-оракулом на 21 360 состояниях, 0 расхождений —
  [docs/WASM-EMITTER.md](docs/WASM-EMITTER.md).
- **Не готово:** связка полного `game.wasm` (все страницы + Z80) с рантаймом, браузерный
  воркер на WASM-пути и игровая оболочка-рендер.

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
