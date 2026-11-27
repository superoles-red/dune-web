# Сохранения: формат, совместимость и перенос

Подсистема сохранений нового BYOP-порта. Формат и нативный payload намеренно
повторяют старую версию игры (`superoles-red/dune-sega-web`), поэтому файл
`*.dune-save.json`, скачанный из старой игры, открывается новой версией **без
конвертации**.

Исходники старой версии, по которым сделан порт:

| Файл старой версии | Что перенесено |
|---|---|
| `Dune Sega Web/web/save-files.mjs` | конверт `dune-sega-web-save` v1, канонический JSON, SHA-256, `validateNativeSave`, `parseSaveFile`, `createSaveFile`, `commitSaveFile`, `SaveFileError` |
| `Dune Sega Web/web/campaign-state.mjs` | `CampaignStore`, ключи localStorage, миграция старых слотов, `normalizeProgress` |
| `Dune Sega Web/web/browser-features.mjs` | `downloadSave`, `pickSaveFile` |
| `Dune Sega Web/web/i18n.mjs` | `LANGUAGE_KEY='dune-sega-language-v1'` |
| `Dune Sega Web/docs/pwa-and-saves.md` | пользовательский сценарий экспорта/импорта |
| `Dune Sega Web/tools/prepare_source.py` | патч нативного ABI: `DUNE_SAVESTATE_VERSION 1 → 2` и ограниченная проверка размера при загрузке |

Файлы нового порта:

- `web/saves/save-files.mjs` — файл сохранения (конверт + нативный payload);
- `web/saves/campaign-state.mjs` — прогресс кампании и слот Continue;
- `web/saves/browser-files.mjs` — скачивание файла и выбор файла в браузере;
- `tests/saves/*.test.mjs` — тесты без игровых данных (только синтетические payload).

> **В репозитории нет игровых данных.** Ни ROM, ни реальных сейвов, ни
> извлечённых ассетов. Тестовый DSAV-пакет собирается в памяти теста: нули,
> корректный заголовок и два слова кампании. Проверка репозитория —
> `python3 tools/check_no_game_data.py`.

## 1. Что содержит файл

Один файл — снимок **метаданных порта** (JSON-конверт) плюс ровно тот нативный
поток байтов, который сериализует сам рантайм игры:

1. общий слот Continue (активная миссия и нативный снапшот `DuneSaveState`),
   если он есть;
2. открытые/пройденные миссии и даты прохождения всех трёх домов;
3. выбранный язык интерфейса (`en`/`ru`);
4. сведения о формате и сборке (`compatibility`).

Графика, звуковые ресурсы, ROM и код рантайма в файл не попадают. Экспорт —
снимок на момент экспорта, автоматической синхронизации нет.

## 2. JSON-конверт `dune-sega-web-save` v1

Верхний уровень — объект **ровно** из восьми ключей; лишние и отсутствующие
ключи отклоняются (`invalid-format`).

| Поле | Тип | Правила |
|---|---|---|
| `format` | string | ровно `"dune-sega-web-save"`, иначе `wrong-game` |
| `version` | number | ровно `1`, иначе `incompatible-version` |
| `compatibility` | object | ровно 5 ключей, см. §4 |
| `createdAt` | number | целое `> 0` (мс Unix), иначе `invalid-format` |
| `language` | string | `"en"` или `"ru"`, иначе `invalid-format` |
| `progress` | object | кампания v1, см. §2.1 |
| `continue` | object \| null | Continue v2 или `null`, см. §2.2 |
| `checksum` | string | `sha256-` + 64 строчные hex-цифры от тела без `checksum`, см. §3 |

Ограничения файла: не более `MAX_SAVE_FILE_BYTES = 512 KiB` (и по числу
символов, и по числу байтов UTF-8; иначе `too-large`), при этом `continue.state`
ограничен `MAX_NATIVE_SAVE_BYTES = 256 KiB` нативного потока. Имя экспорта:
`dune-<ISO-8601 с '-' вместо ':' и '.'>.dune-save.json`, текст заканчивается
переводом строки, отступ 2 пробела (косметика; на checksum не влияет).

