import {
  all,
  get,
  listLop,
  listTuan,
  requireActiveYear,
  run,
  tableExists,
  transaction,
  WorkflowError,
  yearFormulaOf,
  type Db,
  type Dict,
  type HoiHocDouble,
} from "./db.ts";
import { HOI_HOC_MILESTONES } from "./migrate.ts";
import { resolveWeekForWrite, schoolCalendar, scoreWeek } from "./plan.ts";
import { competitionRanks } from "./scoring.ts";

const HOI_HOC_MONTH: Record<string, number> = { "20-11": 11, "26-3": 3 };

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fridayOnOrBefore(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return addDays(value, -((date.getUTCDay() + 2) % 7));
}

function overlapsMonth(start: string, end: string, month: number) {
  return Number(start.slice(5, 7)) === month || Number(end.slice(5, 7)) === month;
}

export function listMilestones(con: Db, namId: number, loai?: "hoi_hoc" | "tam_ket") {
  if (!tableExists(con, "milestone")) return [];
  if (loai) return all(con, "SELECT * FROM milestone WHERE nam_hoc_id=? AND loai=? ORDER BY ma", [namId, loai]);
  return all(con, "SELECT * FROM milestone WHERE nam_hoc_id=? ORDER BY loai, ma", [namId]);
}

export function getMilestone(con: Db, namId: number, id: number) {
  return get(con, "SELECT * FROM milestone WHERE id=? AND nam_hoc_id=?", [id, namId]);
}

export function milestoneWeeks(con: Db, milestoneId: number) {
  if (!tableExists(con, "milestone_week")) return [];
  return all(con, `SELECT mw.thu_tu, t.*
    FROM milestone_week mw JOIN tuan t ON t.id=mw.tuan_id
    WHERE mw.milestone_id=?
    ORDER BY mw.thu_tu, t.ngay_bd, t.so_tuan`, [milestoneId]);
}

export type MilestoneWeekOption = {
  ngay_bd: string;
  ngay_kt: string;
  calendar_no: number;
  tuan_id?: number;
  so_tuan?: number;
  trang_thai?: string;
  suggested: boolean;
  selected: boolean;
};

export function suggestedHoiHocWeeks(con: Db, namId: number, ma: string): MilestoneWeekOption[] {
  const month = HOI_HOC_MONTH[ma];
  const calendar = schoolCalendar(con, namId);
  if (!month || !calendar.ngay_bd || !calendar.ngay_kt) return [];
  const existing = listTuan(con, namId);
  const byStart = new Map(existing.filter((w) => w.ngay_bd).map((w) => [String(w.ngay_bd), w]));
  const firstFriday = fridayOnOrBefore(calendar.ngay_bd);
  const out: MilestoneWeekOption[] = [];
  for (let start = firstFriday; start <= calendar.ngay_kt; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    if (end < calendar.ngay_bd || start > calendar.ngay_kt) continue;
    if (!overlapsMonth(start, end, month)) continue;
    const saved = byStart.get(start);
    const calendarNo = saved?.calendar_no != null
      ? Number(saved.calendar_no)
      : Math.round((new Date(`${start}T00:00:00Z`).getTime() - new Date(`${firstFriday}T00:00:00Z`).getTime()) / 604800000) + 1;
    out.push({
      ngay_bd: start,
      ngay_kt: end,
      calendar_no: calendarNo,
      tuan_id: saved ? Number(saved.id) : undefined,
      so_tuan: saved ? Number(saved.so_tuan) : undefined,
      trang_thai: saved ? String(saved.trang_thai) : undefined,
      suggested: true,
      selected: false,
    });
  }
  return out;
}

export function hoiHocWeekOptions(con: Db, namId: number, milestone: Dict): MilestoneWeekOption[] {
  const suggested = suggestedHoiHocWeeks(con, namId, String(milestone.ma));
  const assigned = milestoneWeeks(con, Number(milestone.id));
  const assignedStarts = new Set(assigned.map((w) => String(w.ngay_bd)));
  const seen = new Set<string>();
  const out: MilestoneWeekOption[] = [];
  for (const week of suggested) {
    week.selected = assignedStarts.has(week.ngay_bd);
    out.push(week);
    seen.add(week.ngay_bd);
  }
  for (const week of assigned) {
    const start = String(week.ngay_bd || "");
    if (!start || seen.has(start)) continue;
    out.push({
      ngay_bd: start,
      ngay_kt: String(week.ngay_kt || ""),
      calendar_no: Number(week.calendar_no || week.so_tuan || 0),
      tuan_id: Number(week.id),
      so_tuan: Number(week.so_tuan),
      trang_thai: String(week.trang_thai || ""),
      suggested: false,
      selected: true,
    });
    seen.add(start);
  }
  return out.sort((a, b) => a.ngay_bd.localeCompare(b.ngay_bd));
}

