import { all, get, listLop, requireActiveYear, requireOwned, run, transaction, WorkflowError, type Db, type Dict } from "./db.ts";

export const PERIODS: Record<string, string> = {
  "1": "Học kỳ I",
  "2": "Học kỳ II",
  "1-dau": "Nửa đầu học kỳ I",
  "1-sau": "Nửa sau học kỳ I",
  "2-dau": "Nửa đầu học kỳ II",
  "2-sau": "Nửa sau học kỳ II",
};
export const KINDS: Record<string, string> = { thi: "Thi", "hoat-dong": "HĐTT" };
export const SUBJECTS: [string, string][] = [
  ["toan", "Toán"],
  ["van", "Ngữ văn"],
  ["anh", "Tiếng Anh"],
  ["ly", "Vật lý"],
  ["hoa", "Hóa học"],
  ["bo_sung", "Môn bổ sung"],
];
export const CLASSIFICATIONS: [string, string, number][] = [
  ["gioi", "Giỏi", 3],
  ["kha", "Khá", 2],
  ["trung_binh", "Trung bình", 1],
  ["yeu", "Yếu", -2],
  ["kem", "Kém", -3],
];
export const ACTIVITIES: [string, string][] = [
  ["the_thao", "Xếp thứ thể thao"],
  ["van_nghe", "Xếp thứ văn nghệ"],
];
const EXAM_FIELDS = [...SUBJECTS.map((s) => s[0]), ...CLASSIFICATIONS.map((c) => c[0])];
const ACTIVITY_FIELDS = ACTIVITIES.map((a) => a[0]);
const TABLES = { thi: "assessment_exam", "hoat-dong": "assessment_activity" };
const MAX = 2147483647;

export type Table = {
  title: string;
  source: string;
  columns: [string, string][];
  rows: Dict[];
  notes: string[];
};

