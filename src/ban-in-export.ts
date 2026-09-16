import ExcelJS from "exceljs";
import { all, get, getTuan, listLop, requireOwned, WorkflowError, type Db, type Dict } from "./db.ts";
import { schoolCalendar, scoreWeek, type ClassWeek } from "./plan.ts";
import { HT_GIO_COLS, NN_COLS, num } from "./scoring.ts";
import { applySafeValue, type Table } from "./workbook-export.ts";

const TNR = "Times New Roman";
const THIN = { style: "thin" as const };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

export function loaiHinhLabel(loai: string) {
  return loai === "chon" ? "Lớp chọn" : "Lớp thường";
}

export function gvcnBonus(xtChung: number | null | undefined): number | "" {
  if (xtChung === 1) return 0.5;
  if (xtChung === 2) return 0.3;
  if (xtChung === 3) return 0.2;
  return "";
}

export type BanInRow = ClassWeek & {
  loai_hinh: "chon" | "thuong";
  loai_hinh_label: string;
  thu_tu: number;
  ktm_ge5: number;
  ktm_lt5: number;
  gvcn_bonus: number | "";
  has_kem: boolean;
};

function classMeta(con: Db, namId: number, tuanId: number) {
  const frozen = all(con, `SELECT lop_id, thu_tu, loai_hinh FROM week_class WHERE tuan_id=?`, [tuanId]);
  if (frozen.length) {
    return new Map(frozen.map((row) => [Number(row.lop_id), {
      thu_tu: Number(row.thu_tu || 0),
      loai_hinh: (row.loai_hinh === "chon" ? "chon" : "thuong") as "chon" | "thuong",
    }]));
  }
  return new Map(listLop(con, namId).map((lop) => [Number(lop.id), {
    thu_tu: Number(lop.thu_tu ?? 0),
    loai_hinh: (lop.loai_hinh === "chon" ? "chon" : "thuong") as "chon" | "thuong",
  }]));
}

function ktmGe5(row: Dict) {
  return num(row, "ktm_9_10") + num(row, "ktm_7_8") + num(row, "ktm_5_6");
}
function ktmLt5(row: Dict) {
  return num(row, "ktm_3_4") + num(row, "ktm_0_2");
}

export function banInRows(con: Db, namId: number, tuanId: number): BanInRow[] {
  requireOwned(con, "tuan", tuanId, namId);
  const meta = classMeta(con, namId, tuanId);
  const ranked = scoreWeek(con, tuanId);
  const hasKem = ranked.some((row) => num(row.row, "gio_kem") !== 0);
  const out: BanInRow[] = ranked.map((row) => {
    const info = meta.get(row.lop_id) ?? {
      thu_tu: 0,
      loai_hinh: (row.nhom === 1 ? "chon" : "thuong") as "chon" | "thuong",
    };
    return {
      ...row,
      loai_hinh: info.loai_hinh,
      loai_hinh_label: loaiHinhLabel(info.loai_hinh),
      thu_tu: info.thu_tu,
      ktm_ge5: ktmGe5(row.row),
      ktm_lt5: ktmLt5(row.row),
      gvcn_bonus: gvcnBonus(row.xt_chung),
      has_kem: hasKem,
    };
  });
  out.sort((a, b) =>
    (a.loai_hinh === "chon" ? 0 : 1) - (b.loai_hinh === "chon" ? 0 : 1)
    || a.thu_tu - b.thu_tu
    || a.ten.localeCompare(b.ten, "vi"));
  return out;
}

function hourLabel(label: string, weight: number) {
  const short = label.replace(/^Giờ /, "");
  const sign = weight > 0 ? "+" : weight < 0 ? "−" : "";
  return `${short} (${sign}${Math.abs(weight)})`;
}

export function banInHourCols(hasKem: boolean): [string, string][] {
  return HT_GIO_COLS
    .filter(([key]) => hasKem || key !== "gio_kem")
    .map(([key, label, weight]) => [key, hourLabel(label, weight)]);
}