Схематичный пример (значения-заглушки; `<...>` — плейсхолдеры, не реальные данные):

```json
{
  "format": "dune-sega-web-save",
  "version": 1,
  "compatibility": {
    "game": "dune-sega-usa",
    "nativeFormat": "DSAV",
    "nativeVersion": 2,
    "nativeBaseBytes": 140056,
    "engineSha256": null
  },
  "createdAt": 0,
  "language": "ru",
  "progress": {
    "version": 1,
    "lastHouse": 1,
    "houses": [
      { "unlocked": 1, "completed": [], "completedAt": {} },
      { "unlocked": 3, "completed": [1, 2], "completedAt": { "1": 0, "2": 0 } },
      { "unlocked": 1, "completed": [], "completedAt": {} }
    ],
    "lastRun": { "house": 1, "mission": 3 }
  },
  "continue": {
    "version": 2,
    "house": 1,
    "mission": 3,
    "state": "<base64 нативного DSAV v2 payload>",
    "savedAt": 0
  },
  "checksum": "sha256-<64 hex>"
}
```

### 2.1 `progress` — кампания v1 (`dune-sega-campaign-v1`)

Структура повторяет старый `CampaignStore`:

- `version` — ровно `1`;
- `lastHouse` — целое `0..2` (HARKONNEN/ATREIDES/ORDOS);
- `houses` — ровно 3 элемента, по одному на дом;
- `houses[h].unlocked` — целое `1..9` (доступная миссия, `1` = только первая);
- `houses[h].completed` — отсортированный по возрастанию массив уникальных
  миссий `1..9`, не длиннее 9;
- `houses[h].completedAt` — объект «номер миссии → время прохождения»: ключ
  обязан быть в `completed` (десятичная запись без ведущих нулей), значение —
  целое `>= 0`;
- `lastRun` — `null` или `{ house, mission }` с валидными домом и миссией.

Дополнительно прогресс обязан быть **самосогласованным**: после
`normalizeProgress(progress)` результат должен совпадать с исходным объектом
(канонически). Так отклоняются, например, `unlocked`, заниженный относительно
пройденных миссий, лишние/неотсортированные элементы, «дыры» в истории. Код
ошибки — `invalid-progress`.

### 2.2 `continue` — Continue v2 (`dune-sega-continue-v2`)

`null` либо объект ровно из 5 ключей:

- `version` — ровно `2`;
- `house` — `0..2`; `mission` — `1..9`;
- `state` — base64 нативного DSAV v2 (см. §3), валидный по ABI;
- `savedAt` — целое `> 0`.

Согласованность с прогрессом (иначе `invalid-continue`/`mission-mismatch`):

- слова `house`/`mission` внутри нативного payload должны совпадать с полями
  объекта;
- `mission <= houses[house].unlocked`;
- `savedAt > houses[house].completedAt[mission]` (нельзя «продолжить» уже
  пройденную миссию со старым временем);
- `progress.lastRun` должен быть ровно `{house, mission}` этого Continue.

`continue: null` — допустимый «снимок только прогресса». Импорт такого файла
записывает в localStorage Continue-«надгробие» `{version:2,state:null,savedAt:0}`,
чтобы старые слоты/архив не «воскресли» после импорта (см. §5).

## 3. Нативный payload `DSAV` v2

Это байтовый поток `DuneSaveState` из рантайма (не JSON). Раскладка
подтверждена компиляцией точной структуры из пинованного
[`runtime/dune-runtime-v2.c`](../runtime/dune-runtime-v2.c) (natural alignment,
**без** `#pragma pack`) и записана в
[`runtime/manifest.json`](../runtime/manifest.json) (`savestate`):
`sizeof(DuneSaveState) == 140056`, `offsetof(ram) == 94`, `offsetof(sr) == 92`.
Заголовок — little-endian:

| Смещение | Размер | Поле | Значение |
|---|---|---|---|
| 0 | u32 | `magic` | `0x56415344` (`"DSAV"` big-endian при записи LE) |
| 4 | u32 | `version` | `2` |
| 8 | u32 | `ym_size` | размер хвоста состояния YM2612 |
| 12 | u32 | `total_size` | полная длина потока |

