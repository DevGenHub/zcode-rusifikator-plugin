// apply-russian.js — скилл «Русификатор»: накатывает русский перевод интерфейса на app.asar ZCode.
// Использование: node apply-russian.js [--asar <путь>] [--dry-run]
// Шаги: разбор asar -> инъекция ru-RU (патчи ниже) -> пересборка -> проверка целостности и синтаксиса ->
//       подмена (если файл занят запущенным приложением — ставит фоновый помощник и перезапустит ZCode после закрытия).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const ASAR = arg('--asar') || path.join(process.env.LOCALAPPDATA || 'C:/Users/Evgen/AppData/Local', 'Programs', 'ZCode', 'resources', 'app.asar');
const DRY = args.includes('--dry-run');
const BUILD_ONLY = args.includes('--build-only');
const HERE = __dirname;
const DICT_DIR = path.join(HERE, 'dict');
const WORK = path.join(HERE, 'work');
const log = (...a) => console.log('[ru]', ...a);
const fail = (m) => { console.error('[ru] ОШИБКА:', m); process.exit(1); };

const RES = path.dirname(ASAR);
const NEW = path.join(RES, 'app.asar.new');
const ZCODE_EXE = path.join(path.dirname(RES), 'ZCode.exe');
const OUT_ASAR = path.join(WORK, 'app.asar.patched');

fs.mkdirSync(WORK, { recursive: true });

// ---------- утилиты ----------
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function integrityOf(buf) {
  const blockSize = 4194304, blocks = [];
  for (let off = 0; off < buf.length; off += blockSize) blocks.push(sha256(buf.slice(off, Math.min(off + blockSize, buf.length))));
  return { algorithm: 'SHA256', hash: sha256(buf), blockSize, blocks };
}
const escapeTpl = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