export function initAssessments(con: Db) {
  const periodsSql = Object.keys(PERIODS)
    .map((p) => `'${p}'`)
    .join(",");
  const examSql = [
    ...SUBJECTS.map(([k]) => `${k} REAL CHECK (${k} IS NULL OR ${k} BETWEEN 0 AND 100)`),
    ...CLASSIFICATIONS.map(([k]) => `${k} INTEGER CHECK (${k} IS NULL OR (typeof(${k})='integer' AND ${k} BETWEEN 0 AND ${MAX}))`),
  ].join(",\n");
  const actSql = ACTIVITY_FIELDS.map(
    (k) => `${k} INTEGER CHECK (${k} IS NULL OR (typeof(${k})='integer' AND ${k} BETWEEN 1 AND ${MAX}))`,
  ).join(",\n");
  for (const [table, fields] of [
    [TABLES.thi, examSql],
    [TABLES["hoat-dong"], actSql],
  ]) {
    con.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
      period TEXT NOT NULL CHECK (period IN (${periodsSql})),
      lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
      ${fields},
      PRIMARY KEY (nam_hoc_id, period, lop_id)
    )`);
  }
}

function rank(rows: Dict[], valueKey: string, rankKey: string, descending = false) {
  const groups: Record<number, Dict[]> = {};
  for (const row of rows) {
    row[rankKey] = null;
    if (row[valueKey] != null) {
      const g = Number(row.nhom);
      (groups[g] ??= []).push(row);
    }
  }
  for (const members of Object.values(groups)) {
    members.sort((a, b) =>
      descending ? Number(b[valueKey]) - Number(a[valueKey]) : Number(a[valueKey]) - Number(b[valueKey]),
    );
    let previous: unknown = null;
    let rk = 0;
    members.forEach((row, i) => {
      if (i === 0 || row[valueKey] !== previous) rk = i + 1;
      row[rankKey] = rk;
      previous = row[valueKey];
    });
  }
}

function inputRows(con: Db, namId: number, kind: string, period: string) {
  const fields = kind === "thi" ? EXAM_FIELDS : ACTIVITY_FIELDS;
  const stored: Record<number, Dict> = {};
  for (const row of all(con, `SELECT * FROM ${TABLES[kind as keyof typeof TABLES]} WHERE nam_hoc_id=? AND period=?`, [
    namId,
    period,
  ])) {
    stored[Number(row.lop_id)] = row;
  }
  return listLop(con, namId).map((lop) => {
    const rec = stored[Number(lop.id)];
    const row: Dict = { lop_id: lop.id, ten: lop.ten, nhom: lop.nhom, si_so: lop.si_so };
    for (const key of fields) row[key] = rec ? rec[key] ?? null : null;
    return row;
  });
}

export function examResults(con: Db, namId: number, period: string) {
  const rows = inputRows(con, namId, "thi", period);
  for (const row of rows) {
    const subjects = SUBJECTS.map(([k]) => row[k]).filter((v) => v != null).map(Number);
    const counts = CLASSIFICATIONS.map(([k]) => row[k]);
    row.so_mon = subjects.length;
    row.trung_binh_mon = subjects.length ? subjects.reduce((a, b) => a + b, 0) / subjects.length : null;
    row.tong_hs = counts.every((v) => v != null) ? counts.reduce((a: number, b) => a + Number(b), 0) : null;
    row.diem_xep_loai = null;
    if (Number(row.si_so) > 0 && row.tong_hs === row.si_so) {
      row.diem_xep_loai =
        CLASSIFICATIONS.reduce((s, [k, , w]) => s + Number(row[k]) * w, 0) / Number(row.si_so);
    }
    const missing: string[] = [];
    if (!subjects.length) missing.push("Chưa nhập tỷ lệ môn thi");
    if (Number(row.si_so) <= 0) missing.push("Cần sĩ số dương trong danh sách lớp");
    if (row.tong_hs == null) missing.push("Chưa nhập đủ 5 số lượng xếp loại");
    else if (row.tong_hs !== row.si_so) missing.push("Tổng số học sinh xếp loại khác sĩ số hiện tại");
    row.trang_thai = missing.length ? missing.join("; ") : "Đủ dữ liệu";
  }
  for (const [key] of SUBJECTS) rank(rows, key, `xt_${key}`, true);
  rank(rows, "trung_binh_mon", "xt_trung_binh", true);
  rank(rows, "diem_xep_loai", "xt_xep_loai", true);
  for (const row of rows) {
    row.tong_xt =
      row.xt_trung_binh != null && row.xt_xep_loai != null ? 2 * Number(row.xt_trung_binh) + Number(row.xt_xep_loai) : null;
  }
  rank(rows, "tong_xt", "xt");
  return rows;
}

export function activityResults(con: Db, namId: number, period: string) {
  const rows = inputRows(con, namId, "hoat-dong", period);
  for (const row of rows) {
    const complete = ACTIVITY_FIELDS.every((k) => row[k] != null);
    row.tong_xt = complete ? ACTIVITY_FIELDS.reduce((s, k) => s + Number(row[k]), 0) : null;
    row.trang_thai = complete ? "Đủ dữ liệu" : "Chưa nhập đủ xếp thứ thể thao và văn nghệ";
  }
  rank(rows, "tong_xt", "xt");
  return rows;
}

export function assessmentTable(con: Db, namId: number, kind: string, period: string): Table {
  const columns: [string, string][] = [
    ["nhom", "Nhóm"],
    ["ten", "Lớp"],
  ];
  const notes = [
    "Xếp thứ riêng từng nhóm lớp, đồng hạng kiểu 1, 1, 3; chỉ so sánh các giá trị đã có.",
    "Ô trống là chưa nhập, khác số 0. Không xếp thứ chung khi thiếu dữ liệu bắt buộc.",
  ];
  let source = "";
  let rows: Dict[] = [];
  if (kind === "thi") {
    source = "Mô hình XT Thi — giữa học kỳ II, năm học 2016–2017";
    columns.push(["si_so", "Sĩ số"]);
    for (const [key, label] of SUBJECTS) columns.push([key, `${label} (%)`], [`xt_${key}`, `XT ${label}`]);
    columns.push(["so_mon", "Số môn đã nhập"], ["trung_binh_mon", "Tỷ lệ trung bình (%)"], ["xt_trung_binh", "XT tỷ lệ trung bình"]);
    for (const [key, label, weight] of CLASSIFICATIONS) columns.push([key, `${label} (${weight > 0 ? "+" : ""}${weight}đ)`]);
    columns.push(["tong_hs", "Tổng HS xếp loại"], ["diem_xep_loai", "Điểm xếp loại"], ["xt_xep_loai", "XT xếp loại"]);
    notes.push(
      "O = trung bình các môn đã nhập; V = (3×Giỏi+2×Khá+TB−2×Yếu−3×Kém)/sĩ số; X = 2×XT tỷ lệ + XT loại.",
    );
    rows = examResults(con, namId, period);
  } else {
    source = "Mô hình XT HD TT — 2017–2018";
    columns.push(...ACTIVITIES);
    notes.push("E = XT thể thao + XT văn nghệ; F = RANK(E).");
    rows = activityResults(con, namId, period);
  }
  columns.push(["tong_xt", "Tổng XT"], ["xt", "XT chung"], ["trang_thai", "Trạng thái"]);
  const nam = get(con, "SELECT ten FROM nam_hoc WHERE id=?", [namId]);
  return {
    title: `${KINDS[kind]} — ${PERIODS[period]} — ${nam?.ten ?? ""}`,
    source,
    columns,
    rows,
    notes,
  };
}

export function parseInputs(form: Record<string, string>, kind: string, siSo: number) {
  const values: Record<string, number | null> = {};
  if (kind === "thi") {
    for (const [key, label] of SUBJECTS) {
      const raw = (form[key] ?? "").trim();
      if (!raw) {
        values[key] = null;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${label}: tỷ lệ phải từ 0 đến 100.`);
      values[key] = value;
    }
    for (const [key, label] of CLASSIFICATIONS) {
      const raw = (form[key] ?? "").trim();
      values[key] = raw ? Math.trunc(Number(raw)) : null;
      if (raw && (values[key]! < 0 || !Number.isFinite(Number(raw)))) throw new Error(`${label}: số nguyên ≥ 0.`);
    }
    const counts = CLASSIFICATIONS.map(([k]) => values[k]);
    const supplied = counts.reduce((s: number, v) => s + (v ?? 0), 0);
    if (siSo > 0 && supplied > siSo) throw new Error("Tổng số học sinh đã nhập không được vượt sĩ số lớp.");
    if (counts.every((v) => v != null) && supplied !== siSo) {
      throw new Error(`Tổng 5 số lượng xếp loại phải bằng sĩ số lớp (${siSo}).`);
    }
  } else {
    for (const [key, label] of ACTIVITIES) {
      const raw = (form[key] ?? "").trim();
      values[key] = raw ? Math.trunc(Number(raw)) : null;
      if (raw && (!(values[key]! >= 1))) throw new Error(`${label}: số nguyên dương.`);
    }
  }
  return values;
}