Правила:

- полная длина `L` обязана удовлетворять `140056 <= L <= 262144`
  (`NATIVE_SAVE_BASE_BYTES + ym_size`, `MAX_NATIVE_SAVE_BYTES`);
- `total_size === L` и `ym_size === L - 140056`, иначе `invalid-payload`;
- `magic`/`version` не совпали — `incompatible-payload`;
- payload — канонический base64 (`btoa(atob(s)) === s`), иначе `invalid-payload`;
- длина base64 ограничена `MAX_NATIVE_SAVE_BYTES`; всё это проверяется до
  каких-либо записей в localStorage.

Позиции кампании внутри `DuneSaveState` (ABI, который обязан сохранить новый
рантайм):

| Что | Смещение в потоке | Формат |
|---|---|---|
| `offsetof(DuneSaveState, sr)` | `92` | конец регистровой части |
| начало `DuneSaveState.ram` | `94` (проверено `offsetof`) | — |
| номер дома | `49874` = `94 + 0xC274` | big-endian u16, `0..2` |
| номер миссии | `49326` = `94 + 0xC050` | big-endian u16, хранится `mission - 1`; миссия `1..9` |

Абсолютные смещения `49874`/`49326` — контракт: они же записаны в
`runtime/manifest.json` (`savestate.house_offset`, `savestate.mission_offset`) и
проверяются тестом `tests/saves/save-files.test.mjs`
(«pinned runtime savestate manifest…»), а также закреплены в коде как
`NATIVE_HOUSE_OFFSET`/`NATIVE_MISSION_OFFSET`.

Смещение `94` — сумма заголовка v2 и регистров: `magic(4) + version(4) +
ym_size(4) + total_size(4) + d[8]*4 + a[8]*4 + pc(4) + usp(4) + ssp(4) + sr(2)`.
Pinned runtime использует natural alignment без `#pragma pack`, поэтому дальше
по структуре есть выравнивающие промежутки, и `sizeof(DuneSaveState) == 140056`.

> **Не собирайте `DuneSaveState` из
> `vendor/rearrakis/genesis_recompiler/dune_savestate.h`.** В этом заголовке
> `#pragma pack(push,1)`: `sizeof` станет `140027`, и все старые сейвы будут
> отклоняться как `invalid-payload`. Пинованный `runtime/dune-runtime-v2.c`
> содержит правильную v2-структуру с natural alignment; подробности и проверка
> — [RUNTIME.md](RUNTIME.md).

Хвост `ym_size` — внутреннее состояние YM2612 (FM) после `DuneSaveState`; порт
проверяет только его размер и сохраняет байты как есть.

### Что обязан сохранить новый рантайм

1. **Побайтовую раскладку** `DuneSaveState`: порядок и размеры полей, `ram` на
   смещении `94`, слова кампании по `$C274`/`$C050` в big-endian внутри RAM.
   Любая вставка/переупорядочивание полей ломает перенос старых Continue.
2. **Сериализатор** `dune_save_state_to_buffer`: заголовок с `magic="DSAV"`,
   `version=2`, `ym_size`, `total_size`; запись YM-состояния после структуры.
3. **Ограниченную загрузку** `dune_load_state_from_buffer`: проверка magic,
   version=2, `size <= sizeof(g_dune_state_buffer)`, `total_size === size`,
   `ym_size` в пределах буфера и `sizeof + ym_size === size`; после загрузки —
   сброс ввода/звука/кэша кадра и повторная синхронизация кампании (в старой
   версии это делает `tools/prepare_source.py`; новый рантайм обязан повторить
   эквивалент, иначе загруженный сейв может «зависнуть»).
4. **`sizeof(DuneSaveState) == 140056` и `offsetof(ram) == 94`** — подтверждено
   компиляцией точной структуры из пинованного baseline 2026-11-27; значения
   записаны в `runtime/manifest.json` (`savestate.base_bytes`, `ram_offset`,
   `house_offset`, `mission_offset`). Добавить статическую проверку этого
   размера/смещений при сборке рантайма и не включать запакованный vendor-заголовок
   (см. предупреждение выше): иначе `sizeof == 140027` и импорт старых файлов
   сломается.
