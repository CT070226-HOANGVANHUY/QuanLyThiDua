import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addNamHoc, all, get, initDb, run, setActiveNam, tableExists } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { initPlan } from "../src/plan.ts";
import {
  createTamKet,
  khenMilestoneKeys,
  milestoneTable,
  milestoneWeeks,
  parseMilestoneKy,
  saveMilestoneEntries,
  saveMilestoneWeeks,
  suggestedHoiHocWeeks,
} from "../src/milestones.ts";
import { reportTables } from "../src/report-export.ts";

process.env.THIDUA_EMPTY_DB = "1";

function emptyDb() {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  initPlan(db);
  return db;
}

function colNames(db: DatabaseSync, table: string) {
  return all(db, `PRAGMA table_info(${table})`).map((row) => String(row.name));
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function publishWeek(
  db: DatabaseSync,
  namId: number,
  soTuan: number,
  start: string,
  ranks: { lop_id: number; xt: number }[],
  status = "cong_bo",
) {
  const end = addDays(start, 6);
  run(db, `INSERT INTO tuan(nam_hoc_id,so_tuan,thang,nam,hoc_ky,ngay_bd,ngay_kt,trang_thai,included,calendar_no)
    VALUES (?,?,?,?,1,?,?,?,1,?)`, [
    namId, soTuan, Number(start.slice(5, 7)), Number(start.slice(0, 4)), start, end, status,
    soTuan,
  ]);
  const tuanId = Number(get(db, "SELECT id FROM tuan WHERE nam_hoc_id=? AND so_tuan=?", [namId, soTuan])!.id);
  if (status === "cong_bo") {
    run(db, "INSERT INTO week_snapshot(tuan_id,payload_json,revision,created_at) VALUES (?,?,1,datetime('now'))", [
      tuanId,
      JSON.stringify({
        results: ranks.map((row) => ({ lop_id: row.lop_id, xt_chung: row.xt, rank_status: "official" })),
      }),
    ]);
  }
  return tuanId;
}

test("migrate v4 inserts empty 20-11/26-3, no weeks, user_version=8", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE lop (
        id INTEGER PRIMARY KEY, nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id),
        ten TEXT NOT NULL, khoi INTEGER NOT NULL, nhom INTEGER NOT NULL, si_so INTEGER NOT NULL DEFAULT 0,
        gvcn TEXT NOT NULL DEFAULT '', thu_tu INTEGER NOT NULL DEFAULT 0, UNIQUE(nam_hoc_id, ten)
      );
      PRAGMA user_version=4;`);
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
    migrate(db);
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
    const rows = all(db, "SELECT ma, loai, ten FROM milestone WHERE nam_hoc_id=1 ORDER BY ma");
    assert.deepEqual(rows.map((r) => r.ma), ["20-11", "26-3", "dot_1", "dot_2", "dot_3", "dot_4"]);
    assert.ok(rows.filter((r) => r.loai === "hoi_hoc").every((r) => r.ma === "20-11" || r.ma === "26-3"));
    assert.equal(get(db, "SELECT id FROM milestone WHERE ma='tam_ket'"), undefined);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone_week")?.n, 0);
    assert.ok(tableExists(db, "milestone_activity"));
    assert.ok(tableExists(db, "milestone_entry"));
  } finally { db.close(); }
});

test("v6 with su_kien gets v7 columns then v8 tables; paper loai backfill giay", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE su_kien (
        id INTEGER PRIMARY KEY, loai TEXT NOT NULL, ho_ten TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE year_formula (
        nam_id INTEGER PRIMARY KEY REFERENCES nam_hoc(id),
        ktm_divisor TEXT NOT NULL DEFAULT 'count',
        hk_month_weight REAL NOT NULL DEFAULT 2,
        hoi_hoc_double TEXT NOT NULL DEFAULT 'none',
        gvcn_5_1_window TEXT NOT NULL DEFAULT 'semester'
      );
      PRAGMA user_version=6;`);
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
    run(db, "INSERT INTO year_formula(nam_id) VALUES (1)");
    run(db, "INSERT INTO su_kien(loai,ho_ten) VALUES ('di_muon','A'),('vp_khac','B'),('other','C')");
    migrate(db);
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
    for (const col of ["tap_the", "gvcn_phat_hien", "nguon"]) {
      assert.ok(colNames(db, "su_kien").includes(col), col);
    }
    assert.equal(get(db, "SELECT nguon FROM su_kien WHERE loai='di_muon'")?.nguon, "giay");
    assert.equal(get(db, "SELECT nguon FROM su_kien WHERE loai='vp_khac'")?.nguon, "giay");
    assert.equal(get(db, "SELECT nguon FROM su_kien WHERE loai='other'")?.nguon, "tnkt");
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone WHERE nam_hoc_id=1 AND loai='hoi_hoc'")?.n, 2);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone_week")?.n, 0);
  } finally { db.close(); }
});

