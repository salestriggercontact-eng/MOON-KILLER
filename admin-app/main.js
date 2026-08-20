const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "src", "index.html"));
}

// Renderer never touches the filesystem directly (contextIsolation).
// Screenshots/recordings come here as base64 and get written out only
// after the user picks a location via the native save dialog.
ipcMain.handle("save-file", async (event, { defaultName, base64Data }) => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win, { defaultPath: defaultName });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(result.filePath, Buffer.from(base64Data, "base64"));
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
