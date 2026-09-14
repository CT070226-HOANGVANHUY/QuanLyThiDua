import { all, get, listLop, listTuan, requireActiveYear, requireOwned, run, transaction, WorkflowError, type Db, type Dict } from "./db.ts";
import { schoolCalendar, scoreWeek } from "./plan.ts";

export const MODE_LABELS: Record<string, string> = {
  teacher: "Đánh giá GVCN",
  classic: "Điểm nề nếp học kỳ",
  data: "Dữ liệu điểm trừ tuần",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conduct_ratio (
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    hoc_ky INTEGER NOT NULL CHECK(hoc_ky IN (1, 2)),
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    model TEXT NOT NULL CHECK(model IN ('classic', 'teacher')),
    ratio REAL NOT NULL CHECK(ratio > 0),
    PRIMARY KEY(nam_hoc_id, hoc_ky, lop_id, model)
);
CREATE TABLE IF NOT EXISTS conduct_penalty (
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    hoc_ky INTEGER NOT NULL CHECK(hoc_ky IN (1, 2)),
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
    penalty REAL NOT NULL CHECK(penalty >= 0),
    source TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(nam_hoc_id, hoc_ky, lop_id, tuan_id)
);
`;

export function initConduct(con: Db) {
  con.exec(SCHEMA);
}

function truncTowardZero(n: number) {
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}

export function feed(con: Db, namId: number, hk: number) {
  const calendar = schoolCalendar(con, namId);
  const schoolFriday = calendar.ngay_bd ? new Date(`${calendar.ngay_bd}T00:00:00Z`) : null;
  if (schoolFriday) schoolFriday.setUTCDate(schoolFriday.getUTCDate() - ((schoolFriday.getUTCDay() + 2) % 7));
  const weeks = listTuan(con, namId).filter((w) => Number(w.hoc_ky) === hk).map((week) => {
    const datedNo = schoolFriday && week.ngay_bd
      ? Math.round((new Date(`${week.ngay_bd}T00:00:00Z`).getTime() - schoolFriday.getTime()) / 604800000) + 1
      : 0;
    return { ...week, display_no: Number(week.calendar_no) || datedNo || Number(week.so_tuan) };
  });
  const canonical: Record<string, Dict> = {};
  for (const week of weeks) for (const result of scoreWeek(con, Number(week.id))) {
    if (result.xt_chung != null) canonical[`${result.lop_id}:${week.id}`] = result;
  }
  const overrides: Record<string, Dict> = {};
  for (const r of all(con, "SELECT * FROM conduct_penalty WHERE nam_hoc_id=? AND hoc_ky=?", [namId, hk])) {
    overrides[`${r.lop_id}:${r.tuan_id}`] = r;
  }
  const ratios: Record<string, number> = {};
  for (const r of all(con, "SELECT * FROM conduct_ratio WHERE nam_hoc_id=? AND hoc_ky=?", [namId, hk])) {
    ratios[`${r.lop_id}:${r.model}`] = Number(r.ratio);
  }
  const rows: Dict[] = [];
  for (const lop of listLop(con, namId)) {
    const row: Dict = { lop_id: lop.id, ten: lop.ten, nhom: lop.nhom, gvcn: lop.gvcn, cells: [], missing: 0 };
    let total = 0;
    const cells: Dict[] = [];
    for (const week of weeks) {
      const key = `${lop.id}:${week.id}`;
      const recorded = canonical[key];
      const def = recorded ? Number(recorded.tong_tru) : null;
      const override = overrides[key];
      const penalty = override ? Number(override.penalty) : def;
      const cell = {
        tuan_id: week.id,
        so_tuan: week.display_no,
        default: def,
        override: override ? Number(override.penalty) : null,
        source_note: override ? String(override.source ?? "") : "",
        source: override ? `Nhập riêng: ${override.source || "không ghi chú"}` : def != null ? `Điểm tuần chuẩn: ${String(recorded.provenance || "")}` : "Chưa có điểm tuần hợp lệ",
        penalty,
      };
      cells.push(cell);
      row[`w_${week.id}`] = penalty;
      if (penalty == null) row.missing = Number(row.missing) + 1;
      else total += Number(penalty);
    }
    row.cells = cells;
    row.total = weeks.length && Number(row.missing) === 0 ? total : null;
    row.status = !weeks.length
      ? "Chưa có tuần trong học kỳ."
      : Number(row.missing)
        ? `Thiếu điểm của ${row.missing}/${weeks.length} tuần.`
        : "Đủ dữ liệu tuần.";
    row.classic_ratio = ratios[`${lop.id}:classic`] ?? null;
    row.teacher_ratio = ratios[`${lop.id}:teacher`] ?? null;
    rows.push(row);
  }
  return { weeks, rows };
}

function modelRows(rawRows: Dict[], model: "classic" | "teacher") {
  return rawRows.map((raw) => {
    const row: Dict = { ...raw, ratio: raw[`${model}_ratio`], quotient: null, remainder: null, deduction: null, helper_ab: null, final: null };
    if (model === "teacher") {
      row.total = raw.total != null ? -Number(raw.total) : null;
      for (const cell of raw.cells as Dict[]) {
        row[`w_${cell.tuan_id}`] = cell.penalty != null ? -Number(cell.penalty) : null;
      }
    }
    if (row.ratio == null) row.status = `${row.status} Chưa nhập tỷ lệ riêng của mô hình này.`;
    if (row.total != null && row.ratio != null) {
      const total = Number(row.total);
      const ratio = Number(row.ratio);
      if (model === "teacher") {
        const quotient = truncTowardZero(total / ratio);
        const remainder = total - quotient * ratio;
        const deduction = quotient * 0.1;
        row.quotient = quotient;
        row.remainder = remainder;
        row.deduction = deduction;
        row.helper_ab = remainder < -ratio ? -0.1 : 0;
        row.final = 20 + deduction;
      } else {
        const quotient = total / ratio;
        row.quotient = quotient;
        row.deduction = quotient;
        row.final = 20 - quotient;
      }
    }
    return row;
  });
}

export function conductTables(con: Db, namId: number, hk: number) {
  const { weeks, rows } = feed(con, namId, hk);
  const common: [string, string][] = [
    ["nhom", "Nhóm"],
    ["ten", "Lớp"],
    ["gvcn", "GVCN"],
  ];
  const weekly: [string, string][] = weeks.map((w) => [`w_${w.id}`, `Tuần ${w.display_no}`]);
  return [
    {
      title: `Dữ liệu HK${hk}`,
      source: "Điểm tuần đã lưu / nguồn nhập riêng.",
      columns: [...common, ...weekly, ["total", "Tổng điểm trừ dương"], ["status", "Trạng thái"]],
      rows,
      notes: ["Ô trống là thiếu dữ liệu."],
    },
    {
      title: hk === 1 ? "Điểm NN(HKI)" : "Điểm NN (HKII)",
      source: "20 − (tổng / tỷ lệ).",
      columns: [...common, ...weekly, ["total", "Tổng điểm dương"], ["ratio", "Điểm tỷ lệ"], ["deduction", "Điểm trừ"], ["final", "Điểm nề nếp"], ["status", "Trạng thái"]],
      rows: modelRows(rows, "classic"),
      notes: ["Tỷ lệ nhập riêng từng lớp."],
    },
    {
      title: `Đánh giá GVCN HK${hk}`,
      source: "Lấy phần nguyên của Điểm NN / Điểm tỷ lệ, nhân 0,1 rồi cộng vào 20.",
      columns: [
        ...common,
        ...weekly,
        ["total", "Điểm NN"],
        ["ratio", "Điểm tỷ lệ"],
        ["quotient", "Hệ số quy đổi"],
        ["deduction", "Điểm trừ"],
        ["final", "Điểm thi đua"],
        ["status", "Trạng thái"],
      ],
      rows: modelRows(rows, "teacher"),
      notes: ["Hệ số quy đổi lấy phần nguyên theo hướng về 0; không cộng cột phụ AB."],
    },
  ];
}

export function saveRatio(con: Db, namId: number, hk: number, lopId: number, model: string, ratio: number | null) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", lopId, namId);
    if (hk !== 1 && hk !== 2) throw new WorkflowError(400, "Học kỳ không hợp lệ.");
    if (model !== "classic" && model !== "teacher") throw new WorkflowError(400, "Mô hình nề nếp không hợp lệ.");
    if (ratio != null && (!Number.isFinite(ratio) || ratio <= 0)) {
      throw new WorkflowError(400, "Tỷ lệ phải là số dương.");
    }
    if (ratio == null) {
      run(con, "DELETE FROM conduct_ratio WHERE nam_hoc_id=? AND hoc_ky=? AND lop_id=? AND model=?", [namId, hk, lopId, model]);
    } else {
      run(
        con,
        "INSERT INTO conduct_ratio(nam_hoc_id,hoc_ky,lop_id,model,ratio) VALUES(?,?,?,?,?) ON CONFLICT(nam_hoc_id,hoc_ky,lop_id,model) DO UPDATE SET ratio=excluded.ratio",
        [namId, hk, lopId, model, ratio],
      );
    }
  });
}

export function savePenalty(con: Db, namId: number, hk: number, lopId: number, tuanId: number, penalty: number | null, source: string) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", lopId, namId);
    const week = requireOwned(con, "tuan", tuanId, namId);
    if (hk !== 1 && hk !== 2) throw new WorkflowError(400, "Học kỳ không hợp lệ.");
    if (Number(week.hoc_ky) !== hk) throw new WorkflowError(404, "Không tìm thấy tuần trong học kỳ này.");
    if (penalty != null && (!Number.isFinite(penalty) || penalty < 0)) {
      throw new WorkflowError(400, "Điểm trừ phải là số không âm.");
    }
    if (penalty == null) {
      run(con, "DELETE FROM conduct_penalty WHERE nam_hoc_id=? AND hoc_ky=? AND lop_id=? AND tuan_id=?", [namId, hk, lopId, tuanId]);
    } else {
      run(
        con,
        "INSERT INTO conduct_penalty(nam_hoc_id,hoc_ky,lop_id,tuan_id,penalty,source) VALUES(?,?,?,?,?,?) ON CONFLICT(nam_hoc_id,hoc_ky,lop_id,tuan_id) DO UPDATE SET penalty=excluded.penalty,source=excluded.source",
        [namId, hk, lopId, tuanId, penalty, source],
      );
    }
  });
}

export { get };