// парсер каталогов: ключи в кавычках или «голые», значения в ` `" `' или литералах
function parseStringAt(src, i) {
  const q = src[i];
  if (q !== '`' && q !== '"' && q !== "'") return null;
  let j = i + 1, val = '';
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { val += src[j] + src[j + 1]; j += 2; continue; }
    if (ch === q) { j++; return { value: val, end: j, q }; }
    val += ch; j++;
  }
  return null;
}
function parseCatalogAt(src, objStart) {
  let i = objStart + 1; const entries = {}; const order = [];
  while (i < src.length) {
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (src[i] === '}') return { end: i + 1, entries, order };
    let key;
    if (src[i] === '"') {
      const k = parseStringAt(src, i);
      if (!k) return { error: 'badkey@' + i };
      key = k.value; i = k.end;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      if (!m) return { error: 'unexpected ' + src[i] + '@' + i };
      key = m[0]; i += m[0].length;
    }
    while (src[i] === ' ') i++;
    if (src[i] !== ':') return { error: 'exp:@' + i };
    i++;
    while (src[i] === ' ') i++;
    if (src[i] === '`' || src[i] === '"' || src[i] === "'") {
      const v = parseStringAt(src, i);
      if (!v) return { error: 'badval@' + i };
      entries[key] = { q: v.q, value: v.value }; if (!order.includes(key)) order.push(key);
      i = v.end;
    } else {
      let j = i; while (!/[,}]/.test(src[j])) j++;
      entries[key] = { q: 'lit', value: src.slice(i, j) }; if (!order.includes(key)) order.push(key);
      i = j;
    }
  }
  return { error: 'eof' };
}
const decodeTpl = v => v.replace(/\\(`|\$|\\)/g, '$1');

// ---------- чтение asar ----------
if (!fs.existsSync(ASAR)) fail('не найден ' + ASAR);
const buf = fs.readFileSync(ASAR);
const hs = buf.readUInt32LE(4);
const headerBuf = buf.slice(8, 8 + hs);
const jsonStart = headerBuf.indexOf(Buffer.from('{"files"'));
const header = JSON.parse(headerBuf.slice(jsonStart).toString('utf8'));
const dataStart = 8 + hs;
const files = [];
(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (val.files) walk(val, p);
    else if (val.link) { /* symlink */ }
    else files.push({ node: val, path: p, offset: Number(val.offset || 0), size: val.size || 0, unpacked: !!val.unpacked });
  }
})(header, '');
const byPath = new Map(files.map(f => [f.path, f]));
const readEntry = f => buf.slice(dataStart + f.offset, dataStart + f.offset + f.size);
log('asar:', ASAR, buf.length, 'байт; файлов:', files.length);

// уже русифицирован?
{
  const intl = files.find(f => /IntlProvider-.*\.js$/.test(f.path) && f.path.includes('renderer'));
  if (intl && readEntry(intl).toString('utf8').includes('"ru-RU"')) {
    log('app.asar уже содержит русскую локализацию — патч применён ранее. Ничего не делаю.');
    process.exit(0);
  }
}

// ---------- загрузка словарей ----------
if (!fs.existsSync(DICT_DIR)) fail('нет папки словарей ' + DICT_DIR);
const ru = {};
for (const f of fs.readdirSync(DICT_DIR).filter(f => f.endsWith('.json')).sort()) {
  Object.assign(ru, JSON.parse(fs.readFileSync(path.join(DICT_DIR, f), 'utf8')));
}
log('ключей в словарях:', Object.keys(ru).length);

// ---------- извлечение текущего en-каталога из IntlProvider ----------
const intlFile = files.find(f => /IntlProvider-.*\.js$/.test(f.path) && f.path.includes('renderer'));
if (!intlFile) fail('чанк IntlProvider не найден в asar (структура изменилась? см. SKILL.md «Рекогносцировка»)');
const intlText = readEntry(intlFile).toString('utf8');
const mapMatch = /(\w+)={"zh-CN":(\w+),"en-US":(\w+)}/.exec(intlText);
if (!mapMatch) fail('карта каталогов {"zh-CN":..,"en-US":..} не найдена в IntlProvider (см. SKILL.md «Рекогносцировка»)');
const [, mapVar, zhVar, enVar] = mapMatch;
function findCatalog(varName) {
  const re = new RegExp('(?:var|,)\\s*' + varName + '\\s*=\\{');
  const m = re.exec(intlText);
  if (!m) return null;
  const objStart = intlText.indexOf('{', m.index);
  const parsed = parseCatalogAt(intlText, objStart);
  if (parsed.error || parsed.order.length < 100) return null;
  return parsed;
}
const zhCat = findCatalog(zhVar), enCat = findCatalog(enVar);
if (!enCat) fail('каталог en (' + enVar + ') не извлечён');
log('en-каталог:', enCat.order.length, 'ключей; карта:', mapVar);

// покрытие словарём
const decodeVal = (q, v) => {
  if (q === '`') return decodeTpl(v);
  if (q === '"') { try { return JSON.parse('"' + v + '"'); } catch { return v; } }
  if (q === "'") return v.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  return v;
};
const missing = enCat.order.filter(k => !(k in ru));
if (missing.length) {
  const report = {};
  for (const k of missing) report[k] = decodeVal(enCat.entries[k].q, enCat.entries[k].value);
  fs.writeFileSync(path.join(WORK, 'missing-keys.json'), JSON.stringify(report, null, 1));
  fail(`для ${missing.length} ключей нет перевода — файл: ${path.join(WORK, 'missing-keys.json')}. Переведите значения, сохраните как dict/dict-new-NN.json и запустите снова.`);
}
const extras = Object.keys(ru).filter(k => !(k in enCat.entries));
const ruOrdered = [...enCat.order, ...extras];
const ruCatalogLiteral = '{' + ruOrdered.map(k => JSON.stringify(k) + ':`' + escapeTpl(ru[k]) + '`').join(',') + '}';
log('ru-каталог собран:', ruOrdered.length, 'ключей');

// ---------- патчи ----------
// Метки-заполнители в replace: {{RU_CATALOG}} {{RU_MENU}} {{RU_ABOUT}} {{RU_CUA}} {{RU_PM}}
const RU_MENU = {
  'titleBar.menu.file': 'Файл', 'titleBar.menu.edit': 'Правка', 'titleBar.menu.view': 'Вид',
  'titleBar.menu.window': 'Окно', 'titleBar.menu.help': 'Справка',
  'titleBar.menu.file.newTask': 'Новая задача', 'titleBar.menu.file.openWorkspace': 'Открыть рабочую область', 'titleBar.menu.file.closeWindow': 'Закрыть окно',
  'titleBar.menu.edit.undo': 'Отменить', 'titleBar.menu.edit.redo': 'Повторить', 'titleBar.menu.edit.cut': 'Вырезать',
  'titleBar.menu.edit.copy': 'Копировать', 'titleBar.menu.edit.paste': 'Вставить', 'titleBar.menu.edit.delete': 'Удалить', 'titleBar.menu.edit.selectAll': 'Выделить всё',
  'titleBar.menu.view.toggleFullScreen': 'Переключить полноэкранный режим', 'titleBar.menu.view.actualSize': 'Реальный размер',
  'titleBar.menu.view.zoomIn': 'Увеличить', 'titleBar.menu.view.zoomOut': 'Уменьшить',
  'titleBar.menu.window.minimize': 'Свернуть', 'titleBar.menu.window.zoom': 'Масштаб', 'titleBar.menu.window.bringAllToFront': 'Все окна вперёд',
  'titleBar.menu.app.services': 'Службы', 'titleBar.menu.app.hide': 'Скрыть {appName}', 'titleBar.menu.app.hideOthers': 'Скрыть остальные',
  'titleBar.menu.app.showAll': 'Показать все', 'titleBar.menu.app.quit': 'Завершить {appName}',
  'titleBar.menu.help.about': 'О ZCode', 'titleBar.menu.help.whatsNew': 'Что нового', 'titleBar.menu.help.checkForUpdates': 'Проверить обновления',
  'titleBar.menu.help.toggleDevTools': 'Инструменты разработчика', 'titleBar.menu.help.processMonitor': 'Монитор процессов',
  'titleBar.menu.help.toggleZCodeStdioTap': 'Захват stdio-трафика агента', 'titleBar.menu.help.zcodeEndpoint': 'ZCode Endpoint',
  'titleBar.menu.help.zcodeEndpoint.production': 'Production (по умолчанию)', 'titleBar.menu.help.zcodeEndpoint.test': 'Test',
  'titleBar.menu.help.zcodeEndpoint.custom': 'Свой...', 'titleBar.menu.help.zcodeEndpoint.reset': 'Вернуть по умолчанию',
  'titleBar.menu.help.startPerformanceRecording': 'Начать запись производительности', 'titleBar.menu.help.stopPerformanceRecording': 'Остановить запись производительности',
  'titleBar.menu.help.feedback': 'Обратная связь', 'titleBar.menu.help.exportLogs': 'Экспортировать журналы', 'titleBar.menu.help.clearAllData': 'Очистить все данные',
  'desktopMenu.help.checkingForUpdates': 'Проверка обновлений...', 'desktopMenu.help.updateAvailableVersion': 'Доступно обновление {version}',
  'desktopMenu.help.downloadingUpdateVersion': 'Загрузка обновления {version}...', 'desktopMenu.help.downloadingUpdateProgress': 'Загрузка обновления... {progress}',
  'desktopMenu.help.restartToUpdate': 'Перезапустить для обновления ({version})',
  'dock.menu.showCurrentWindow': 'Показать текущее окно', 'tray.tooltip': 'ZCode', 'tray.menu.openZCode': 'Открыть ZCode', 'tray.menu.quit': 'Выход',
};
const lit = o => '{' + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',') + '}';

