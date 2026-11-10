const {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  desktopCapturer,
  ipcMain,
  session,
  systemPreferences,
  clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");
const { pathToFileURL } = require("url");
const { execFile } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

/* ── tiny .env loader (no extra dependency) ── */
function loadEnv() {
  const envPath = app.isPackaged
    ? path.join(app.getPath("userData"), ".env")
    : path.join(__dirname, ".env");
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]])
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env file */
  }
}
loadEnv();

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a concise, helpful assistant inside a small notes overlay. Keep answers short and easy to scan.";
const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
const MIN_WHISPER_MODEL_SIZE = 50 * 1024 * 1024;
let whisperContextPromise;

let win;
let clickThrough = false;
const windowWidth = 1000;
const compactWindowHeight = 205;

function createWindow() {
  const {
    x,
    y,
    width: workAreaWidth,
    height: workAreaHeight,
  } = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    width: windowWidth,
    height: Math.min(compactWindowHeight, workAreaHeight),
    x: x + (workAreaWidth - windowWidth) / 2,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  // Ask the OS to exclude this window from screen capture.
  win.setContentProtection(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile("index.html");
}

ipcMain.handle("window:get-bounds", (event) => {
  if (event.sender !== win?.webContents) {
    throw new Error("Window bounds were requested by an unexpected renderer.");
  }
  return win.getBounds();
});

ipcMain.handle("window:set-bounds", (event, bounds) => {
  if (event.sender !== win?.webContents) {
    throw new Error("Window resize was requested by an unexpected renderer.");
  }
  if (
    !bounds ||
    !["x", "y", "width", "height"].every((key) => Number.isFinite(bounds[key]))
  ) {
    throw new TypeError(
      "Window bounds must contain finite coordinates and dimensions.",
    );
  }

  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const width = Math.min(workArea.width, Math.max(1, Math.ceil(bounds.width)));
  const height = Math.min(
    workArea.height,
    Math.max(1, Math.ceil(bounds.height)),
  );
  const x = Math.min(
    Math.max(Math.round(bounds.x), workArea.x),
    workArea.x + workArea.width - width,
  );
  const y = Math.min(
    Math.max(Math.round(bounds.y), workArea.y),
    workArea.y + workArea.height - height,
  );
  win.setBounds({ x, y, width, height });
});

ipcMain.handle("window:set-content-height", (event, height) => {
  if (event.sender !== win?.webContents) {
    throw new Error("Window resize was requested by an unexpected renderer.");
  }
  if (!Number.isFinite(height) || height < 1) {
    throw new TypeError("Window height must be a positive finite number.");
  }
  const [width] = win.getSize();
  const { height: workAreaHeight } = screen.getDisplayMatching(
    win.getBounds(),
  ).workArea;
  win.setSize(
    width,
    Math.min(workAreaHeight, Math.max(compactWindowHeight, Math.ceil(height))),
  );
});

ipcMain.handle("window:reset-content-height", (event) => {
  if (event.sender !== win?.webContents) {
    throw new Error("Window resize was requested by an unexpected renderer.");
  }
  const [width] = win.getSize();
  const { height: workAreaHeight } = screen.getDisplayMatching(
    win.getBounds(),
  ).workArea;
  win.setSize(width, Math.min(compactWindowHeight, workAreaHeight));
});

function quitApp() {
  try {
    globalShortcut.unregisterAll();
    if (win && !win.isDestroyed()) win.destroy();
  } finally {
    // exit() does not wait on the pending renderer reply. quit() from
    // inside ipcMain.handle never finishes, so the process stays open.
    app.exit(0);
  }
}

ipcMain.on("app:quit", (event) => {
  if (event.sender !== win?.webContents) return;
  setImmediate(quitApp);
});

/* ── Exa answers. The key stays in this main process, never in the page. ── */
ipcMain.handle("ai:chat", async (event, { history, requestId }) => {
  if (event.sender !== win?.webContents) {
    throw new Error("Chat was requested by an unexpected renderer.");
  }
  if (
    !Array.isArray(history) ||
    typeof requestId !== "string" ||
    requestId.length === 0
  ) {
    throw new TypeError("A chat history and request ID are required.");
  }
  const key = process.env.EXA_API_KEY;
  if (!key || key === "your_key") {
    const envPath = app.isPackaged
      ? path.join(app.getPath("userData"), ".env")
      : ".env";
    return {
      error: `Add your Exa API key as EXA_API_KEY in ${envPath}, then restart Veilpad.`,
    };
  }
  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history
        .slice(-20)
        .filter(
          (m) =>
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string",
        ),
    ];
    const res = await fetch("https://api.exa.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "exa",
        messages,
        text: true,
        stream: true,
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      return {
        error:
          data?.error?.message ||
          `Exa request failed (${res.status}). Check the key and Exa credits.`,
      };
    }

    if (!res.body) throw new Error("Exa returned an empty response.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let eventData = [];

    const processEvent = () => {
      if (eventData.length === 0) return;
      const data = eventData.join("\n");
      eventData = [];
      if (data === "[DONE]") return;

      const payload = JSON.parse(data);
      const content =
        payload.choices?.[0]?.delta?.content ??
        payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) return;

      answer += content;
      if (!event.sender.isDestroyed()) {
        event.sender.send("ai:chat-chunk", requestId, content);
      }
    };

    const processLine = (line) => {
      if (line === "") {
        processEvent();
      } else if (line.startsWith("data:")) {
        eventData.push(line.slice(5).trimStart());
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) processLine(line.replace(/\r$/, ""));
      if (done) break;
    }
    if (buffer) processLine(buffer.replace(/\r$/, ""));
    processEvent();

    return { text: answer.trim() || "(empty reply)" };
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }
});

