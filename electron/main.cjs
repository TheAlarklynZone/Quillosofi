/*
 * Quillosofi Desktop — Electron main process
 * Copyright 2026 Alarkius Elvya Jay
 * Licensed under the Apache License, Version 2.0
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');

// v0.4.14: tray icon removed entirely.
// Reasons:
//   1. It duplicated the Update tab's "Check for updates" with a stripped
//      version — confusing surface, no unique value.
//   2. It was the suspected file-handle holder on Quillosofi.exe even after
//      tray.destroy() during update install. Removing it eliminates the
//      whole class of "Error 2" / "won't reinstall after download" issues.
//   3. App still auto-checks for updates on launch (autoCheck setting) and
//      the in-app Update tab handles everything else.
// Side effects: closing the last window now actually quits the app on all
// platforms (no more hide-to-tray). The global Ctrl/Cmd+Shift+Q hotkey
// remains for quick foreground summoning of an already-running instance.

// Optional auto-updater — only loaded if installed (so dev install works without it).
// IMPORTANT: electron-updater MUST live in `dependencies`, not devDependencies.
// electron-builder only bundles `dependencies` into the packaged app, and a
// silently-caught require here was the root cause of v0.4.3 → v0.4.7 "Check for
// Updates does nothing". Surfacing the load failure loudly so this can't regress.
let autoUpdater = null;
let updaterLoadError = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  updaterLoadError = (e && e.message) || String(e);
  console.error('[updater] FAILED to load electron-updater:', updaterLoadError);
  console.error('[updater] Auto-updates DISABLED. Check that electron-updater is in `dependencies`.');
}

const isDev = !app.isPackaged || process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

let mainWindow = null;
app.isQuitting = false;
app.isInstallingUpdate = false;

// v0.4.14: with no tray to destroy and no "hide to tray" close handler, the
// shutdown sequence is dramatically simpler. Just flag intent + drop global
// shortcuts; quitAndInstall() handles the rest of the dance with NSIS.
function prepareForUpdateInstall() {
  app.isQuitting = true;
  app.isInstallingUpdate = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
}

// =============================================================
// Single-instance lock — focus the existing window if user double-launches
// =============================================================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// =============================================================
// Update settings (persisted to disk in userData/)
// =============================================================
const userDataPath = () => app.getPath('userData');
const updateSettingsFile = () => path.join(userDataPath(), 'update-settings.json');
const pendingInstallFile = () => path.join(userDataPath(), 'pending-install.json');

const DEFAULT_UPDATE_SETTINGS = {
  // v0.5.72 — autoInstall removed from the user-facing toggle. The field is
  // kept here (defaulting to false) so older serialised settings files load
  // cleanly, but nothing in main.cjs reads it anymore. Updates are now
  // strictly user-driven: badge appears, user clicks Install & Restart.
  autoInstall: false,
  autoCheck: true,          // silent check on startup (just so the badge appears)
  channel: 'stable',
};

function loadUpdateSettings() {
  try {
    const raw = fs.readFileSync(updateSettingsFile(), 'utf8');
    return { ...DEFAULT_UPDATE_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULT_UPDATE_SETTINGS };
  }
}
function saveUpdateSettings(settings) {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true });
    fs.writeFileSync(updateSettingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.warn('Failed to persist update settings:', e.message);
  }
}
let updateSettings = loadUpdateSettings();

// v0.4.51 — "pending install on next launch" flow.
// When a download finishes mid-session AND autoInstall is on, we DON'T install
// silently on quit anymore. Instead we persist a small marker, and on next
// launch (after a brief 3s settle), the renderer pops a 10s countdown modal
// and then calls quitAndInstall. This makes the install transparent + visible
// instead of a surprise restart.
function loadPendingInstall() {
  try {
    const raw = fs.readFileSync(pendingInstallFile(), 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}
function savePendingInstall(payload) {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true });
    fs.writeFileSync(pendingInstallFile(), JSON.stringify(payload, null, 2));
  } catch (e) {
    console.warn('Failed to persist pending-install marker:', e.message);
  }
}
function clearPendingInstall() {
  try { fs.unlinkSync(pendingInstallFile()); } catch (_) {}
}

// =============================================================
// Update state machine — broadcast to renderer over 'updates:state'
// =============================================================
const updateState = {
  status: 'idle',           // idle | checking | available | not-available | downloading | downloaded | error
  currentVersion: app.getVersion(),
  latestVersion: null,
  releaseNotes: null,
  releaseDate: null,
  downloadPercent: 0,
  error: null,
  lastChecked: null,
};

function emitUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:state', { ...updateState, settings: updateSettings });
  }
}

function wireAutoUpdater() {
  if (!autoUpdater || isDev) return;

  autoUpdater.autoDownload = false;            // we control download timing
  autoUpdater.autoInstallOnAppQuit = false;    // v0.5.72 — install only on explicit user action
  autoUpdater.allowPrerelease = false;

  // Explicit feed URL — belt-and-suspenders so even older installs whose
  // bundled app-update.yml predates the public-repo rename can still find
  // releases. Public repo, no token required for read.
  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'AlarkiusJay',
      repo: 'Quillosofi',
      releaseType: 'release',
    });
  } catch (e) {
    console.warn('setFeedURL failed (will fall back to bundled yml):', e && e.message);
  }

  // Pipe verbose updater logs to stderr so 'Not checked yet' failures stop
  // being silent. Surfaced in the Update tab via the 'error' event below.
  try {
    autoUpdater.logger = {
      info: (...args) => console.log('[updater]', ...args),
      warn: (...args) => console.warn('[updater]', ...args),
      error: (...args) => console.error('[updater]', ...args),
      debug: (...args) => console.log('[updater:debug]', ...args),
    };
  } catch (_) {}

  autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    updateState.lastChecked = Date.now();
    emitUpdateState();
  });

  autoUpdater.on('update-available', (info) => {
    updateState.status = 'available';
    updateState.latestVersion = info.version;
    updateState.releaseDate = info.releaseDate || null;
    updateState.releaseNotes =
      typeof info.releaseNotes === 'string' ? info.releaseNotes : info.releaseNotes || null;
    emitUpdateState();
    // v0.5.72 — the renderer drives downloads explicitly. The old
    // `autoInstall` toggle is gone (it raced the manual flow and made the
    // "Download New Update" button feel inert). The Settings-gear badge
    // tells the user a release is waiting; they decide when to fetch it.
  });

  autoUpdater.on('update-not-available', (info) => {
    updateState.status = 'not-available';
    updateState.latestVersion = info.version;
    updateState.error = null;
    emitUpdateState();
  });

  autoUpdater.on('download-progress', (progress) => {
    updateState.status = 'downloading';
    updateState.downloadPercent = Math.round(progress.percent || 0);
    emitUpdateState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.status = 'downloaded';
    updateState.latestVersion = info.version;
    updateState.downloadPercent = 100;
    emitUpdateState();
    // v0.5.72 — no auto-install path anymore. The downloaded installer
    // sits on disk and the "Install & Restart" button in the Update tab
    // (and the badge on the Settings gear) is the explicit user action
    // that triggers quitAndInstall.
  });

  autoUpdater.on('error', (err) => {
    updateState.status = 'error';
    updateState.error = err && err.message ? err.message : String(err);
    emitUpdateState();
  });
}

// =============================================================
// Window
// =============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: !startHidden,
    backgroundColor: '#0b0b10',
    title: 'Quillosofi',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // Menu bar starts hidden, BUT we drive its visibility ourselves so Alt
    // toggles it as a sticky overlay (open until Alt is hit again, instead
    // of Electron's default "close on focus loss"). See the before-input-event
    // listener below — v0.4.33 easter-egg polish.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // v0.4.14: closing the window now actually quits (no tray to hide into).
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // v0.4.33 — sticky Alt-toggle for the native menu bar.
  // Default Electron behavior on Windows: Alt momentarily shows the bar, but
  // it auto-hides the moment focus leaves it. Alaria wants it to behave like
  // a deliberate toggle: Alt shows, click-anywhere does NOT close, Alt again
  // closes. We achieve this by:
  //   1. Listening for Alt keydown via before-input-event (fires before the
  //      renderer sees it).
  //   2. Toggling our own menuBarVisible flag and calling setMenuBarVisible.
  //   3. Suppressing the original event so Electron's default "momentary
  //      reveal" handler doesn't run and re-hide the bar on blur.
  let menuBarStuck = false;
  mainWindow.setMenuBarVisible(false);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Bare Alt press (no modifiers besides alt itself, no character).
    const isBareAlt =
      input.type === 'keyDown' &&
      input.key === 'Alt' &&
      input.alt &&
      !input.control &&
      !input.shift &&
      !input.meta;
    if (!isBareAlt) return;
    menuBarStuck = !menuBarStuck;
    mainWindow.setMenuBarVisible(menuBarStuck);
    event.preventDefault();
  });
}

// =============================================================
// IPC — app
// =============================================================
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:platform', () => process.platform);
ipcMain.handle('app:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});
ipcMain.on('app:quit', () => {
  app.isQuitting = true;
  app.quit();
});

// =============================================================
// IPC — spellchecker
// =============================================================
// Bridges Quillosofi's local custom dictionary (renderer-side, backed by
// localStorage — see src/lib/customDict.js) into Chromium's native
// spellchecker session. Without this, words pinned to the custom dictionary
// still get flagged by the native squiggly-underline spellcheck, since that
// checker has no visibility into the app's own word list.
ipcMain.handle('spellchecker:add-word', (_e, word) => {
  if (typeof word !== 'string' || !word.trim()) return false;
  try {
    session.defaultSession.addWordToSpellCheckerDictionary(word.trim());
    return true;
  } catch (e) {
    console.warn('[spellchecker] addWord failed:', e && e.message);
    return false;
  }
});

ipcMain.handle('spellchecker:remove-word', (_e, word) => {
  if (typeof word !== 'string' || !word.trim()) return false;
  try {
    session.defaultSession.removeWordFromSpellCheckerDictionary(word.trim());
    return true;
  } catch (e) {
    console.warn('[spellchecker] removeWord failed:', e && e.message);
    return false;
  }
});

// =============================================================
// IPC — updates
// =============================================================
ipcMain.handle('updates:status', () => ({
  ...updateState,
  settings: updateSettings,
  // Diagnostic flags so the renderer can show *why* the updater isn't working
  // instead of pretending everything's fine.
  updaterAvailable: !!autoUpdater,
  updaterLoadError,
  isDev,
}));

ipcMain.handle('updates:check', async () => {
  if (!autoUpdater || isDev) {
    const reason = isDev
      ? 'Auto-updates disabled in dev'
      : `Updater unavailable: ${updaterLoadError || 'electron-updater module not loaded'}`;
    // Push to the state stream so the diagnostic panel + sass tier counter both see it.
    updateState.status = 'error';
    updateState.error = reason;
    updateState.lastChecked = Date.now();
    emitUpdateState();
    return { ok: false, error: reason };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, info: r ? r.updateInfo : null };
  } catch (err) {
    updateState.status = 'error';
    updateState.error = err && err.message ? err.message : String(err);
    emitUpdateState();
    return { ok: false, error: updateState.error };
  }
});

ipcMain.handle('updates:download', async () => {
  if (!autoUpdater || isDev) {
    return { ok: false, error: 'Updater unavailable' };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('updates:install', async () => {
  if (!autoUpdater || isDev) {
    return { ok: false, error: 'Updater unavailable' };
  }
  try {
    // v0.4.13: stop pre-destroying windows. The previous flow killed all
    // BrowserWindows synchronously, which fired 'window-all-closed' →
    // app.exit(0) BEFORE the setTimeout could call quitAndInstall(). Result:
    // app exited cleanly, NSIS never ran, no upgrade.
    //
    // New flow:
    //   1. Mark intent (so close handlers stop hiding to tray).
    //   2. Kill the tray (this was the real file-handle culprit on .exe).
    //   3. Call quitAndInstall(isSilent=true, isForceRunAfter=true) — it
    //      gracefully closes all windows itself, then launches NSIS.
    prepareForUpdateInstall();
    // v0.4.51 — we're about to vanish; clear the pending-install marker so
    // the next launch (the freshly-installed version) doesn't re-trigger the
    // countdown for an already-applied update.
    clearPendingInstall();
    // Small tick so the IPC reply lands before we vanish.
    setImmediate(() => {
      try { autoUpdater.quitAndInstall(true, true); } catch (_) {}
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('updates:setSettings', (_e, partial) => {
  updateSettings = { ...updateSettings, ...(partial || {}) };
  saveUpdateSettings(updateSettings);
  emitUpdateState();
  return updateSettings;
});

ipcMain.handle('updates:openReleasePage', () => {
  shell.openExternal('https://github.com/AlarkiusJay/Quillosofi/releases');
  return true;
});

// =============================================================
// Lifecycle
// =============================================================
app.whenReady().then(() => {
  createWindow();
  wireAutoUpdater();

  // Global hotkey to summon Quillosofi (Ctrl/Cmd+Shift+Q).
  try {
    globalShortcut.register('CommandOrControl+Shift+Q', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    });
  } catch (_) {}

  // Initial update check 3s after launch (after window had time to render).
  if (autoUpdater && !isDev && updateSettings.autoCheck) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.warn('Initial update check failed:', err && err.message);
      });
    }, 3000);
  }

  // v0.4.51 — if we left a pending-install marker last session AND it points
  // to a version that's still newer than what we just booted, the staged
  // installer is sitting in <userData>/pending waiting for us. Tell the
  // renderer 3s after launch so it can show the visible 10s countdown.
  // The renderer will call updates:install once the countdown finishes.
  setTimeout(() => {
    if (isDev) return;
    const pending = loadPendingInstall();
    if (!pending || !pending.version) return;
    // Already on the new version? Marker is stale — clean up.
    try {
      const cur = app.getVersion();
      const sameOrNewer = (a, b) => {
        const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] || 0) > (pb[i] || 0)) return true;
          if ((pa[i] || 0) < (pb[i] || 0)) return false;
        }
        return true;
      };
      if (sameOrNewer(cur, pending.version)) { clearPendingInstall(); return; }
    } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updates:pending-install', { version: pending.version });
    }
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // v0.4.14: no tray, no reason to linger. Quit on all platforms (mac
  // included — no menu bar presence to maintain). If we're mid-install,
  // electron-updater's quitAndInstall drives the exit, so do nothing here.
  if (app.isInstallingUpdate) return;
  app.quit();
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
});
