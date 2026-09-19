import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { get, initDb, listLop, setActiveNam, yearFormulaOf } from "../src/db.ts";
import { appendWeekLoi, initPlan, listWeekLoi, schoolCalendar } from "../src/plan.ts";
import { matchLoi, saveAlias } from "../src/tieu-chi-alias.ts";
import { mapViolation } from "../src/phan-anh-import.ts";

function seeded() {
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

test("v12 seeds aliases from nội quy spoken names", () => {
  const db = seeded();
  try {
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    const dep = matchLoi(db, namId, "dép sai quy định", "A");
    assert.equal(dep?.ma, "trang_phuc");
    assert.equal(dep?.tapThe, false);
    const rac = matchLoi(db, namId, "chưa đổ rác", "");
    assert.equal(rac?.ma, "ve_sinh_ban_muon");
    assert.equal(rac?.tapThe, true);
    const muon = matchLoi(db, namId, "Đi học muộn", "B");
    assert.equal(muon?.ma, "di_muon");
    assert.equal(mapViolation("dép lê", "C", db, namId).ma, "trang_phuc");
  } finally { db.close(); }
});

test("appendWeekLoi writes to the class and uses catalog points", () => {
  const db = seeded();
  try {
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    setActiveNam(db, namId);
    const cal = schoolCalendar(db, namId);
    const start = cal.ngay_bd === "2026-09-07" ? "2026-09-04" : "2026-09-04";
    const lop = listLop(db, namId).find((row) => row.ten === "10A2")!;
    const tc = get(db, "SELECT id, diem FROM tieu_chi WHERE nam_hoc_id=? AND ma='trang_phuc'", [namId])!;
    const saved = appendWeekLoi(db, namId, { week_start: start }, {
      lop_id: Number(lop.id),
      ngay: "2026-09-09",
      ho_ten: "Trần Quang Minh",
      tieu_chi_id: Number(tc.id),
      buoi: "sang",
    });
    assert.equal(saved.diem, Number(tc.diem));
    const rows = listWeekLoi(db, Number(saved.week.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lop_ten, "10A2");
    assert.equal(rows[0].ho_ten, "Trần Quang Minh");
    assert.equal(rows[0].ma, "trang_phuc");
    assert.equal(get(db, "SELECT buoi FROM su_kien sk JOIN bao_cao_tuan bc ON bc.id=sk.bao_cao_id WHERE bc.tuan_id=?", [saved.week.id])?.buoi, "sang");
    const cham = get(db, "SELECT thanh_diem FROM cham_dong WHERE tuan_id=? AND lop_id=? AND nguon='auto'", [saved.week.id, lop.id]);
    assert.equal(Number(cham?.thanh_diem), Number(tc.diem));
  } finally { db.close(); }
});

test("new alias is used for matching", () => {
  const db = seeded();
  try {
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    setActiveNam(db, namId);
    const tc = get(db, "SELECT id FROM tieu_chi WHERE nam_hoc_id=? AND ma='tnkt_bo_nhiem_vu'", [namId])!;
    saveAlias(db, namId, Number(tc.id), "TNKT số bỏ việc");
    const hit = matchLoi(db, namId, "TNKT số bỏ việc", "X");
    assert.equal(hit?.ma, "tnkt_bo_nhiem_vu");
  } finally { db.close(); }
});

test("year formula flags stay year-scoped after v12", () => {
  const db = seeded();
  try {
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    assert.equal(yearFormulaOf(db, namId).ktm_divisor, "si_so");
  } finally { db.close(); }
});
