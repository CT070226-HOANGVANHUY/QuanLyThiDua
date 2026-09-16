import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { get, initDb, listLop, run, SAMPLE_WEEK_NOTE, upsertLop } from "../src/db.ts";
import { deleteSampleWeek, initPlan } from "../src/plan.ts";
import { migrate } from "../src/migrate.ts";

function openV4Roster() {
  const db = new DatabaseSync(":memory:");
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
  const old: [number, string, number][] = [
    [1, "11A1", 47], [1, "11A2", 44], [1, "11A3", 47], [1, "11A4", 46],
    [1, "10A1", 44], [1, "10A2", 42], [1, "10A4", 43], [1, "10A6", 43], [1, "10A8", 42],
    [1, "12A1", 45], [1, "12A2", 45], [1, "12A4", 44], [1, "12A8", 42], [1, "11A8", 41],
    [2, "11A5", 45], [2, "11A6", 46], [2, "11A7", 44], [2, "11A9", 38], [2, "11A10", 41],
    [2, "10A3", 43], [2, "10A5", 43], [2, "10A7", 43], [2, "10A9", 41], [2, "10A10", 41],
    [2, "12A3", 45], [2, "12A5", 42], [2, "12A6", 42], [2, "12A7", 44], [2, "12A9", 43], [2, "12A10", 42],
  ];
  old.forEach(([nhom, ten, siSo], i) => {
    run(db, "INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu) VALUES (1,?,?,?,?,?)",
      [ten, Number(ten.slice(0, 2)), nhom, siSo, i + 1]);
  });
  return db;
}

const CHON = ["10A1", "10A2", "10A3", "11A1", "11A8", "12A1", "12A2"];

function seededDb() {
  const prev = process.env.THIDUA_EMPTY_DB;
  delete process.env.THIDUA_EMPTY_DB;
  const db = new DatabaseSync(":memory:");
  try {
    initDb(db);
    initPlan(db);
  } finally {
    if (prev == null) delete process.env.THIDUA_EMPTY_DB;
    else process.env.THIDUA_EMPTY_DB = prev;
  }
  return db;
}

test("fresh db seeds 2026-2027 roster without sample week 3", () => {
  const db = seededDb();
  try {
    const active = listLop(db, 1);
    const all = listLop(db, 1, { activeOnly: false });
    assert.equal(active.length, 30);
    assert.equal(all.length, 30);
    assert.equal(active.some((row) => row.ten === "10A7"), false);
    assert.equal(all.some((row) => row.ten === "10A7"), false);
    const d1 = active.find((row) => row.ten === "10A1");
    const d10 = active.find((row) => row.ten === "10D1");
    const a4 = active.find((row) => row.ten === "10A4");
    assert.ok(d10);
    assert.equal(d10?.khoi, 10);
    assert.equal(d10?.nhom, 2);
    assert.equal(d10?.loai_hinh, "thuong");
    assert.equal(d10?.gvcn, "Đỗ Văn Dương");
    assert.equal(d1?.loai_hinh, "chon");
    assert.equal(d1?.nhom, 1);
    assert.equal(a4?.loai_hinh, "thuong");
    assert.equal(a4?.nhom, 2);
    assert.deepEqual(active.filter((row) => row.loai_hinh === "chon").map((row) => row.ten), CHON);
    for (const row of active) {
      assert.equal(row.nhom, row.loai_hinh === "chon" ? 1 : 2);
      assert.equal(row.ap_dung, 1);
    }
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM tuan")?.n, 0);
    assert.equal(get(db, "SELECT id FROM tuan WHERE so_tuan=3 AND ghi_chu=?", [SAMPLE_WEEK_NOTE]), undefined);
    assert.ok(Number(get(db, "SELECT COUNT(*) AS n FROM quy_che")?.n) > 0);
    assert.equal(active[0]?.ten, "10A1");
    assert.equal(active[6]?.ten, "10D1");
  } finally { db.close(); }
});

