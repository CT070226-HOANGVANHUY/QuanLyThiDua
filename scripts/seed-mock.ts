import { existsSync } from "node:fs";
import { initAssessments, saveAssessment } from "../src/assessments.ts";
import { vacuumBackup } from "../src/backup.ts";
import { initConduct, saveGvcnGroup } from "../src/conduct.ts";
import {
  all,
  connect,
  get,
  getActiveNam,
  initDb,
  listLop,
  setActiveNam,
  type Db,
} from "../src/db.ts";
import { listMilestones, saveMilestoneWeeks } from "../src/milestones.ts";
import { importRoster2026 } from "../src/migrate.ts";
import { initPeriods } from "../src/periods.ts";
import {
  catalogTieuChi,
  initPlan,
  listTieuChi,
  parseReport,
  saveKhen,
  saveReport,
  saveSchoolCalendar,
  setTuanStatus,
} from "../src/plan.ts";

const HO = ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Phan", "Vũ", "Đặng", "Bùi", "Đỗ", "Hồ", "Ngô"];
const DEM = ["Văn", "Thị", "Minh", "Thanh", "Hữu", "Ngọc"];
const TEN = ["An", "Bình", "Cường", "Dũng", "Giang", "Hà", "Hùng", "Lan", "Mai", "Nam", "Phúc", "Quân", "Sơn"];

export const MOCK_WEEKS = {
  published: ["2026-09-04", "2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"],
  chot: "2026-09-18",
  open: "2026-09-11",
};

function studentName(classTen: string, i: number) {
  const seed = [...classTen].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) + i * 17;
  return `${HO[seed % HO.length]} ${DEM[seed % DEM.length]} ${TEN[seed % TEN.length]}`;
}

