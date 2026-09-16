import assert from "node:assert/strict";
import { test } from "node:test";
import { addNamHoc, get, run, setActiveNam, transaction, yearFormulaOf } from "../src/db.ts";
import { initPlan, parseReport, resolveWeekForWrite, saveReport, scoreWeek, setTuanStatus } from "../src/plan.ts";
import { periodTable } from "../src/periods.ts";
import { tbKtm } from "../src/scoring.ts";
import { emptyDb, week10Fixture } from "./week10-fixture.ts";

process.env.THIDUA_EMPTY_DB = "1";

function reportForm(extra: Record<string, string> = {}) {
  return {
    gio_tong: "0", gio_tot: "0", gio_kha: "0", gio_tb: "0", gio_yeu: "0", gio_kem: "0",
    ktm_9_10: "0", ktm_7_8: "0", ktm_5_6: "0", ktm_3_4: "0", ktm_0_2: "0",
    bi_thu: "Bí thư", ngay_lap: "2026-09-13", ghi_chu_ktm: "Không phát sinh", ...extra,
  };
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
