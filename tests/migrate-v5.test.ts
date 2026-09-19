import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { get, all, initDb, listLop, run, setLopApDung, upsertLop } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { initPlan, setTuanStatus } from "../src/plan.ts";

const OLD_LOP: [number, string, number][] = [
  [1, "11A1", 47], [1, "11A2", 44], [1, "11A3", 47], [1, "11A4", 46],
  [1, "10A1", 44], [1, "10A2", 42], [1, "10A4", 43], [1, "10A6", 43], [1, "10A8", 42],
  [1, "12A1", 45], [1, "12A2", 45], [1, "12A4", 44], [1, "12A8", 42], [1, "11A8", 41],
  [2, "11A5", 45], [2, "11A6", 46], [2, "11A7", 44], [2, "11A9", 38], [2, "11A10", 41],
  [2, "10A3", 43], [2, "10A5", 43], [2, "10A7", 43], [2, "10A9", 41], [2, "10A10", 41],
  [2, "12A3", 45], [2, "12A5", 42], [2, "12A6", 42], [2, "12A7", 44], [2, "12A9", 43], [2, "12A10", 42],
];

function openV4Roster(dbPath: string | ":memory:" = ":memory:") {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE nam_hoc (
      id INTEGER PRIMARY KEY, ten TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE lop (
      id INTEGER PRIMARY KEY,
      nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
      ten TEXT NOT NULL, khoi INTEGER NOT NULL, nhom INTEGER NOT NULL,
      si_so INTEGER NOT NULL DEFAULT 0, gvcn TEXT NOT NULL DEFAULT '',
      thu_tu INTEGER NOT NULL DEFAULT 0, UNIQUE(nam_hoc_id, ten)
    );
    CREATE TABLE tuan (
      id INTEGER PRIMARY KEY,
      nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
      so_tuan INTEGER NOT NULL, thang INTEGER NOT NULL, nam INTEGER NOT NULL,
      hoc_ky INTEGER NOT NULL DEFAULT 1, ghi_chu TEXT NOT NULL DEFAULT '',
      trang_thai TEXT NOT NULL DEFAULT 'nhap', UNIQUE(nam_hoc_id, so_tuan)
    );
    CREATE TABLE week_class (
      tuan_id INTEGER NOT NULL REFERENCES tuan(id),
      lop_id INTEGER NOT NULL REFERENCES lop(id),
      ten TEXT NOT NULL, nhom INTEGER NOT NULL, si_so INTEGER NOT NULL,
      gvcn TEXT NOT NULL DEFAULT '', PRIMARY KEY(tuan_id, lop_id)
    );
    PRAGMA user_version=4;`);
  run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
  OLD_LOP.forEach(([nhom, ten, siSo], i) => {
    run(db, "INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu) VALUES (1,?,?,?,?,?)",
      [ten, Number(ten.slice(0, 2)), nhom, siSo, i + 1]);
  });
  run(db, "INSERT INTO tuan(id,nam_hoc_id,so_tuan,thang,nam,trang_thai) VALUES (1,1,1,9,2026,'nhap')");
  run(db, "INSERT INTO tuan(id,nam_hoc_id,so_tuan,thang,nam,trang_thai) VALUES (2,1,2,9,2026,'chot')");
  for (const lop of all(db, "SELECT * FROM lop")) {
    run(db, "INSERT INTO week_class(tuan_id,lop_id,ten,nhom,si_so,gvcn) VALUES (1,?,?,?,?,?)",
      [lop.id, lop.ten, lop.nhom, lop.si_so, ""]);
    run(db, "INSERT INTO week_class(tuan_id,lop_id,ten,nhom,si_so,gvcn) VALUES (2,?,?,?,?,?)",
      [lop.id, lop.ten, lop.nhom, lop.si_so, ""]);
  }
  return db;
}

function colNames(db: DatabaseSync, table: string) {
  return all(db, `PRAGMA table_info(${table})`).map((row) => String(row.name));
}

test("v4 roster migrates to v5 columns, backfill, leftover ap_dung=0 and nhap week_class import", () => {
  const db = openV4Roster();
  try {
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 4);
    migrate(db);
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
    assert.equal(get(db, "SELECT value FROM app_meta WHERE key='schema_max'")?.value, "12");
    assert.equal(get(db, "SELECT nguong FROM gvcn_ratio_group WHERE nam_hoc_id=1 AND ma='A'")?.nguong, 5);
    assert.equal(get(db, "SELECT nguong FROM gvcn_ratio_group WHERE nam_hoc_id=1 AND ma='B'")?.nguong, 7);
    assert.equal(get(db, "SELECT nguong FROM gvcn_ratio_group WHERE nam_hoc_id=1 AND ma='C'")?.nguong, 10);
    assert.ok(Number(get(db, "SELECT COUNT(*) AS n FROM lop WHERE gvcn_group_id IS NOT NULL")?.n) > 0);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM year_formula WHERE nam_id=1")?.n, 1);
    assert.equal(get(db, "SELECT ktm_divisor FROM year_formula WHERE nam_id=1")?.ktm_divisor, "si_so");
    assert.equal(get(db, "SELECT hk_month_weight FROM year_formula WHERE nam_id=1")?.hk_month_weight, 2);
    for (const col of ["nu", "kt", "loai_hinh", "ap_dung", "gvcn_group_id"]) {
      assert.ok(colNames(db, "lop").includes(col), `lop.${col}`);
    }
    for (const col of ["thu_tu", "loai_hinh", "gvcn_group_id", "ap_dung"]) {
      assert.ok(colNames(db, "week_class").includes(col), `week_class.${col}`);
    }
    const a4 = get(db, "SELECT * FROM lop WHERE ten='10A4'");
    assert.equal(a4?.loai_hinh, "thuong");
    assert.equal(a4?.nhom, 2);
    assert.equal(a4?.si_so, 44);
    assert.equal(a4?.ap_dung, 1);
    const leftover = get(db, "SELECT * FROM lop WHERE ten='10A7'");
    assert.equal(leftover?.ap_dung, 0);
    assert.equal(leftover?.loai_hinh, "thuong");
    assert.ok(get(db, "SELECT id FROM lop WHERE ten='10A9' AND ap_dung=0"));
    assert.ok(get(db, "SELECT id FROM lop WHERE ten='10A10' AND ap_dung=0"));
    const a8 = get(db, "SELECT * FROM lop WHERE ten='10A8'");
    assert.equal(a8?.ap_dung, 0);
    assert.equal(a8?.loai_hinh, "chon");
    assert.equal(a8?.nhom, 1);
    const d1 = get(db, "SELECT * FROM lop WHERE ten='10D1'");
    assert.ok(d1);
    assert.equal(d1?.khoi, 10);
    assert.equal(d1?.ap_dung, 1);
    assert.equal(d1?.gvcn, "Đỗ Văn Dương");
    assert.equal(get(db, "SELECT loai_hinh, nhom FROM lop WHERE ten='10A1'")?.loai_hinh, "chon");
    assert.equal(get(db, "SELECT nhom FROM lop WHERE ten='10A1'")?.nhom, 1);
    const nhapA4 = get(db, "SELECT * FROM week_class WHERE tuan_id=1 AND lop_id=?", [a4?.id]);
    assert.equal(nhapA4?.si_so, 44);
    assert.equal(nhapA4?.loai_hinh, "thuong");
    assert.equal(nhapA4?.nhom, 2);
    const leftoverWeek = get(db, "SELECT * FROM week_class WHERE tuan_id=1 AND lop_id=?", [leftover?.id]);
    assert.equal(leftoverWeek?.ap_dung, 0);
    assert.equal(get(db, "SELECT ap_dung FROM week_class WHERE tuan_id=2 AND lop_id=?", [leftover?.id])?.ap_dung, 0);
    const nhapD1 = get(db, "SELECT * FROM week_class WHERE tuan_id=1 AND lop_id=?", [d1?.id]);
    assert.ok(nhapD1);
    assert.equal(nhapD1?.ap_dung, 1);
    assert.equal(nhapD1?.ten, "10D1");
    assert.equal(get(db, "SELECT 1 AS n FROM week_class WHERE tuan_id=2 AND lop_id=?", [d1?.id]), undefined);
    const chotA4 = get(db, "SELECT * FROM week_class WHERE tuan_id=2 AND lop_id=?", [a4?.id]);
    assert.equal(chotA4?.si_so, 43);
    assert.equal(chotA4?.nhom, 1);
    assert.equal(listLop(db, 1).some((row) => row.ten === "10A7"), false);
    assert.ok(listLop(db, 1, { activeOnly: false }).some((row) => row.ten === "10A7"));
  } finally { db.close(); }
});

test("leftover 10A7 without da_gui does not 409 chốt after import", () => {
  const db = openV4Roster();
  try {
    migrate(db);
    initDb(db);
    initPlan(db);
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
    for (const col of ["tieu_chi_id", "tap_the", "gvcn_phat_hien", "nguon"]) {
      assert.ok(colNames(db, "su_kien").includes(col), `su_kien.${col}`);
    }
    run(db, "UPDATE tuan SET ngay_bd='2026-09-11', ngay_kt='2026-09-17', revision=0 WHERE id=1");
    const leftoverId = Number(get(db, "SELECT id FROM lop WHERE ten='10A7'")?.id);
    assert.equal(get(db, "SELECT ap_dung FROM week_class WHERE tuan_id=1 AND lop_id=?", [leftoverId])?.ap_dung, 0);
    for (const row of all(db, "SELECT lop_id FROM week_class WHERE tuan_id=1 AND ap_dung=1")) {
      run(db, "INSERT INTO bao_cao_tuan(tuan_id,lop_id,trang_thai) VALUES (1,?,'da_gui')", [row.lop_id]);
    }
    assert.equal(get(db, "SELECT 1 AS n FROM bao_cao_tuan WHERE tuan_id=1 AND lop_id=?", [leftoverId]), undefined);
    setTuanStatus(db, 1, 1, 0, "chot");
    assert.equal(get(db, "SELECT trang_thai FROM tuan WHERE id=1")?.trang_thai, "chot");
  } finally { db.close(); }
});

test("setLopApDung inserts leftover into nhap week_class and leaves chot frozen", () => {
  const db = openV4Roster();
  try {
    migrate(db);
    const leftoverId = Number(get(db, "SELECT id FROM lop WHERE ten='10A7'")?.id);
    assert.equal(get(db, "SELECT ap_dung FROM week_class WHERE tuan_id=1 AND lop_id=?", [leftoverId])?.ap_dung, 0);
    assert.equal(get(db, "SELECT ap_dung FROM week_class WHERE tuan_id=2 AND lop_id=?", [leftoverId])?.ap_dung, 0);
    setLopApDung(db, 1, leftoverId, 1);
    assert.equal(get(db, "SELECT ap_dung FROM lop WHERE id=?", [leftoverId])?.ap_dung, 1);
    assert.equal(get(db, "SELECT ap_dung FROM week_class WHERE tuan_id=1 AND lop_id=?", [leftoverId])?.ap_dung, 1);
    assert.equal(get(db, "SELECT ap_dung FROM week_class WHERE tuan_id=2 AND lop_id=?", [leftoverId])?.ap_dung, 0);
    const zId = upsertLop(db, 1, { ten: "10Z1", khoi: 10, si_so: 40, loai_hinh: "thuong" });
    assert.ok(get(db, "SELECT 1 AS n FROM week_class WHERE tuan_id=1 AND lop_id=? AND ap_dung=1", [zId]));
    assert.equal(get(db, "SELECT 1 AS n FROM week_class WHERE tuan_id=2 AND lop_id=?", [zId]), undefined);
  } finally { db.close(); }
});

test("v5 backup is VACUUM INTO beside the db file and skipped for memory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "thidua-v5-"));
  const file = path.join(dir, "thidua.db");
  const db = openV4Roster(file);
  let backup: DatabaseSync | undefined;
  try {
    migrate(db);
    const backupPath = `${file}.before-v5.db`;
    assert.ok(existsSync(backupPath));
    backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(get(backup, "PRAGMA user_version")?.user_version, 4);
    assert.equal(colNames(backup, "lop").includes("loai_hinh"), false);
    assert.ok(get(backup, "SELECT id FROM lop WHERE ten='10A7'"));
    assert.equal(get(backup, "SELECT ten FROM lop WHERE ten='10D1'"), undefined);
    migrate(db);
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
  } finally {
    backup?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
