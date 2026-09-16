import { existsSync } from "node:fs";
import path from "node:path";
import { addColumn, all, applyLeftoverWeekClass, get, loadSeed, run, syncNhapWeekClass, tableExists, type Db } from "./db.ts";

function userVersion(con: Db): number {
  return Number(get(con, "PRAGMA user_version")?.user_version ?? 0);
}

function dbFilePath(con: Db): string {
  return String(get(con, "SELECT file FROM pragma_database_list WHERE name='main'")?.file ?? "");
}

function backupBeforeV5(con: Db) {
  const file = dbFilePath(con);
  if (!file) return;
  const backupPath = `${path.resolve(file)}.before-v5.db`;
  if (existsSync(backupPath)) return;
  con.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
}

function ensureV5Columns(con: Db) {
  if (tableExists(con, "lop")) {
    addColumn(con, "lop", "nu", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "lop", "kt", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "lop", "loai_hinh", "TEXT NOT NULL DEFAULT 'thuong' CHECK(loai_hinh IN ('chon','thuong'))");
    addColumn(con, "lop", "ap_dung", "INTEGER NOT NULL DEFAULT 1 CHECK(ap_dung IN (0,1))");
    addColumn(con, "lop", "gvcn_group_id", "INTEGER");
  }
  if (tableExists(con, "week_class")) {
    addColumn(con, "week_class", "thu_tu", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "week_class", "loai_hinh", "TEXT NOT NULL DEFAULT 'thuong'");
    addColumn(con, "week_class", "gvcn_group_id", "INTEGER");
    addColumn(con, "week_class", "ap_dung", "INTEGER NOT NULL DEFAULT 1");
  }
}

function backfillV5(con: Db) {
  if (tableExists(con, "lop")) {
    run(con, "UPDATE lop SET loai_hinh=CASE WHEN nhom=1 THEN 'chon' ELSE 'thuong' END");
  }
  if (tableExists(con, "week_class") && tableExists(con, "lop")) {
    con.exec(`UPDATE week_class SET
      thu_tu=COALESCE((SELECT thu_tu FROM lop WHERE lop.id=week_class.lop_id), thu_tu),
      loai_hinh=COALESCE((SELECT loai_hinh FROM lop WHERE lop.id=week_class.lop_id), loai_hinh),
      gvcn_group_id=(SELECT gvcn_group_id FROM lop WHERE lop.id=week_class.lop_id),
      ap_dung=COALESCE((SELECT ap_dung FROM lop WHERE lop.id=week_class.lop_id), ap_dung)`);
  }
}

function rosterYearId(con: Db): number | undefined {
  const named = get(con, "SELECT id FROM nam_hoc WHERE ten=?", ["2026-2027"]);
  if (named) return Number(named.id);
  const years = all(con, "SELECT id FROM nam_hoc");
  if (years.length === 1) return Number(years[0].id);
  return undefined;
}

