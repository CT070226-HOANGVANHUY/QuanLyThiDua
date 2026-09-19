import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { addNamHoc, get, run, setActiveNam, transaction } from "../src/db.ts";
import { initPlan, parseReport, resolveWeekForWrite, saveChamTay, saveReport } from "../src/plan.ts";
import { banInHourCols, banInRows, banInTables, banInWorkbook, gvcnBonus, htColumns, nnColumns } from "../src/ban-in-export.ts";
import { reportTables } from "../src/report-export.ts";
import { paperNumber, workbookBuffer } from "../src/workbook-export.ts";
import { violationRows, violationTables, VIOLATION_COLUMNS } from "../src/violation-export.ts";
import { emptyDb, week10Fixture } from "./week10-fixture.ts";

process.env.THIDUA_EMPTY_DB = "1";

function reportForm(extra: Record<string, string> = {}) {
  return {
    gio_tong: "0", gio_tot: "0", gio_kha: "0", gio_tb: "0", gio_yeu: "0", gio_kem: "0",
    ktm_9_10: "0", ktm_7_8: "0", ktm_5_6: "0", ktm_3_4: "0", ktm_0_2: "0",
    bi_thu: "", ngay_lap: "", ghi_chu_gio: "", ghi_chu_ktm: "", ...extra,
  };
}

test("Ban in week 10 2025 grouping: 11A1 0.5, 11A8 0.3, 10A8 0.2; Lớp chọn not NÂNG CAO", async () => {
  const { db, namId, tuanId } = week10Fixture();
  try {
    assert.equal(get(db, "SELECT ten FROM nam_hoc WHERE id=?", [namId])?.ten, "2025-2026-fixture");
    assert.equal(get(db, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten='10D1'", [namId]), undefined);
    const rows = banInRows(db, namId, tuanId);
    const by = Object.fromEntries(rows.map((row) => [row.ten, row]));
    assert.equal(by["11A1"].gvcn_bonus, 0.5);
    assert.equal(by["11A8"].gvcn_bonus, 0.3);
    assert.equal(by["10A8"].gvcn_bonus, 0.2);
    assert.equal(by["11A1"].xt_chung, 1);
    assert.equal(by["11A8"].xt_chung, 2);
    assert.equal(by["10A8"].xt_chung, 3);
    assert.equal(by["11A1"].loai_hinh_label, "Lớp chọn");
    assert.equal(by["11A5"].loai_hinh_label, "Lớp thường");
    assert.ok(rows.every((row) => !String(row.loai_hinh_label).includes("NÂNG") && !String(row.loai_hinh_label).includes("CƠ BẢN")));
    const chon = rows.filter((row) => row.loai_hinh === "chon");
    const thuong = rows.filter((row) => row.loai_hinh === "thuong");
    assert.equal(chon.length, 14);
    assert.equal(thuong.length, 16);
    assert.deepEqual(rows.slice(0, chon.length).map((row) => row.ten), chon.map((row) => row.ten));
    assert.equal(nnColumns()[3][0], "trang_tri");
    assert.equal(nnColumns()[20][0], "vp_khac");
    const ht = htColumns(false);
    assert.ok(!ht.some(([key]) => key === "ktm_5_6" || key === "gio_kem"));
    assert.deepEqual(ht.filter(([key]) => key.startsWith("ktm_")).map(([key]) => key),
      ["ktm_ge5", "ktm_lt5", "ktm_9_10", "ktm_7_8", "ktm_3_4", "ktm_0_2"]);
    assert.equal(by["11A2"].ktm_ge5, 15);
    assert.equal(by["11A2"].ktm_lt5, 5);
    const tables = banInTables(db, namId, tuanId);
    assert.equal(tables.length, 2);
    assert.match(tables[0].title, /NỀ NẾP/);
    assert.match(tables[1].title, /HỌC TẬP/);
    assert.ok(!tables[1].columns.some(([key]) => key === "ktm_5_6"));
    const buf = await banInWorkbook(db, namId, tuanId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    assert.equal(ws.name, "Ban in");
    const labels: string[] = [];
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === "string") labels.push(cell.value);
      });
    });
    assert.ok(labels.some((v) => v.includes("Lớp chọn")));
    assert.ok(!labels.some((v) => v.includes("NÂNG CAO") || v.includes("CƠ BẢN")));
    assert.throws(
      () => reportTables(db, namId, { scope: "ban_in" as never, key: "ban_in", model: "monthly", view: "preview", cut: "school" }),
      { status: 400 },
    );
    assert.throws(
      () => reportTables(db, namId, { scope: "loi_hs" as never, key: "loi_hs", model: "monthly", view: "preview", cut: "school" }),
      { status: 400 },
    );
  } finally { db.close(); }
});

