'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const isDev = !app.isPackaged;

// ---- Diagnostic logging (low-frequency events only) ----
// Log file: %APPDATA%/ratib-shghlk/ratib-debug.log
// يسجَّل فقط: بداية الجلسة + دورة حياة النوافذ الفرعية (طباعة/auth) وإعادة التركيز.
// أحداث focus/blur المتكررة أُزيلت بعد حل مشكلة فقدان التركيز — كانت مصدر معظم النمو.
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const LOG_KEEP_TAIL_BYTES = 64 * 1024; // عند التجاوز: نحتفظ بآخر 64KB فقط
let logFilePath = null;

// فحص لمرة واحدة عند أول كتابة: إن تجاوز الملف الحد، نقتطعه ونبقي ذيله الأخير
function initLogFile() {
  logFilePath = path.join(app.getPath('userData'), 'ratib-debug.log');
  try {
    const stat = fs.statSync(logFilePath);
    if (stat.size > LOG_MAX_BYTES) {
      const fd = fs.openSync(logFilePath, 'r');
      const tail = Buffer.alloc(LOG_KEEP_TAIL_BYTES);
      const bytesRead = fs.readSync(fd, tail, 0, LOG_KEEP_TAIL_BYTES, stat.size - LOG_KEEP_TAIL_BYTES);
      fs.closeSync(fd);
      fs.writeFileSync(
        logFilePath,
        `[${new Date().toISOString()}] log truncated (was ${stat.size} bytes)\n` +
        tail.subarray(0, bytesRead).toString('utf8')
      );
    }
  } catch { /* الملف غير موجود أو تعذّر الفحص — نتابع بشكل طبيعي */ }
}

function dbg(msg) {
  try {
    if (!logFilePath) initLogFile();
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* logging must never crash the app */ }
}

let localServer = null;
let localPort = null;

const PREFERRED_PORTS = [38473, 38474];

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript',
  '.mjs':   'application/javascript',
  '.css':   'text/css',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.webp':  'image/webp',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.json':  'application/json',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
};

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(port);
    });
  });
}

function startLocalServer() {
  const distDir = path.join(__dirname, '../dist');

  localServer = http.createServer((req, res) => {
    try {
      // 🔴 يُفكّ الترميز أولاً: بدونه يمرّ `%2e%2e%2f` كنصٍّ حرفي فلا يراه path.join
      //    محاولةَ صعود، ويُفحص مسارٌ غير الذي سيُقرأ فعلاً.
      let urlPath;
      try {
        urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
      } catch {
        res.writeHead(400); res.end('Bad request'); return;
      }
      // ⚠️ `let` لا `const`: سطر SPA fallback أدناه يُسنِد إليه. وجعلُه ثابتاً كان يرمي
      // TypeError يلتقطه catch الخارجي فيردّ 500 — أي **شاشة بيضاء** في نسخة سطح المكتب.
      let filePath = path.resolve(distDir, '.' + path.posix.normalize(urlPath));

      /**
       * 🔴 كان الفحص `filePath.startsWith(distDir)` — وهو مقارنة **نصّية** تمرّ على
       * مجلدٍ شقيق يبدأ بنفس الحروف: `…/dist-evil/x` يبدأ بـ`…/dist`.
       * والصحيح مقارنةٌ بحدّ فاصل المسار، أو تطابقُ المجلد نفسه.
       */
      const rootWithSep = distDir.endsWith(path.sep) ? distDir : distDir + path.sep;
      if (filePath !== distDir && !filePath.startsWith(rootWithSep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // SPA fallback: serve index.html for unknown paths so React Router handles them
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distDir, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error('[local-server] error:', err);
      res.writeHead(500);
      res.end('Internal server error');
    }
  });

  // Try each preferred port in order; fixed port keeps the origin stable across restarts
  return PREFERRED_PORTS.reduce(
    (chain, port) =>
      chain.catch(() => tryListen(localServer, port)),
    Promise.reject(new Error('start'))
  ).then(port => {
    localPort = port;
    console.log(`[local-server] listening on http://localhost:${localPort}`);
    return localPort;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.setMenuBarVisibility(false);

  if (isDev) {
    win.loadURL('http://localhost:3000');
  } else {
    win.loadURL(`http://localhost:${localPort}`);
  }

  // Restore focus to the main window whenever ANY child window (print/auth) closes.
  // Renderer-side window.focus() is not enough in Electron: it does not refocus the
  // BrowserWindow at the OS level, leaving all inputs without a caret until restart.
  win.webContents.on('did-create-window', (childWindow, details) => {
    dbg(`child-window created: ${details?.url || 'about:blank'}`);
    childWindow.on('closed', () => {
      dbg('child-window closed');
      if (!win.isDestroyed()) {
        win.focus();
        win.webContents.focus();
        dbg('refocus executed: win.focus() + webContents.focus()');
      } else {
        dbg('refocus skipped: main window destroyed');
      }
    });
  });

  // Auth popups must open inside Electron so window.opener is available for postMessage
  win.webContents.setWindowOpenHandler(({ url }) => {
    const isAuthPopup =
      url.includes('/__/auth/handler') ||
      url.startsWith('https://accounts.google.com/');

    // Allow about:blank popups (used for invoice print windows)
    const isPrintWindow = url === '' || url === 'about:blank';

    if (isAuthPopup || isPrintWindow) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900,
          height: 700,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  dbg('=== app ready — session start ===');
  if (!isDev) {
    try {
      await startLocalServer();
    } catch (err) {
      console.error('[local-server] failed to start:', err);
      app.quit();
      return;
    }
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (localServer) localServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
