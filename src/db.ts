import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { GIO_KEYS, KTM_SCORE_KEYS, NN_KEYS, SCORE_FIELDS } from "./scoring.ts";
import { migrate } from "./migrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const DB_PATH = process.env.THIDUA_DB_PATH || path.join(DATA_DIR, "thidua.db");
export const REPORT_DIR = path.join(ROOT, "BaoCao");
export const SAMPLE_WEEK_NOTE = "Dữ liệu mẫu — Tuần 3 (theo file Excel cũ)";
export const ROSTER_YEAR = "2026-2027";
export type Dict = Record<string, unknown> & { [key: string]: unknown };
export type Db = DatabaseSync;
export type SeedClass = {
  thu_tu: number;
  gvcn: string;
  ten: string;
  si_so: number;
  nu: number;
  kt: number;
  loai_hinh: "chon" | "thuong";
};
export type ListLopOpts = { activeOnly?: boolean };

export function loadSeed(): { lop: SeedClass[]; quy_che: [string, string, string, string, string][] } {
  return JSON.parse(readFileSync(path.join(ROOT, "src", "seed.json"), "utf8"));
}

export function tableExists(con: Db, name: string): boolean {
  return Boolean(get(con, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]));
}

export function khoiFromTen(ten: string): number {
  return Number.parseInt(String(ten).trim(), 10);
}

export function nhomFromLoaiHinh(loaiHinh: string): number {
  return loaiHinh === "chon" ? 1 : 2;
}

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
    nu INTEGER NOT NULL DEFAULT 0,
    kt INTEGER NOT NULL DEFAULT 0,
    loai_hinh TEXT NOT NULL DEFAULT 'thuong' CHECK(loai_hinh IN ('chon','thuong')),
    ap_dung INTEGER NOT NULL DEFAULT 1 CHECK(ap_dung IN (0,1)),
    gvcn_group_id INTEGER,
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

const txDepth = new WeakMap<Db, number>();

export function inTransaction(con: Db): boolean {
  return (txDepth.get(con) ?? 0) > 0;
}

