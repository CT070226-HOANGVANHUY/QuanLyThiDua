import { get, requireOwned, WorkflowError, type Db, type Dict } from "./db.ts";
import { loadReport, schoolCalendar } from "./plan.ts";

export type ClassReportLine = {
  ho_ten: string;
  ngay: string;
  so_luong: number;
  ghi_chu: string;
  tiet_mon: string;
  noi_dung: string;
};

export type ClassReportDocument = {
  blank: boolean;
  detail: boolean;
  org: { xa: string; truong: string; doan: string; dia_danh: string };
  nam_hoc: string;
  lop: string;
  lop_id: number;
  tuan_id?: number;
  calendar_no: string;
  ngay_bd: string;
  ngay_kt: string;
  status: string;
  revision: number;
  bi_thu: string;
  ngay_lap: string;
  notice: string;
  absences: ClassReportLine[];
  late: ClassReportLine[];
  uniform: ClassReportLine[];
  badge: ClassReportLine[];
  other: ClassReportLine[];
  attitude: ClassReportLine[];
  gio: { tong: number; tot: number; kha: number; tb: number; yeu: number; kem: number; ghi_chu: string };
  ktm: { n910: number; n78: number; n56: number; n34: number; n02: number; ge5: number; lt5: number; ghi_chu: string };
};

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function line(row: Dict): ClassReportLine {
  return {
    ho_ten: String(row.ho_ten ?? ""),
    ngay: String(row.ngay ?? ""),
    so_luong: Number(row.so_luong || 1),
    ghi_chu: String(row.ghi_chu ?? ""),
    tiet_mon: String(row.tiet_mon ?? ""),
    noi_dung: String(row.noi_dung ?? ""),
  };
}

function emptyCounts() {
  return {
    gio: { tong: 0, tot: 0, kha: 0, tb: 0, yeu: 0, kem: 0, ghi_chu: "" },
    ktm: { n910: 0, n78: 0, n56: 0, n34: 0, n02: 0, ge5: 0, lt5: 0, ghi_chu: "" },
  };
}

export function buildClassReport(
  con: Db,
  namId: number,
  opts: { tuan_id?: number; week_start?: string; lop_id: number; blank?: boolean },
): ClassReportDocument {
  const lop = requireOwned(con, "lop", opts.lop_id, namId);
  const year = get(con, "SELECT * FROM nam_hoc WHERE id=?", [namId]);
  if (!year) throw new WorkflowError(404, "Không tìm thấy năm học.");
  const calendar = schoolCalendar(con, namId);
  const blank = Boolean(opts.blank);
  let week: Dict | undefined;
  if (opts.tuan_id != null) {
    week = requireOwned(con, "tuan", opts.tuan_id, namId);
    if (opts.week_start && week.ngay_bd && opts.week_start !== week.ngay_bd) {
      throw new WorkflowError(400, "Ngày và định danh tuần không khớp.");
    }
  } else if (blank && opts.week_start) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.week_start)) throw new WorkflowError(400, "Ngày phải có định dạng YYYY-MM-DD.");
    week = { ngay_bd: opts.week_start, ngay_kt: addDays(opts.week_start, 6), calendar_no: "" };
  } else {
    throw new WorkflowError(400, "Báo cáo nội dung cần tuần đã lưu. Mẫu trắng dùng week_start.");
  }
  const counts = emptyCounts();
  const doc: ClassReportDocument = {
    blank,
    detail: false,
    org: calendar.org,
    nam_hoc: String(year.ten),
    lop: String(lop.ten),
    lop_id: Number(lop.id),
    tuan_id: week.id == null ? undefined : Number(week.id),
    calendar_no: String(week.calendar_no || week.so_tuan || ""),
    ngay_bd: String(week.ngay_bd || ""),
    ngay_kt: String(week.ngay_kt || ""),
    status: blank ? "Mẫu trống" : "Chưa nhập",
    revision: 0,
    bi_thu: "",
    ngay_lap: "",
    notice: "",
    absences: [],
    late: [],
    uniform: [],
    badge: [],
    other: [],
    attitude: [],
    ...counts,
  };
  if (blank) {
    doc.notice = "MẪU TRỐNG";
    return doc;
  }
  const loaded = loadReport(con, Number(week.id), Number(lop.id));
  if (!loaded.bc) {
    const legacy = get(con, "SELECT 1 FROM weekly_legacy_input WHERE tuan_id=? AND lop_id=?", [week.id, lop.id]);
    throw new WorkflowError(409, legacy ? "Chưa có báo cáo chi tiết." : "Chưa có báo cáo. Nhập báo cáo tuần trước khi xuất Word.");
  }
  const events = loaded.sk;
  doc.detail = true;
  doc.status = loaded.bc.trang_thai === "da_gui" ? "Đã gửi" : "Nháp";
  doc.revision = Number(loaded.bc.revision || 0);
  doc.bi_thu = String(loaded.bc.bi_thu || "");
  doc.ngay_lap = String(loaded.bc.ngay_lap || "");
  doc.absences = loaded.nghi.map(line);
  doc.late = events.filter((row) => row.loai === "di_muon").map(line);
  doc.uniform = events.filter((row) => row.loai === "trang_phuc").map(line);
  doc.badge = events.filter((row) => row.loai === "phu_hieu").map(line);
  doc.other = events.filter((row) => row.loai === "vp_khac").map(line);
  doc.attitude = events.filter((row) => row.loai === "thai_do").map(line);
  doc.gio = {
    tong: Number(loaded.bc.gio_tong || 0),
    tot: Number(loaded.bc.gio_tot || 0),
    kha: Number(loaded.bc.gio_kha || 0),
    tb: Number(loaded.bc.gio_tb || 0),
    yeu: Number(loaded.bc.gio_yeu || 0),
    kem: Number(loaded.bc.gio_kem || 0),
    ghi_chu: String(loaded.bc.ghi_chu_gio || ""),
  };
  const n910 = Number(loaded.bc.ktm_9_10 || 0);
  const n78 = Number(loaded.bc.ktm_7_8 || 0);
  const n56 = Number(loaded.bc.ktm_5_6 || 0);
  const n34 = Number(loaded.bc.ktm_3_4 || 0);
  const n02 = Number(loaded.bc.ktm_0_2 || 0);
  doc.ktm = {
    n910, n78, n56, n34, n02, ge5: n910 + n78 + n56, lt5: n34 + n02,
    ghi_chu: String(loaded.bc.ghi_chu_ktm || ""),
  };
  return doc;
}

export function classReportFilename(doc: ClassReportDocument, ext: "docx" | "xlsx") {
  const lop = doc.lop.replaceAll(/[\\/:*?"<>|]+/g, "_");
  const year = doc.nam_hoc.replaceAll(/[\\/:*?"<>|]+/g, "_");
  return `Bao_cao_chi_doan_${lop}_${year}_${doc.ngay_bd}_${doc.ngay_kt}.${ext}`;
}