test("listLop activeOnly hides leftover 10A7 after v5 import and 10D1 is present", () => {
  const db = openV4Roster();
  try {
    migrate(db);
    const active = listLop(db, 1);
    const all = listLop(db, 1, { activeOnly: false });
    assert.equal(active.some((row) => row.ten === "10A7"), false);
    assert.ok(all.some((row) => row.ten === "10A7"));
    assert.ok(active.some((row) => row.ten === "10D1"));
    assert.equal(active.find((row) => row.ten === "10A1")?.nhom, 1);
    assert.equal(active.find((row) => row.ten === "10A1")?.loai_hinh, "chon");
    assert.equal(active.find((row) => row.ten === "11A8")?.nhom, 1);
    assert.equal(active.find((row) => row.ten === "10A4")?.nhom, 2);
  } finally { db.close(); }
});

test("selecting loai_hinh writes matching nhom; 10D* is khoi 10", () => {
  const prev = process.env.THIDUA_EMPTY_DB;
  process.env.THIDUA_EMPTY_DB = "1";
  const db = new DatabaseSync(":memory:");
  try {
    initDb(db);
    initPlan(db);
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
    const chonId = upsertLop(db, 1, { ten: "10A1", khoi: 10, si_so: 40, loai_hinh: "chon", gvcn: "A" });
    assert.equal(get(db, "SELECT nhom, loai_hinh FROM lop WHERE id=?", [chonId])?.nhom, 1);
    assert.equal(get(db, "SELECT loai_hinh FROM lop WHERE id=?", [chonId])?.loai_hinh, "chon");
    upsertLop(db, 1, { id: chonId, ten: "10A1", khoi: 10, si_so: 40, loai_hinh: "thuong" });
    assert.equal(get(db, "SELECT nhom, loai_hinh FROM lop WHERE id=?", [chonId])?.nhom, 2);
    const dId = upsertLop(db, 1, { ten: "10D1", khoi: 12, si_so: 44, loai_hinh: "thuong", nu: 24, kt: 2 });
    assert.equal(get(db, "SELECT khoi, nhom FROM lop WHERE id=?", [dId])?.khoi, 10);
    assert.equal(get(db, "SELECT nhom FROM lop WHERE id=?", [dId])?.nhom, 2);
  } finally {
    db.close();
    if (prev == null) delete process.env.THIDUA_EMPTY_DB;
    else process.env.THIDUA_EMPTY_DB = prev;
  }
});

test("deleting sample week with week_class does not raise SQLITE_CONSTRAINT", () => {
  const prev = process.env.THIDUA_EMPTY_DB;
  process.env.THIDUA_EMPTY_DB = "1";
  const db = new DatabaseSync(":memory:");
  try {
    initDb(db);
    initPlan(db);
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    run(db, "INSERT INTO tuan(id,nam_hoc_id,so_tuan,thang,nam,ghi_chu,trang_thai) VALUES (9,1,3,9,2026,?, 'nhap')", [SAMPLE_WEEK_NOTE]);
    run(db, "INSERT INTO week_class(tuan_id,lop_id,ten,nhom,si_so,gvcn) VALUES (9,1,'10A1',1,30,'')");
    run(db, "INSERT INTO week_snapshot(tuan_id,payload_json,revision,created_at) VALUES (9,'{}',0,datetime('now'))");
    run(db, "INSERT INTO week_status_log(tuan_id,from_status,to_status,reason) VALUES (9,'nhap','chot','mẫu')");
    run(db, "INSERT INTO weekly_legacy_input(tuan_id,lop_id,payload_json) VALUES (9,1,'{}')");
    run(db, "INSERT INTO manual_score_conflict(tuan_id,lop_id,tieu_chi_id) VALUES (9,1,1)");
    deleteSampleWeek(db, 1);
    assert.equal(get(db, "SELECT id FROM tuan WHERE id=9"), undefined);
    assert.equal(get(db, "SELECT 1 AS n FROM week_class WHERE tuan_id=9"), undefined);
    assert.equal(get(db, "SELECT 1 AS n FROM week_snapshot WHERE tuan_id=9"), undefined);
  } finally {
    db.close();
    if (prev == null) delete process.env.THIDUA_EMPTY_DB;
    else process.env.THIDUA_EMPTY_DB = prev;
  }
});