5. **Версию ABI v2**: `runtime/dune-runtime-v2.c` объявляет
   `DUNE_SAVESTATE_VERSION 2`; сборка из старого vendor-заголовка (v1) без
   патча вернула бы v1. `tools/prepare_source.py` применяет патч v2 и
   ограниченную проверку размеров при загрузке (`total_size === size`,
   `sizeof + ym_size === size`).

## 4. Политика совместимости old → new

Для BYOP-порта важно разделить две вещи:

- **ABI — нормативен.** `game:'dune-sega-usa'`, `nativeFormat:'DSAV'`,
  `nativeVersion:2`, `nativeBaseBytes:140056`. Именно они гарантируют, что
  байты payload можно отдать рантайму. Несовпадение любого поля —
  `incompatible-engine`.
- **`engineSha256` — информационный идентификатор сборки.** Он не участвует в
  разборе байтов, а служит меткой «какой движок это записал».

Принимаемые значения `engineSha256`:

1. **весь старый allowlist** — 13 хэшей, дословно скопированных из
   `Dune Sega Web/web/save-files.mjs` (`LEGACY_ENGINE_SHA256S`). Это все
   когда-либо опубликованные старые ядра, поэтому любой старый экспорт проходит;
2. **`NEW_ENGINE_SHA256`** — хэш сборки нового рантайма. Пока он равен `null`
   (плейсхолдер до первой сборки WASM-ядра), поэтому **новый экспорт
   пишет `engineSha256: null`**, а `null` принимается парсером всегда. Порядок
   заполнения:
   1. рантайм уже пинован: `runtime/dune-runtime-v2.c`
      (`runtime_sha256` = `e47a4cae…`, проверка
      `python3 tools/build_runtime.py --baseline <dune-base.c> --check`);
      осталось собрать WASM-ядро (`emcc 3.1.74`) и зафиксировать его SHA-256.
      Старый `engineSha256` означал именно SHA-256 собранного WASM-модуля
      (`docs/wasm-build.json`), а **не** хэш C-преамбулы (`runtime_sha256`) и
      **не** подготовленного C-ядра (`shipped_core_sha256`); семантику поля для
      нового порта стоит зафиксировать здесь до заполнения;
   2. записать SHA-256 итогового WASM-ядра в `NEW_ENGINE_SHA256` в
      `web/saves/save-files.mjs`;
   3. не удалять старые хэши из `LEGACY_ENGINE_SHA256S`;
   4. прогнать `node --test tests/saves/` — экспорт получает новый хэш, старые
      файлы по-прежнему импортируются, `null`-экспорты, сделанные до фиксации,
      остаются валидными.

Прочие валидные по форме SHA-256 значения отклоняются (`incompatible-engine`) —
это сохранённое поведение старого формата и защита от файлов сторонних
сборок. `null` — единственное исключение, оно означает «экспорт нового порта до
фиксации хэша».

**Совместимость односторонняя: old → new.** Старая сборка принимает только
свой allowlist, поэтому новый экспорт (с новым или `null` хэшем) в ней не
откроется — намеренно, чтобы не выдавать чужую сборку за проверенную. Для
переноса «новый → старый» старый файл нужно просто сохранить до перехода.
Не подставляйте чужой/старый хэш в новый экспорт ради обратной совместимости.

Checksum защищает от случайного повреждения и **не является** подписью: он
считается открытым алгоритмом и не заменяет проверку ABI.

## 5. localStorage: ключи, владельцы, миграция

Новый порт читает те же ключи, что и старая версия на том же origin, поэтому
при открытии с того же домена прогресс и Continue подхватываются автоматически.
Правила — как в старом `CampaignStore` (`web/saves/campaign-state.mjs`).