export function importRoster2026(con: Db, namId?: number) {
  const id = namId ?? rosterYearId(con);
  if (id == null) return;
  const seed = loadSeed();
  const names = new Set(seed.lop.map((row) => row.ten));
  for (const row of seed.lop) {
    const loaiHinh = row.loai_hinh === "chon" ? "chon" : "thuong";
    const nhom = loaiHinh === "chon" ? 1 : 2;
    const khoi = Number.parseInt(row.ten, 10);
    const existing = get(con, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten=?", [id, row.ten]);
    if (existing) {
      run(con, `UPDATE lop SET si_so=?, gvcn=?, nu=?, kt=?, nhom=?, loai_hinh=?, thu_tu=?, ap_dung=1, khoi=?
        WHERE id=?`, [row.si_so, row.gvcn, row.nu, row.kt, nhom, loaiHinh, row.thu_tu, khoi, existing.id]);
    } else {
      run(con, `INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu, nu, kt, loai_hinh, ap_dung)
        VALUES (?,?,?,?,?,?,?,?,?,?,1)`, [
        id, row.ten, khoi, nhom, row.si_so, row.gvcn, row.thu_tu, row.nu, row.kt, loaiHinh,
      ]);
    }
  }
  for (const lop of all(con, "SELECT id, ten FROM lop WHERE nam_hoc_id=?", [id])) {
    if (!names.has(String(lop.ten))) run(con, "UPDATE lop SET ap_dung=0 WHERE id=?", [lop.id]);
  }
  applyLeftoverWeekClass(con, id);
  syncNhapWeekClass(con, id);
}

function migrateV5(con: Db) {
  backupBeforeV5(con);
  ensureV5Columns(con);
  backfillV5(con);
  importRoster2026(con);
}

export function ensureYearFormula(con: Db) {
  con.exec(`CREATE TABLE IF NOT EXISTS year_formula (
  nam_id INTEGER PRIMARY KEY REFERENCES nam_hoc(id) ON DELETE CASCADE,
  ktm_divisor TEXT NOT NULL DEFAULT 'count' CHECK(ktm_divisor IN ('count','si_so')),
  hk_month_weight REAL NOT NULL DEFAULT 2,
  hoi_hoc_double TEXT NOT NULL DEFAULT 'none' CHECK(hoi_hoc_double IN ('none','hdtt_only','week_xt')),
  gvcn_5_1_window TEXT NOT NULL DEFAULT 'semester' CHECK(gvcn_5_1_window IN ('semester','weekly'))
)`);
  if (tableExists(con, "nam_hoc")) {
    run(con, "INSERT OR IGNORE INTO year_formula(nam_id) SELECT id FROM nam_hoc");
  }
}

function hasColumn(con: Db, table: string, name: string) {
  return all(con, `PRAGMA table_info(${table})`).some((column) => column.name === name);
}

function migrateCatalogV6(con: Db) {
  if (tableExists(con, "tieu_chi")) {
    run(con, "UPDATE tieu_chi SET diem=-30 WHERE ma='phu_hieu_gia'");
    const withScoreKey = hasColumn(con, "tieu_chi", "score_key");
    const extra: [string, string, string, number, string, string][] = [
      ["gio_kem", "Giờ kém", "hoc_tap", -2, "giờ", "gio_kem"],
      ["xe_dap_de_sai_tap_the", "Để xe không đúng quy định — tập thể", "ne_nep", -10, "lần", "xe_dap"],
    ];
    for (const nam of all(con, "SELECT id FROM nam_hoc")) {
      for (const [ma, ten, nhom, diem, donVi, scoreKey] of extra) {
        if (withScoreKey) {
          run(con, `INSERT INTO tieu_chi(nam_hoc_id,ma,ten,nhom,diem,don_vi,ap_dung,score_key) VALUES (?,?,?,?,?,?,1,?)
            ON CONFLICT(nam_hoc_id,ma) DO NOTHING`, [nam.id, ma, ten, nhom, diem, donVi, scoreKey]);
        } else {
          run(con, `INSERT INTO tieu_chi(nam_hoc_id,ma,ten,nhom,diem,don_vi,ap_dung) VALUES (?,?,?,?,?,?,1)
            ON CONFLICT(nam_hoc_id,ma) DO NOTHING`, [nam.id, ma, ten, nhom, diem, donVi]);
        }
      }
    }
  }
  if (tableExists(con, "quy_che")) {
    run(con, "UPDATE quy_che SET diem='−30/HS' WHERE noi_dung LIKE '%hù hiệu giả%'");
  }
}

function migrateV6(con: Db) {
  ensureYearFormula(con);
  migrateCatalogV6(con);
}

export function migrate(con: Db): void {
  const steps: [number, (con: Db) => void][] = [[5, migrateV5], [6, migrateV6]];
  for (const [n, step] of steps) {
    if (userVersion(con) < n) {
      step(con);
      con.exec(`PRAGMA user_version=${n}`);
    }
  }
  ensureV5Columns(con);
  ensureYearFormula(con);
}
