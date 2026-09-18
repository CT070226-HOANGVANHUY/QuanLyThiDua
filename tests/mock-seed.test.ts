import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initAssessments, assessmentTable } from "../src/assessments.ts";
import { gvcnScores, initConduct } from "../src/conduct.ts";
import { addNamHoc, connect, get, initDb, setActiveNam } from "../src/db.ts";
import { importRoster2026 } from "../src/migrate.ts";
import { milestoneTable } from "../src/milestones.ts";
import { initPeriods, periodTable } from "../src/periods.ts";
import { catalogTieuChi, classNameHints, initPlan, scoreWeek, setTuanStatus, weekDayOptions } from "../src/plan.ts";
import { banInTables } from "../src/ban-in-export.ts";
import { violationTables } from "../src/violation-export.ts";
import { MOCK_WEEKS, seedMockData } from "../scripts/seed-mock.ts";

process.env.THIDUA_EMPTY_DB = "1";

function seeded() {
  const db = connect(":memory:");
  initDb(db);
  initPlan(db);
  initPeriods(db);
  initAssessments(db);
  initConduct(db);
  const namId = addNamHoc(db, "2026-2027");
  setActiveNam(db, namId);
  importRoster2026(db, namId);
  initPlan(db);
  const summary = seedMockData(db, namId);
  return { db, namId, summary };
}

test("mock seed: published week ranks inside groups and snapshot locks", () => {
  const { db, namId, summary } = seeded();
  try {
    assert.equal(summary.classes, 30);
    const week = get(db, "SELECT * FROM tuan WHERE nam_hoc_id=? AND ngay_bd=?", [namId, MOCK_WEEKS.published[0]]);
    assert.equal(week?.trang_thai, "cong_bo");
    const rows = scoreWeek(db, Number(week!.id));
    assert.equal(rows.length, 30);
    assert.ok(rows.every((row) => row.xt_chung != null && row.rank_status === "official"));
    const chon = rows.filter((row) => row.nhom === 1).map((row) => row.xt_chung as number);
    const thuong = rows.filter((row) => row.nhom === 2).map((row) => row.xt_chung as number);
    assert.equal(Math.min(...chon), 1);
    assert.equal(Math.min(...thuong), 1);
    assert.throws(() => setTuanStatus(db, namId, Number(week!.id), Number(week!.revision), "chot"), /lý do/i);
  } finally { db.close(); }
});

test("mock seed: current week cannot chốt while classes are still draft", () => {
  const { db, namId } = seeded();
  try {
    const week = get(db, "SELECT * FROM tuan WHERE nam_hoc_id=? AND ngay_bd=?", [namId, MOCK_WEEKS.open]);
    assert.equal(week?.trang_thai, "nhap");
    const rows = scoreWeek(db, Number(week!.id));
    const submitted = rows.filter((row) => row.report_status === "da_gui");
    assert.equal(submitted.length, 12);
    assert.throws(() => setTuanStatus(db, namId, Number(week!.id), Number(week!.revision), "chot"));
    const names = classNameHints(db, namId, Number(submitted[0].lop_id));
    assert.ok(names.length >= 1);
    const days = weekDayOptions(week!);
    assert.equal(days.length, 7);
    assert.equal(days[0].short, "T6");
  } finally { db.close(); }
});

test("mock seed: hội học, tháng preview, GVCN preview, thi and exports", () => {
  const { db, namId, summary } = seeded();
  try {
    const hoi = milestoneTable(db, namId, summary.hoiHocId, "official");
    assert.ok((hoi.rows as { xt_dot?: number | null }[]).some((row) => row.xt_dot != null));
    const month = periodTable(db, namId, "thang", "2026-09", "monthly", "preview");
    assert.ok((month.rows as { total?: number | null }[]).some((row) => row.total != null));
    const gvcn = gvcnScores(db, namId, 1, "preview");
    assert.equal(gvcn.rows.filter((row) => row.missing_group).length, 0);
    assert.ok(gvcn.rows.some((row) => row.diem != null));
    const thi = assessmentTable(db, namId, "thi", "1");
    assert.equal(thi.rows.length, 30);
    const tuanId = Number(get(db, "SELECT id FROM tuan WHERE nam_hoc_id=? AND ngay_bd=?", [namId, MOCK_WEEKS.published[0]])!.id);
    assert.ok(banInTables(db, namId, tuanId).length >= 1);
    assert.ok(violationTables(db, namId, tuanId).length >= 1);
    assert.ok(catalogTieuChi(db, namId).length > 5);
  } finally { db.close(); }
});