test("addNamHoc inserts empty hội học rows and copyFrom does not copy weeks or create tam_ket", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
    const rows = all(db, "SELECT * FROM milestone WHERE nam_hoc_id=? AND loai='hoi_hoc' ORDER BY ma", [namId]);
    assert.deepEqual(rows.map((r) => [r.ma, r.loai, r.ten]), [
      ["20-11", "hoi_hoc", "Hội học 20/11"],
      ["26-3", "hoi_hoc", "Hội học 26/3"],
    ]);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone WHERE nam_hoc_id=? AND ma LIKE 'dot_%'", [namId])?.n, 4);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone_week")?.n, 0);
    assert.equal(get(db, "SELECT id FROM milestone WHERE ma='tam_ket'"), undefined);
    run(db, `INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung)
      VALUES (?,'10A1',10,1,40,1,'chon',1)`, [namId]);
    const ms = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    saveMilestoneWeeks(db, namId, ms, ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"]);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone_week WHERE milestone_id=?", [ms])?.n, 4);
    createTamKet(db, namId, "union");
    assert.ok(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='tam_ket'", [namId]));
    const copied = Number(addNamHoc(db, "2027-2028", namId));
    const copyRows = all(db, "SELECT ma, loai FROM milestone WHERE nam_hoc_id=? AND loai='hoi_hoc' ORDER BY ma", [copied]);
    assert.deepEqual(copyRows.map((r) => r.ma), ["20-11", "26-3"]);
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM milestone_week mw
      JOIN milestone m ON m.id=mw.milestone_id WHERE m.nam_hoc_id=?`, [copied])?.n, 0);
    assert.equal(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='tam_ket'", [copied]), undefined);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone WHERE nam_hoc_id=? AND ma LIKE 'dot_%'", [copied])?.n, 4);
  } finally { db.close(); }
});

test("suggested hội học weeks overlap November/March and are not T7–T10", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    const nov = suggestedHoiHocWeeks(db, namId, "20-11");
    const mar = suggestedHoiHocWeeks(db, namId, "26-3");
    assert.ok(nov.length >= 4);
    assert.notDeepEqual(nov.map((w) => w.calendar_no), [7, 8, 9, 10]);
    assert.ok(nov.every((w) => w.ngay_bd.slice(5, 7) === "11" || w.ngay_kt.slice(5, 7) === "11"));
    assert.ok(nov.some((w) => w.ngay_bd === "2026-10-30"));
    assert.ok(nov.every((w) => !w.selected));
    assert.ok(mar.every((w) => w.ngay_bd.slice(5, 7) === "03" || w.ngay_kt.slice(5, 7) === "03"));
    assert.ok(mar.some((w) => w.ngay_bd === "2027-02-26"));
  } finally { db.close(); }
});

test("official null without 4 published weeks; none = SUM 4 xt_chung then RANK", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    run(db, `INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung) VALUES
      (?,'A',10,1,40,1,'chon',1),(?,'B',10,1,40,2,'chon',1)`, [namId, namId]);
    const a = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='A'", [namId])!.id);
    const b = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='B'", [namId])!.id);
    const ms = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    const empty = milestoneTable(db, namId, ms, "official");
    assert.ok(empty.rows.every((row) => row.xt_dot == null && row.tong == null));

    const starts = ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"];
    const ranks = [
      [{ lop_id: a, xt: 3 }, { lop_id: b, xt: 1 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 7 }],
      [{ lop_id: a, xt: 11 }, { lop_id: b, xt: 10 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 2 }],
    ];
    const weekIds = starts.map((start, i) =>
      publishWeek(db, namId, i + 1, start, ranks[i], i === 3 ? "nhap" : "cong_bo"));
    weekIds.forEach((id, i) => {
      run(db, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [ms, id, i + 1]);
    });
    const missing = milestoneTable(db, namId, ms, "official");
    assert.ok(missing.rows.every((row) => row.xt_dot == null));
    const preview = milestoneTable(db, namId, ms, "preview");
    assert.equal(preview.rows.find((r) => r.ten === "A")!.tong, 15);
    assert.equal(preview.rows.find((r) => r.ten === "B")!.tong, 18);

    run(db, "UPDATE tuan SET trang_thai='cong_bo' WHERE id=?", [weekIds[3]]);
    run(db, "INSERT INTO week_snapshot(tuan_id,payload_json,revision,created_at) VALUES (?,?,1,datetime('now'))", [
      weekIds[3],
      JSON.stringify({
        results: ranks[3].map((row) => ({ lop_id: row.lop_id, xt_chung: row.xt, rank_status: "official" })),
      }),
    ]);
    const official = milestoneTable(db, namId, ms, "official");
    const rowA = official.rows.find((r) => r.ten === "A")!;
    const rowB = official.rows.find((r) => r.ten === "B")!;
    assert.equal(rowA.tong, 16);
    assert.equal(rowB.tong, 20);
    assert.equal(rowA.xt_dot, 1);
    assert.equal(rowB.xt_dot, 2);
  } finally { db.close(); }
});

test("hdtt_only adds 2×xt_hdtt; week_xt doubles tong but keeps rank", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    run(db, `INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung) VALUES
      (?,'A',10,1,40,1,'chon',1),(?,'B',10,1,40,2,'chon',1)`, [namId, namId]);
    const a = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='A'", [namId])!.id);
    const b = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='B'", [namId])!.id);
    const ms = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    const starts = ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"];
    const ranks = [
      [{ lop_id: a, xt: 4 }, { lop_id: b, xt: 3 }],
      [{ lop_id: a, xt: 3 }, { lop_id: b, xt: 3 }],
      [{ lop_id: a, xt: 2 }, { lop_id: b, xt: 3 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 2 }],
    ];
    starts.forEach((start, i) => {
      const id = publishWeek(db, namId, i + 1, start, ranks[i]);
      run(db, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [ms, id, i + 1]);
    });
    const none = milestoneTable(db, namId, ms, "official");
    assert.equal(none.rows.find((r) => r.ten === "A")!.tong, 10);
    assert.equal(none.rows.find((r) => r.ten === "B")!.tong, 11);
    assert.equal(none.rows.find((r) => r.ten === "A")!.xt_dot, 1);
    assert.equal(none.rows.find((r) => r.ten === "B")!.xt_dot, 2);

    run(db, "UPDATE year_formula SET hoi_hoc_double='week_xt' WHERE nam_id=?", [namId]);
    const doubled = milestoneTable(db, namId, ms, "official");
    assert.equal(doubled.rows.find((r) => r.ten === "A")!.tong, 20);
    assert.equal(doubled.rows.find((r) => r.ten === "B")!.tong, 22);
    assert.equal(doubled.rows.find((r) => r.ten === "A")!.xt_dot, 1);
    assert.equal(doubled.rows.find((r) => r.ten === "B")!.xt_dot, 2);
    assert.ok((doubled.notes as string[]).some((n) => /thứ tự lớp không đổi/.test(n)));

    run(db, "UPDATE year_formula SET hoi_hoc_double='hdtt_only' WHERE nam_id=?", [namId]);
    const noHdtt = milestoneTable(db, namId, ms, "official");
    assert.ok(noHdtt.rows.every((row) => row.xt_dot == null && row.tong == null));
    run(db, "INSERT INTO milestone_activity(milestone_id,lop_id,the_thao,van_nghe) VALUES (?,?,2,2),(?,?,1,1)", [ms, a, ms, b]);
    const hdtt = milestoneTable(db, namId, ms, "official");
    assert.equal(hdtt.rows.find((r) => r.ten === "A")!.xt_hdtt, 2);
    assert.equal(hdtt.rows.find((r) => r.ten === "B")!.xt_hdtt, 1);
    assert.equal(hdtt.rows.find((r) => r.ten === "A")!.tong, 14);
    assert.equal(hdtt.rows.find((r) => r.ten === "B")!.tong, 13);
    assert.equal(hdtt.rows.find((r) => r.ten === "B")!.xt_dot, 1);
    assert.equal(hdtt.rows.find((r) => r.ten === "A")!.xt_dot, 2);

    run(db, "UPDATE year_formula SET hoi_hoc_double='hdtt' WHERE nam_id=?", [namId]);
    const hdttOnce = milestoneTable(db, namId, ms, "official");
    assert.equal(hdttOnce.rows.find((r) => r.ten === "A")!.tong, 12);
    assert.equal(hdttOnce.rows.find((r) => r.ten === "B")!.tong, 12);
  } finally { db.close(); }
});

test("saving hội học weeks syncs tam_ket nguon_tuan=union", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    const nov = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    const mar = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='26-3'", [namId])!.id);
    assert.equal(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='tam_ket'", [namId]), undefined);
    const tam = createTamKet(db, namId, "union");
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone_week WHERE milestone_id=?", [tam])?.n, 0);
    saveMilestoneWeeks(db, namId, nov, ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"]);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone_week WHERE milestone_id=?", [tam])?.n, 4);
    saveMilestoneWeeks(db, namId, mar, ["2027-02-26", "2027-03-05", "2027-03-12", "2027-03-19"]);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM milestone_week WHERE milestone_id=?", [tam])?.n, 8);
    saveMilestoneWeeks(db, namId, nov, ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
    const unionStarts = all(db, `SELECT t.ngay_bd FROM milestone_week mw JOIN tuan t ON t.id=mw.tuan_id
      WHERE mw.milestone_id=? ORDER BY mw.thu_tu`, [tam]).map((row) => String(row.ngay_bd));
    assert.equal(unionStarts.length, 8);
    assert.ok(!unionStarts.includes("2026-10-30"));
    assert.ok(unionStarts.includes("2026-11-27"));
    assert.ok(unionStarts.includes("2027-03-19"));
    assert.throws(() => createTamKet(db, namId, "union"), { status: 400 });
  } finally { db.close(); }
});

test("hội học ranking has 4 XT columns + tong + xt_dot + kỷ luật/khen like 20-11-2025", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    run(db, `INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung) VALUES
      (?,'A',10,1,40,1,'chon',1),(?,'B',10,1,40,2,'chon',1)`, [namId, namId]);
    const a = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='A'", [namId])!.id);
    const b = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='B'", [namId])!.id);
    const ms = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    const starts = ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"];
    const ranks = [
      [{ lop_id: a, xt: 3 }, { lop_id: b, xt: 1 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 7 }],
      [{ lop_id: a, xt: 11 }, { lop_id: b, xt: 10 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 2 }],
    ];
    starts.forEach((start, i) => {
      const id = publishWeek(db, namId, i + 1, start, ranks[i]);
      run(db, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [ms, id, i + 1]);
    });
    const table = milestoneTable(db, namId, ms, "official");
    const weekCols = milestoneWeeks(db, ms).map((week) => `w_${week.id}`);
    assert.equal(weekCols.length, 4);
    const colKeys = (table.columns as [string, string][]).map(([key]) => key);
    for (const key of [...weekCols, "ten", "tong", "xt_dot", "discipline", "reward"]) {
      assert.ok(colKeys.includes(key), key);
    }
    const rowA = table.rows.find((r) => r.ten === "A")!;
    const rowB = table.rows.find((r) => r.ten === "B")!;
    assert.deepEqual(weekCols.map((key) => rowA[key]), [3, 1, 11, 1]);
    assert.deepEqual(weekCols.map((key) => rowB[key]), [1, 7, 10, 2]);
    assert.equal(rowA.tong, 16);
    assert.equal(rowB.tong, 20);
    assert.equal(rowA.xt_dot, 1);
    assert.equal(rowB.xt_dot, 2);
    saveMilestoneEntries(db, namId, ms, {
      [`discipline_${a}`]: "Khiển trách",
      [`reward_${a}`]: "Giấy khen",
      [`notes_${a}`]: "Ghi chú A",
    });
    const noted = milestoneTable(db, namId, ms, "official").rows.find((r) => r.ten === "A")!;
    assert.equal(noted.discipline, "Khiển trách");
    assert.equal(noted.reward, "Giấy khen");
    assert.equal(noted.notes, "Ghi chú A");
    assert.equal(tableExists(db, "period_entry") ? Number(get(db, "SELECT COUNT(*) AS n FROM period_entry")?.n) : 0, 0);
  } finally { db.close(); }
});

test("tam_ket SUM 8 xt_chung, not xt_dot of two hội học", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    run(db, `INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung) VALUES
      (?,'A',10,1,40,1,'chon',1),(?,'B',10,1,40,2,'chon',1)`, [namId, namId]);
    const a = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='A'", [namId])!.id);
    const b = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='B'", [namId])!.id);
    const nov = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    const mar = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='26-3'", [namId])!.id);
    const novStarts = ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"];
    const marStarts = ["2027-02-26", "2027-03-05", "2027-03-12", "2027-03-19"];
    const novRanks = [
      [{ lop_id: a, xt: 3 }, { lop_id: b, xt: 1 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 7 }],
      [{ lop_id: a, xt: 11 }, { lop_id: b, xt: 10 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 2 }],
    ];
    const marRanks = [
      [{ lop_id: a, xt: 5 }, { lop_id: b, xt: 4 }],
      [{ lop_id: a, xt: 8 }, { lop_id: b, xt: 4 }],
      [{ lop_id: a, xt: 1 }, { lop_id: b, xt: 2 }],
      [{ lop_id: a, xt: 2 }, { lop_id: b, xt: 1 }],
    ];
    novStarts.forEach((start, i) => {
      const id = publishWeek(db, namId, i + 1, start, novRanks[i]);
      run(db, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [nov, id, i + 1]);
    });
    marStarts.forEach((start, i) => {
      const id = publishWeek(db, namId, i + 11, start, marRanks[i]);
      run(db, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [mar, id, i + 1]);
    });
    const hoiNov = milestoneTable(db, namId, nov, "official");
    const hoiMar = milestoneTable(db, namId, mar, "official");
    assert.equal(hoiNov.rows.find((r) => r.ten === "A")!.xt_dot, 1);
    assert.equal(hoiNov.rows.find((r) => r.ten === "B")!.xt_dot, 2);
    assert.equal(hoiMar.rows.find((r) => r.ten === "A")!.xt_dot, 2);
    assert.equal(hoiMar.rows.find((r) => r.ten === "B")!.xt_dot, 1);
    const tam = createTamKet(db, namId, "union");
    const table = milestoneTable(db, namId, tam, "official");
    assert.equal(milestoneWeeks(db, tam).length, 8);
    const rowA = table.rows.find((r) => r.ten === "A")!;
    const rowB = table.rows.find((r) => r.ten === "B")!;
    assert.equal(rowA.complete_count, 8);
    assert.equal(rowA.tong, 32);
    assert.equal(rowB.tong, 31);
    assert.equal(rowA.xt_dot, 2);
    assert.equal(rowB.xt_dot, 1);
    assert.notEqual(rowA.tong, Number(hoiNov.rows.find((r) => r.ten === "A")!.xt_dot)
      + Number(hoiMar.rows.find((r) => r.ten === "A")!.xt_dot));
  } finally { db.close(); }
});

test("/khen hoi_hoc and tam_ket keys use milestone_entry; export scopes hoi_hoc/tam_ket", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    run(db, `INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung) VALUES
      (?,'A',10,1,40,1,'chon',1),(?,'B',10,1,40,2,'chon',1)`, [namId, namId]);
    const a = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='A'", [namId])!.id);
    const b = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='B'", [namId])!.id);
    const ms = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    const starts = ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"];
    starts.forEach((start, i) => {
      const id = publishWeek(db, namId, i + 1, start, [{ lop_id: a, xt: i + 1 }, { lop_id: b, xt: i + 2 }]);
      run(db, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [ms, id, i + 1]);
    });
    const keys = khenMilestoneKeys(db, namId);
    assert.deepEqual(keys.filter(([key]) => key.startsWith("hoi_hoc")).map(([key]) => key.split(":")[0]), ["hoi_hoc", "hoi_hoc"]);
    assert.equal(keys.filter(([key]) => key.startsWith("tam_ket")).length, 4);
    assert.deepEqual(parseMilestoneKy(`hoi_hoc:${ms}`), { loai: "hoi_hoc", id: ms });
    saveMilestoneEntries(db, namId, ms, { [`kq_${a}`]: "Khen hội học", [`gc_${a}`]: "Ghi chú khen" });
    const row = milestoneTable(db, namId, ms, "official").rows.find((r) => r.ten === "A")!;
    assert.equal(row.reward, "Khen hội học");
    assert.equal(row.notes, "Ghi chú khen");
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM khen_thuong")?.n ?? 0, 0);
    const exported = reportTables(db, namId, {
      scope: "hoi_hoc", key: String(ms), model: "monthly", view: "official", cut: "school",
    });
    assert.equal(exported[0].rows.find((r) => r.ten === "A")!.tong, 10);
    assert.equal(exported[0].rows.find((r) => r.ten === "A")!.reward, "Khen hội học");
    const tam = createTamKet(db, namId, "union");
    assert.ok(khenMilestoneKeys(db, namId).some(([key]) => key === `tam_ket:${tam}`));
    saveMilestoneEntries(db, namId, tam, { [`kq_${a}`]: "Khen 8 tuần" });
    const tamTable = reportTables(db, namId, {
      scope: "tam_ket", key: String(tam), model: "monthly", view: "official", cut: "school",
    });
    assert.equal(tamTable[0].rows.find((r) => r.ten === "A")!.reward, "Khen 8 tuần");
    assert.throws(() => reportTables(db, namId, {
      scope: "loi_hs" as never, key: "1", model: "monthly", view: "official", cut: "school",
    }), /Phạm vi xuất không hợp lệ/);
  } finally { db.close(); }
});