export function transaction<T>(con: Db, fn: () => T): T {
  const nested = inTransaction(con);
  con.exec(nested ? "SAVEPOINT workflow" : "BEGIN IMMEDIATE");
  try {
    txDepth.set(con, (txDepth.get(con) ?? 0) + 1);
    const result = fn();
    con.exec(nested ? "RELEASE workflow" : "COMMIT");
    return result;
  } catch (error) {
    con.exec(nested ? "ROLLBACK TO workflow; RELEASE workflow" : "ROLLBACK");
    throw error;
  } finally {
    const next = (txDepth.get(con) ?? 1) - 1;
    if (next <= 0) txDepth.delete(con);
    else txDepth.set(con, next);
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
  migrate(con);
  const seed = loadSeed();
  if (process.env.THIDUA_EMPTY_DB === "1") {
    if (!get(con, "SELECT id FROM quy_che LIMIT 1")) {
      transaction(con, () => {
        for (const row of seed.quy_che) {
          run(con, "INSERT INTO quy_che(stt,muc,noi_dung,diem,ghi_chu) VALUES (?,?,?,?,?)", row);
        }
      });
    }
    return;
  }
  if (get(con, "SELECT COUNT(*) AS c FROM nam_hoc")!.c) return;
  run(con, "INSERT INTO nam_hoc(ten, active) VALUES (?, 1)", [ROSTER_YEAR]);
  const namId = get(con, "SELECT id FROM nam_hoc WHERE ten=?", [ROSTER_YEAR])!.id;
  for (const row of seed.lop) {
    const loaiHinh = row.loai_hinh === "chon" ? "chon" : "thuong";
    run(con, `INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu, nu, kt, loai_hinh, ap_dung)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`, [
      namId,
      row.ten,
      khoiFromTen(row.ten),
      nhomFromLoaiHinh(loaiHinh),
      row.si_so,
      row.gvcn,
      row.thu_tu,
      row.nu,
      row.kt,
      loaiHinh,
    ]);
  }
  for (const row of seed.quy_che) {
    run(con, "INSERT INTO quy_che(stt, muc, noi_dung, diem, ghi_chu) VALUES (?,?,?,?,?)", row);
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
    for (const lop of all(con, "SELECT ten, khoi, nhom, si_so, gvcn, thu_tu, nu, kt, loai_hinh, ap_dung, gvcn_group_id FROM lop WHERE nam_hoc_id=?", [copyFrom])) {
      run(con, `INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu, nu, kt, loai_hinh, ap_dung, gvcn_group_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
        newId,
        lop.ten,
        lop.khoi,
        lop.nhom,
        lop.si_so,
        lop.gvcn,
        lop.thu_tu,
        lop.nu ?? 0,
        lop.kt ?? 0,
        lop.loai_hinh === "chon" ? "chon" : "thuong",
        Number(lop.ap_dung) === 0 ? 0 : 1,
        lop.gvcn_group_id ?? null,
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
export function listLop(con: Db, namId: number, { activeOnly = true }: ListLopOpts = {}) {
  const where = activeOnly ? "AND ap_dung=1" : "";
  return all(con, `SELECT * FROM lop WHERE nam_hoc_id=? ${where} ORDER BY thu_tu, khoi, ten`, [namId]);
}

export function loaiHinhMismatch(con: Db, namId: number) {
  return all(con, `SELECT ten FROM lop WHERE nam_hoc_id=? AND (nhom=1) != (loai_hinh='chon') ORDER BY thu_tu, ten`, [namId]);
}

export function leftoverClassReports(con: Db, namId: number) {
  if (!tableExists(con, "bao_cao_tuan")) return [];
  return all(con, `SELECT DISTINCT lop.ten AS ten
    FROM lop
    JOIN bao_cao_tuan ON bao_cao_tuan.lop_id=lop.id
    JOIN tuan ON tuan.id=bao_cao_tuan.tuan_id
    WHERE lop.nam_hoc_id=? AND lop.ap_dung=0 AND tuan.ghi_chu<>?
    ORDER BY lop.ten`, [namId, SAMPLE_WEEK_NOTE]);
}

export function setLopApDung(con: Db, namId: number, lopId: number, apDung: number) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", lopId, namId);
    const value = apDung === 0 ? 0 : 1;
    run(con, "UPDATE lop SET ap_dung=? WHERE id=? AND nam_hoc_id=?", [value, lopId, namId]);
    return value;
  });
}

export function upsertLop(con: Db, namId: number, data: Dict) {
  return transaction(con, () => {
  requireActiveYear(con, namId);
  data.ten = String(data.ten ?? "").trim().toUpperCase();
  const khoiTen = khoiFromTen(data.ten);
  if ([10, 11, 12].includes(khoiTen)) data.khoi = khoiTen;
  let loaiHinh: "chon" | "thuong";
  let nhom: number;
  if (data.loai_hinh === "chon" || data.loai_hinh === "thuong") {
    loaiHinh = data.loai_hinh;
    nhom = nhomFromLoaiHinh(loaiHinh);
  } else {
    nhom = Number(data.nhom);
    loaiHinh = nhom === 1 ? "chon" : "thuong";
  }
  const nu = data.nu == null || data.nu === "" ? 0 : Number(data.nu);
  const kt = data.kt == null || data.kt === "" ? 0 : Number(data.kt);
  const apDung = data.ap_dung === 0 || data.ap_dung === "0" ? 0 : 1;
  const thuTu = data.thu_tu == null || data.thu_tu === "" ? 0 : Number(data.thu_tu);
  if (!data.ten || ![10, 11, 12].includes(Number(data.khoi)) ||
      !Number.isInteger(nhom) || nhom <= 0 ||
      !Number.isInteger(Number(data.si_so)) || Number(data.si_so) <= 0 ||
      !Number.isInteger(nu) || nu < 0 || !Number.isInteger(kt) || kt < 0 ||
      !Number.isInteger(thuTu)) {
    throw new WorkflowError(400, "Cần tên lớp, khối 10–12, loại hình và sĩ số nguyên dương.");
  }
  if (data.id) requireOwned(con, "lop", Number(data.id), namId);
  if (get(con, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten=? AND id<>?", [namId, data.ten, data.id || 0])) {
    throw new WorkflowError(409, "Tên lớp đã tồn tại trong năm học.");
  }
  if (data.id) {
    run(con, `UPDATE lop SET ten=?, khoi=?, nhom=?, si_so=?, gvcn=?, thu_tu=?, nu=?, kt=?, loai_hinh=?, ap_dung=?
      WHERE id=? AND nam_hoc_id=?`, [
      data.ten,
      data.khoi,
      nhom,
      data.si_so,
      data.gvcn ?? "",
      thuTu,
      nu,
      kt,
      loaiHinh,
      apDung,
      data.id,
      namId,
    ]);
    return Number(data.id);
  }
  const r = run(con, `INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu, nu, kt, loai_hinh, ap_dung)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    namId,
    data.ten,
    data.khoi,
    nhom,
    data.si_so,
    data.gvcn ?? "",
    thuTu,
    nu,
    kt,
    loaiHinh,
    apDung,
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
