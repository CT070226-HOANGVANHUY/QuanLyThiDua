import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addNamHoc, get, initDb, listLop, run, SAMPLE_WEEK_NOTE, transaction } from "../src/db.ts";
import { initConduct, gvcnScores, saveGvcnGroup, saveGvcnPhatHien, savePenalty } from "../src/conduct.ts";
import { initPlan, parseReport, resolveWeekForWrite, saveReport, setTuanStatus } from "../src/plan.ts";

process.env.THIDUA_EMPTY_DB = "1";

function reportForm(extra: Record<string, string> = {}) {
  return {
    gio_tong: "0", gio_tot: "0", gio_kha: "0", gio_tb: "0", gio_yeu: "0", gio_kem: "0",
    ktm_9_10: "0", ktm_7_8: "0", ktm_5_6: "0", ktm_3_4: "0", ktm_0_2: "0",
    bi_thu: "", ngay_lap: "2026-09-11", ghi_chu_ktm: "Không phát sinh", ...extra,
  };
}

function emptyDb() {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  initPlan(db);
  initConduct(db);
  run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
  initPlan(db);
  return db;
}

function groupId(db: DatabaseSync, ma: string, namId = 1) {
  return Number(get(db, "SELECT id FROM gvcn_ratio_group WHERE nam_hoc_id=? AND ma=?", [namId, ma])!.id);
}

function publish(db: DatabaseSync, namId: number, tuanId: number) {
  const rev = Number(get(db, "SELECT revision FROM tuan WHERE id=?", [tuanId])!.revision);
  setTuanStatus(db, namId, tuanId, rev, "chot");
  setTuanStatus(db, namId, tuanId, rev + 1, "cong_bo");
}

function submitClass(db: DatabaseSync, namId: number, tuanId: number, lopId: number, extra: Record<string, string> = {}) {
  const week = get(db, "SELECT * FROM tuan WHERE id=?", [tuanId])!;
  const revision = Number(get(db, "SELECT COALESCE(revision,0) AS r FROM bao_cao_tuan WHERE tuan_id=? AND lop_id=?", [tuanId, lopId])?.r ?? 0);
  saveReport(db, namId, { tuan_id: tuanId }, lopId, revision, parseReport(reportForm({
    ngay_lap: String(week.ngay_bd || "2026-09-11"),
    ...extra,
  }), week), "submit");
}

function openWeek(db: DatabaseSync, start: string) {
  return Number(transaction(db, () => resolveWeekForWrite(db, 1, { week_start: start })).id);
}

function seedClasses(db: DatabaseSync, count: number) {
  for (let i = 1; i <= count; i++) {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so,thu_tu) VALUES (?,?,?,10,1,30,?)",
      [i, 1, `10A${i}`, i]);
  }
}

function submitAll(db: DatabaseSync, tuanId: number, count: number, extraByLop: Record<number, Record<string, string>> = {}) {
  for (let i = 1; i <= count; i++) submitClass(db, 1, tuanId, i, extraByLop[i] ?? {});
}

test("v9 seeds A/B/C thresholds and does not assign classes", () => {
  const db = emptyDb();
  try {
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 9);
    const groups = ["A", "B", "C"].map((ma) => get(db, "SELECT * FROM gvcn_ratio_group WHERE nam_hoc_id=1 AND ma=?", [ma]));
    assert.equal(groups[0]?.nguong, 5);
    assert.equal(groups[1]?.nguong, 7);
    assert.equal(groups[2]?.nguong, 10);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM gvcn_ratio_group WHERE nam_hoc_id=1")?.n, 3);
    run(db, "INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,'10A1',10,1,30)");
    assert.equal(get(db, "SELECT gvcn_group_id FROM lop WHERE ten='10A1'")?.gvcn_group_id, null);
  } finally { db.close(); }
});

test("−30 nhóm A trừ 10 chứ không 10.6; GVCN phát hiện thì không trừ nặng", () => {
  const db = emptyDb();
  try {
    seedClasses(db, 4);
    saveGvcnGroup(db, 1, 1, groupId(db, "A"));
    const tuanId = openWeek(db, "2026-09-11");
    const tc = Number(get(db, "SELECT id FROM tieu_chi WHERE nam_hoc_id=1 AND ma='ky_luat_muc_30'")!.id);
    submitAll(db, tuanId, 4, {
      1: { vp_0_tieu_chi_id: String(tc), vp_0_ho_ten: "HS", vp_0_ngay: "2026-09-11" },
    });
    publish(db, 1, tuanId);
    const row = gvcnScores(db, 1, 1, "official").rows.find((r) => Number(r.lop_id) === 1)!;
    assert.equal(row.penalty_hk, 0);
    assert.equal(row.tru_5_1, 0);
    assert.equal(row.tru_nang_hk, 10);
    assert.equal(row.cong_hk, 0);
    assert.equal(row.diem, 10);
    assert.notEqual(row.diem, 20 - 10.6);
    const eventId = Number(get(db, "SELECT id FROM su_kien ORDER BY id DESC LIMIT 1")!.id);
    saveGvcnPhatHien(db, 1, eventId, 1);
    const waived = gvcnScores(db, 1, 1, "official").rows.find((r) => Number(r.lop_id) === 1)!;
    assert.equal(waived.tru_nang_hk, 0);
    assert.equal(waived.penalty_hk, 0);
    assert.equal(waived.diem, 20);
  } finally { db.close(); }
});

