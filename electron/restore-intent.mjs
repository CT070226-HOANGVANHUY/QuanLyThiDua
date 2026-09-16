import fs from "node:fs";
import path from "node:path";

export const INTENT_FILE = "restore-intent.json";

export function isLocalFsPath(input) {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0")) return false;
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) return false;
  return path.isAbsolute(trimmed);
}

export function intentPath(dataDir) {
  return path.join(dataDir, INTENT_FILE);
}

export function writeRestoreIntent(file, intent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(intent));
}

function normPath(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

export function sameFsPath(a, b) {
  return Boolean(a) && Boolean(b) && normPath(a) === normPath(b);
}

export function pathInside(inner, outer) {
  if (!inner || !outer) return false;
  const a = normPath(inner);
  const b = normPath(outer);
  if (a === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(prefix);
}

function replaceDirectory(source, dest) {
  if (sameFsPath(source, dest) || pathInside(dest, source) || pathInside(source, dest)) return;
  const tmp = `${String(dest).replace(/[\\/]+$/, "")}.restoring`;
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(source, tmp, { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

export function applyRestoreIntent(file) {
  if (!fs.existsSync(file)) return false;
  const intent = JSON.parse(fs.readFileSync(file, "utf8"));
  const sourceDb = String(intent.sourceDb ?? "");
  const destDb = String(intent.destDb ?? "");
  if (!isLocalFsPath(sourceDb) || !isLocalFsPath(destDb)) {
    throw new Error("Đường dẫn phục hồi không hợp lệ.");
  }
  if (!fs.existsSync(sourceDb) || !fs.statSync(sourceDb).isFile()) {
    throw new Error("Không tìm thấy file sao lưu.");
  }
  fs.mkdirSync(path.dirname(destDb), { recursive: true });
  const tmp = `${destDb}.restoring`;
  fs.copyFileSync(sourceDb, tmp);
  if (fs.existsSync(destDb)) fs.unlinkSync(destDb);
  fs.renameSync(tmp, destDb);
  for (const ext of ["-wal", "-shm"]) {
    const side = destDb + ext;
    if (fs.existsSync(side)) fs.unlinkSync(side);
  }
  const sourceBaoCao = intent.sourceBaoCao ? String(intent.sourceBaoCao) : "";
  const destBaoCao = intent.destBaoCao ? String(intent.destBaoCao) : "";
  if (sourceBaoCao && destBaoCao && fs.existsSync(sourceBaoCao) && isLocalFsPath(destBaoCao)) {
    replaceDirectory(sourceBaoCao, destBaoCao);
  }
  fs.unlinkSync(file);
  return true;
}