test("1224 ties: every class with xt_chung 1 gets 0.5 bonus", () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    run(db, `INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung) VALUES
      (1,?, 'A',10,1,10,1,'chon',1),(2,?, 'B',10,1,10,2,'chon',1),(3,?, 'C',10,1,10,3,'chon',1)`, [namId, namId, namId]);
    initPlan(db);
    run(db, `INSERT INTO tuan(nam_hoc_id,so_tuan,thang,nam,hoc_ky,ngay_bd,ngay_kt,trang_thai,included)
      VALUES (?,1,9,2026,1,'2026-09-11','2026-09-17','nhap',1)`, [namId]);
    const tuanId = Number(get(db, "SELECT id FROM tuan WHERE nam_hoc_id=?", [namId])!.id);
    for (const lopId of [1, 2, 3]) {
      const payload = lopId === 3
        ? { gio_tot: 1, gio_kha: 0, gio_tb: 0, gio_yeu: 0, gio_kem: 0, ktm_9_10: 0, ktm_7_8: 0, ktm_5_6: 0, ktm_3_4: 0, ktm_0_2: 0, di_muon: -5 }
        : { gio_tot: 2, gio_kha: 0, gio_tb: 0, gio_yeu: 0, gio_kem: 0, ktm_9_10: 1, ktm_7_8: 0, ktm_5_6: 0, ktm_3_4: 0, ktm_0_2: 0 };
      run(db, "INSERT INTO weekly_legacy_input(tuan_id,lop_id,payload_json,confirmed) VALUES (?,?,?,1)",
        [tuanId, lopId, JSON.stringify(payload)]);
    }
    const rows = banInRows(db, namId, tuanId);
    const by = Object.fromEntries(rows.map((row) => [row.ten, row]));
    assert.equal(by.A.xt_chung, 1);
    assert.equal(by.B.xt_chung, 1);
    assert.equal(by.A.gvcn_bonus, 0.5);
    assert.equal(by.B.gvcn_bonus, 0.5);
    assert.equal(gvcnBonus(1), 0.5);
    assert.equal(gvcnBonus(2), 0.3);
    assert.equal(gvcnBonus(3), 0.2);
    assert.equal(gvcnBonus(4), "");
    assert.equal(by.C.xt_chung, 3);
    assert.equal(by.C.gvcn_bonus, 0.2);
  } finally { db.close(); }
});

test("paper display rounds averages to 3 decimals; stored scores stay exact", async () => {
  assert.equal(paperNumber(-0.3409090909090909), -0.341);
  assert.equal(paperNumber(1.7037037037037037), 1.704);
  assert.equal(paperNumber(0.3414), 0.341);
  assert.equal(paperNumber(0.3406), 0.341);
  assert.notEqual(0.3414, 0.3406);
  assert.equal(paperNumber(0.75), 0.75);
  assert.equal(paperNumber(7), 7);
  const { db, namId, tuanId } = week10Fixture();
  try {
    const raw = banInRows(db, namId, tuanId).find((row) => row.ten === "11A2")!;
    assert.equal(raw.tb_ktm, 0.05);
    const paperBuf = await banInWorkbook(db, namId, tuanId);
    const paperWb = new ExcelJS.Workbook();
    await paperWb.xlsx.load(paperBuf);
    let sawPaperFmt = false;
    paperWb.worksheets[0].eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === "number" && !Number.isInteger(cell.value)) {
          assert.equal(cell.numFmt, "0.000");
          sawPaperFmt = true;
        }
      });
    });
    assert.equal(sawPaperFmt, true);
    const rankBuf = await workbookBuffer(reportTables(db, namId, {
      scope: "tuan", key: String(tuanId), model: "monthly", view: "preview", cut: "school",
    }));
    const rankWb = new ExcelJS.Workbook();
    await rankWb.xlsx.load(rankBuf);
    rankWb.worksheets[0].eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === "number" && !Number.isInteger(cell.value)) {
          assert.notEqual(cell.numFmt, "0.000");
        }
      });
    });
  } finally { db.close(); }
});

