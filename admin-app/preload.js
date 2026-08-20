const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit bridge - the renderer gets exactly one capability
// (save a file the user has already been shown, via the native
// save dialog) and nothing else. No direct fs/child_process access.
contextBridge.exposeInMainWorld("electronAPI", {
  saveFile: (defaultName, base64Data) =>
    ipcRenderer.invoke("save-file", { defaultName, base64Data })
});