const PATCHES = [
  {
    file: { kind: 'intl' },
    patches: [
      { name: 'ru-каталог+карта', find: 'g={"zh-CN":p,"en-US":m}', replace: 'rU9x={{RU_CATALOG}},g={"zh-CN":p,"en-US":m,"ru-RU":rU9x}', expect: 1 },
      { name: 'валидатор-y', find: 'function y(e){return e===`zh-CN`||e===`en-US`}', replace: 'function y(e){return e===`zh-CN`||e===`en-US`||e===`ru-RU`}', expect: 1 },
      { name: 'системный-резолвер', find: 'e.toLowerCase().startsWith(`zh`)?`zh-CN`:`en-US`', replace: 'e.toLowerCase().startsWith(`zh`)?`zh-CN`:e.toLowerCase().startsWith(`ru`)?`ru-RU`:`en-US`', expect: 1 },
      { name: 'фолбэк-формат-сообщений', find: 'function w(e){let t=g[e]??g[`zh-CN`];return{formatMessage({id:e},n){let r=t[e]??e;', replace: 'function w(e){let t=g[e]??g[`en-US`];return{formatMessage({id:e},n){let r=t[e]??(g[`en-US`]??t)[e]??e;', expect: 1 },
      { name: 'метки-языка-en', find: ',m={"manualClaimPlan.banner.aria":`Claimable trial plan`', replace: ',m={"settings.locale.ru-RU":"Русский","sidebar.settings.locale.ru-RU":"Русский","manualClaimPlan.banner.aria":`Claimable trial plan`', expect: 1 },
      { name: 'метки-языка-zh', find: 'var p={"manualClaimPlan.banner.aria":', replace: 'var p={"settings.locale.ru-RU":"Русский","sidebar.settings.locale.ru-RU":"Русский","manualClaimPlan.banner.aria":', expect: 1 },
    ],
  },
  {
    file: { kind: 'styles' },
    patches: [
      { name: 'дропдаун-настроек', find: '(0,$.jsx)(En,{value:`zh-CN`,"data-testid":Xi(aa,`zh-CN`),children:he.formatMessage({id:`settings.locale.zh-CN`})}),(0,$.jsx)(En,{value:`en-US`,"data-testid":Xi(aa,`en-US`),children:he.formatMessage({id:`settings.locale.en-US`})})', replace: '(0,$.jsx)(En,{value:`zh-CN`,"data-testid":Xi(aa,`zh-CN`),children:he.formatMessage({id:`settings.locale.zh-CN`})}),(0,$.jsx)(En,{value:`en-US`,"data-testid":Xi(aa,`en-US`),children:he.formatMessage({id:`settings.locale.en-US`})}),(0,$.jsx)(En,{value:`ru-RU`,"data-testid":Xi(aa,`ru-RU`),children:he.formatMessage({id:`settings.locale.ru-RU`})})', expect: 1 },
      { name: 'дропдаун-сайдбара', find: '(0,$.jsx)(Pe,{value:`zh-CN`,children:v.formatMessage({id:`sidebar.settings.locale.zh-CN`})})', replace: '(0,$.jsx)(Pe,{value:`zh-CN`,children:v.formatMessage({id:`sidebar.settings.locale.zh-CN`})}),(0,$.jsx)(Pe,{value:`ru-RU`,children:v.formatMessage({id:`sidebar.settings.locale.ru-RU`})})', expect: 1 },
      { name: 'гард-настроек', find: '(e===`zh-CN`||e===`en-US`)&&SO({input:{featureId:`settings.locale`', replace: '(e===`zh-CN`||e===`en-US`||e===`ru-RU`)&&SO({input:{featureId:`settings.locale`', expect: 1 },
      { name: 'гард-сайдбара', find: '(e===`zh-CN`||e===`en-US`)&&W(e)', replace: '(e===`zh-CN`||e===`en-US`||e===`ru-RU`)&&W(e)', expect: 1 },
      { name: 'нормализатор-локали', find: 'function Qdt(e){return e===`en-US`?`en-US`:`zh-CN`}', replace: 'function Qdt(e){return e===`ru-RU`?`ru-RU`:e===`en-US`?`en-US`:`zh-CN`}', expect: 1 },
      { name: 'подпись-локали', find: 't.formatMessage({id:e===`en-US`?`settings.locale.en-US`:`settings.locale.zh-CN`})', replace: 't.formatMessage({id:e===`en-US`?`settings.locale.en-US`:e===`ru-RU`?`settings.locale.ru-RU`:`settings.locale.zh-CN`})', expect: 1 },
    ],
  },
  {
    file: { kind: 'contains', re: /out\/main\/chunk-.*\.js$/, find: '"tray.menu.quit":"Quit"' },
    patches: [
      { name: 'каталог-меню', find: '"tray.menu.quit":"Quit"}};function by(t,n){return(pp[t]??pp[Yr])[n]}', replace: '"tray.menu.quit":"Quit"},"ru-RU":{{RU_MENU}}};function by(t,n){return(pp[t]??pp[Yr])[n]}', expect: 1 },
      { name: 'enum-locale', find: '.enum(["zh-CN","en-US"])', replace: '.enum(["zh-CN","en-US","ru-RU"])', expect: 1 },
      { name: 'enum-preference', find: '.enum(["system","zh-CN","en-US"])', replace: '.enum(["system","zh-CN","en-US","ru-RU"])', expect: 1 },
    ],
  },
  {
    file: { kind: 'regex', re: /out\/main\/index\.js$/ },
    patches: [
      { name: 'диалог-о-программе', find: '"copyright")}};function xt(e){if(typeof e!="string")', replace: '"copyright")},"ru-RU":{aboutTitle:"О ZCode",versionLabel:"версия",okButtonLabel:"ОК",optimizedForAppleSilicon:"Оптимизировано для Apple Silicon.",copyright:s(e=>`Copyright © ${e} ZCode.`,"copyright")}};function xt(e){if(typeof e!="string")', expect: 1 },
      { name: 'shell-меню-открыть', find: ',"en-US":"Open in ZCode"}', replace: ',"en-US":"Open in ZCode","ru-RU":"Открыть в ZCode"}', expect: 2 },
    ],
  },
  {
    file: { kind: 'regex', re: /out\/renderer\/assets\/cua-permission-panel-.*\.js$/ },
    patches: [
      { name: 'панель-разрешений-cua', find: 'screen_recording:`Screen Recording`}};function t(t,n){let r=e[t];', replace: 'screen_recording:`Screen Recording`},"ru-RU":{documentTitle:`Разрешения ZCode Computer Use`,dragTitle:`Перетащите меня в список разрешений выше`,hintPrefix:`Перетащите значок слева в список `,hintSuffix:` выше`,completion:`Отпустите, чтобы выдать доступ. Переключатель менять не нужно`,accessibility:`Универсальный доступ`,screen_recording:`Запись экрана`}};function t(t,n){let r=e[t];', expect: 1 },
    ],
  },
  {
    file: { kind: 'regex', re: /out\/renderer\/assets\/process-monitor-.*\.js$/ },
    patches: [
      { name: 'монитор-процессов', find: 'unavailable:`Process monitor bridge is unavailable`}};', replace: 'unavailable:`Process monitor bridge is unavailable`},"ru-RU":{title:`Монитор процессов`,process:`Процесс`,pid:`PID`,cpu:`ЦП`,memory:`Память`,processCount:e=>`${e} процессов`,loading:`Чтение метрик процессов...`,unavailable:`Мост монитора процессов недоступен`}};', expect: 1 },
    ],
  },
  {
    file: { kind: 'contains', re: /out\/host\/.*\.js$/, find: '.enum(["zh-CN","en-US"])' },
    patches: [
      { name: 'enum-locale', find: '.enum(["zh-CN","en-US"])', replace: '.enum(["zh-CN","en-US","ru-RU"])', expect: 1 },
      { name: 'enum-preference', find: '.enum(["system","zh-CN","en-US"])', replace: '.enum(["system","zh-CN","en-US","ru-RU"])', expect: 1 },
    ],
    optional: true,
  },
  {
    file: { kind: 'contains', re: /out\/scheduler\/.*\.js$/, find: '.enum(["zh-CN","en-US"])' },
    patches: [
      { name: 'enum-locale', find: '.enum(["zh-CN","en-US"])', replace: '.enum(["zh-CN","en-US","ru-RU"])', expect: 1 },
      { name: 'enum-preference', find: '.enum(["system","zh-CN","en-US"])', replace: '.enum(["system","zh-CN","en-US","ru-RU"])', expect: 1 },
    ],
    optional: true,
  },
];