export function nnColumns(): [string, string][] {
  return [
    ["loai_hinh_label", "Loại hình"],
    ["ten", "Lớp"],
    ["si_so", "Sĩ số"],
    ...NN_COLS.map(([key, label]) => [key, label] as [string, string]),
    ["diem_nn", "Điểm NN"],
    ["tb_nn", "TB NN"],
    ["xt_nn", "XT NN"],
  ];
}

export function htColumns(hasKem: boolean): [string, string][] {
  return [
    ["loai_hinh_label", "Loại hình"],
    ["ten", "Lớp"],
    ["si_so", "Sĩ số"],
    ...banInHourCols(hasKem),
    ["diem_gio", "Tổng điểm giờ"],
    ["tb_gio", "TB giờ"],
    ["ktm_ge5", "≥5"],
    ["ktm_lt5", "<5"],
    ["ktm_9_10", "9–10"],
    ["ktm_7_8", "7–8"],
    ["ktm_3_4", "3–4"],
    ["ktm_0_2", "0–2"],
    ["diem_ktm", "Tổng điểm KTM"],
    ["tb_ktm", "TB KTM"],
    ["tb_ht", "TB HT"],
    ["xt_ht", "XT HT"],
    ["tong_xt", "Tổng XT"],
    ["xt_chung", "XT chung"],
    ["gvcn_bonus", ""],
  ];
}

export function banInRecord(row: BanInRow, opts: { blankLoai?: boolean } = {}): Dict {
  const r = row.row;
  const hours = Object.fromEntries(HT_GIO_COLS.map(([key]) => [key, num(r, key)]));
  return {
    loai_hinh_label: opts.blankLoai ? "" : row.loai_hinh_label,
    ten: row.ten,
    si_so: row.si_so,
    ...Object.fromEntries(NN_COLS.map(([key]) => [key, num(r, key)])),
    diem_nn: row.diem_nn,
    tb_nn: row.tb_nn,
    xt_nn: row.xt_nn,
    ...hours,
    diem_gio: row.diem_gio,
    tb_gio: row.tb_gio,
    ktm_ge5: row.ktm_ge5,
    ktm_lt5: row.ktm_lt5,
    ktm_9_10: num(r, "ktm_9_10"),
    ktm_7_8: num(r, "ktm_7_8"),
    ktm_3_4: num(r, "ktm_3_4"),
    ktm_0_2: num(r, "ktm_0_2"),
    diem_ktm: row.diem_ktm,
    tb_ktm: row.tb_ktm,
    tb_ht: row.tb_ht,
    xt_ht: row.xt_ht,
    tong_xt: row.tong_xt,
    xt_chung: row.xt_chung,
    gvcn_bonus: row.gvcn_bonus,
  };
}

function displayRows(rows: BanInRow[]): Dict[] {
  let prev = "";
  return rows.map((row) => {
    const blankLoai = row.loai_hinh_label === prev;
    prev = row.loai_hinh_label;
    return banInRecord(row, { blankLoai });
  });
}

export function banInTables(con: Db, namId: number, tuanId: number): Table[] {
  const week = getTuan(con, tuanId);
  if (!week) throw new WorkflowError(400, "Không có tuần.");
  const year = get(con, "SELECT ten FROM nam_hoc WHERE id=?", [namId]);
  const rows = banInRows(con, namId, tuanId);
  const hasKem = rows.some((row) => row.has_kem);
  const printed = displayRows(rows);
  const source = `${year?.ten ?? ""} · Tuần ${week.calendar_no || week.so_tuan} · ${week.ngay_bd ?? ""} – ${week.ngay_kt ?? ""}`;
  return [
    {
      title: "1. NỀ NẾP",
      source,
      notes: ["Nhóm Lớp chọn / Lớp thường theo week_class.thu_tu. Không dùng nhãn NÂNG CAO / CƠ BẢN."],
      columns: nnColumns(),
      rows: printed,
    },
    {
      title: "2. HỌC TẬP",
      source,
      notes: ["KTM ≥5 / <5 derived. Không in cột 5–6. Thưởng tuần: XT chung 1/2/3 → 0.5/0.3/0.2 (1224)."],
      columns: htColumns(hasKem),
      rows: printed,
    },
  ];
}

