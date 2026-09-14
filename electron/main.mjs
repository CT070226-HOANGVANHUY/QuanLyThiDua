import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || "5050";
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

function startBackend() {
  const node = findNode();
  const { promise, resolve, reject } = Promise.withResolvers();
  const child = spawn(node, ["--experimental-strip-types", path.join(ROOT, "src", "server.ts")], {
    cwd: ROOT,
    env: { ...process.env, PORT, DESKTOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (buf) => process.stderr.write(buf));
  const onData = (buf) => {
    const text = String(buf);
    process.stdout.write(text);
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) {
      child.stdout.off("data", onData);
      resolve({ child, url: match[0] });
    }
  };
  child.stdout.on("data", onData);
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code) reject(new Error(`Server thoát mã ${code}`));
  });
  setTimeout(() => reject(new Error("Server không sẵn sàng")), 15000);
  return promise;
}

app.whenReady().then(async () => {
  const { child, url } = await startBackend();
  console.log(url);
  ipcMain.handle("open-print", async (_event, href) => {
    let parsed;
    try { parsed = new URL(String(href)); } catch { throw new Error("URL không hợp lệ"); }
    if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
      throw new Error("Chỉ mở địa chỉ máy này.");
    }
    await shell.openExternal(parsed.href);
  });
  const win = new BrowserWindow({
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
  await win.loadURL(url);
  win.on("closed", () => {
    child.kill();
    app.quit();
  });
  app.on("before-quit", () => child.kill());
});

app.on("window-all-closed", () => app.quit());
