import { DatabaseSync } from "node:sqlite";
import { addNamHoc, get, initDb, run, setActiveNam } from "../src/db.ts";
import { initAssessments } from "../src/assessments.ts";
import { initPeriods } from "../src/periods.ts";
import { initPlan } from "../src/plan.ts";

process.env.THIDUA_EMPTY_DB = "1";

type Week10Row = {
  ten: string;
  nhom: 1 | 2;
  si_so: number;
  nn?: Record<string, number>;
  gio: [number, number, number, number];
  ktm: [number, number, number, number, number, number];
};

/** Ban in tuần 10 2025–2026 (PR3). Not the 2026–2027 seed. */
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

export function emptyDb() {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  initPlan(db);
  initPeriods(db);
  initAssessments(db);
  return db;
}

export function week10Fixture() {
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