| Ключ | Кто пишет | Содержимое / поведение |
|---|---|---|
| `dune-sega-campaign-v1` | `CampaignStore.persist()` | `progress` v1 (см. §2.1); читается через `normalizeProgress` |
| `dune-sega-continue-v2` | `CampaignStore.writeContinue()`, `commitSaveFile` | Continue v2 (см. §2.2) — **единственный авторитетный слот**; `{version:2,state:null,savedAt:0}` = «надгробие» |
| `dune-sega-house-save-v1-0..2` | только старая версия | исторические слоты `{version:1,house,mission,state,savedAt}`; читаются один раз при миграции, **не удаляются** |
| `dune-original-aot-state-v2` | только старая версия | старый безымянный архив; **никогда не удаляется/не перезаписывается**, показывается через `store.legacy()` только пока нет настоящего Continue |
| `dune-sega-language-v1` | `GameLanguage.setLanguage()` (старая версия), `commitSaveFile` (импорт) | `'en'`/`'ru'`; в подсистеме сейвов продублирован как `LANGUAGE_KEY` (владелец — будущий `web/i18n.mjs`) |

Порядок инициализации `CampaignStore`:

1. прочитать и нормализовать `dune-sega-campaign-v1` (битые данные → свежий
   прогресс, ошибка в `store.error`);
2. если `dune-sega-continue-v2` существует — он главный, миграция слотов не
   выполняется;
3. иначе просмотреть три `dune-sega-house-save-v1-*`, выбрать самый свежий
   легитимный слот (`version 1`, совпадающий `house`, валидные миссия/state,
   `savedAt` новее даты прохождения этой миссии) и записать его в
   `dune-sega-continue-v2` (исходные слоты сохраняются);
4. если Continue нет, а `dune-original-aot-state-v2` есть — разрешить
   `store.legacy()` (не более чем до первого настоящего сохранения).

`commitSaveFile` (импорт файла) меняет три ключа — кампания, Continue, язык —
транзакционно: сначала читает старые значения, пишет все три, при ошибке
откатывает уже записанные и возвращает `storage-write-failed` (локальные
данные не пострадали) либо `storage-rollback-failed` (нужно сохранить
экспортированную копию). Память стора меняется только после успешной записи.
Возвращается `rollback()` для отката, если рантайм не смог принять нативный
снапшот; откат идемпотентен. Исторические ключи импорт не трогает.

## 6. Процедура переноса для пользователя

### Способ 1 — файл (работает между устройствами и браузерами)

1. В **старой** версии: `OPTIONS` → `FILES & OFFLINE` → `DOWNLOAD SAVE`.
   Получится `dune-<дата>.dune-save.json`.
2. В **новой** версии: раздел сохранений → выбрать файл → «Импортировать».
3. Проверить описание (дом, миссия, прогресс) и подтвердить замену. Импорт
   заменяет текущие сохранение и прогресс новой версии; старые ключи браузера
   не удаляются. Перед импортом можно экспортировать текущее состояние как
   резервную копию.
4. Миссия продолжится с того же места. Если в файле только прогресс без
   активного Continue — откроется главное меню.

Повреждённый/слишком большой/подменённый файл и файл другой сборки не меняют
текущие данные. Checksum проверяется до любых записей.

### Способ 2 — автоматически (тот же origin)

Если старая и новая версии открыты с одного origin (например,
`superoles-red.github.io`), `localStorage` общий: новый порт при старте сам
читает `dune-sega-campaign-v1` / `dune-sega-continue-v2` / исторические слоты и
показывает готовый прогресс. С другого адреса (локальный сервер, другой домен,
установленное приложение с иным origin) автоматический перенос не сработает —
используйте файл.

### Экспорт из новой версии

Тот же формат `dune-sega-web-save` v1 и тот же нативный `DSAV` v2. Файл
открывается новой версией на любом устройстве и совместим со старой по
payload/ABI, но **старая сборка отклонит его по `engineSha256`** (см. §4).

## 7. Коды ошибок (`SaveFileError.code`)

