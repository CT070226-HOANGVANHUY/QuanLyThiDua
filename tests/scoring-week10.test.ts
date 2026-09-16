import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addNamHoc, get, initDb, run, setActiveNam, transaction, yearFormulaOf } from "../src/db.ts";
import { initAssessments } from "../src/assessments.ts";
import { initPeriods, periodTable } from "../src/periods.ts";
import { initPlan, parseReport, resolveWeekForWrite, saveReport, scoreWeek, setTuanStatus } from "../src/plan.ts";
import { tbKtm } from "../src/scoring.ts";

process.env.THIDUA_EMPTY_DB = "1";

type Week10Row = {
  ten: string;
  nhom: 1 | 2;
  si_so: number;
  nn?: Record<string, number>;
  gio: [number, number, number, number];
  ktm: [number, number, number, number, number, number];
};

/** Ban in tuần 10 2025–2026: NN magnitudes (signed in payload), hours, KTM ge5/lt5/910/78/34/02. */
const WEEK10: Week10Row[] = [
  { ten: "11A1", nhom: 1, si_so: 47, gio: [29, 0, 0, 0], ktm: [1, 0, 1, 0, 0, 0] },
  { ten: "11A2", nhom: 1, si_so: 44, nn: { trang_phuc: 2 }, gio: [28, 1, 0, 0], ktm: [15, 5, 2, 5, 2, 3] },
  { ten: "11A3", nhom: 1, si_so: 47, gio: [29, 0, 0, 0], ktm: [4, 0, 2, 1, 0, 0] },
  { ten: "11A4", nhom: 1, si_so: 46, nn: { sdb_y_thuc: 1, sdb_hoc_tap: 2 }, gio: [27, 0, 0, 0], ktm: [15, 4, 6, 8, 3, 1] },
  { ten: "11A8", nhom: 1, si_so: 41, gio: [29, 0, 0, 0], ktm: [16, 0, 11, 5, 0, 0] },
  { ten: "10A1", nhom: 1, si_so: 44, nn: { di_muon: 2 }, gio: [20, 0, 1, 0], ktm: [16, 0, 9, 6, 0, 0] },
  { ten: "10A2", nhom: 1, si_so: 42, nn: { di_muon: 1, nghi_hoc: 10, sdb_y_thuc: 1, sdb_hoc_tap: 1 }, gio: [29, 0, 0, 0], ktm: [7, 0, 3, 3, 0, 0] },
  { ten: "10A4", nhom: 1, si_so: 43, nn: { sdb_hoc_tap: 2 }, gio: [29, 0, 0, 0], ktm: [9, 1, 4, 3, 1, 0] },
  { ten: "10A6", nhom: 1, si_so: 43, nn: { di_muon: 1 }, gio: [28, 1, 0, 0], ktm: [5, 1, 2, 2, 1, 0] },
  { ten: "10A8", nhom: 1, si_so: 42, gio: [27, 0, 0, 0], ktm: [8, 0, 4, 4, 0, 0] },
  { ten: "12A1", nhom: 1, si_so: 45, nn: { di_muon: 1 }, gio: [29, 0, 0, 0], ktm: [5, 1, 3, 2, 1, 0] },
  { ten: "12A2", nhom: 1, si_so: 45, nn: { di_muon: 3, trang_phuc: 1, nghi_hoc: 20 }, gio: [29, 0, 0, 0], ktm: [6, 0, 2, 4, 0, 0] },
  { ten: "12A4", nhom: 1, si_so: 44, nn: { di_muon: 1 }, gio: [29, 0, 0, 0], ktm: [4, 0, 1, 3, 0, 0] },
  { ten: "12A8", nhom: 1, si_so: 42, nn: { di_muon: 2, sdb_y_thuc: 2 }, gio: [28, 1, 0, 0], ktm: [9, 0, 9, 0, 0, 0] },
  { ten: "11A5", nhom: 2, si_so: 45, nn: { di_muon: 3, nghi_hoc: 20, sdb_y_thuc: 2, sdb_hoc_tap: 1, hs_ky_luat: 30 }, gio: [25, 3, 0, 1], ktm: [9, 5, 5, 4, 3, 2] },
  { ten: "11A6", nhom: 2, si_so: 46, nn: { di_muon: 4, trang_phuc: 1, nghi_hoc: 10 }, gio: [28, 0, 0, 0], ktm: [7, 1, 4, 3, 0, 1] },
  { ten: "11A7", nhom: 2, si_so: 44, nn: { di_muon: 4, trang_phuc: 1, nghi_hoc: 20, tnkt: 20 }, gio: [27, 1, 0, 0], ktm: [1, 0, 1, 0, 0, 0] },
  { ten: "11A9", nhom: 2, si_so: 38, nn: { di_muon: 2, trang_phuc: 1, tnkt: 10, sdb_hoc_tap: 4 }, gio: [28, 1, 0, 0], ktm: [1, 0, 0, 0, 0, 0] },
  { ten: "11A10", nhom: 2, si_so: 41, nn: { di_muon: 4, trang_phuc: 1, sdb_hoc_tap: 11 }, gio: [27, 0, 2, 0], ktm: [16, 5, 5, 10, 4, 1] },
  { ten: "10A3", nhom: 2, si_so: 43, nn: { di_muon: 1, sdb_y_thuc: 1, sdb_hoc_tap: 3, hs_ky_luat: 30 }, gio: [27, 1, 0, 1], ktm: [6, 1, 3, 3, 0, 1] },
  { ten: "10A5", nhom: 2, si_so: 43, gio: [32, 0, 0, 0], ktm: [23, 1, 8, 11, 0, 1] },
  { ten: "10A7", nhom: 2, si_so: 43, nn: { di_muon: 1, tnkt: 30, sdb_hoc_tap: 1 }, gio: [28, 1, 0, 0], ktm: [3, 1, 1, 1, 0, 1] },
  { ten: "10A9", nhom: 2, si_so: 41, nn: { tnkt: 40 }, gio: [29, 0, 0, 0], ktm: [3, 0, 3, 0, 0, 0] },
  { ten: "10A10", nhom: 2, si_so: 41, nn: { di_muon: 1, nghi_hoc: 20, tnkt: 10 }, gio: [28, 1, 0, 0], ktm: [9, 2, 1, 3, 2, 0] },
  { ten: "12A3", nhom: 2, si_so: 45, nn: { di_muon: 5, tnkt: 20 }, gio: [28, 1, 0, 0], ktm: [15, 0, 12, 2, 0, 0] },
  { ten: "12A5", nhom: 2, si_so: 42, nn: { di_muon: 3 }, gio: [29, 0, 0, 0], ktm: [7, 1, 5, 2, 1, 0] },
  { ten: "12A6", nhom: 2, si_so: 42, nn: { di_muon: 1 }, gio: [29, 0, 0, 0], ktm: [1, 0, 0, 0, 0, 0] },
  { ten: "12A7", nhom: 2, si_so: 44, nn: { tnkt: 20 }, gio: [29, 0, 0, 0], ktm: [11, 3, 4, 6, 1, 2] },
  { ten: "12A9", nhom: 2, si_so: 43, nn: { di_muon: 3, trang_phuc: 1, sdb_y_thuc: 5 }, gio: [29, 0, 0, 0], ktm: [10, 3, 2, 8, 2, 1] },
  { ten: "12A10", nhom: 2, si_so: 42, nn: { di_muon: 1 }, gio: [29, 0, 0, 0], ktm: [1, 0, 0, 0, 0, 0] },
];