test("violation export sorts week_class.thu_tu then ngay then ho_ten; formula strings use numFmt @", async () => {
  const db = emptyDb();
  try {
    const namId = Number(addNamHoc(db, "2026-2027"));
    setActiveNam(db, namId);
    run(db, `INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so,thu_tu,loai_hinh,ap_dung) VALUES
      (1,?, 'A1',10,1,30,2,'chon',1),(2,?, 'Z1',10,1,30,1,'chon',1)`, [namId, namId]);
    initPlan(db);
    const week = transaction(db, () => resolveWeekForWrite(db, namId, { week_start: "2026-09-11" }));
    const tuanId = Number(week.id);
    const tnkt = get(db, "SELECT id,ten,diem FROM tieu_chi WHERE nam_hoc_id=? AND ma='tnkt_muon'", [namId])!;
    const nghiRule = get(db, "SELECT id FROM tieu_chi WHERE nam_hoc_id=? AND ma='nghi_hoc'", [namId])!;
    saveReport(db, namId, { tuan_id: tuanId }, 1, 0, parseReport(reportForm({
      gio_tong: "0",
      nghi_0_ho_ten: "=1+1", nghi_0_ngay: "2026-09-11",
    }), week), "save");
    saveReport(db, namId, { tuan_id: tuanId }, 2, 0, parseReport(reportForm({
      gio_tong: "0",
      nghi_0_ho_ten: "ZZZ", nghi_0_ngay: "2026-09-12",
      di_muon_0_ho_ten: "M", di_muon_0_ngay: "2026-09-11",
      vp_0_tieu_chi_id: String(tnkt.id), vp_0_ho_ten: "Catalog", vp_0_ngay: "2026-09-13", vp_0_tap_the: "0",
    }), week), "save");
    const rev = Number(get(db, "SELECT revision FROM tuan WHERE id=?", [tuanId])?.revision);
    saveChamTay(db, namId, tuanId, 1, Number(nghiRule.id), 1, rev, "Điều chỉnh tay");
    run(db, "UPDATE week_class SET thu_tu=1 WHERE tuan_id=? AND lop_id=2", [tuanId]);
    run(db, "UPDATE week_class SET thu_tu=2 WHERE tuan_id=? AND lop_id=1", [tuanId]);
    const rows = violationRows(db, namId, tuanId);
    assert.deepEqual(rows.map((row) => [row.ten, row.ngay, row.ho_ten, row.nguon]), [
      ["Z1", "2026-09-11", "M", "giay"],
      ["Z1", "2026-09-12", "ZZZ", "giay"],
      ["Z1", "2026-09-13", "Catalog", "tnkt"],
      ["A1", "", "", "tay"],
      ["A1", "2026-09-11", "=1+1", "giay"],
    ]);
    assert.equal(rows[2].tap_the, "không");
    assert.equal(rows[3].ho_ten, "");
    assert.ok(VIOLATION_COLUMNS.map(([key]) => key).includes("nguon"));
    const tables = violationTables(db, namId, tuanId);
    const buf = await workbookBuffer(tables);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    let found = false;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value === "=1+1") {
          found = true;
          assert.equal(cell.numFmt, "@");
        }
      });
    });
    assert.equal(found, true);
    assert.throws(
      () => reportTables(db, namId, { scope: "loi_hs" as never, key: "loi_hs", model: "monthly", view: "preview", cut: "school" }),
      { status: 400 },
    );
  } finally { db.close(); }
});

test("Ban in includes Kém column only when a class has gio_kem", () => {
  assert.ok(!banInHourCols(false).some(([key]) => key === "gio_kem"));
  assert.ok(banInHourCols(true).some(([key]) => key === "gio_kem"));
});