| Код | Когда |
|---|---|
| `no-store` | `createSaveFile` без стора |
| `too-large` | входной JSON/нативный payload больше лимита |
| `invalid-json` | файл не парсится как JSON |
| `invalid-format` | неверный набор/типы полей конверта, дата, язык |
| `wrong-game` | `format` не `dune-sega-web-save` |
| `incompatible-version` | `version` конверта не 1 |
| `incompatible-engine` | ABI-поля `compatibility` не совпали, неизвестный/испорченный `engineSha256` |
| `invalid-checksum` | checksum отсутствует или не в формате `sha256-<64 hex>` |
| `checksum-mismatch` | тело изменено/повреждено |
| `invalid-progress` | структура/согласованность `progress` |
| `invalid-continue` | структура/согласованность `continue` |
| `invalid-payload` | размер/base64/семантика нативного payload, house/mission вне диапазона, не активная миссия кампании |
| `incompatible-payload` | magic/version нативного потока не DSAV v2 |
| `mission-mismatch` | метки Continue не совпадают со словами кампании в payload |
| `unverified` | `commitSaveFile` получил архив, не прошедший `parseSaveFile` (или подделку объекта) |
| `storage-unavailable` | localStorage недоступен на чтение/запись |
| `storage-write-failed` | запись не удалась, старые данные восстановлены |
| `storage-rollback-failed` | запись и откат не удались — нужна резервная копия |
| `checksum-unavailable` | нет WebCrypto SHA-256 (не HTTPS/localhost в браузере) |

## 8. Тесты

Запуск (Node 24+, без внешних зависимостей):

```sh
node --test tests/saves/
# эквиваленты:
node --test                          # все тесты репозитория
npm run test:saves
```

30 тестов, 3 файла:

| Файл | Покрытие |
|---|---|
| `tests/saves/save-files.test.mjs` | синтетический DSAV v2 на смещениях ABI (включая абсолютные 49874/49326); контракт с `runtime/manifest.json` (`sizeof`/`ram_offset`/смещения/лимиты); отказы по magic/version/размеру/base64/house/mission; сборка старого конверта и успешный `parseSaveFile` + `commitSaveFile` в mock-storage; round-trip create→parse; все 13 старых `engineSha256`; идентичность нового экспорта; порча checksum, `format`/`version`; рассогласование прогресса/Continue; `unverified`; атомарность записи и `rollback()` |
| `tests/saves/campaign-state.test.mjs` | значения ключей localStorage; разблокировка миссий по домам; `normalizeProgress`; миграция старых слотов; `legacy()`; сохранение байтов исторических ключей; ошибки хранилища |
| `tests/saves/browser-files.test.mjs` | `downloadSave` (anchor + iOS share, отмена/фолбэк), `pickSaveFile` (выбор/отмена), `isAppleMobile` |

Фикстуры синтетические: `tests/saves/helpers.mjs` собирает нулевой буфер
`140056` байт с корректным заголовком и словами `house`/`mission`; файлы
сохранений собираются в памяти с подписью через `node:crypto`. Игровых данных
нет.

> **Каталог как аргумент `--test`:** рекурсивные шаблоны Node применяет только
> когда аргументов нет. Явный `tests/saves/` передаётся как путь модуля и
> разрешается через классический `index.js` каталога. Поэтому в
> `tests/saves/index.js` лежит шим, импортирующий все `*.test.mjs`: команда
> `node --test tests/saves/` работает, а `node --test` без аргументов находит
> сами тестовые файлы и шим не исполняет (дублей нет). При добавлении нового
> `*.test.mjs` добавьте импорт в шим. Проверено на Node 22.23.5 и Node 24.16.0.
> (Владельцу `package.json`/CI: команда `node --test tests/` с каталогом по той
> же причине не работает — используйте `node --test` или шаблон
> `node --test "tests/**/*.test.mjs"`.)

## 9. Отклонения от старого кода и открытые вопросы

Отклонения (всё остальное — построчный порт):

1. **Идентичность сборки.** Старый `SAVE_COMPATIBILITY` содержал хэш старого
   ядра; новый пишет идентичность нового порта, `engineSha256` — плейсхолдер
   `null` до фиксации WASM-ядра. Старый allowlist сохранён полностью.
2. **`null` в `engineSha256`** принимается (файлы, экспортированные новым портом
   до фиксации хэша). Остальные неизвестные хэши по-прежнему отклоняются.
3. **Совместимость односторонняя** (old → new); старый код не меняется, поэтому
   новый экспорт в нём не откроется. Текст `docs/MIGRATION.md` («экспорт из
   новой версии … открывается старой версией») этому не соответствует и должен
   быть поправлен владельцем документа.