export function saveAssessment(
  con: Db,
  namId: number,
  kind: string,
  period: string,
  lopId: number,
  values: Record<string, number | null> | null,
) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", lopId, namId);
    if (!Object.hasOwn(TABLES, kind)) throw new WorkflowError(400, "Loại đánh giá không hợp lệ.");
    if (!Object.hasOwn(PERIODS, period)) throw new WorkflowError(400, "Kỳ đánh giá không hợp lệ.");
    const table = TABLES[kind as keyof typeof TABLES];
    if (!values) {
      run(con, `DELETE FROM ${table} WHERE nam_hoc_id=? AND period=? AND lop_id=?`, [namId, period, lopId]);
      return;
    }
    const fields = kind === "thi" ? EXAM_FIELDS : ACTIVITY_FIELDS;
    const cols = fields.join(",");
    const ph = fields.map(() => "?").join(",");
    const upd = fields.map((k) => `${k}=excluded.${k}`).join(",");
    run(
      con,
      `INSERT INTO ${table} (nam_hoc_id,period,lop_id,${cols}) VALUES (?,?,?,${ph}) ON CONFLICT(nam_hoc_id,period,lop_id) DO UPDATE SET ${upd}`,
      [namId, period, lopId, ...fields.map((k) => values[k])],
    );
  });
}

export { EXAM_FIELDS, ACTIVITY_FIELDS };
