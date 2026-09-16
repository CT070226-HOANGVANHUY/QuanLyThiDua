import { all, getTuan, requireOwned, WorkflowError, type Db, type Dict } from "./db.ts";
import type { Table } from "./workbook-export.ts";

export type ViolationRow = {
  thu_tu: number;
  ten: string;
  loai_hinh: "chon" | "thuong";
  loai_hinh_label: string;
  ho_ten: string;
  ngay: string;
  tieu_chi: string;
  so_luong: number;
  diem: number;
  tap_the: "có" | "không";
  nguon: "giay" | "tnkt" | "tay";
  ghi_chu: string;
};

function loaiHinhOf(value: unknown): "chon" | "thuong" {
  return value === "chon" ? "chon" : "thuong";
}

function loaiHinhLabel(loai: "chon" | "thuong") {
  return loai === "chon" ? "Lớp chọn" : "Lớp thường";
}

function nguonOf(value: unknown): "giay" | "tnkt" | "tay" {
  if (value === "giay" || value === "tay") return value;
  return "tnkt";
}

function asRow(raw: Dict): ViolationRow {
  const loai = loaiHinhOf(raw.loai_hinh);
  return {
    thu_tu: Number(raw.thu_tu || 0),
    ten: String(raw.ten ?? ""),
    loai_hinh: loai,
    loai_hinh_label: loaiHinhLabel(loai),
    ho_ten: String(raw.ho_ten ?? ""),
    ngay: String(raw.ngay ?? ""),
    tieu_chi: String(raw.tieu_chi ?? ""),
    so_luong: Number(raw.so_luong || 0),
    diem: Number(raw.diem || 0),
    tap_the: Number(raw.tap_the) === 1 ? "có" : "không",
    nguon: nguonOf(raw.nguon),
    ghi_chu: String(raw.ghi_chu ?? ""),
  };
}

const CLASS_JOIN = `JOIN lop ON lop.id=bc.lop_id
LEFT JOIN week_class wc ON wc.tuan_id=bc.tuan_id AND wc.lop_id=bc.lop_id`;

const CLASS_COLS = `COALESCE(wc.thu_tu, lop.thu_tu, 0) AS thu_tu,
  COALESCE(wc.ten, lop.ten) AS ten,
  CASE WHEN COALESCE(wc.loai_hinh, lop.loai_hinh)='chon' THEN 'chon' ELSE 'thuong' END AS loai_hinh`;

export function violationRows(con: Db, namId: number, tuanId: number): ViolationRow[] {
  requireOwned(con, "tuan", tuanId, namId);
  const nghi = all(con, `SELECT ${CLASS_COLS},
      n.ho_ten AS ho_ten, n.ngay AS ngay,
      COALESCE(tc.ten, 'Nghỉ học không lý do') AS tieu_chi,
      1 AS so_luong, COALESCE(tc.diem, 0) AS diem,
      0 AS tap_the, 'giay' AS nguon, n.ghi_chu AS ghi_chu
    FROM nghi_hoc n
    JOIN bao_cao_tuan bc ON bc.id=n.bao_cao_id
    ${CLASS_JOIN}
    LEFT JOIN tieu_chi tc ON tc.nam_hoc_id=lop.nam_hoc_id AND tc.ma='nghi_hoc'
    WHERE bc.tuan_id=?`, [tuanId]);
  const events = all(con, `SELECT ${CLASS_COLS},
      s.ho_ten AS ho_ten, s.ngay AS ngay,
      COALESCE(tc.ten, tc_loai.ten, s.loai) AS tieu_chi,
      s.so_luong AS so_luong,
      COALESCE(tc.diem, tc_loai.diem, 0) * s.so_luong AS diem,
      s.tap_the AS tap_the, s.nguon AS nguon, s.ghi_chu AS ghi_chu
    FROM su_kien s
    JOIN bao_cao_tuan bc ON bc.id=s.bao_cao_id
    ${CLASS_JOIN}
    LEFT JOIN tieu_chi tc ON tc.id=s.tieu_chi_id
    LEFT JOIN tieu_chi tc_loai ON tc_loai.nam_hoc_id=lop.nam_hoc_id AND tc_loai.ma=s.loai
    WHERE bc.tuan_id=?`, [tuanId]);
  const tay = all(con, `SELECT COALESCE(wc.thu_tu, lop.thu_tu, 0) AS thu_tu,
      COALESCE(wc.ten, lop.ten) AS ten,
      CASE WHEN COALESCE(wc.loai_hinh, lop.loai_hinh)='chon' THEN 'chon' ELSE 'thuong' END AS loai_hinh,
      '' AS ho_ten, '' AS ngay,
      COALESCE(c.ten_snapshot, tc.ten, c.score_key) AS tieu_chi,
      c.so_luong AS so_luong, c.thanh_diem AS diem,
      0 AS tap_the, 'tay' AS nguon, c.reason AS ghi_chu
    FROM cham_dong c
    JOIN lop ON lop.id=c.lop_id
    LEFT JOIN week_class wc ON wc.tuan_id=c.tuan_id AND wc.lop_id=c.lop_id
    LEFT JOIN tieu_chi tc ON tc.id=c.tieu_chi_id
    WHERE c.tuan_id=? AND c.nguon='tay'`, [tuanId]);
  return [...nghi, ...events, ...tay].map(asRow).sort((a, b) =>
    a.thu_tu - b.thu_tu
    || a.ten.localeCompare(b.ten, "vi")
    || a.ngay.localeCompare(b.ngay)
    || a.ho_ten.localeCompare(b.ho_ten, "vi"));
}

export const VIOLATION_COLUMNS: [string, string][] = [
  ["ten", "Lớp"],
  ["loai_hinh_label", "Loại hình"],
  ["ho_ten", "Họ tên"],
  ["ngay", "Ngày"],
  ["tieu_chi", "Tiêu chí"],
  ["so_luong", "Số lượng"],
  ["diem", "Điểm"],
  ["tap_the", "Tập thể"],
  ["nguon", "Nguồn"],
  ["ghi_chu", "Ghi chú"],
];

export function violationTables(con: Db, namId: number, tuanId: number): Table[] {
  const week = getTuan(con, tuanId);
  if (!week) throw new WorkflowError(400, "Không có tuần.");
  const rows = violationRows(con, namId, tuanId);
  return [{
    title: `Lỗi học sinh tuần ${week.calendar_no || week.so_tuan}`,
    source: `${week.ngay_bd ?? ""} – ${week.ngay_kt ?? ""} · su_kien ∪ nghi_hoc ∪ chấm tay`,
    notes: ["Sort: thứ tự lớp (week_class.thu_tu) → ngày → họ tên. Nguồn: giay | tnkt | tay."],
    columns: VIOLATION_COLUMNS,
    rows: rows as unknown as Dict[],
  }];
}

export function violationFilename(tuanId: number, week?: Dict) {
  const no = week?.calendar_no || week?.so_tuan || tuanId;
  return `loi-hs_tuan-${no}.xlsx`;
}
