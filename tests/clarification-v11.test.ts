import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { get, initDb, listLop, setActiveNam, transaction, yearFormulaOf } from "../src/db.ts";
import { diemGio, HOI_HOC_WEIGHTS } from "../src/scoring.ts";
import {
  initPlan,
  parseReport,
  resolveWeekForWrite,
  saveReport,
  saveSchoolCalendar,
  scoreWeek,
} from "../src/plan.ts";
import { listTamKet, saveMilestoneWeeks, syncDotWeeks } from "../src/milestones.ts";
import { mapViolation, importPhanAnhRows } from "../src/phan-anh-import.ts";
import { initPeriods } from "../src/periods.ts";
import { initConduct } from "../src/conduct.ts";

process.env.THIDUA_EMPTY_DB = "1";

function seeded() {
  const prev = process.env.THIDUA_EMPTY_DB;
  delete process.env.THIDUA_EMPTY_DB;
  const db = new DatabaseSync(":memory:");
  try {
    initDb(db);
    initPlan(db);
    initPeriods(db);
    initConduct(db);
  } finally {
    if (prev == null) delete process.env.THIDUA_EMPTY_DB;
    else process.env.THIDUA_EMPTY_DB = prev;
  }
  return db;
}

test("v11 roster, GVCN A/C, sĩ số KTM, đợt 8 tuần", () => {
  const db = seeded();
  try {
    assert.equal(get(db, "PRAGMA user_version")?.user_version, 12);
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    const yf = yearFormulaOf(db, namId);
    assert.equal(yf.ktm_divisor, "si_so");
    assert.equal(yf.hoi_hoc_double, "hdtt");
    assert.equal(yf.hk_basis, "dots");
    const lop = Object.fromEntries(listLop(db, namId).map((row) => [String(row.ten), row]));
    assert.equal(lop["11A4"]?.si_so, 41);
    assert.equal(lop["11A7"]?.si_so, 41);
    assert.equal(lop["12A1"]?.si_so, 45);
    assert.equal(lop["12A3"]?.si_so, 46);
    assert.equal(lop["12A9"]?.si_so, 38);
    assert.equal(lop["10D4"]?.si_so, 44);
    const groupOf = (ten: string) => get(db, `SELECT g.ma FROM lop l JOIN gvcn_ratio_group g ON g.id=l.gvcn_group_id WHERE l.id=?`, [lop[ten].id])?.ma;
    for (const ten of ["10A1", "10A2", "10A3", "11A1", "11A8", "12A1", "12A2"]) {
      assert.equal(groupOf(ten), "A", ten);
    }
    assert.equal(groupOf("10A4"), "C");
    assert.equal(groupOf("10D1"), "C");
    const dots = listTamKet(db, namId).filter((row) => String(row.ma).startsWith("dot_"));
    assert.equal(dots.length, 4);
  } finally { db.close(); }
});

test("hội học tháng 11: giờ khá −2, điểm 9–10 nhân đôi", () => {
  assert.equal(HOI_HOC_WEIGHTS["20-11"].gio?.gio_kha, -2);
  assert.equal(HOI_HOC_WEIGHTS["20-11"].ktm?.ktm_9_10, 4);
  assert.equal(diemGio({ gio_kha: 1 }, HOI_HOC_WEIGHTS["20-11"]), -2);
  assert.equal(diemGio({ gio_kha: 1 }), 1);
});

test("mapViolation đọc lỗi phản ánh", () => {
  const db = seeded();
  try {
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    assert.deepEqual(mapViolation("dép sai quy định", "A", db, namId), { ma: "trang_phuc", tapThe: false, paper: true });
    assert.deepEqual(mapViolation("chưa đổ rác", "", db, namId), { ma: "ve_sinh_ban_muon", tapThe: true, paper: false });
    assert.deepEqual(mapViolation("Không làm nhiệm vụ", "TNKT số 49", db, namId), { ma: "tnkt_bo_nhiem_vu", tapThe: false, paper: false });
    assert.deepEqual(mapViolation("Nghỉ học không phép", "Nam", db, namId), { ma: "nghi_hoc", tapThe: false, paper: true });
    assert.deepEqual(mapViolation("Không phù hiệu", "Linh", db, namId), { ma: "phu_hieu", tapThe: false, paper: true });
    assert.deepEqual(mapViolation("Quên phù hiệu", "Huy", db, namId), { ma: "phu_hieu_quen", tapThe: false, paper: false });
  } finally { db.close(); }
});

