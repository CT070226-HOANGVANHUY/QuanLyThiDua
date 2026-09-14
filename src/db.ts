import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { GIO_KEYS, KTM_SCORE_KEYS, NN_KEYS, SCORE_FIELDS } from "./scoring.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const DB_PATH = process.env.THIDUA_DB_PATH || path.join(DATA_DIR, "thidua.db");
export const REPORT_DIR = path.join(ROOT, "BaoCao");
export type Dict = Record<string, unknown> & { [key: string]: unknown };
export type Db = DatabaseSync;

const NN_SQL = NN_KEYS.map((k) => `${k} REAL NOT NULL DEFAULT 0`).join(", ");
const GIO_SQL = GIO_KEYS.map((k) => `${k} INTEGER NOT NULL DEFAULT 0`).join(", ");
const KTM_SQL = KTM_SCORE_KEYS.map((k) => `${k} INTEGER NOT NULL DEFAULT 0`).join(", ");

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS nam_hoc (
    id INTEGER PRIMARY KEY,
    ten TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lop (
    id INTEGER PRIMARY KEY,
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    ten TEXT NOT NULL,
    khoi INTEGER NOT NULL,
    nhom INTEGER NOT NULL,
    si_so INTEGER NOT NULL DEFAULT 0,
    gvcn TEXT NOT NULL DEFAULT '',
    thu_tu INTEGER NOT NULL DEFAULT 0,
    UNIQUE(nam_hoc_id, ten)
);
CREATE TABLE IF NOT EXISTS tuan (
    id INTEGER PRIMARY KEY,
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    so_tuan INTEGER NOT NULL,
    thang INTEGER NOT NULL,
    nam INTEGER NOT NULL,
    hoc_ky INTEGER NOT NULL DEFAULT 1,
    ghi_chu TEXT NOT NULL DEFAULT '',
    UNIQUE(nam_hoc_id, so_tuan)
);
CREATE TABLE IF NOT EXISTS diem_tuan (
    id INTEGER PRIMARY KEY,
    tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    ${NN_SQL},
    ${GIO_SQL},
    ktm_ge5 INTEGER NOT NULL DEFAULT 0,
    ktm_lt5 INTEGER NOT NULL DEFAULT 0,
    ${KTM_SQL},
    ghi_chu TEXT NOT NULL DEFAULT '',
    UNIQUE(tuan_id, lop_id)
);
CREATE TABLE IF NOT EXISTS quy_che (
    id INTEGER PRIMARY KEY,
    stt TEXT NOT NULL,
    muc TEXT NOT NULL,
    noi_dung TEXT NOT NULL,
    diem TEXT NOT NULL,
    ghi_chu TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS loi_vi_pham (
    id INTEGER PRIMARY KEY,
    tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    ten_loi TEXT NOT NULL,
    so_luong REAL NOT NULL DEFAULT 1,
    diem_mot REAL NOT NULL,
    diem_tru REAL NOT NULL,
    ho_ten TEXT NOT NULL DEFAULT '',
    ghi_chu TEXT NOT NULL DEFAULT ''
);
`;

const WEEK3_SCORES: Record<string, Record<string, number>> = {
  "11A5": { hs_ky_luat: 30, gio_tot: 23, ktm_ge5: 1 },
  "11A9": { hs_ky_luat: 30, gio_tot: 23, ktm_ge5: 1 },
  "12A6": { phu_hieu: 1, gio_tot: 23, ktm_ge5: 1 },
  "12A7": { vp_khac: 1, gio_tot: 23, ktm_ge5: 1 },
};
const WEEK3_DEFAULT_HT = { gio_tot: 23, ktm_ge5: 1 };

export function connect(dbPath = DB_PATH): Db {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const con = new DatabaseSync(dbPath);
  con.exec("PRAGMA foreign_keys = ON");
  if (dbPath !== ":memory:" && Number(get(con, "PRAGMA user_version")?.user_version ?? 0) < 1 &&
      get(con, "SELECT name FROM sqlite_master WHERE type='table' AND name='nam_hoc'")) {
    const backupPath = `${path.resolve(dbPath)}.before-workflow-v1.db`;
    if (!existsSync(backupPath)) con.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  }
  con.exec("PRAGMA journal_mode = WAL");
  return con;
}

export function all(con: Db, sql: string, params: unknown[] = []): Dict[] {
  return con.prepare(sql).all(...params) as Dict[];
}
export function get(con: Db, sql: string, params: unknown[] = []): Dict | undefined {
  return con.prepare(sql).get(...params) as Dict | undefined;
}
export function run(con: Db, sql: string, params: unknown[] = []) {
  return con.prepare(sql).run(...params);
}

export class WorkflowError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function transaction<T>(con: Db, fn: () => T): T {
  const nested = con.isTransaction;
  con.exec(nested ? "SAVEPOINT workflow" : "BEGIN IMMEDIATE");
  try {
    const result = fn();
    con.exec(nested ? "RELEASE workflow" : "COMMIT");
    return result;
  } catch (error) {
    con.exec(nested ? "ROLLBACK TO workflow; RELEASE workflow" : "ROLLBACK");
    throw error;
  }
}

export function requireActiveYear(con: Db, namId: number) {
  if (!Number.isSafeInteger(namId) || namId <= 0 || !get(con, "SELECT id FROM nam_hoc WHERE id=?", [namId])) {
    throw new WorkflowError(404, "Không tìm thấy năm học.");
  }
  if (Number(getActiveNam(con)?.id) !== namId) {
    throw new WorkflowError(409, "Năm học đã thay đổi. Nội dung chưa được lưu.");
  }
}

export function requireOwned(con: Db, table: "lop" | "tuan" | "tieu_chi", id: number, namId: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(namId) || namId <= 0) {
    throw new WorkflowError(404, "Định danh không hợp lệ.");
  }
  const row = get(con, `SELECT * FROM ${table} WHERE id=? AND nam_hoc_id=?`, [id, namId]);
  if (!row) throw new WorkflowError(404, "Không tìm thấy dữ liệu trong năm học này.");
  return row;
}

export function addColumn(con: Db, table: string, name: string, definition: string) {
  if (!all(con, `PRAGMA table_info(${table})`).some((column) => column.name === name)) {
    con.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function initDb(con: Db): void {
  con.exec(SCHEMA);
  if (process.env.THIDUA_EMPTY_DB === "1") {
    if (!get(con, "SELECT id FROM quy_che LIMIT 1")) {
      const seed = JSON.parse(readFileSync(path.join(ROOT, "src", "seed.json"), "utf8"));
      transaction(con, () => {
        for (const row of seed.quy_che) {
          run(con, "INSERT INTO quy_che(stt,muc,noi_dung,diem,ghi_chu) VALUES (?,?,?,?,?)", row);
        }
      });
    }
    return;
  }
  const n = get(con, "SELECT COUNT(*) AS c FROM nam_hoc")!.c;
  if (n) return;
  const seed = JSON.parse(readFileSync(path.join(ROOT, "src", "seed.json"), "utf8")) as {
    lop: [number, string, number][];
    quy_che: [string, string, string, string, string][];
  };
  run(con, "INSERT INTO nam_hoc(ten, active) VALUES (?, 1)", ["2026-2027"]);
  const namId = get(con, "SELECT id FROM nam_hoc WHERE ten=?", ["2026-2027"])!.id;
  seed.lop.forEach(([nhom, ten, siSo], i) => {
    run(con, "INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, thu_tu) VALUES (?,?,?,?,?,?)", [
      namId,
      ten,
      Number(ten.slice(0, 2)),
      nhom,
      siSo,
      i + 1,
    ]);
  });
  for (const row of seed.quy_che) {
    run(con, "INSERT INTO quy_che(stt, muc, noi_dung, diem, ghi_chu) VALUES (?,?,?,?,?)", row);
  }
  run(con, "INSERT INTO tuan(nam_hoc_id, so_tuan, thang, nam, hoc_ky, ghi_chu) VALUES (?,?,?,?,?,?)", [
    namId,
    3,
    9,
    2026,
    1,
    "Dữ liệu mẫu — Tuần 3 (theo file Excel cũ)",
  ]);
  const tuanId = get(con, "SELECT id FROM tuan WHERE nam_hoc_id=? AND so_tuan=?", [namId, 3])!.id;
  const fields = [...NN_KEYS, ...GIO_KEYS, "ktm_ge5", "ktm_lt5", ...KTM_SCORE_KEYS];
  const ph = Array(2 + fields.length).fill("?").join(",");
  for (const lop of all(con, "SELECT id, ten FROM lop WHERE nam_hoc_id=?", [namId])) {
    const scores = { ...WEEK3_DEFAULT_HT, ...(WEEK3_SCORES[lop.ten] ?? {}) };
    const vals = [tuanId, lop.id, ...fields.map((f) => scores[f] ?? 0)];
    run(con, `INSERT INTO diem_tuan(tuan_id, lop_id, ${fields.join(",")}) VALUES (${ph})`, vals);
  }
}

export function listNamHoc(con: Db) {
  return all(con, "SELECT * FROM nam_hoc ORDER BY ten DESC");
}
export function getActiveNam(con: Db) {
  return get(con, "SELECT * FROM nam_hoc WHERE active=1") ?? get(con, "SELECT * FROM nam_hoc ORDER BY id DESC LIMIT 1");
}
export function setActiveNam(con: Db, namId: number) {
  transaction(con, () => {
    if (!get(con, "SELECT id FROM nam_hoc WHERE id=?", [namId])) {
      throw new WorkflowError(404, "Không tìm thấy năm học.");
    }
    con.exec("UPDATE nam_hoc SET active=0");
    run(con, "UPDATE nam_hoc SET active=1 WHERE id=?", [namId]);
  });
}
export function addNamHoc(con: Db, ten: string, copyFrom?: number) {
  return transaction(con, () => {
  if (!ten.trim()) throw new WorkflowError(400, "Tên năm học không được trống.");
  if (copyFrom) requireActiveYear(con, copyFrom);
  run(con, "INSERT INTO nam_hoc(ten, active) VALUES (?, 0)", [ten]);
  const newId = get(con, "SELECT id FROM nam_hoc WHERE ten=?", [ten])!.id;
  if (copyFrom) {
    for (const lop of all(con, "SELECT ten, khoi, nhom, si_so, gvcn, thu_tu FROM lop WHERE nam_hoc_id=?", [copyFrom])) {
      run(con, "INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu) VALUES (?,?,?,?,?,?,?)", [
        newId,
        lop.ten,
        lop.khoi,
        lop.nhom,
        lop.si_so,
        lop.gvcn,
        lop.thu_tu,
      ]);
    }
    if (get(con, "SELECT name FROM sqlite_master WHERE type='table' AND name='tieu_chi'")) {
      run(con, `INSERT INTO tieu_chi(nam_hoc_id,ma,ten,nhom,diem,don_vi,ap_dung,ghi_chu)
        SELECT ?,ma,ten,nhom,diem,don_vi,ap_dung,ghi_chu FROM tieu_chi WHERE nam_hoc_id=?`, [newId, copyFrom]);
    }
    if (get(con, "SELECT name FROM sqlite_master WHERE type='table' AND name='period_options'")) {
      run(con, `INSERT INTO period_options(nam_id,model,semester,include_exam,exclude_activity)
        SELECT ?,model,semester,include_exam,exclude_activity FROM period_options WHERE nam_id=?`, [newId, copyFrom]);
    }
  }
  return newId;
  });
}
export function listLop(con: Db, namId: number) {
  return all(con, "SELECT * FROM lop WHERE nam_hoc_id=? ORDER BY nhom, thu_tu, ten", [namId]);
}
export function upsertLop(con: Db, namId: number, data: Dict) {
  return transaction(con, () => {
  requireActiveYear(con, namId);
  data.ten = String(data.ten ?? "").trim().toUpperCase();
  if (!data.ten || ![10, 11, 12].includes(Number(data.khoi)) ||
      !Number.isInteger(Number(data.nhom)) || Number(data.nhom) <= 0 ||
      !Number.isInteger(Number(data.si_so)) || Number(data.si_so) <= 0) {
    throw new WorkflowError(400, "Cần tên lớp, khối 10–12, nhóm và sĩ số nguyên dương.");
  }
  if (data.id) requireOwned(con, "lop", Number(data.id), namId);
  if (get(con, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten=? AND id<>?", [namId, data.ten, data.id || 0])) {
    throw new WorkflowError(409, "Tên lớp đã tồn tại trong năm học.");
  }
  if (data.id) {
    run(con, "UPDATE lop SET ten=?, khoi=?, nhom=?, si_so=?, gvcn=?, thu_tu=? WHERE id=? AND nam_hoc_id=?", [
      data.ten,
      data.khoi,
      data.nhom,
      data.si_so,
      data.gvcn ?? "",
      data.thu_tu ?? 0,
      data.id,
      namId,
    ]);
    return Number(data.id);
  }
  const r = run(con, "INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu) VALUES (?,?,?,?,?,?,?)", [
    namId,
    data.ten,
    data.khoi,
    data.nhom,
    data.si_so,
    data.gvcn ?? "",
    data.thu_tu ?? 0,
  ]);
  return Number(r.lastInsertRowid);
  });
}
export function deleteLop(con: Db, namId: number, lopId: number) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", lopId, namId);
    for (const table of all(con, "SELECT name FROM sqlite_master WHERE type='table'")) {
      const name = String(table.name).replaceAll('"', '""');
      const columns = all(con, `PRAGMA table_info("${name}")`);
      if (columns.some((column) => column.name === "lop_id") &&
          get(con, `SELECT 1 AS found FROM "${name}" WHERE lop_id=? LIMIT 1`, [lopId])) {
        throw new WorkflowError(409, "Lớp có lịch sử, chỉ được sửa thông tin; không thể xóa.");
      }
    }
    run(con, "DELETE FROM lop WHERE id=?", [lopId]);
  });
}
export function listTuan(con: Db, namId: number) {
  return all(con, "SELECT * FROM tuan WHERE nam_hoc_id=? ORDER BY CASE WHEN ngay_bd='' THEN 1 ELSE 0 END, ngay_bd, so_tuan", [namId]);
}
export function getTuan(con: Db, tuanId: number) {
  return get(con, "SELECT * FROM tuan WHERE id=?", [tuanId]);
}
export function upsertTuan(con: Db, namId: number, data: Dict) {
  if (data.id) {
    run(con, "UPDATE tuan SET so_tuan=?, thang=?, nam=?, hoc_ky=?, ghi_chu=?, ngay_bd=?, ngay_kt=? WHERE id=? AND nam_hoc_id=?", [
      data.so_tuan,
      data.thang,
      data.nam,
      data.hoc_ky,
      data.ghi_chu ?? "",
      data.ngay_bd ?? "",
      data.ngay_kt ?? "",
      data.id,
      namId,
    ]);
    return Number(data.id);
  }
  const r = run(
    con,
    "INSERT INTO tuan(nam_hoc_id, so_tuan, thang, nam, hoc_ky, ghi_chu, ngay_bd, ngay_kt, trang_thai) VALUES (?,?,?,?,?,?,?,?, 'nhap')",
    [namId, data.so_tuan, data.thang, data.nam, data.hoc_ky, data.ghi_chu ?? "", data.ngay_bd ?? "", data.ngay_kt ?? ""],
  );
  return Number(r.lastInsertRowid);
}
export function listQuyChe(con: Db) {
  return all(con, "SELECT * FROM quy_che ORDER BY id");
}
export function upsertQuyChe(con: Db, data: Dict) {
  const stt = String(data.stt ?? "").trim();
  const muc = String(data.muc ?? "").trim();
  const noiDung = String(data.noi_dung ?? "").trim();
  const diem = String(data.diem ?? "").trim();
  const ghiChu = String(data.ghi_chu ?? "").trim();
  if (!muc || !noiDung || !diem) throw new Error("Cần mục, nội dung và điểm.");
  if (stt.length > 20 || muc.length > 80 || noiDung.length > 2000 || diem.length > 200 || ghiChu.length > 500) {
    throw new Error("Nội dung quá dài.");
  }
  if (data.id) {
    run(con, "UPDATE quy_che SET stt=?, muc=?, noi_dung=?, diem=?, ghi_chu=? WHERE id=?", [
      stt,
      muc,
      noiDung,
      diem,
      ghiChu,
      Number(data.id),
    ]);
    return Number(data.id);
  }
  const r = run(con, "INSERT INTO quy_che(stt, muc, noi_dung, diem, ghi_chu) VALUES (?,?,?,?,?)", [
    stt,
    muc,
    noiDung,
    diem,
    ghiChu,
  ]);
  return Number(r.lastInsertRowid);
}
export function deleteQuyChe(con: Db, id: number) {
  run(con, "DELETE FROM quy_che WHERE id=?", [id]);
}

export function tuanLabel(t: Dict | undefined) {
  if (!t) return "Chưa có tuần";
  return `Tuần ${t.so_tuan} — Tháng ${t.thang}/${t.nam} (HK${t.hoc_ky})`;
}