function resolveTarget(spec) {
  if (spec.kind === 'intl') return intlFile.path;
  if (spec.kind === 'styles') {
    const f = files.find(f => /styles-.*\.js$/.test(f.path) && f.path.includes('renderer'));
    return f ? f.path : null;
  }
  if (spec.kind === 'contains') {
    const cand = files.filter(f => spec.re.test(f.path));
    const hit = cand.find(f => readEntry(f).toString('utf8').includes(spec.find));
    return hit ? hit.path : null;
  }
  if (spec.kind === 'regex') {
    const f = files.find(f => spec.re.test(f.path));
    return f ? f.path : null;
  }
  return null;
}

const newContents = new Map();
let applied = 0, skippedGroups = [];
for (const group of PATCHES) {
  const target = resolveTarget(group.file);
  if (!target) {
    if (group.optional) { skippedGroups.push(group.file.kind + ': цель не найдена (необязательно)'); continue; }
    fail('цель патча не найдена: ' + JSON.stringify(group.file));
  }
  const f = byPath.get(target);
  let text = (newContents.get(target) || readEntry(f)).toString('utf8');
  for (const p of group.patches) {
    const replace = p.replace
      .replace('{{RU_CATALOG}}', () => ruCatalogLiteral)
      .replace('{{RU_MENU}}', () => lit(RU_MENU))
      .replace('{{RU_ABOUT}}', '')
      .replace('{{RU_CUA}}', '')
      .replace('{{RU_PM}}', '');
    const count = text.split(p.find).length - 1;
    if (count !== p.expect) {
      if (group.optional && count === 0) { skippedGroups.push(target + ' :: ' + p.name + ' (якорь не найден, пропущено)'); continue; }
      fail(`патч «${p.name}» в ${target}: ожидалось ${p.expect} вхождений, найдено ${count}. Якоря устарели — см. SKILL.md «Рекогносцировка».`);
    }
    text = text.split(p.find).join(replace);
    log('  ok:', target, '::', p.name);
    applied++;
  }
  newContents.set(target, Buffer.from(text, 'utf8'));
}
if (skippedGroups.length) log('пропущено (необязательное):', JSON.stringify(skippedGroups));
log('патчей применено:', applied);

