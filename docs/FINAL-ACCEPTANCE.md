# BYOP-порт Dune (Sega, USA) — финальная приёмка

Живой сайт: https://superoles-red.github.io/dune-web/
Репозиторий: superoles-red/dune-web (main, GitHub Pages деплой из Actions).

## Что должно было получиться

Полная копия старой версии https://superoles-red.github.io/dune-sega-web/:
тот же фронтенд, UI и поведение, но ROM и игровое ядро игрок приносит сам и
сборка идёт на устройстве. Отличия допустимы только там, где без них не
обойтись из-за BYOP.

## Матрица требований и доказательств

| Требование | Как проверено | Результат |
|---|---|---|
| Старый фронтенд/UI/поведение | файлы старого `web/` перенесены в корень; `tests/browser/legacy-screens.mjs` (живой сайт) — OPTIONS/MUSIC 100%→50%, RU, HOW TO PLAY, FILES & OFFLINE, возврат домой | LEGACY-SCREENS OK |
| Запуск кампании | `tests/browser/legacy-start.mjs` (живой сайт): ROM → сборка → меню → дом → миссия → брифинг → карта `armed=1`, звук `running`, 0 ошибок | LEGACY-START OK |
| Старые сохранения | тот же тест: F5 → перезагрузка → CONTINUE → миссия восстановлена | OK |
| Chrome | живые прогоны выше; самообновление: штамп версии в `index.html`, SW v6 `cache: no-store`, self-heal старого SW | OK |
| Safari/WebKit | реальная сборка Pyodide в WebKit (iPhone viewport) → главный экран; `tests/browser/webkit-legacy.mjs` (сетевой стаб ядра) проходит | WEBKIT-LEGACY OK |
| iPhone-специфика | OPFS в WebKit падает с UnknownError → воркер отдаёт ядро в страницу, IndexedDB-кэш; Chromium с принудительно сломанным OPFS: первый запуск 19–32 с, повторный 8–9 с без пикера; WebKit реальная сборка ~17 с | OK |
| PWA/офлайн | `tests/browser/legacy-offline.mjs` (живой сайт): SW-кэш, офлайн-перезагрузка, `name/short_name=Dune`, `standalone`, иконки 192+512 | LEGACY-OFFLINE OK |
| ROM отдельно | ROM не в репозитории (`tools/check_no_game_data.py`), `game.wasm`/`.state.bin` не коммитятся; сборка на устройстве; ROM хранится в OPFS/IndexedDB локально | OK |
| Внешний вид | сверка скриншотов со старым локальным билдом: дома/миссии/подтверждение 0.1–0.2% пикселей (анимации), меню/карта — только кадры анимации/камеры | без структурных отличий |
| Управление браузера | живые проверки: `userSelect=none`, `touch-action=manipulation`, нет callout/контекстного меню/зума страницы | OK |
| Установка | кнопка «УСТАНОВИТЬ ИГРУ» при `beforeinstallprompt`; приложение называется Dune | OK |
| Credits | `tests/browser/legacy-credits.mjs` (живой сайт): миссия 9 отмечена, replayCredits → нативная сцена `credits`; чекпоинт берётся из старого деплоя same-origin, в репозиторий не кладётся | LEGACY-CREDITS OK |
| Совместимость старых DSAV | старый `house-1.state.bin` (140 921 байт, DSAV v2) загружается нашим рантаймом, сцена credits открывается | OK |

Скриншоты и JSON-отчёты прогонов: `test-results/legacy/` и
`test-results/parity/` (не коммитятся, создаются тестами).

## Осознанные отличия из-за BYOP

1. **Первый запуск** — сборка ядра из ROM (Pyodide) занимает время; повторные
   запуски идут из кэша (OPFS или IndexedDB) за секунды.
2. **ROM** хранится только на устройстве; после очистки данных сайта или в
   приватном окне его нужно выбрать снова.
3. **Credits** используют ROM-зависимый чекпоинт `credits/house-N.state.bin`,
   который по правилам BYOP не лежит в репозитории: страница берёт его у
   старого деплоя (тот же origin, `../dune-sega-web/credits/...`). Если старый
   сайт недоступен/офлайн, старый UI покажет своё сообщение об ошибке.
   `demo-harkonnen.state.bin`/`training.state.bin` в старом фронтенде нигде не
   вызываются (мёртвый код), поэтому сцен demo/training в игре нет и в
   оригинале.
4. **Install-gate** старой версии заменён на необязательную кнопку установки:
   игра доступна сразу после выбора ROM.

## Как воспроизвести проверки

```bash
# локально
python3 tools/serve.py --port 4550
DUNE_ROM="/path/Dune - The Battle for Arrakis (USA).gen" LEGACY_URL="http://127.0.0.1:4550/" \
  node tests/browser/legacy-start.mjs
DUNE_ROM="..." LEGACY_URL="http://127.0.0.1:4550/" node tests/browser/legacy-screens.mjs
DUNE_ROM="..." LEGACY_PORT=4577 node tests/browser/legacy-offline.mjs
node tests/browser/webkit-legacy.mjs   # движок Safari (нужен WebKit Playwright)

# живой сайт
DUNE_ROM="..." LEGACY_URL="https://superoles-red.github.io/dune-web/" \
  node tests/browser/legacy-start.mjs
```