export function banInFilename(week?: Dict) {
  const no = week?.calendar_no || week?.so_tuan || "tuan";
  return `ban-in_tuan-${no}.xlsx`;
}

function paint(cell: ExcelJS.Cell, opts: { bold?: boolean; size?: number; fill?: string; center?: boolean } = {}) {
  cell.font = { name: TNR, size: opts.size ?? 10, bold: opts.bold };
  cell.alignment = { vertical: "middle", horizontal: opts.center ? "center" : "left", wrapText: true };
  cell.border = BORDER;
  if (opts.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
}

function writeBlock(
  ws: ExcelJS.Worksheet,
  startCol: number,
  headerRow: number,
  columns: [string, string][],
  rows: Dict[],
) {
  columns.forEach(([_, label], i) => {
    const cell = ws.getCell(headerRow, startCol + i);
    cell.value = label;
    paint(cell, { bold: true, size: 9, fill: "FF17365D", center: true });
    cell.font = { name: TNR, size: 9, bold: true, color: { argb: "FFFFFFFF" } };
    ws.getColumn(startCol + i).width = Math.min(14, Math.max(6, label.length + 2));
  });
  rows.forEach((record, r) => {
    columns.forEach(([key], c) => {
      const cell = ws.getCell(headerRow + 1 + r, startCol + c);
      applySafeValue(cell, record[key]);
      paint(cell, { size: 9, fill: (r + 1) % 2 === 0 ? "FFEDF3F8" : undefined, center: true });
    });
  });
}

export async function banInWorkbook(con: Db, namId: number, tuanId: number) {
  const week = getTuan(con, tuanId);
  if (!week) throw new WorkflowError(400, "Không có tuần.");
  const year = get(con, "SELECT ten FROM nam_hoc WHERE id=?", [namId]);
  const cal = schoolCalendar(con, namId);
  const rows = banInRows(con, namId, tuanId);
  const hasKem = rows.some((row) => row.has_kem);
  const printed = displayRows(rows);
  const nnCols = nnColumns();
  const htCols = htColumns(hasKem);
  const nnStart = 1;
  const nnEnd = nnCols.length;
  const htStart = nnEnd + 2;
  const htEnd = htStart + htCols.length - 1;
  const headerRow = 6;
  const last = headerRow + Math.max(1, printed.length);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Quản lý thi đua THPT Giao Thủy C";
  const ws = wb.addWorksheet("Ban in", { views: [{ state: "frozen", ySplit: headerRow, showGridLines: false }] });
  const weekLabel = `Tuần: ${week.calendar_no || week.so_tuan} tháng ${week.thang} năm ${week.nam}`;

  const banner = (row: number, start: number, end: number, text: string, size: number, bold = true) => {
    ws.mergeCells(row, start, row, end);
    const cell = ws.getCell(row, start);
    cell.value = text;
    cell.font = { name: TNR, size, bold };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  };
  banner(1, nnStart, nnEnd, cal.org.truong, 11);
  banner(1, htStart, htEnd, cal.org.truong, 11);
  banner(2, nnStart, nnEnd, "BẢNG TỔNG HỢP THI ĐUA GIỮA CÁC CHI ĐOÀN", 14);
  banner(2, htStart, htEnd, "BẢNG TỔNG HỢP THI ĐUA GIỮA CÁC CHI ĐOÀN", 14);
  banner(3, nnStart, nnEnd, `Năm học ${year?.ten ?? ""}`, 11, false);
  banner(3, htStart, htEnd, `Năm học ${year?.ten ?? ""}`, 11, false);
  banner(4, nnStart, nnEnd, `1. NỀ NẾP    ${weekLabel}`, 12);
  banner(4, htStart, htEnd, `2. HỌC TẬP    ${weekLabel}`, 12);

  writeBlock(ws, nnStart, headerRow, nnCols, printed);
  writeBlock(ws, htStart, headerRow, htCols, printed);
  ws.getColumn(nnEnd + 1).width = 2;
  ws.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    printArea: `A1:${ws.getColumn(htEnd).letter}${last}`,
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
  ws.headerFooter.oddFooter = "Trang &P / &N";
  return Buffer.from(await wb.xlsx.writeBuffer());
}