// ---------- пересборка asar ----------
let cursor = 0;
for (const f of files) {
  const nb = newContents.get(f.path);
  if (f.unpacked) { if (!f.node.offset) f.node.offset = '0'; continue; }
  if (f.size === 0) { f.node.offset = '0'; continue; }
  const content = nb || readEntry(f);
  f.newContent = content;
  f.node.offset = String(cursor);
  f.node.size = content.length;
  f.node.integrity = integrityOf(content);
  cursor += content.length;
}
const newHeaderStr = JSON.stringify(header);
const jsonLen = Buffer.byteLength(newHeaderStr, 'utf8');
if (DRY) { log('--dry-run: сборка пропущена'); process.exit(0); }
const out = fs.openSync(OUT_ASAR, 'w');
const pre = Buffer.alloc(8);
pre.writeUInt32LE(4, 0); pre.writeUInt32LE(jsonLen + 8, 4);
fs.writeSync(out, pre);
const hdr = Buffer.alloc(8);
hdr.writeUInt32LE(jsonLen + 4, 0); hdr.writeUInt32LE(jsonLen, 4);
fs.writeSync(out, hdr);
fs.writeSync(out, Buffer.from(newHeaderStr, 'utf8'));
for (const f of files) {
  if (f.unpacked || f.size === 0) continue;
  fs.writeSync(out, f.newContent || buf.slice(dataStart + f.offset, dataStart + f.offset + f.size));
}
fs.closeSync(out);
log('собрано:', OUT_ASAR, fs.statSync(OUT_ASAR).size, 'байт');

