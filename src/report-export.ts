import { getTuan, requireOwned, WorkflowError, type Db, type Dict } from "./db.ts";
import { HT_GIO_COLS, HT_KTM_COLS, NN_COLS } from "./scoring.ts";
import { periodKeys, periodTable } from "./periods.ts";
import { scoreWeek, type ClassWeek } from "./plan.ts";
import type { Table } from "./workbook-export.ts";

export type ExportRequest = {
  scope: "tuan" | "thang" | "nua" | "hk" | "nam";
  key: string;
  model: string;
  view: "official" | "preview";
  cut: "school" | "group" | "class";
  nhom?: number;
  lop_id?: number;
};

function cutRows(rows: Dict[], request: ExportRequest) {
  if (request.cut === "class") {
    if (!request.lop_id) throw new WorkflowError(400, "Xuất lớp cần lop_id.");
    return rows.filter((row) => Number(row.lop_id) === request.lop_id);
  }
  if (request.cut === "group") {
    if (!request.nhom) throw new WorkflowError(400, "Xuất nhóm cần nhom.");
    return rows.filter((row) => Number(row.nhom) === request.nhom);
  }
  return rows;
}

function weekTables(con: Db, namId: number, request: ExportRequest): Table[] {
  const weekId = Number(request.key);
  if (!Number.isSafeInteger(weekId) || weekId < 1) throw new WorkflowError(400, "Tuần xuất không hợp lệ.");
  requireOwned(con, "tuan", weekId, namId);
  const week = getTuan(con, weekId)!;
  if (request.view === "official" && week.trang_thai !== "cong_bo") {
    throw new WorkflowError(409, "Tuần chưa công bố nên chưa có báo cáo chính thức.");
  }
  const ranked = scoreWeek(con, weekId);
  if (request.view === "official" && ranked.some((row) => row.rank_status === "missing")) {
    throw new WorkflowError(409, "Tuần chính thức còn lớp thiếu dữ liệu.");
  }
  const rows = cutRows(ranked as unknown as Dict[], request) as unknown as ClassWeek[];
  const scoreLabel = (label: string, weight: number) => `${label} (${weight > 0 ? "+" : weight < 0 ? "−" : ""}${Math.abs(weight)})`;
  const nnCols = NN_COLS.map(([key, label]) => [key, label] as [string, string]);
  const gioCols = HT_GIO_COLS.map(([key, label, weight]) => [key, scoreLabel(label, weight)] as [string, string]);
  const ktmCols: [string, string][] = [
    [HT_KTM_COLS[0][0], scoreLabel(HT_KTM_COLS[0][1], HT_KTM_COLS[0][2])],
    [HT_KTM_COLS[1][0], scoreLabel(HT_KTM_COLS[1][1], HT_KTM_COLS[1][2])],
    ["ktm_5_6", "Điểm 5–6 (0)"],
    [HT_KTM_COLS[2][0], scoreLabel(HT_KTM_COLS[2][1], HT_KTM_COLS[2][2])],
    [HT_KTM_COLS[3][0], scoreLabel(HT_KTM_COLS[3][1], HT_KTM_COLS[3][2])],
  ];
  const rankingRows = rows.map((row) => ({
    ...row,
    ...row.row,
    cong_ne_nep: row.row.cong_ne_nep ?? 0,
  }));
  return [
    {
      title: `Xếp hạng tuần ${week.calendar_no || week.so_tuan}`,
      source: `${request.view === "official" ? "Snapshot đã công bố" : "Xem trước"} · ${week.ngay_bd ?? ""} – ${week.ngay_kt ?? ""} · năm ${namId}`,
      notes: ["Xếp thứ riêng từng nhóm trước khi lọc lớp/nhóm. Hạng nhỏ hơn tốt hơn.", "Trọng số giờ: Tốt +2, Khá +1, TB 0, Yếu −1, Kém −2. Điểm miệng: 9–10 +2, 7–8 +1, 5–6 0, 3–4 −1, 0–2 −2."],
      columns: [
        ["nhom", "Nhóm"], ["ten", "Lớp"], ["si_so", "Sĩ số"],
        ...nnCols, ["cong_ne_nep", "Cộng nề nếp"],
        ["diem_nn", "Điểm NN"], ["tb_nn", "TB NN"], ["xt_nn", "XT NN"],
        ...gioCols, ...ktmCols,
        ["tb_gio", "TB giờ"], ["tb_ktm", "TB miệng"], ["tb_ht", "TB học tập"],
        ["xt_ht", "XT học tập"], ["tong_xt", "Tổng XT"], ["xt_chung", "XT chung"],
        ["rank_status", "Trạng thái"],
      ],
      rows: rankingRows,
    },
    {
      title: "Chi tiết nguồn",
      source: "Tự tính từ báo cáo / chấm bổ sung / nguồn cũ.",
      columns: [
        ["ten", "Lớp"], ["nguon", "Nguồn"], ["score_key", "Khóa"], ["ten_snapshot", "Tiêu chí lúc ghi"],
        ["so_luong", "SL"], ["diem_mot", "Điểm/SL"], ["thanh_diem", "Thành điểm"], ["reason", "Lý do"],
      ],
      rows: rows.flatMap((row) => row.lines.map((line) => ({ ...line, ten: row.ten }))),
    },
  ];
}

export function reportTables(con: Db, namId: number, request: ExportRequest): Table[] {
  if (!["school", "group", "class"].includes(request.cut)) throw new WorkflowError(400, "Phạm vi xuất không hợp lệ.");
  if (request.cut === "class" && request.lop_id) requireOwned(con, "lop", request.lop_id, namId);
  if (request.scope === "tuan") return weekTables(con, namId, request);
  if (!periodKeys(con, namId, request.scope, request.model).some(([key]) => key === request.key)) {
    throw new WorkflowError(400, "Kỳ xuất không hợp lệ.");
  }
  const table = periodTable(con, namId, request.scope, request.key, request.model, request.view) as Table;
  if (request.view === "official" && table.rows.some((row) => row.xt == null)) {
    throw new WorkflowError(409, "Kỳ chính thức còn thiếu dữ liệu.");
  }
  return [{ ...table, rows: cutRows(table.rows, request) }];
}

export function reportFilename(request: ExportRequest, ext: "xlsx" | "docx") {
  const cut = request.cut === "class" ? `lop-${request.lop_id}` : request.cut === "group" ? `nhom-${request.nhom}` : "toan-truong";
  return `${request.scope}_${request.key}_${cut}.${ext}`.replaceAll(/[^\w.-]+/g, "_");
}

