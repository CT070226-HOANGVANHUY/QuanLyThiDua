import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRestoreIntent, intentPath, isLocalFsPath, sameFsPath, writeRestoreIntent } from "./restore-intent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || "5050";
const DATA_DIR = path.join(ROOT, "data");
const NODE_CANDIDATES = [
  process.env.NODE_BINARY,
  path.join(ROOT, "tools", "node.exe"),
  path.join(ROOT, "node.exe"),
  path.join("C:", "Program Files", "nodejs", "node.exe"),
  "node",
].filter(Boolean);

function findNode() {
  for (const candidate of NODE_CANDIDATES) {
    if (candidate === "node") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

function isLocalSender(event) {
  try {
    const href = event.senderFrame?.url || event.sender.getURL();
    const parsed = new URL(String(href));
    return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

function liveDbPath() {
  return process.env.THIDUA_DB_PATH || path.join(DATA_DIR, "thidua.db");
}

let child = null;
let win = null;
let stopping = false;

function startBackend() {
  const node = findNode();
  const { promise, resolve, reject } = Promise.withResolvers();
  const proc = spawn(node, ["--experimental-strip-types", path.join(ROOT, "src", "server.ts")], {
    cwd: ROOT,
    env: { ...process.env, PORT, DESKTOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (buf) => process.stderr.write(buf));
  const onData = (buf) => {
    const text = String(buf);
    process.stdout.write(text);
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) {
      proc.stdout.off("data", onData);
      resolve({ child: proc, url: match[0] });
    }
  };
  proc.stdout.on("data", onData);
  proc.on("error", reject);
  proc.on("exit", (code) => {
    if (stopping) return;
    if (code) reject(new Error(`Server thoát mã ${code}`));
  });
  setTimeout(() => reject(new Error("Server không sẵn sàng")), 15000);
  return promise;
}

function stopBackend() {
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode != null) {
      child = null;
      return resolve();
    }
    stopping = true;
    const timer = setTimeout(() => {
      stopping = false;
      reject(new Error("Server không thoát kịp."));
    }, 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      stopping = false;
      child = null;
      resolve();
    });
    child.kill();
  });
}

app.whenReady().then(async () => {
  // Crash mid-copy: finish restore-intent.json before opening the live DB.
  try {
    applyRestoreIntent(intentPath(DATA_DIR));
  } catch (error) {
    dialog.showErrorBox("Phục hồi dữ liệu", error instanceof Error ? error.message : String(error));
  }
  const started = await startBackend();
  child = started.child;
  console.log(started.url);
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Thi đua Giao Thủy C",
    autoHideMenuBar: true,
    backgroundColor: "#eef3f8",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: path.join(ROOT, "electron", "preload.cjs"),
    },
  });
  ipcMain.handle("open-print", async (event, href) => {
    if (!isLocalSender(event)) throw new Error("Chỉ máy này.");
    let parsed;
    try { parsed = new URL(String(href)); } catch { throw new Error("URL không hợp lệ"); }
    if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
      throw new Error("Chỉ mở địa chỉ máy này.");
    }
    await shell.openExternal(parsed.href);
  });
  ipcMain.handle("pick-restore-db", async (event) => {
    if (!isLocalSender(event)) throw new Error("Chỉ máy này.");
    const result = await dialog.showOpenDialog(win, {
      title: "Chọn file sao lưu",
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("restore-db", async (event, filePath) => {
    if (!isLocalSender(event)) throw new Error("Chỉ máy này.");
    const source = path.resolve(String(filePath ?? ""));
    if (!isLocalFsPath(source)) throw new Error("Đường dẫn không hợp lệ.");
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Không tìm thấy file.");
    const destDb = path.resolve(liveDbPath());
    if (sameFsPath(source, destDb)) throw new Error("File đang mở là dữ liệu hiện tại.");
    const sourceBaoCao = path.join(path.dirname(source), "BaoCao");
    const destBaoCao = path.join(ROOT, "BaoCao");
    const intent = intentPath(DATA_DIR);
    writeRestoreIntent(intent, {
      sourceDb: source,
      destDb,
      sourceBaoCao: fs.existsSync(sourceBaoCao) && !sameFsPath(sourceBaoCao, destBaoCao) ? sourceBaoCao : null,
      destBaoCao,
    });
    await stopBackend();
    try {
      applyRestoreIntent(intent);
      return { ok: true };
    } catch (error) {
      const pending = [`${destDb}.restoring`, `${destBaoCao}.restoring`];
      if (fs.existsSync(intent) && !pending.some((file) => fs.existsSync(file))) fs.unlinkSync(intent);
      throw error;
    } finally {
      const again = await startBackend();
      child = again.child;
      if (win && !win.isDestroyed()) await win.reload();
    }
  });
  await win.loadURL(started.url);
  win.on("closed", () => {
    child?.kill();
    app.quit();
  });
  app.on("before-quit", () => child?.kill());
});

app.on("window-all-closed", () => app.quit());