// ---------- проверка ----------
const vbuf = fs.readFileSync(OUT_ASAR);
const vhs = vbuf.readUInt32LE(4);
const vhdr = vbuf.slice(8, 8 + vhs);
const vheader = JSON.parse(vhdr.slice(vhdr.indexOf(Buffer.from('{"files"'))).toString('utf8'));
const vds = 8 + vhs;
const vfiles = [];
(function walk2(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (val.files) walk2(val, p);
    else if (val.link) { /* symlink */ }
    else vfiles.push({ node: val, path: p, offset: Number(val.offset || 0), size: val.size || 0, unpacked: !!val.unpacked });
  }
})(vheader, '');
if (vfiles.length !== files.length) fail('число файлов в заголовке не совпало');
let mismatches = 0;
for (const vf of vfiles) {
  if (vf.unpacked || vf.size === 0) continue;
  const of_ = byPath.get(vf.path);
  const nb = newContents.get(vf.path);
  const actual = vbuf.slice(vds + vf.offset, vds + vf.offset + vf.size);
  const expected = nb || buf.slice(dataStart + of_.offset, dataStart + of_.offset + of_.size);
  if (!actual.equals(expected)) { mismatches++; log('НЕСОВПАДЕНИЕ:', vf.path); }
}
if (mismatches) fail('проверка целостности не пройдена: ' + mismatches);
for (const p of newContents.keys()) {
  const vf = vfiles.find(x => x.path === p);
  if (!vbuf.slice(vds + vf.offset, vds + vf.offset + vf.size).toString('utf8').includes('ru-RU')) fail('нет метки ru-RU в ' + p);
}
log('целостность: OK');

