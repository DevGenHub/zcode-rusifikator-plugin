// ensure-ru.js — SessionStart-хук плагина zcode-rusifikator (v2, автофикс).
// Проверяет маркер перевода в app.asar. Если перевод слетел после обновления ZCode —
// тихо запускает авто-восстановление (сборка + окно перезапуска) и никогда не блокирует сеанс.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const AUTO_FIX = path.join(PLUGIN_ROOT, 'hooks', 'auto-fix.js');
const LOG = path.join(PLUGIN_ROOT, 'skills', 'rusifikator', 'assets', 'work', 'hook.log');

function asarPath() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(base, 'Programs', 'ZCode', 'resources', 'app.asar');
}

function hasMarker(file, marker) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 4 * 1024 * 1024;
    const OVERLAP = marker.length - 1;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0, carried = '';
    while (pos < size) {
      const read = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (read <= 0) break;
      const s = carried + buf.toString('latin1', 0, read);
      if (s.includes(marker)) return true;
      carried = s.slice(-OVERLAP);
      pos += read;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

function logToWork(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}

(function main() {
  try {
    const file = asarPath();
    if (!fs.existsSync(file)) return; // ZCode не найден — молча
    const res = hasMarker(file, 'rU9x=');
    if (res === true) {
      console.log('[rusifikator] ✅ Русский интерфейс ZCode активен.');
      return;
    }
    if (res === null) return;
    // перевод слетел — запускаем авто-восстановление в фоне
    fs.mkdirSync(path.dirname(AUTO_FIX), { recursive: true });
    logToWork('маркер не найден — запускаю авто-восстановление');
    const child = spawn(process.execPath, [AUTO_FIX], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    console.log('[rusifikator] 🛠 Русский интерфейс слетел после обновления ZCode — авто-восстановление запущено в фоне. Скоро появится окно перезапуска.');
  } catch { /* старт сеанса не блокируем никогда */ }
})();