export function namHocMilestoneContext(con: Db, namId: number) {
  const formula = yearFormulaOf(con, namId);
  const hoiHoc = listMilestones(con, namId, "hoi_hoc").map((ms) => ({
    ...ms,
    weeks: hoiHocWeekOptions(con, namId, ms),
  }));
  return { year_formula: formula, hoi_hoc: hoiHoc };
}

function uniqueStarts(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const start = String(raw || "").trim();
    if (!start || seen.has(start)) continue;
    seen.add(start);
    out.push(start);
  }
  return out.sort();
}

export function syncUnionTamKet(con: Db, namId: number) {
  if (!tableExists(con, "milestone")) return;
  const unions = all(con, "SELECT * FROM milestone WHERE nam_hoc_id=? AND loai='tam_ket' AND nguon_tuan='union'", [namId]);
  if (!unions.length) return;
  const hoiIds = all(con, "SELECT id FROM milestone WHERE nam_hoc_id=? AND loai='hoi_hoc' AND ma IN ('20-11','26-3')", [namId])
    .map((row) => Number(row.id));
  const members = hoiIds.length
    ? all(con, `SELECT DISTINCT t.id AS tuan_id, t.calendar_no, t.ngay_bd, t.so_tuan
        FROM milestone_week mw JOIN tuan t ON t.id=mw.tuan_id
        WHERE mw.milestone_id IN (${hoiIds.map(() => "?").join(",")})`, hoiIds)
    : [];
  members.sort((a, b) =>
    Number(a.calendar_no ?? a.so_tuan ?? 0) - Number(b.calendar_no ?? b.so_tuan ?? 0)
    || String(a.ngay_bd || "").localeCompare(String(b.ngay_bd || "")));
  for (const ms of unions) {
    run(con, "DELETE FROM milestone_week WHERE milestone_id=?", [ms.id]);
    members.forEach((week, i) => {
      run(con, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [ms.id, week.tuan_id, i + 1]);
    });
  }
}

export function saveMilestoneWeeks(con: Db, namId: number, milestoneId: number, weekStarts: string[]) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    if (!tableExists(con, "milestone")) throw new WorkflowError(500, "Chưa có bảng mốc hội học.");
    const ms = getMilestone(con, namId, milestoneId);
    if (!ms) throw new WorkflowError(404, "Không tìm thấy mốc trong năm học này.");
    if (String(ms.nguon_tuan) === "union") {
      throw new WorkflowError(400, "Mốc hợp tuần được cập nhật từ hội học 20/11 và 26/3, không chọn tay.");
    }
    const starts = uniqueStarts(weekStarts);
    if (String(ms.loai) === "hoi_hoc" && starts.length !== 0 && starts.length !== 4) {
      throw new WorkflowError(400, "Hội học cần đúng 4 tuần (hoặc bỏ chọn hết để xóa).");
    }
    const weeks = starts.map((start) => resolveWeekForWrite(con, namId, { week_start: start }));
    weeks.sort((a, b) =>
      Number(a.calendar_no ?? a.so_tuan ?? 0) - Number(b.calendar_no ?? b.so_tuan ?? 0)
      || String(a.ngay_bd || "").localeCompare(String(b.ngay_bd || "")));
    run(con, "DELETE FROM milestone_week WHERE milestone_id=?", [milestoneId]);
    weeks.forEach((week, i) => {
      run(con, "INSERT INTO milestone_week(milestone_id,tuan_id,thu_tu) VALUES (?,?,?)", [milestoneId, week.id, i + 1]);
    });
    if (String(ms.loai) === "hoi_hoc") syncUnionTamKet(con, namId);
    return weeks.map((week) => Number(week.id));
  });
}