function emptyDb() {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  initPlan(db);
  initPeriods(db);
  initAssessments(db);
  return db;
}

function reportForm(extra: Record<string, string> = {}) {
  return {
    gio_tong: "0", gio_tot: "0", gio_kha: "0", gio_tb: "0", gio_yeu: "0", gio_kem: "0",
    ktm_9_10: "0", ktm_7_8: "0", ktm_5_6: "0", ktm_3_4: "0", ktm_0_2: "0",
    bi_thu: "Bí thư", ngay_lap: "2026-09-13", ghi_chu_ktm: "Không phát sinh", ...extra,
  };
}

function week10Fixture() {
  const db = emptyDb();
  const namId = Number(addNamHoc(db, "2025-2026-fixture"));
  setActiveNam(db, namId);
  WEEK10.forEach((row, i) => {
    const loai = row.nhom === 1 ? "chon" : "thuong";
    run(db, `INSERT INTO lop(nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung)
      VALUES (?,?,?,?,?,?,?,1)`, [namId, row.ten, Number(row.ten.slice(0, 2)), row.nhom, row.si_so, i + 1, loai]);
  });
  initPlan(db);
  run(db, `INSERT INTO tuan(nam_hoc_id,so_tuan,thang,nam,hoc_ky,ngay_bd,ngay_kt,trang_thai,included)
    VALUES (? ,10,11,2025,1,'2025-11-07','2025-11-13','nhap',1)`, [namId]);
  const tuanId = Number(get(db, "SELECT id FROM tuan WHERE nam_hoc_id=? AND so_tuan=10", [namId])!.id);
  for (const row of WEEK10) {
    const lopId = Number(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten=?", [namId, row.ten])!.id);
    const [ge5, lt5, n910, n78, n34, n02] = row.ktm;
    const payload: Record<string, number> = {
      gio_tot: row.gio[0], gio_kha: row.gio[1], gio_tb: row.gio[2], gio_yeu: row.gio[3], gio_kem: 0,
      ktm_9_10: n910, ktm_7_8: n78, ktm_5_6: ge5 - n910 - n78, ktm_3_4: n34, ktm_0_2: n02,
    };
    for (const [key, mag] of Object.entries(row.nn ?? {})) payload[key] = -mag;
    run(db, "INSERT INTO weekly_legacy_input(tuan_id,lop_id,payload_json,confirmed) VALUES (?,?,?,1)",
      [tuanId, lopId, JSON.stringify(payload)]);
  }
  return { db, namId, tuanId };
}

test("Ban-in week 10 fixture: tbKtm count path and 1224 XT NN", () => {
  const { db, namId, tuanId } = week10Fixture();
  try {
    assert.equal(get(db, "SELECT ten FROM nam_hoc WHERE id=?", [namId])?.ten, "2025-2026-fixture");
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM lop WHERE nam_hoc_id=?", [namId])?.n, 30);
    assert.equal(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='10D1'", [namId]), undefined);
    assert.equal(yearFormulaOf(db, namId).ktm_divisor, "count");
    const rows = scoreWeek(db, tuanId);
    const by = Object.fromEntries(rows.map((row) => [row.ten, row]));
    assert.equal(by["11A1"].tb_ktm, 2);
    assert.equal(by["11A2"].tb_ktm, 0.05);
    assert.equal(by["11A3"].tb_ktm, 1.25);
    assert.equal(by["11A4"].tb_ktm, 15 / 19);
    assert.equal(by["11A1"].xt_nn, 1);
    assert.equal(by["11A3"].xt_nn, 1);
    assert.equal(by["11A8"].xt_nn, 1);
    assert.equal(by["10A8"].xt_nn, 1);
    assert.equal(by["12A1"].xt_nn, 5);
    assert.ok(Math.abs(Number(by["12A1"].tb_nn) - (-1 / 45)) < 1e-12);
    assert.equal(by["11A1"].tb_ktm_divisor, "count");
    assert.equal(get(db, "SELECT diem FROM tieu_chi WHERE nam_hoc_id=? AND ma='phu_hieu_gia'", [namId])?.diem, -30);
    assert.ok(get(db, "SELECT id FROM tieu_chi WHERE nam_hoc_id=? AND ma='gio_kem'", [namId]));
    assert.ok(get(db, "SELECT id FROM tieu_chi WHERE nam_hoc_id=? AND ma='xe_dap_de_sai_tap_the'", [namId]));
    assert.equal(get(db, "SELECT diem FROM quy_che WHERE noi_dung LIKE '%hù hiệu giả%'")?.diem, "−30/HS");
  } finally { db.close(); }
});

test("si_so divisor changes 11A2 tbKtm to 1/44; missing year_formula uses count", () => {
  const { db, namId, tuanId } = week10Fixture();
  try {
    const row = { ktm_9_10: 2, ktm_7_8: 5, ktm_5_6: 8, ktm_3_4: 2, ktm_0_2: 3 };
    assert.equal(tbKtm(row), 0.05);
    assert.equal(tbKtm(row, "si_so", 44), 1 / 44);
    run(db, "UPDATE year_formula SET ktm_divisor='si_so' WHERE nam_id=?", [namId]);
    const siSo = scoreWeek(db, tuanId).find((r) => r.ten === "11A2")!;
    assert.equal(siSo.tb_ktm, 1 / 44);
    assert.equal(siSo.tb_ktm_divisor, "si_so");
    run(db, "DELETE FROM year_formula WHERE nam_id=?", [namId]);
    const missing = scoreWeek(db, tuanId).find((r) => r.ten === "11A2")!;
    assert.equal(missing.tb_ktm, 0.05);
    assert.equal(yearFormulaOf(db, namId).ktm_divisor, "count");
    assert.equal(yearFormulaOf(db, namId).hk_month_weight, 2);
  } finally { db.close(); }
});

test("addNamHoc inserts exactly one year_formula row and copyFrom copies flags", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2027-2028"));
    setActiveNam(db, namId);
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM year_formula WHERE nam_id=?", [namId])?.n, 1);
    const yf = yearFormulaOf(db, namId);
    assert.equal(yf.ktm_divisor, "count");
    assert.equal(yf.hk_month_weight, 2);
    assert.equal(yf.hoi_hoc_double, "none");
    assert.equal(yf.gvcn_5_1_window, "semester");
    run(db, `UPDATE year_formula SET ktm_divisor='si_so', hk_month_weight=3, hoi_hoc_double='hdtt_only', gvcn_5_1_window='weekly' WHERE nam_id=?`, [namId]);
    const copied = Number(addNamHoc(db, "2028-2029", namId));
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM year_formula WHERE nam_id=?", [copied])?.n, 1);
    const dst = yearFormulaOf(db, copied);
    assert.equal(dst.ktm_divisor, "si_so");
    assert.equal(dst.hk_month_weight, 3);
    assert.equal(dst.hoi_hoc_double, "hdtt_only");
    assert.equal(dst.gvcn_5_1_window, "weekly");
  } finally { db.close(); }
});