test("import phản ánh ghi su_kien vào tuần Thứ Sáu–Thứ Năm", () => {
  const db = seeded();
  try {
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    setActiveNam(db, namId);
    saveSchoolCalendar(db, namId, { ngay_bd: "2026-09-07", ngay_kt: "2027-05-31", hk2_bd: "2027-01-08" });
    const result = importPhanAnhRows(db, namId, [
      { sheet: "Tuần 1", stt: "1", ngay: "2026-09-09", lop: "10A2", hoTen: "Trần Quang Minh", loi: "không sơ vin trước khi ra khỏi cổng trường", buoi: "Sáng", ghiChu: "" },
      { sheet: "Tuần 1", stt: "2", ngay: "2026-09-09", lop: "10A5", hoTen: "", loi: "chưa đổ rác", buoi: "Sáng", ghiChu: "" },
    ]);
    assert.equal(result.events, 2);
    assert.equal(result.unknownClasses.length, 0);
    const week = get(db, "SELECT * FROM tuan WHERE nam_hoc_id=? AND ngay_bd='2026-09-04'", [namId]);
    assert.ok(week);
    const events = Number(get(db, `SELECT COUNT(*) AS n FROM su_kien sk JOIN bao_cao_tuan bc ON bc.id=sk.bao_cao_id WHERE bc.tuan_id=?`, [week.id])?.n);
    assert.equal(events, 2);
  } finally { db.close(); }
});

test("đợt 1 nhận tuần calendar_no 1–8; HK dots cộng hai đợt", () => {
  const db = seeded();
  try {
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    setActiveNam(db, namId);
    saveSchoolCalendar(db, namId, { ngay_bd: "2026-09-07", ngay_kt: "2027-05-31", hk2_bd: "2027-01-08" });
    const starts = ["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"];
    for (const start of starts) transaction(db, () => resolveWeekForWrite(db, namId, { week_start: start }));
    syncDotWeeks(db, namId);
    const dot1 = listTamKet(db, namId).find((row) => row.ma === "dot_1")!;
    const n = Number(get(db, "SELECT COUNT(*) AS n FROM milestone_week WHERE milestone_id=?", [dot1.id])?.n);
    assert.equal(n, 8);
  } finally { db.close(); }
});

test("scoreWeek hội học 20-11 dùng trọng số giờ khá −2", () => {
  const db = seeded();
  try {
    const namId = Number(get(db, "SELECT id FROM nam_hoc WHERE ten='2026-2027'")!.id);
    setActiveNam(db, namId);
    const lops = listLop(db, namId).filter((row) => Number(row.nhom) === 1);
    const ms = Number(get(db, "SELECT id FROM milestone WHERE nam_hoc_id=? AND ma='20-11'", [namId])!.id);
    saveMilestoneWeeks(db, namId, ms, ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"]);
    const week = get(db, "SELECT * FROM tuan WHERE nam_hoc_id=? AND ngay_bd='2026-10-30'", [namId])!;
    const form = (extra: Record<string, string> = {}) => parseReport({
      gio_tong: "1", gio_tot: "0", gio_kha: "1", gio_tb: "0", gio_yeu: "0", gio_kem: "0",
      ktm_9_10: "0", ktm_7_8: "0", ktm_5_6: "0", ktm_3_4: "0", ktm_0_2: "0",
      bi_thu: "", ngay_lap: "2026-10-30", ghi_chu_ktm: "Không phát sinh", ...extra,
    }, week);
    lops.forEach((lop, i) => {
      saveReport(db, namId, { tuan_id: Number(week.id) }, Number(lop.id), 0, form(i === 0 ? {} : { gio_kha: "0", gio_tot: "1" }), "submit");
    });
    const scored = scoreWeek(db, Number(week.id));
    const first = scored.find((row) => row.lop_id === Number(lops[0].id))!;
    assert.equal(first.diem_gio, -2);
    assert.equal(first.tb_gio, -2);
  } finally { db.close(); }
});