function rankField(rows: Dict[], field: string, output = "xt_dot") {
  const groups: Record<number, Dict[]> = {};
  for (const row of rows) {
    row[output] = null;
    (groups[Number(row.nhom)] ??= []).push(row);
  }
  for (const group of Object.values(groups)) {
    if (group.every((r) => r[field] != null)) {
      const ranks = competitionRanks(group.map((r) => Number(r[field])), false);
      group.forEach((row, i) => {
        row[output] = ranks[i];
      });
    }
  }
}

function applyOverride(rows: Dict[], entries: Record<number, Dict>) {
  const groups: Record<number, Dict[]> = {};
  for (const row of rows) {
    row.override_rank = entries[Number(row.lop_id)]?.override_rank ?? null;
    (groups[Number(row.nhom)] ??= []).push(row);
  }
  for (const group of Object.values(groups)) {
    if (group.some((r) => r.override_rank != null)) {
      const values = group.map((r) => r.override_rank).filter((v) => v != null).map(Number).sort((a, b) => a - b);
      const complete =
        values.length === group.length &&
        values.every((v, i) => v === i + 1 || (i > 0 && v === values[i - 1]));
      for (const row of group) {
        row.xt_dot = complete ? row.override_rank : null;
        row.input_source = complete ? "Ghi đè nguồn (cả nhóm)" : "Chờ đủ XT ghi đè hợp lệ của cả nhóm";
      }
    }
  }
}

function weekXt(con: Db, week: Dict, view: "official" | "preview") {
  const out: Record<number, number | undefined> = {};
  if (view === "official" && (week.trang_thai !== "cong_bo" || !get(con, "SELECT 1 FROM week_snapshot WHERE tuan_id=?", [week.id]))) {
    return out;
  }
  for (const result of scoreWeek(con, Number(week.id))) {
    if (result.xt_chung != null) out[result.lop_id] = result.xt_chung;
  }
  return out;
}

function hdttByClass(con: Db, milestoneId: number, rows: Dict[]) {
  const stored: Record<number, Dict> = {};
  if (tableExists(con, "milestone_activity")) {
    for (const row of all(con, "SELECT * FROM milestone_activity WHERE milestone_id=?", [milestoneId])) {
      stored[Number(row.lop_id)] = row;
    }
  }
  for (const row of rows) {
    const rec = stored[Number(row.lop_id)];
    row.the_thao = rec?.the_thao ?? null;
    row.van_nghe = rec?.van_nghe ?? null;
    row.hdtt_sum = rec?.the_thao != null && rec?.van_nghe != null ? Number(rec.the_thao) + Number(rec.van_nghe) : null;
  }
  rankField(rows, "hdtt_sum", "xt_hdtt");
}

function formulaTong(sumXt: number, double: HoiHocDouble, xtHdtt: number | null): number | null {
  if (double === "hdtt_only") return xtHdtt == null ? null : sumXt + 2 * xtHdtt;
  if (double === "week_xt") return 2 * sumXt;
  return sumXt;
}

