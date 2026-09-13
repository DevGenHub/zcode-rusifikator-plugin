// auto-fix.js — оркестратор авто-восстановления (запускается детачем из ensure-ru.js).
// 1) сборка пропатченного asar (--build-only)  2) окно «Требуется перезапуск»  3) подмена + релонч
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(PLUGIN_ROOT, 'skills', 'rusifikator', 'assets', 'apply-russian.js');
const WORK = path.join(PLUGIN_ROOT, 'skills', 'rusifikator', 'assets', 'work');
const LOG = path.join(WORK, 'auto-fix.log');
const RES = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'resources');
const CURRENT = path.join(RES, 'app.asar');
const PATCHED = path.join(WORK, 'app.asar.patched');
const ZCODE_EXE = path.join(path.dirname(RES), 'ZCode.exe');

const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  try { fs.mkdirSync(WORK, { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log('[auto-fix]', ...a);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function verifyAsar(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const sb = Buffer.alloc(8);
    fs.readSync(fd, sb, 0, 8, 0);
    const hs = sb.readUInt32LE(4);
    const hb = Buffer.alloc(Math.min(hs, 32 * 1024 * 1024));
    fs.readSync(fd, hb, 0, hb.length, 8);
    fs.closeSync(fd);
    const header = JSON.parse(hb.slice(hb.indexOf(Buffer.from('{"files"'))).toString('utf8'));
    return !!(header && header.files && header.files.out);
  } catch { return false; }
}

function showDialog() {
  // PowerShell через -EncodedCommand: кириллица без проблем с кодировками
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    "$r = [System.Windows.Forms.MessageBox]::Show(" +
      "'Русификатор установлен: русский интерфейс готов.' + [char]10 + [char]10 +" +
      "'Требуется перезапуск ZCode. Убедитесь, что агент не выполняет задачу.' + [char]10 + [char]10 +" +
      "'Перезапустить сейчас?', 'ZCode Rusifikator', 'YesNo', 'Information', 'Button1')",
    '[Environment]::Exit([int]$r)',
  ].join('; ');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8' });
  return r.status; // 6 = Yes, 7 = No
}

function swap() {
  const backups = fs.readdirSync(RES).filter(f => /^app\.asar\.ru-backup/.test(f));
  const BACKUP = path.join(RES, backups[0] || 'app.asar.ru-backup-auto');
  // ждём снятия блокировки (ZCode уже закрывается)
  for (let i = 0; i < 30; i++) {
    try { fs.renameSync(CURRENT, BACKUP); break; } catch (e) { if (i === 29) throw e; sleep(1000); }
  }
  if (fs.statSync(PATCHED).size < 100 * 1024 * 1024) throw new Error('патченный файл подозрительно мал');
  fs.renameSync(PATCHED, CURRENT);
  if (!verifyAsar(CURRENT)) throw new Error('проверка после подмены не пройдена');
}

async function main() {
  log('старт авто-восстановления');
  // 1. сборка
  const build = spawnSync(process.execPath, [INSTALLER, '--build-only'], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (build.status !== 0 || !fs.existsSync(PATCHED)) {
    log('сборка не удалась:', (build.stdout || '').slice(-400), (build.stderr || '').slice(-400));
    return;
  }
  log('сборка готова');

  // 2. окно
  const answer = showDialog();
  log('ответ пользователя:', answer === 6 ? 'перезапустить сейчас' : 'позже');

  // 3. подмена
  if (answer === 6) {
    try {
      spawnSync('taskkill', ['/F', '/IM', 'ZCode.exe']);
      await sleep(1500);
      swap();
    } catch (e) { log('подмена не удалась:', e.message); return; }
  } else {
    // «Позже»: подмена при закрытии ZCode (старая схема помощника)
    let swapped = false;
    for (let i = 0; i < 3600; i++) {
      await sleep(1000);
      try {
        const b = fs.readdirSync(RES).filter(f => /^app\.asar\.ru-backup/.test(f));
        fs.renameSync(CURRENT, path.join(RES, b[0] || 'app.asar.ru-backup-later'));
        swapped = true; break;
      } catch {}
      if (!fs.existsSync(CURRENT)) { swapped = true; break; } // закрыли, но файл уже кто-то увёл
    }
    if (!swapped) { log('ZCode не закрыт за отведённое время — выходим'); return; }
    fs.renameSync(PATCHED, CURRENT);
    log('подменено в режиме «позже»');
  }

  // 4. перезапуск
  log('перезапускаю ZCode');
  const c = spawn(ZCODE_EXE, [], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  log('ZCode запущен (pid ' + c.pid + ') — русский интерфейс активен');
}

main().then(() => log('завершено')).catch(e => log('ОШИБКА:', e.message));
