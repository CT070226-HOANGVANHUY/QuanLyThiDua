import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { all, DATA_DIR, get, run, tableExists, WorkflowError, type Db } from "./db.ts";
import { APP_SCHEMA_MAX } from "./migrate.ts";

export { APP_SCHEMA_MAX };

function dbFilePath(con: Db): string {
  return String(get(con, "SELECT file FROM pragma_database_list WHERE name='main'")?.file ?? "");
}

function sqlString(value: string) {
  if (value.includes("\0")) throw new WorkflowError(400, "Đường dẫn không hợp lệ.");
  return `'${value.replaceAll("'", "''")}'`;
}

function timestampName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `thidua-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
}

export function isLocalFsPath(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0")) return false;
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) return false;
  return path.isAbsolute(trimmed);
}

export function resolveLocalPath(input: string, base: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0")) throw new WorkflowError(400, "Đường dẫn không hợp lệ.");
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    throw new WorkflowError(400, "Không dùng đường dẫn mạng.");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new WorkflowError(400, "Đường dẫn không hợp lệ.");
  }
  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(base, trimmed);
  if (resolved.startsWith("\\\\") || resolved.startsWith("//")) {
    throw new WorkflowError(400, "Không dùng đường dẫn mạng.");
  }
  return resolved;
}

function sameFile(a: string, b: string) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function metaGet(con: Db, key: string): string | undefined {
  if (!tableExists(con, "app_meta")) return undefined;
  const row = get(con, "SELECT value FROM app_meta WHERE key=?", [key]);
  return row ? String(row.value) : undefined;
}

export function metaSet(con: Db, key: string, value: string) {
  run(con, `INSERT INTO app_meta(key, value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
}

export function lastBackupInfo(con: Db): { at?: string; path?: string } {
  return { at: metaGet(con, "last_backup_at"), path: metaGet(con, "last_backup_path") };
}

export function resolveBackupDest(con: Db, input?: string): string {
  const source = dbFilePath(con);
  const trimmed = (input ?? "").trim();
  let dest: string;
  if (!trimmed) {
    dest = path.join(DATA_DIR, "backups", timestampName());
  } else {
    const dirHint = trimmed.endsWith("/") || trimmed.endsWith("\\");
    const resolved = resolveLocalPath(trimmed, DATA_DIR);
    if (dirHint || (existsSync(resolved) && statSync(resolved).isDirectory())) {
      dest = path.join(resolved, timestampName());
    } else {
      dest = resolved;
    }
  }
  if (!isLocalFsPath(dest)) throw new WorkflowError(400, "Đường dẫn sao lưu không hợp lệ.");
  if (source && sameFile(source, dest)) throw new WorkflowError(400, "Không sao lưu đè lên file đang mở.");
  if (existsSync(dest)) throw new WorkflowError(409, "File đích đã tồn tại.");
  return dest;
}

export function vacuumBackup(con: Db, destInput?: string): string {
  const dest = resolveBackupDest(con, destInput);
  mkdirSync(path.dirname(dest), { recursive: true });
  con.exec(`VACUUM INTO ${sqlString(dest)}`);
  metaSet(con, "last_backup_at", new Date().toISOString());
  metaSet(con, "last_backup_path", dest);
  return dest;
}

export type RestoreCheck = { user_version: number; nam_hoc: string };

export function checkRestoreCandidate(filePath: string): RestoreCheck {
  const resolved = resolveLocalPath(filePath, DATA_DIR);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new WorkflowError(400, "Không tìm thấy file.");
  }
  let cand: DatabaseSync | undefined;
  try {
    cand = new DatabaseSync(resolved, { readOnly: true });
  } catch (error) {
    throw new WorkflowError(400, error instanceof Error ? error.message : "File không phải SQLite hợp lệ.");
  }
  try {
    let integrity: { integrity_check?: unknown }[];
    try {
      integrity = all(cand, "PRAGMA integrity_check") as { integrity_check?: unknown }[];
    } catch {
      throw new WorkflowError(400, "File hỏng (integrity_check).");
    }
    if (integrity.length !== 1 || String(integrity[0]?.integrity_check) !== "ok") {
      throw new WorkflowError(400, "File hỏng (integrity_check).");
    }
    if (!tableExists(cand, "nam_hoc")) throw new WorkflowError(400, "File thiếu bảng nam_hoc.");
    const nam = get(cand, "SELECT ten FROM nam_hoc ORDER BY active DESC, id DESC LIMIT 1");
    if (!nam) throw new WorkflowError(400, "File không có năm học.");
    const version = Number(get(cand, "PRAGMA user_version")?.user_version ?? 0);
    if (version > APP_SCHEMA_MAX) {
      throw new WorkflowError(400, `Phiên bản file (${version}) lớn hơn ứng dụng (${APP_SCHEMA_MAX}).`);
    }
    return { user_version: version, nam_hoc: String(nam.ten) };
  } finally {
    cand.close();
  }
}