export function milestoneTable(
  con: Db,
  namId: number,
  milestoneId: number,
  view: "official" | "preview" = "official",
): Dict {
  if (view !== "official" && view !== "preview") throw new WorkflowError(400, "Chế độ xem không hợp lệ.");
  const ms = getMilestone(con, namId, milestoneId);
  if (!ms) throw new WorkflowError(404, "Không tìm thấy mốc trong năm học này.");
  const double = String(ms.loai) === "hoi_hoc" ? yearFormulaOf(con, namId).hoi_hoc_double : "none";
  const weeks = milestoneWeeks(con, milestoneId);
  const expected = String(ms.loai) === "hoi_hoc" ? 4 : weeks.length;
  const rows: Dict[] = listLop(con, namId).map((r) => ({
    lop_id: r.id,
    ten: r.ten,
    nhom: r.nhom,
    input_source: "Tính từ dữ liệu",
    xt_dot: null,
  }));
  const columns: [string, string][] = [
    ["nhom", "Nhóm"],
    ["ten", "Lớp"],
  ];
  const notes = [
    "Xếp thứ tăng dần riêng từng nhóm. Thiếu một lớp: cả nhóm chờ.",
  ];
  if (String(ms.loai) === "hoi_hoc") {
    notes.push("Hội học official cần đúng 4 tuần thành viên đã công bố.");
    // none: Excel 20-11-2025 = Σ xt_chung 4 tuần rồi RANK(tong, asc); không cột HĐTT, không ×2.
    // hdtt_only: OQ5 «nhân đôi hoạt động» = Σ xt_w + 2·xt_hdtt, xt_hdtt = RANK(the_thao+van_nghe) trong nhom từ milestone_activity (không assessment_activity).
    // week_xt: Σ 2·xt_w — RANK(2x)=RANK(x) nên hạng giống none; chỉ để xem, UI phải cảnh báo.
    if (double === "none") notes.push("Công thức none: tong = Σ xt_chung 4 tuần, rồi RANK tăng dần trong nhóm.");
    if (double === "hdtt_only") notes.push("Công thức hdtt_only: tong = Σ xt_chung + 2 × XT HĐTT đợt. Thiếu HĐTT cả nhóm → official null.");
    if (double === "week_xt") {
      notes.push("Cảnh báo: week_xt nhân 2 từng XT tuần nhưng RANK(2x)=RANK(x) nên hạng giống none — chỉ để xem, không đổi xếp hạng.");
    }
  } else {
    notes.push("8 tuần: tong = Σ xt_chung mọi tuần thành viên (không cộng XT hai đợt hội học).");
  }
  const weekResults: Record<number, Record<number, number | undefined>> = {};
  for (const week of weeks) {
    weekResults[Number(week.id)] = weekXt(con, week, view);
    columns.push([`w_${week.id}`, `XT tuần ${week.calendar_no || week.so_tuan}`]);
  }
  if (double === "hdtt_only") hdttByClass(con, milestoneId, rows);
  const officialReady = expected > 0 && weeks.length === expected;
  for (const row of rows) {
    const values = weeks.map((week) => {
      const value = weekResults[Number(week.id)][Number(row.lop_id)];
      row[`w_${week.id}`] = value ?? null;
      return value;
    });
    const available = values.filter((value) => value != null);
    row.complete_count = available.length;
    row.constituent_count = values.length;
    const sumXt = available.length ? available.reduce((a, b) => a + Number(b), 0) : null;
    const hdtt = double === "hdtt_only" ? (row.xt_hdtt as number | null) : 0;
    const ready = view === "preview"
      ? sumXt != null && (double !== "hdtt_only" || hdtt != null)
      : officialReady && available.length === values.length && (double !== "hdtt_only" || hdtt != null);
    row.tong = ready && sumXt != null ? formulaTong(sumXt, double, double === "hdtt_only" ? hdtt : 0) : null;
  }
  rankField(rows, "tong", "xt_dot");
  const entries: Record<number, Dict> = {};
  if (tableExists(con, "milestone_entry")) {
    for (const row of all(con, "SELECT * FROM milestone_entry WHERE milestone_id=?", [milestoneId])) {
      entries[Number(row.lop_id)] = row;
    }
  }
  applyOverride(rows, entries);
  columns.push(["complete_count", "Đã đủ"], ["constituent_count", "Cấu phần"]);
  if (double === "hdtt_only") columns.push(["xt_hdtt", "XT HĐTT"]);
  columns.push(["tong", "Tổng"], ["override_rank", "XT nguồn ghi đè"], ["xt_dot", "XT đợt"]);
  for (const row of rows) {
    const entry = entries[Number(row.lop_id)] ?? {};
    for (const field of ["discipline", "reward", "notes"]) row[field] = entry[field] ?? "";
    row.status = row.xt_dot != null
      ? view === "preview" && row.complete_count != null && row.complete_count < row.constituent_count
        ? `Xem trước ${row.complete_count}/${row.constituent_count}`
        : "Đã xếp hạng"
      : "Chờ đủ dữ liệu của nhóm";
  }
  columns.push(["input_source", "Nguồn XT"], ["status", "Trạng thái"], ["discipline", "Kỷ luật"], ["reward", "Khen thưởng"], ["notes", "Ghi chú"]);
  const source = double === "hdtt_only"
    ? "tong = Σ xt_chung + 2 × xt_hdtt; xt_dot = RANK(tong, asc) trong nhóm."
    : double === "week_xt"
      ? "tong = Σ (2 × xt_chung); xt_dot = RANK(tong, asc) — hạng giống none."
      : "tong = Σ xt_chung tuần thành viên; xt_dot = RANK(tong, asc) trong nhóm.";
  return {
    title: String(ms.ten),
    source,
    columns,
    rows,
    notes,
    view,
    weeks,
    hoi_hoc_double: double,
    milestone: ms,
  };
}

export { HOI_HOC_MILESTONES };
