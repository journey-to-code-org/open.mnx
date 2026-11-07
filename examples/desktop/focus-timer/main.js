// The main process: a sandboxed window, sessions saved as JSON in the user's data folder, a
// notification when a session ends, and the running state in the window's title.
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.FOCUS_DATA) app.setPath('userData', process.env.FOCUS_DATA);
const file = () => join(app.getPath('userData'), 'focus.json');

function load() {
  try {
    return { sessions: [], lengths: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    return { sessions: [], lengths: {} };
  }
}
function save(data) {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(data, null, 2));
}

ipcMain.handle('focus:load', () => load());
ipcMain.handle('focus:finished', (event, session) => {
  const data = load();
  data.sessions = [...data.sessions, session].slice(-500);
  save(data);
  globalThis.notified = (globalThis.notified ?? 0) + 1;
  if (Notification.isSupported()) {
    new Notification({ title: session.mode === 'focus' ? 'Session done' : 'Break over', body: session.task || 'Time for the next one.' }).show();
  }
});
ipcMain.on('focus:running', (event, running) => {
  BrowserWindow.fromWebContents(event.sender)?.setTitle(running ? 'Focus (running)' : 'Focus');
});

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 440,
    height: 720,
    title: 'Focus',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.loadFile(join(here, 'dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