function shift(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function reportForm(
  weekStart: string,
  classIndex: number,
  ten: string,
  extras: { vpId?: number; ky30?: number; heavy?: boolean; gvcnCaught?: boolean },
) {
  const tot = 22 + (classIndex % 6);
  const kha = 3 + (classIndex % 3);
  const tb = classIndex % 4 === 0 ? 1 : 0;
  const yeu = classIndex % 9 === 0 ? 1 : 0;
  const kem = 0;
  const tong = tot + kha + tb + yeu + kem;
  const form: Record<string, string> = {
    gio_tong: String(tong),
    gio_tot: String(tot),
    gio_kha: String(kha),
    gio_tb: String(tb),
    gio_yeu: String(yeu),
    gio_kem: String(kem),
    ktm_9_10: String(2 + (classIndex % 5)),
    ktm_7_8: String(4 + (classIndex % 4)),
    ktm_5_6: String(1 + (classIndex % 3)),
    ktm_3_4: String(classIndex % 3),
    ktm_0_2: String(classIndex % 6 === 0 ? 1 : 0),
    bi_thu: `Bí thư ${ten}`,
    ngay_lap: shift(weekStart, 6),
    ghi_chu_gio: "",
    ghi_chu_ktm: classIndex % 8 === 0 ? "Không phát sinh thêm" : "",
  };
  if (classIndex % 3 === 0) {
    form.nghi_0_ho_ten = studentName(ten, 0);
    form.nghi_0_ngay = weekStart;
    form.nghi_0_ghi_chu = "Nghỉ không phép";
  }
  if (classIndex % 2 === 0) {
    form.di_muon_0_ho_ten = studentName(ten, 1);
    form.di_muon_0_ngay = shift(weekStart, 1);
    form.di_muon_0_so_luong = String(1 + (classIndex % 2));
  }
  if (classIndex % 4 === 1) {
    form.trang_phuc_0_ho_ten = studentName(ten, 2);
    form.trang_phuc_0_ngay = weekStart;
    form.trang_phuc_0_so_luong = "1";
  }
  if (classIndex % 5 === 2) {
    form.phu_hieu_0_ho_ten = studentName(ten, 3);
    form.phu_hieu_0_ngay = shift(weekStart, 2);
    form.phu_hieu_0_so_luong = "1";
  }
  if (extras.vpId && classIndex % 5 === 3) {
    form.vp_0_tieu_chi_id = String(extras.vpId);
    form.vp_0_ho_ten = studentName(ten, 4);
    form.vp_0_ngay = weekStart;
    form.vp_0_so_luong = "1";
  }
  if (extras.ky30 && extras.heavy) {
    const key = form.vp_0_tieu_chi_id ? "vp_1" : "vp_0";
    form[`${key}_tieu_chi_id`] = String(extras.ky30);
    form[`${key}_ho_ten`] = studentName(ten, 9);
    form[`${key}_ngay`] = weekStart;
    form[`${key}_so_luong`] = "1";
    if (extras.gvcnCaught) form[`${key}_gvcn_phat_hien`] = "1";
  }
  return form;
}

function examValues(siSo: number, index: number) {
  const gioi = Math.max(0, 6 + (index % 5));
  const kha = Math.max(0, 12 + (index % 4));
  const tb = Math.max(0, siSo - gioi - kha - 3);
  const yeu = 2;
  const kem = Math.max(0, siSo - gioi - kha - tb - yeu);
  return {
    toan: 68 + (index % 12),
    van: 70 + (index % 10),
    anh: 64 + (index % 15),
    ly: 60 + (index % 8),
    hoa: 62 + (index % 9),
    bo_sung: 66 + (index % 7),
    gioi, kha, trung_binh: tb, yeu, kem,
  };
}

export type MockSeedSummary = {
  namId: number;
  published: string[];
  chot: string;
  open: string;
  openDone: number;
  openTotal: number;
  hoiHocId: number;
  classes: number;
};

export function seedMockData(con: Db, namId = Number(getActiveNam(con)?.id)): MockSeedSummary {
  if (!namId) throw new Error("Chưa có năm học để nạp dữ liệu mẫu.");
  initPlan(con);
  const lops = listLop(con, namId);
  if (!lops.length) throw new Error("Chưa có lớp. Nạp roster trước.");
  const groups = Object.fromEntries(
    all(con, "SELECT id, ma FROM gvcn_ratio_group WHERE nam_hoc_id=?", [namId]).map((row) => [String(row.ma), Number(row.id)]),
  );
  const catalog = catalogTieuChi(con, namId);
  const vpId = Number(catalog.find((row) => String(row.ma) === "tnkt_muon")?.id ?? catalog[0]?.id ?? 0) || undefined;
  const ky30 = Number(listTieuChi(con, namId, true).find((row) => String(row.ma) === "ky_luat_muc_30")?.id ?? 0) || undefined;

  saveSchoolCalendar(con, namId, {
    ngay_bd: "2026-09-01",
    ngay_kt: "2027-05-28",
    hk2_bd: "2027-01-18",
  });

  for (const lop of lops) {
    const ten = String(lop.ten);
    const ma = Number(lop.nhom) === 1 ? "A" : ten.startsWith("10") ? "C" : "B";
    saveGvcnGroup(con, namId, Number(lop.id), groups[ma] ?? null);
  }

  const fillWeek = (weekStart: string, mode: "submit" | "mixed") => {
    lops.forEach((lop, index) => {
      if (mode === "mixed" && index >= 18) return;
      const ten = String(lop.ten);
      const action = mode === "mixed" && index >= 12 ? "save" : "submit";
      const form = reportForm(weekStart, index, ten, {
        vpId,
        ky30,
        heavy: ten === "11A5" && weekStart === "2026-09-04",
        gvcnCaught: ten === "12A3" && weekStart === "2026-11-06",
      });
      const week = { ngay_bd: weekStart, ngay_kt: shift(weekStart, 6) };
      const parsed = parseReport(form, week);
      if (Object.keys(parsed.errors).length) {
        throw new Error(`${ten} ${weekStart}: ${JSON.stringify(parsed.errors)}`);
      }
      saveReport(con, namId, { week_start: weekStart }, Number(lop.id), 0, parsed, action);
    });
    const week = get(con, "SELECT * FROM tuan WHERE nam_hoc_id=? AND ngay_bd=?", [namId, weekStart]);
    return week!;
  };

  for (const start of MOCK_WEEKS.published) {
    const week = fillWeek(start, "submit");
    setTuanStatus(con, namId, Number(week.id), Number(week.revision), "chot");
    const after = get(con, "SELECT * FROM tuan WHERE id=?", [week.id])!;
    setTuanStatus(con, namId, Number(after.id), Number(after.revision), "cong_bo");
  }

  const chotWeek = fillWeek(MOCK_WEEKS.chot, "submit");
  setTuanStatus(con, namId, Number(chotWeek.id), Number(chotWeek.revision), "chot");

  fillWeek(MOCK_WEEKS.open, "mixed");

  const hoi = listMilestones(con, namId, "hoi_hoc").find((ms) => ms.ma === "20-11");
  if (!hoi) throw new Error("Thiếu mốc hội học 20-11.");
  saveMilestoneWeeks(con, namId, Number(hoi.id), ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);

  const firstPublished = get(con, "SELECT * FROM tuan WHERE nam_hoc_id=? AND ngay_bd=?", [namId, MOCK_WEEKS.published[0]])!;
  for (const lop of lops) {
    const index = Number(lop.thu_tu) || Number(lop.id);
    const siSo = Number(lop.si_so);
    saveAssessment(con, namId, "thi", "1", Number(lop.id), examValues(siSo, index));
    saveAssessment(con, namId, "hoat-dong", "1", Number(lop.id), {
      the_thao: 1 + (index % 8),
      van_nghe: 1 + ((index + 3) % 8),
    });
    if (index <= 3) {
      saveKhen(con, namId, `tuan:${firstPublished.id}`, Number(lop.id), "Khen", "Nhất / nhì tuần mẫu");
    }
  }

  return {
    namId,
    published: MOCK_WEEKS.published,
    chot: MOCK_WEEKS.chot,
    open: MOCK_WEEKS.open,
    openDone: 12,
    openTotal: lops.length,
    hoiHocId: Number(hoi.id),
    classes: lops.length,
  };
}

function prepareLive(): Db {
  const con = connect();
  initDb(con);
  initPlan(con);
  initPeriods(con);
  initAssessments(con);
  initConduct(con);
  let nam = getActiveNam(con);
  if (!nam) throw new Error("Chưa có năm học.");
  if (!listLop(con, Number(nam.id)).length) {
    importRoster2026(con, Number(nam.id));
    initPlan(con);
    nam = getActiveNam(con)!;
  }
  setActiveNam(con, Number(nam.id));
  return con;
}

const launched = Boolean(process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/seed-mock.ts"));
if (launched) {
  const con = prepareLive();
  const existing = Number(get(con, "SELECT COUNT(*) AS n FROM bao_cao_tuan")?.n ?? 0);
  if (existing && !process.argv.includes("--force")) {
    console.log(`Đã có ${existing} báo cáo tuần. Không ghi đè. Thêm --force nếu muốn nạp lại (sẽ lỗi trùng tuần).`);
    process.exit(0);
  }
  if (existsSync("data/thidua.db")) {
    const dest = vacuumBackup(con);
    console.log(`Đã sao lưu trước khi nạp mẫu: ${dest}`);
  }
  const summary = seedMockData(con);
  console.log(JSON.stringify(summary, null, 2));
  console.log("Nạp xong. Mở app, chọn tuần 11/09 (đang nhập) hoặc 04/09 (đã công bố).");
}
