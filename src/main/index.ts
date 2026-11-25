import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixPath } from '../core/env';
import { markStay, prFromAppUrl } from '../shared/prInput';
import { checkForUpdate, currentVersion } from './updates';
import { appTheme, DEFAULT_APP_THEME } from '../shared/themes';
import { registerIpc } from './ipc';
import { SessionRegistry, userDataSubdir } from './sessions';

let registry: SessionRegistry | undefined;
let windowBackground = appTheme(DEFAULT_APP_THEME).background;

/** Context menus and the window background before the page paints follow the app theme. */
function applyAppTheme(id: string): void {
  const theme = appTheme(id);
  nativeTheme.themeSource = theme.kind;
  windowBackground = theme.background;
  for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(theme.background);
}

if (process.env.PR_REVIEW_USER_DATA) app.setPath('userData', process.env.PR_REVIEW_USER_DATA);

/** Pop-out windows show one PR; links always go to the main window. */
const popOuts = new WeakSet<BrowserWindow>();
/** PR links (prreview://) that arrived before a window's page was listening, e.g. the link that launched the app. */
const pendingLinks: string[] = [];
/** Pages that asked for pending links, so they are listening for new ones too. */
const linkReady = new Set<number>();
/** Set once startup has opened the main window; before that a link only waits for it. */
let started = false;

const mainWindow = () => BrowserWindow.getAllWindows().find((w) => !popOuts.has(w));

/** The Chrome extension's folder: shipped next to the app's resources, or in the repo when running from source. */
/** Chromium browsers that can load the unpacked extension, and their extensions page. */
const BROWSERS = [
  { name: 'Chrome', app: 'Google Chrome', page: 'chrome://extensions' },
  { name: 'Edge', app: 'Microsoft Edge', page: 'edge://extensions' },
  { name: 'Brave', app: 'Brave Browser', page: 'brave://extensions' },
];

async function installedBrowsers(): Promise<{ name: string; page: string }[]> {
  const found = [];
  for (const b of BROWSERS) {
    const paths = [join('/Applications', `${b.app}.app`), join(app.getPath('home'), 'Applications', `${b.app}.app`)];
    if ((await Promise.all(paths.map((p) => stat(p).then(() => true, () => false)))).some(Boolean)) found.push({ name: b.name, page: b.page });
  }
  return found;
}

/**
 * Asks the browser to open its extensions page. Other apps can't open chrome:// addresses themselves, and a browser
 * may still ignore one handed to it, so the page also copies the address for pasting.
 */
function openExtensionsPage(page: string): Promise<boolean> {
  const browser = BROWSERS.find((b) => b.page === page);
  if (!browser) return Promise.resolve(false);
  return new Promise((resolve) => execFile('open', ['-a', browser.app, page], (err) => resolve(!err)));
}

function browserExtensionDir(): string {
  // From source the main bundle is out/main/index.js, two levels below the repo.
  return app.isPackaged ? join(process.resourcesPath, 'browser-extension') : join(import.meta.dirname, '../../browser-extension');
}

function bringToFront(win: BrowserWindow): void {
  if (process.env.PR_REVIEW_HIDDEN_WINDOWS) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

function createWindow(popOutKey?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: 'PR Review',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: windowBackground,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A hidden window must still paint, for screenshots in automated runs.
      backgroundThrottling: !process.env.PR_REVIEW_HIDDEN_WINDOWS,
    },
  });
  // Automated runs (PR_REVIEW_HIDDEN_WINDOWS) keep their windows off screen instead of popping up over yours.
  if (!process.env.PR_REVIEW_HIDDEN_WINDOWS) win.once('ready-to-show', () => win.show());
  if (popOutKey) popOuts.add(win);
  const id = win.webContents.id;
  // A reload or a closed window stops listening until its page asks again.
  win.webContents.on('did-navigate', () => linkReady.delete(id));
  win.on('closed', () => linkReady.delete(id));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(markStay(url));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost')) event.preventDefault();
  });
  const hash = popOutKey ? `pr=${encodeURIComponent(popOutKey)}` : '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), hash ? { hash } : {});
  return win;
}

/** Opens the PR a prreview:// link points at in the main window, or keeps it until that window's page is listening. */
function openFromUrl(url: string): void {
  const input = prFromAppUrl(url);
  if (!input) return;
  const win = mainWindow();
  if (win && linkReady.has(win.webContents.id)) {
    win.webContents.send('open-pr', input);
    bringToFront(win);
    return;
  }
  pendingLinks.push(input);
  // macOS keeps the app running without windows: open one, and its page collects the link.
  if (!win && started) createWindow();
}

ipcMain.handle('links:take', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || popOuts.has(win)) return [];
  linkReady.add(event.sender.id);
  if (pendingLinks.length > 0) bringToFront(win);
  return pendingLinks.splice(0);
});