async function ensureWhisperModel(reportProgress) {
  const modelDirectory = path.join(app.getPath("userData"), "models");
  const modelPath = path.join(modelDirectory, "ggml-tiny.bin");
  await fs.promises.mkdir(modelDirectory, { recursive: true });

  try {
    const stats = await fs.promises.stat(modelPath);
    if (stats.size >= MIN_WHISPER_MODEL_SIZE) return modelPath;
    await fs.promises.unlink(modelPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  reportProgress({ phase: "download", received: 0, total: 0 });
  const response = await fetch(WHISPER_MODEL_URL);
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download the offline speech model (${response.status}).`,
    );
  }

  const temporaryPath = `${modelPath}.${randomUUID()}.part`;
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  let lastReportedAt = 0;
  const progressStream = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.byteLength;
      const now = Date.now();
      if (now - lastReportedAt > 250) {
        reportProgress({ phase: "download", received, total });
        lastReportedAt = now;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      progressStream,
      fs.createWriteStream(temporaryPath, { flags: "wx" }),
    );
    if (received < MIN_WHISPER_MODEL_SIZE) {
      throw new Error(
        "The downloaded speech model was incomplete. Check your connection and retry.",
      );
    }
    await fs.promises.rename(temporaryPath, modelPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
  reportProgress({ phase: "download", received, total: total || received });
  return modelPath;
}

async function getWhisperContext(modelPath) {
  if (!whisperContextPromise) {
    whisperContextPromise = import("@fugood/whisper.node")
      .then(({ initWhisper }) =>
        initWhisper({
          filePath: modelPath,
          useGpu: process.platform === "darwin",
        }),
      )
      .catch((error) => {
        whisperContextPromise = undefined;
        throw error;
      });
  }
  return whisperContextPromise;
}

ipcMain.handle("ai:transcribe", async (event, audio) => {
  if (event.sender !== win?.webContents) {
    return { error: "Transcription was requested by an unexpected window." };
  }
  if (!["darwin", "win32", "linux"].includes(process.platform)) {
    return { error: "Local transcription is not supported on this platform." };
  }
  if (!(audio instanceof Uint8Array) || audio.byteLength <= 44) {
    return {
      error:
        "No audio was recorded. Try speaking after starting the microphone.",
    };
  }
  if (audio.byteLength > 100 * 1024 * 1024) {
    return {
      error: "That recording is too large. Keep recordings under 100 MB.",
    };
  }

  const reportProgress = (progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("transcription:progress", progress);
    }
  };
  const audioPath = path.join(os.tmpdir(), `veilpad-${randomUUID()}.wav`);
  try {
    const modelPath = await ensureWhisperModel(reportProgress);
    reportProgress({ phase: "loading" });
    const context = await getWhisperContext(modelPath);
    await fs.promises.writeFile(audioPath, Buffer.from(audio));
    reportProgress({ phase: "transcribing" });
    const { promise } = context.transcribeFile(audioPath, {
      language: "auto",
      temperature: 0,
      maxThreads: Math.max(1, Math.min(os.cpus().length - 1, 8)),
      onProgress: (progress) =>
        reportProgress({ phase: "transcribing", progress }),
    });
    const result = await promise;
    if (result.isAborted)
      return { error: "Transcription was interrupted. Try again." };
    return { text: result.result?.trim() || "" };
  } catch (error) {
    return { error: `Local transcription failed: ${error.message}` };
  } finally {
    await fs.promises.rm(audioPath, { force: true });
  }
});

ipcMain.handle("dictation:paste", async (event, text) => {
  if (event.sender !== win?.webContents) {
    return { error: "Dictation paste was requested by an unexpected window." };
  }
  if (process.platform !== "darwin") {
    return {
      error: "Paste-into-app dictation is currently supported on macOS only.",
    };
  }
  if (typeof text !== "string" || !text.trim() || text.length > 100_000) {
    return { error: "The transcription is empty or too long to paste." };
  }
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    return {
      error:
        "Allow Veilpad under System Settings > Privacy & Security > Accessibility to paste dictation into other apps.",
    };
  }

  clipboard.writeText(text);
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      [
        "-e",
        'tell application "System Events" to keystroke "v" using {command down}',
      ],
      { timeout: 5000 },
      (error) => {
        if (error) {
          resolve({
            error: `Could not paste the transcription: ${error.message}`,
          });
          return;
        }
        resolve({ pasted: true });
      },
    );
  });
});

app.whenReady().then(() => {
  ipcMain.on("dictation:request-toggle", (event) => {
    if (event.sender === win?.webContents) {
      win.webContents.send("dictation:toggle");
    }
  });

  const appPage = pathToFileURL(path.join(__dirname, "index.html")).href;
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame?.url !== appPage) {
      callback(null);
      return;
    }
    desktopCapturer
      .getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      })
      .then(
        (sources) => {
          const primaryDisplayId = String(screen.getPrimaryDisplay().id);
          const source =
            sources.find((item) => item.display_id === primaryDisplayId) ||
            sources[0];
          if (!source) {
            callback(null);
            return;
          }
          callback({ video: source, audio: "loopback" });
        },
        (error) => {
          console.error("Could not capture computer audio:", error);
          callback(null);
        },
      );
  });
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const isAppPage = webContents.getURL() === appPage;
      const requestsAudio =
        permission === "media" && details.mediaTypes?.includes("audio");
      const requestsDisplayCapture = permission === "display-capture";
      if (!isAppPage || (!requestsAudio && !requestsDisplayCapture)) {
        callback(false);
        return;
      }
      if (requestsDisplayCapture) {
        callback(true);
        return;
      }
      if (process.platform === "darwin") {
        systemPreferences
          .askForMediaAccess("microphone")
          .then(callback, (error) => {
            console.error("Could not request microphone access:", error);
            callback(false);
          });
        return;
      }
      callback(true);
    },
  );
  createWindow();

  // Ctrl/Cmd+Shift+H → hide / show
  globalShortcut.register("CommandOrControl+Shift+H", () => {
    win.isVisible() ? win.hide() : win.showInactive();
  });

  // Ctrl/Cmd+Shift+C → click-through on/off
  globalShortcut.register("CommandOrControl+Shift+C", () => {
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    win.webContents.send("click-through", clickThrough);
  });

  // Ctrl/Cmd+Shift+Space → show and focus the chat box
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    if (clickThrough) {
      clickThrough = false;
      win.setIgnoreMouseEvents(false);
      win.webContents.send("click-through", false);
    }
    win.show();
    win.focus();
    win.webContents.send("focus-input");
  });

  // Ctrl/Cmd+Shift+Q → quit
  globalShortcut.register("CommandOrControl+Shift+Q", quitApp);

  // Ctrl/Cmd+Shift+D → toggle dictation into the focused app
  globalShortcut.register("CommandOrControl+Shift+D", () => {
    win.webContents.send("dictation:toggle");
  });

  ipcMain.on("dictation:started", (event) => {
    if (event.sender === win.webContents) win.hide();
  });
  ipcMain.on("dictation:error", (event, message) => {
    if (event.sender !== win.webContents || typeof message !== "string") return;
    win.show();
    win.focus();
    win.webContents.send("dictation:error", message);
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
