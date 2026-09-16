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
    fs.mkdirSync(path.dirname(destBaoCao), { recursive: true });
    if (fs.existsSync(destBaoCao)) fs.rmSync(destBaoCao, { recursive: true, force: true });
    fs.cpSync(sourceBaoCao, destBaoCao, { recursive: true });
  }
  fs.unlinkSync(file);
  return true;
}