test("override skips heavy mapping but still enters Σ 5.1", () => {
  const db = emptyDb();
  try {
    seedClasses(db, 4);
    saveGvcnGroup(db, 1, 1, groupId(db, "A"));
    const tuanId = openWeek(db, "2026-09-11");
    const tc = Number(get(db, "SELECT id FROM tieu_chi WHERE nam_hoc_id=1 AND ma='ky_luat_muc_30'")!.id);
    submitAll(db, tuanId, 4, {
      1: { vp_0_tieu_chi_id: String(tc), vp_0_ho_ten: "HS", vp_0_ngay: "2026-09-11" },
    });
    publish(db, 1, tuanId);
    const mapped = gvcnScores(db, 1, 1, "official").rows.find((r) => Number(r.lop_id) === 1)!;
    assert.equal(mapped.tru_nang_hk, 10);
    assert.equal(mapped.penalty_hk, 0);
    savePenalty(db, 1, 1, 1, tuanId, 10, "Biên bản đối chiếu");
    const over = gvcnScores(db, 1, 1, "official").rows.find((r) => Number(r.lop_id) === 1)!;
    assert.equal(over.tru_nang_hk, 0);
    assert.equal(over.penalty_hk, 10);
    assert.equal(over.tru_5_1, 0.2);
    assert.equal(over.cong_hk, 0);
    assert.equal(over.diem, 19.8);
  } finally { db.close(); }
});

test("semester vs weekly 5.1 on 4×4.9 nhóm A", () => {
  const db = emptyDb();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    saveGvcnGroup(db, 1, 1, groupId(db, "A"));
    const starts = ["2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02"];
    const ids: number[] = [];
    for (const start of starts) {
      const tuanId = openWeek(db, start);
      ids.push(tuanId);
      submitClass(db, 1, tuanId, 1);
      publish(db, 1, tuanId);
      savePenalty(db, 1, 1, 1, tuanId, 4.9, "cửa sổ");
    }
    const semester = gvcnScores(db, 1, 1, "official").rows[0];
    assert.equal(semester.window, "semester");
    assert.equal(semester.penalty_hk, 19.6);
    assert.equal(semester.tru_5_1, 0.3);
    assert.equal(semester.tru_nang_hk, 0);
    run(db, "UPDATE year_formula SET gvcn_5_1_window='weekly' WHERE nam_id=1");
    const weekly = gvcnScores(db, 1, 1, "official").rows[0];
    assert.equal(weekly.window, "weekly");
    assert.equal(weekly.tru_5_1, 0);
    assert.equal(weekly.penalty_hk, 19.6);
  } finally { db.close(); }
});

test("two classes ranked nhất both get +0.5", () => {
  const db = emptyDb();
  try {
    run(db, `INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so,thu_tu) VALUES
      (1,1,'10A1',10,1,30,1),(2,1,'10A2',10,1,30,2)`);
    saveGvcnGroup(db, 1, 1, groupId(db, "A"));
    saveGvcnGroup(db, 1, 2, groupId(db, "A"));
    const tuanId = openWeek(db, "2026-09-11");
    submitClass(db, 1, tuanId, 1);
    submitClass(db, 1, tuanId, 2);
    publish(db, 1, tuanId);
    const rows = gvcnScores(db, 1, 1, "official").rows;
    assert.equal(rows[0].cong_hk, 0.5);
    assert.equal(rows[1].cong_hk, 0.5);
    assert.equal(rows[0].diem, 20);
    assert.equal(rows[1].diem, 20);
  } finally { db.close(); }
});

test("NULL gvcn_group_id yields official diem null", () => {
  const db = emptyDb();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    const tuanId = openWeek(db, "2026-09-11");
    submitClass(db, 1, tuanId, 1);
    publish(db, 1, tuanId);
    const row = gvcnScores(db, 1, 1, "official").rows[0];
    assert.equal(row.gvcn_group_id, null);
    assert.equal(row.diem, null);
    assert.match(String(row.status), /Chưa gán nhóm/);
  } finally { db.close(); }
});

test("WEEK3 included=0 does not null HK I when included=1 weeks are cong_bo", () => {
  const db = emptyDb();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    saveGvcnGroup(db, 1, 1, groupId(db, "A"));
    const tuanId = openWeek(db, "2026-09-11");
    submitClass(db, 1, tuanId, 1);
    publish(db, 1, tuanId);
    run(db, `INSERT INTO tuan(nam_hoc_id,so_tuan,thang,nam,hoc_ky,ghi_chu,trang_thai,included)
      VALUES (1,3,9,2026,1,?, 'nhap', 0)`, [SAMPLE_WEEK_NOTE]);
    const scored = gvcnScores(db, 1, 1, "official");
    assert.equal(scored.officialReady, true);
    assert.equal(scored.weeks.length, 1);
    assert.equal(scored.rows[0].diem, 20);
    run(db, "UPDATE tuan SET included=1 WHERE so_tuan=3");
    const blocked = gvcnScores(db, 1, 1, "official");
    assert.equal(blocked.officialReady, false);
    assert.equal(blocked.rows[0].diem, null);
    const preview = gvcnScores(db, 1, 1, "preview").rows[0];
    assert.equal(preview.diem, 20);
  } finally { db.close(); }
});

test("addNamHoc copy remaps gvcn_group_id by ma", () => {
  const db = emptyDb();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    const srcA = groupId(db, "A", 1);
    saveGvcnGroup(db, 1, 1, srcA);
    const copied = Number(addNamHoc(db, "2027-2028", 1));
    const dstA = groupId(db, "A", copied);
    assert.notEqual(dstA, srcA);
    const copiedLop = get(db, "SELECT gvcn_group_id FROM lop WHERE nam_hoc_id=? AND ten='10A1'", [copied]);
    assert.equal(copiedLop?.gvcn_group_id, dstA);
    assert.equal(listLop(db, copied).length, 1);
  } finally { db.close(); }
});
