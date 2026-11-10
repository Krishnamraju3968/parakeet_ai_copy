const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onClickThrough: (cb) => ipcRenderer.on("click-through", (_e, on) => cb(on)),
  onFocusInput: (cb) => ipcRenderer.on("focus-input", () => cb()),
  getWindowBounds: () => ipcRenderer.invoke("window:get-bounds"),
  setWindowBounds: (bounds) => ipcRenderer.invoke("window:set-bounds", bounds),
  setContentHeight: (height) =>
    ipcRenderer.invoke("window:set-content-height", height),
  resetContentHeight: () => ipcRenderer.invoke("window:reset-content-height"),
  quitApp: () => ipcRenderer.send("app:quit"),
  chat: (history) => ipcRenderer.invoke("ai:chat", history),
  transcribe: (audio) => ipcRenderer.invoke("ai:transcribe", audio),
  onTranscriptionProgress: (cb) =>
    ipcRenderer.on("transcription:progress", (_event, progress) =>
      cb(progress),
    ),
  pasteTranscription: (text) => ipcRenderer.invoke("dictation:paste", text),
  toggleGlobalDictation: () => ipcRenderer.send("dictation:request-toggle"),
  onGlobalDictationToggle: (cb) =>
    ipcRenderer.on("dictation:toggle", () => cb()),
  dictationStarted: () => ipcRenderer.send("dictation:started"),
  reportDictationError: (message) =>
    ipcRenderer.send("dictation:error", message),
  onDictationError: (cb) =>
    ipcRenderer.on("dictation:error", (_event, message) => cb(message)),
});