test("HK monthly total is td_total * hk_month_weight, not rank_td; preview ×2 of available months", () => {
  const db = emptyDb();
  try {
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
    initPlan(db);
    run(db, `INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so,thu_tu) VALUES
      (1,1,'A',10,1,10,1),(2,1,'B',10,1,10,2)`);
    const sep = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: "2026-09-11" }));
    transaction(db, () => resolveWeekForWrite(db, 1, { week_start: "2026-10-02" }));
    const submitted = (extra: Record<string, string> = {}) => parseReport(reportForm(extra), sep);
    saveReport(db, 1, { tuan_id: Number(sep.id) }, 1, 0, submitted({
      nghi_0_ho_ten: "HS", nghi_0_ngay: "2026-09-11",
    }), "submit");
    saveReport(db, 1, { tuan_id: Number(sep.id) }, 2, 0, submitted(), "submit");
    setTuanStatus(db, 1, Number(sep.id), 2, "chot");
    setTuanStatus(db, 1, Number(sep.id), 3, "cong_bo");
    run(db, `INSERT INTO period_options(nam_id,model,semester,include_exam,exclude_activity)
      VALUES (1,'monthly',1,0,1)`);
    const official = periodTable(db, 1, "hk", "1", "monthly", "official");
    const preview = periodTable(db, 1, "hk", "1", "monthly", "preview");
    const offA = official.rows.find((r) => r.ten === "A")!;
    assert.equal(offA.td_total, null);
    assert.equal(offA.xt, null);
    const preA = preview.rows.find((r) => r.ten === "A")!;
    const preB = preview.rows.find((r) => r.ten === "B")!;
    assert.equal(preA.complete_count, 1);
    assert.equal(preA.constituent_count, 2);
    assert.equal(preB.td_total, 1);
    assert.equal(preA.td_total, 2);
    assert.equal(preB.total, 2);
    assert.equal(preA.total, 4);
    assert.notEqual(preB.total, preB.rank_td);
    assert.equal(preB.xt, 1);
    assert.equal(preA.xt, 2);
    run(db, "UPDATE year_formula SET hk_month_weight=3 WHERE nam_id=1");
    const weighted = periodTable(db, 1, "hk", "1", "monthly", "preview").rows;
    assert.equal(weighted.find((r) => r.ten === "B")!.total, 3);
    assert.equal(weighted.find((r) => r.ten === "A")!.total, 6);
  } finally { db.close(); }
});