// синтаксическая проверка патченных чанков (ESM import: ошибки синтаксиса ловим до ошибки модулей)
(async () => {
  for (const p of newContents.keys()) {
    const vf = vfiles.find(x => x.path === p);
    const text = vbuf.slice(vds + vf.offset, vds + vf.offset + vf.size).toString('utf8');
    const tmp = path.join(os.tmpdir(), 'ru-check-' + Date.now() + '.mjs');
    fs.writeFileSync(tmp, text);
    try {
      await import('file:///' + tmp.replace(/\\/g, '/'));
      log('синтаксис: OK (загрузился?!):', p);
    } catch (e) {
      if (e instanceof SyntaxError) fail('СИНТАКСИЧЕСКАЯ ОШИБКА в ' + p + ': ' + e.message);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  log('синтаксис всех патченных файлов: OK');
  if (BUILD_ONLY) { log('--build-only: сборка завершена, установка не выполнялась'); process.exit(0); }
  install();
})().catch(e => fail(e.message));

// ---------- установка ----------
function install() {
  const free = fs.statfsSync(RES);
  if ((free.bsize * free.bfree) / 1024 ** 3 < 1) fail('меньше 1 ГБ свободного места');
  fs.copyFileSync(OUT_ASAR, NEW);
  const backupCandidates = fs.readdirSync(RES).filter(f => /^app\.asar\.ru-backup/.test(f));
  try {
    fs.renameSync(ASAR, path.join(RES, backupCandidates[0] || 'app.asar.ru-backup-' + new Date().toISOString().slice(0, 10)));
  } catch (e) {
    // файл занят запущенным приложением — ставим фонового помощника
    log('app.asar занят (приложение запущено) — ставлю фонового помощника, он подменит файл после закрытия ZCode и перезапустит приложение.');
    installViaHelper();
    return;
  }
  fs.renameSync(NEW, ASAR);
  verifyInstalled();
  log('ГОТОВО: русифицированный app.asar установлен. Перезапустите ZCode.');
}
function verifyInstalled() {
  const b = fs.readFileSync(ASAR);
  const h = JSON.parse(b.slice(8, 8 + b.readUInt32LE(4)).slice(b.slice(8, 8 + b.readUInt32LE(4)).indexOf(Buffer.from('{"files"'))).toString('utf8'));
  let intl = null;
  (function w(n, p) { for (const [k, v] of Object.entries(n.files || {})) { const q = p ? p + '/' + k : k; if (v.files) w(v, q); else if (/IntlProvider-.*\.js$/.test(q)) intl = v; } })(h, '');
  const t = b.slice(8 + b.readUInt32LE(4) + Number(intl.offset), 8 + b.readUInt32LE(4) + Number(intl.offset) + intl.size).toString('utf8');
  if (!t.includes('"ru-RU"')) fail('проверка установленного файла не пройдена');
}
function installViaHelper() {
  const helperDir = path.join(RES, 'ru-apply');
  fs.mkdirSync(helperDir, { recursive: true });
  const helperJs = path.join(helperDir, 'apply-when-closed.js');
  const helperSrc = `// Автосгенерировано скиллом «Русификатор»
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const DIR=__dirname,RES=path.dirname(DIR),LOG=path.join(DIR,'apply.log');
const CURRENT=path.join(RES,'app.asar'),NEW=path.join(RES,'app.asar.new'),ZEXE=path.join(path.dirname(RES),'ZCode.exe');
const TIMEOUT=3*60*60*1000;
function log(m){try{fs.appendFileSync(LOG,new Date().toISOString()+' '+m+'\\n');}catch{}console.log(m);}
function verify(f){const fd=fs.openSync(f,'r');try{const sb=Buffer.alloc(8);fs.readSync(fd,sb,0,8,0);const hs=sb.readUInt32LE(4);const hb=Buffer.alloc(Math.min(hs,64*1024*1024));fs.readSync(fd,hb,0,hb.length,8);return JSON.parse(hb.slice(hb.indexOf(Buffer.from('{"files"'))).toString('utf8')).files.out?'ok':'bad';}finally{fs.closeSync(fd);}}
const backups=fs.readdirSync(RES).filter(f=>/^app\\.asar\\.ru-backup/.test(f));
const BACKUP=path.join(RES,backups[0]||'app.asar.ru-backup-'+new Date().toISOString().slice(0,10));
log('helper: жду закрытия ZCode...');
const start=Date.now();let moved=false;
while(Date.now()-start<TIMEOUT){
  try{fs.renameSync(CURRENT,BACKUP);moved=true;break;}
  catch(e){}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);
}
if(!moved){log('helper: таймаут — ничего не изменено');process.exit(0);}
try{
  if(fs.statSync(NEW).size<100*1024*1024)throw new Error('файл слишком мал');
  fs.renameSync(NEW,CURRENT);
  if(verify(CURRENT)!=='ok')throw new Error('проверка не пройдена');
  log('helper: русифицированный app.asar установлен');
  log('helper: перезапускаю ZCode...');
  const c=spawn(ZEXE,[],{detached:true,stdio:'ignore',windowsHide:true});c.unref();
  log('helper: ZCode запущен (pid '+c.pid+')');
}catch(e){
  log('helper: ОШИБКА '+e.message+' — откат');
  try{if(!fs.existsSync(CURRENT))fs.renameSync(BACKUP,CURRENT);}catch(e2){log('helper: откат не удался: '+e2.message);}
}
`;
  fs.writeFileSync(helperJs, helperSrc);
  const bat = '@echo off\r\nchcp 65001 >nul\r\necho === ZCode Russian UI rollback ===\r\npause\r\ntaskkill /im ZCode.exe /f 2>nul\r\ntimeout /t 2 /nobreak >nul\r\nfor %%f in ("%~dp0..\\app.asar.ru-backup-*") do set B=%%f\r\nif "%B%"=="" (echo ERROR: backup not found & pause & exit /b 1)\r\ncopy /b /y "%B%" "%~dp0..\\app.asar"\r\necho Rollback complete.\r\npause\r\n';
  fs.writeFileSync(path.join(helperDir, 'rollback-russian.bat'), bat);
  const node = process.execPath.includes('node.exe') ? process.execPath : 'C:/Program Files/nodejs/node.exe';
  if (!fs.existsSync(node)) fail('node.exe не найден для фонового помощника');
  const { spawn } = require('child_process');
  const child = spawn(node, [helperJs], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  log('помощник запущен (pid ' + child.pid + '), журнал: ' + path.join(helperDir, 'apply.log'));
  log('Теперь закройте ZCode (значок в трее → Выход) — приложение перезапустится уже с русским интерфейсом.');
}