// Only the installed app with the normal profile claims prreview://. Dev and test runs (plain Electron, or another
// profile through PR_REVIEW_USER_DATA) would otherwise take the scheme over from it.
if (app.isPackaged && !process.env.PR_REVIEW_USER_DATA) app.setAsDefaultProtocolClient('prreview');
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (app.isReady()) openFromUrl(url);
  else void app.whenReady().then(() => openFromUrl(url));
});

/** The menu's "Check for Updates…": the answer as a dialog, with a way to the download when there's a newer version. */
async function checkForUpdatesNow(): Promise<void> {
  const info = await checkForUpdate();
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const show = (options: Electron.MessageBoxOptions) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  if (info.error) {
    await show({ type: 'warning', message: "Couldn't check for updates", detail: info.error });
  } else if (info.available && info.url) {
    const { response } = await show({ type: 'info', message: `PR Review ${info.latest} is available`, detail: `You have ${info.current}.`, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1 });
    if (response === 0) await shell.openExternal(info.url);
  } else {
    await show({ type: 'info', message: "You're up to date", detail: `PR Review ${info.current} is the latest version.` });
  }
}

function buildMenu(): void {
  const send = (channel: string) => () => (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send('menu', channel);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { label: 'Check for Updates…', click: () => void checkForUpdatesNow() },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('new-tab') },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
          { type: 'separator' },
          { label: 'Refresh Pull Request', accelerator: 'CmdOrCtrl+R', click: send('refresh') },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('find') },
          { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: send('find-next') },
          { label: 'Find Previous', accelerator: 'Shift+CmdOrCtrl+G', click: send('find-previous') },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Toggle File Tree', accelerator: 'CmdOrCtrl+B', click: send('toggle-tree') },
          { label: 'Toggle Conversations', accelerator: 'CmdOrCtrl+Shift+C', click: send('toggle-conversations') },
          { label: 'Toggle Agent Panel', accelerator: 'CmdOrCtrl+Shift+A', click: send('toggle-agent') },
          { label: 'Toggle Word Wrap', accelerator: 'Alt+Z', click: send('toggle-word-wrap') },
          { type: 'separator' },
          { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: send('find-in-files') },
          { label: 'Show Files', accelerator: 'CmdOrCtrl+Shift+E', click: send('show-files') },
          { type: 'separator' },
          { role: 'toggleDevTools' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

void app.whenReady().then(async () => {
  await fixPath();
  registry = new SessionRegistry({
    userDataDir: userDataSubdir(app.getPath('userData')),
    emit: (event) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('pr:event', event);
    },
    pickFolder: async (title) => {
      const res = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    // Pull request links the app sends to the browser are marked, so the Chrome extension leaves them on GitHub.
    openExternal: async (url) => {
      if (url.startsWith('https://')) await shell.openExternal(markStay(url));
    },
    revealBrowserExtension: () => shell.showItemInFolder(browserExtensionDir()),
    browserExtensionInfo: async () => ({ path: browserExtensionDir(), browsers: await installedBrowsers() }),
    openExtensionsPage,
    showItemInFolder: (path) => shell.showItemInFolder(path),
    popOut: (key) => {
      createWindow(key);
    },
    contextMenu: (items) =>
      new Promise((resolve) => {
        const menu = Menu.buildFromTemplate(
          items.map((item) =>
            item === 'separator'
              ? { type: 'separator' as const }
              : { label: item.label, enabled: item.enabled ?? true, accelerator: item.accelerator, registerAccelerator: false, click: () => resolve(item.id) },
          ),
        );
        // On macOS the close callback can run before the item's click handler, so give the click a moment to win.
        menu.popup({ window: BrowserWindow.getFocusedWindow() ?? undefined, callback: () => setTimeout(() => resolve(null), 100) });
      }),
    applyAppTheme,
    confirm: async (message, detail, button) => {
      const parent = BrowserWindow.getFocusedWindow();
      const options: Electron.MessageBoxOptions = { type: 'question', message, detail, buttons: [button, 'Cancel'], defaultId: 0, cancelId: 1 };
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 0;
    },
    copyText: (text) => clipboard.writeText(text),
    // Only "new session" links: nothing else of Claude Desktop's can be reached from the app.
    openClaudeLink: async (url) => {
      if (!url.startsWith('claude://code/new?')) throw new Error('Only links that start a new Claude Desktop session can be opened.');
      await shell.openExternal(url);
    },
    notify: (title, body, url) => {
      // In the app, the status bar shows it.
      if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
      const note = new Notification({ title, body });
      note.on('click', () => openFromUrl(`prreview://open?pr=${encodeURIComponent(url)}`));
      note.show();
    },
  });
  applyAppTheme((await registry.appState.settings()).appTheme);
  registerIpc(registry.api());
  // Without the server (no Keychain access…) the app still works; Settings › Agents shows that it isn't running.
  await registry.startMcp().catch(() => undefined);
  app.setAboutPanelOptions({ applicationName: 'PR Review', applicationVersion: currentVersion() });
  buildMenu();
  createWindow();
  started = true;
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  registry?.stopActions();
  registry?.stopMcp();
  registry?.disposeAll();
});