4. **`LANGUAGE_KEY`** продублирован в `web/saves/campaign-state.mjs`, чтобы
   подсистема сейвов не зависела от загрузчика переводов. Когда появится
   `web/i18n.mjs`, значение должно остаться одним источником истины.
5. **`browser-files.mjs`**: зависимости (`navigator`/`document`/`URL`) можно
   подменять для тестов; таймер `revokeObjectURL` вызывает `.unref?.()` (в
   браузере это no-op), чтобы тесты не ждали 60 с. Логика скачивания/share —
   как в старом `downloadSave`.
6. **`tests/saves/index.js`** — совместимость с поведением `--test` при
   аргументе-каталоге (Node 22/24, см. §8).
7. **`NATIVE_SAVE_BASE_BYTES` = 140056** — подтверждено 2026-11-27 сборкой
   точной структуры `DuneSaveState` из pinned baseline (natural alignment, без
   `#pragma pack`): `sizeof == 140056`, `offsetof(ram) == 94`, house по
   абсолютному смещению 49874 (`94+0xC274`), mission — 49326 (`94+0xC050`).
   В коде это `NATIVE_HOUSE_OFFSET`/`NATIVE_MISSION_OFFSET`. Пинованный
   `vendor/.../dune_savestate.h` содержит `#pragma pack(push,1)` и даёт
   140027 — **не пересобирать структуру из него**, иначе старые сейвы перестанут
   открываться. Подробности и манифест: [RUNTIME.md](RUNTIME.md),
   `runtime/manifest.json` (`savestate`).

Открытые вопросы:

1. **Зафиксировать `NEW_ENGINE_SHA256`** после сборки WASM-ядра нового
   рантайма (см. §4). Пока экспорт пишет `null`.
2. ~~Гарантировать `sizeof(DuneSaveState) == 140056`~~ — **решено**: база 140056
   подтверждена компиляцией точной структуры из baseline; в `runtime/manifest.json`
   записаны `base_bytes`, `ram_offset`, `house_offset`, `mission_offset`.
   Новый билд обязан сохранить эти значения (статическая проверка при сборке).
3. ~~Версия ABI в vendor~~ — **решено**: `tools/prepare_source.py` нового репозитория
   применяет патч `DUNE_SAVESTATE_VERSION 2` и ограниченную проверку размеров при
   загрузке (как старая версия); `runtime/dune-runtime-v2.c` — именно эта сборка.
4. **Origin будущего хостинга:** автоматическая миграция localStorage возможна
   только на общем origin со старой игрой. Если новый порт будет на другом
   домене, остаётся файл; это стоит явно написать в пользовательской
   документации/MIGRATION.
5. **UI-обвязка:** `web/app.mjs` уже вызывает модули (`parseSaveFile`,
   `commitSaveFile({store,archive})`, `createSaveFile`, `downloadSave(file)`);
   API сохранено, но подтверждение импорта и обработка `rollback()` — на
   стороне оболочки.

## 10. Источники

- Старая версия: `Dune Sega Web/web/save-files.mjs`, `web/campaign-state.mjs`,
  `web/browser-features.mjs`, `web/i18n.mjs`, `docs/pwa-and-saves.md`,
  `tools/prepare_source.py`, `docs/wasm-build.json`.
- Пинованный заголовок ABI: `vendor/rearrakis/genesis_recompiler/dune_savestate.h`,
  `psg_state.h`, `eeprom_state.h`.
- Пинованный рантайм v2: `runtime/dune-runtime-v2.c` (`DuneSaveState`, exporter/
  loader сохранений) и `runtime/manifest.json` (`savestate` — machine-readable
  ABI: `base_bytes`, `ram_offset`, `house_offset`, `mission_offset`, лимиты),
  сборка/проверка — `tools/build_runtime.py`; предупреждение о
  `#pragma pack` — [RUNTIME.md](RUNTIME.md).
- Пользовательский сценарий старой версии: `Dune Sega Web/docs/pwa-and-saves.md`
  (§«Сохранить файл», §«Восстановить или перенести»).
