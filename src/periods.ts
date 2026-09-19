import { all, get, listLop, listTuan, requireActiveYear, requireOwned, run, transaction, WorkflowError, yearFormulaOf, type Db, type Dict } from "./db.ts";
import { schoolCalendar, scoreWeek } from "./plan.ts";
import { activityResults, examResults } from "./assessments.ts";
import { DOT_8_TUAN } from "./migrate.ts";
import { listTamKet, milestoneTable } from "./milestones.ts";
import { competitionRanks } from "./scoring.ts";
export const MODELS: Record<string, string> = {
  monthly: "Theo tháng (năm nay)",
  halves: "Theo nửa kỳ (mẫu cũ)",
};
export const MODES: Record<string, string> = {
  thang: "Tháng",
  nua: "Nửa học kỳ",
  hk: "Học kỳ",
  nam: "Cả năm",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS period_month (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 month_key TEXT NOT NULL, semester INTEGER NOT NULL CHECK(semester IN (1,2)),
 half TEXT NOT NULL DEFAULT '' CHECK(half IN ('','dau','sau')),
 PRIMARY KEY(nam_id,month_key)
);
CREATE TABLE IF NOT EXISTS period_week_half (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
 half TEXT NOT NULL CHECK(half IN ('dau','sau')),
 PRIMARY KEY(nam_id,tuan_id)
);
CREATE TABLE IF NOT EXISTS period_options (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 model TEXT NOT NULL CHECK(model IN ('monthly','halves')),
 semester INTEGER NOT NULL CHECK(semester IN (1,2)),
 include_exam INTEGER NOT NULL DEFAULT 0 CHECK(include_exam IN (0,1)),
 exclude_activity INTEGER NOT NULL DEFAULT 0 CHECK(exclude_activity IN (0,1)),
 PRIMARY KEY(nam_id,model,semester)
);
CREATE TABLE IF NOT EXISTS period_entry (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 model TEXT NOT NULL CHECK(model IN ('monthly','halves')),
 mode TEXT NOT NULL CHECK(mode IN ('thang','nua','hk','nam')),
 period_key TEXT NOT NULL,
 lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
 override_rank INTEGER CHECK(override_rank > 0),
 discipline TEXT NOT NULL DEFAULT '', reward TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(nam_id,model,mode,period_key,lop_id)
);
`;

export function initPeriods(con: Db) {
  con.exec(SCHEMA);
}

type Month = { key: string; semester: number; half: string; weeks: Dict[]; conflict: boolean };

export function monthsOf(con: Db, namId: number): Month[] {
  const months: Record<string, Month> = {};
  for (const w of listTuan(con, namId).filter((week) => Number(week.included))) {
    const key = `${String(w.nam).padStart(4, "0")}-${String(w.thang).padStart(2, "0")}`;
    const m = (months[key] ??= { key, semester: Number(w.hoc_ky), half: "", weeks: [], conflict: false });
    m.conflict ||= m.semester !== Number(w.hoc_ky);
    m.weeks.push(w);
  }
  for (const row of all(con, "SELECT * FROM period_month WHERE nam_id=?", [namId])) {
    const m = (months[String(row.month_key)] ??= { key: String(row.month_key), semester: 1, half: "", weeks: [], conflict: false });
    m.semester = Number(row.semester);
    m.half = String(row.half ?? "");
    m.conflict = m.weeks.some((w) => Number(w.hoc_ky) !== Number(row.semester));
  }
  return Object.keys(months)
    .sort()
    .map((k) => months[k]);
}

function optionsOf(con: Db, namId: number, model: string, semester: number) {
  return (
    get(con, "SELECT * FROM period_options WHERE nam_id=? AND model=? AND semester=?", [namId, model, semester]) ?? {
      include_exam: 0,
      exclude_activity: 0,
    }
  );
}

function entriesOf(con: Db, namId: number, mode: string, key: string, model: string) {
  if (mode === "thang") model = "monthly";
  const map: Record<number, Dict> = {};
  for (const r of all(con, "SELECT * FROM period_entry WHERE nam_id=? AND model=? AND mode=? AND period_key=?", [
    namId,
    model,
    mode,
    key,
  ])) {
    map[Number(r.lop_id)] = r;
  }
  return map;
}

function rankField(rows: Dict[], field: string, output = "xt") {
  const groups: Record<number, Dict[]> = {};
  for (const row of rows) {
    row[output] = null;
    (groups[Number(row.nhom)] ??= []).push(row);
  }
  for (const group of Object.values(groups)) {
    if (group.every((r) => r[field] != null)) {
      const ranks = competitionRanks(
        group.map((r) => Number(r[field])),
        false,
      );
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
        row.xt = complete ? row.override_rank : null;
        row.input_source = complete ? "Ghi đè nguồn (cả nhóm)" : "Chờ đủ XT ghi đè hợp lệ của cả nhóm";
      }
    }
  }
}

function weekXt(con: Db, week: Dict, view: "official" | "preview") {
  const out: Record<number, number | undefined> = {};
  if (view === "official" && (week.trang_thai !== "cong_bo" || !get(con, "SELECT 1 FROM week_snapshot WHERE tuan_id=?", [week.id]))) return out;
  for (const result of scoreWeek(con, Number(week.id))) {
    if (result.xt_chung != null) out[result.lop_id] = result.xt_chung;
  }
  return out;
}

export function periodTable(
  con: Db, namId: number, mode: string, key: string, model = "monthly", view: "official" | "preview" = "official",
): Dict {
  key = String(key);
  if (!Object.hasOwn(MODELS, model) || !Object.hasOwn(MODES, mode) || !["official", "preview"].includes(view)) throw new WorkflowError(400, "Mô hình, kỳ hoặc chế độ xem không hợp lệ.");
  if (mode === "nua" && model === "monthly") throw new WorkflowError(400, "Mô hình theo tháng không có chế độ nửa học kỳ.");
  const rows: Dict[] = listLop(con, namId).map((r) => ({
    lop_id: r.id,
    ten: r.ten,
    nhom: r.nhom,
    input_source: "Tính từ dữ liệu",
    xt: null,
  }));
  const columns: [string, string][] = [
    ["nhom", "Nhóm"],
    ["ten", "Lớp"],
  ];
  const notes = ["Xếp thứ tăng dần riêng từng nhóm. Thiếu một lớp: cả nhóm chờ."];
  let source = "";
  let title = "";
  const months = monthsOf(con, namId);
  const entries = entriesOf(con, namId, mode, key, model);
  if (mode === "thang") {
    title = `Tháng ${key}`;
    source = "Cộng hạng các tuần trong tháng, rồi xếp hạng trong nhóm.";
    const month = months.find((m) => m.key === key);
    const weeks = month?.weeks ?? [];
    const weekResults: Record<number, Record<number, number | undefined>> = {};
    for (const week of weeks) {
      weekResults[Number(week.id)] = weekXt(con, week, view);
      columns.push([`w_${week.id}`, `XT tuần ${week.so_tuan}`]);
    }
    for (const row of rows) {
      const values = weeks.map((week) => {
        const value = weekResults[Number(week.id)][Number(row.lop_id)];
        row[`w_${week.id}`] = value ?? null;
        return value;
      });
      const available = values.filter((value) => value != null);
      row.complete_count = available.length;
      row.constituent_count = values.length;
      row.total = available.length && (view === "preview" || available.length === values.length) ? available.reduce((a, b) => a + Number(b), 0) : null;
    }
    rankField(rows, "total");
    applyOverride(rows, entries);
    columns.push(["complete_count", "Đã đủ"], ["constituent_count", "Cấu phần"], ["total", "Tổng XT tuần"], ["override_rank", "XT nguồn ghi đè"], ["xt", "XT tháng"]);
  } else if (mode === "nua") {
    const [sem, half] = key.split("-");
    title = `Nửa ${half === "dau" ? "đầu" : "sau"} HK ${sem}`;
    source = "XT nửa kỳ từ XT tháng được phân vào nửa kỳ.";
    const mappings: Record<number, string> = {};
    for (const r of all(con, "SELECT * FROM period_week_half WHERE nam_id=?", [namId])) {
      mappings[Number(r.tuan_id)] = String(r.half);
    }
    const selected: Month[] = [];
    let ready = true;
    for (const month of months) {
      if (month.semester !== Number(sem)) continue;
      const assigned = new Set(month.weeks.length ? month.weeks.map((w) => mappings[Number(w.id)] || "") : [month.half]);
      if (month.conflict || assigned.has("") || assigned.size !== 1) {
        ready = false;
        continue;
      }
      if (assigned.has(half)) selected.push(month);
    }
    const maps = selected.map((m) => [m, Object.fromEntries((periodTable(con, namId, "thang", m.key, model, view).rows as Dict[]).map((r) => [r.lop_id, r]))] as const);
    for (const month of selected) columns.push([`m_${month.key}`, `XT tháng ${month.key}`]);
    for (const row of rows) {
      const values = maps.map(([month, result]) => {
        const value = result[Number(row.lop_id)]?.xt;
        row[`m_${month.key}`] = value ?? null;
        return value;
      });
      const available = values.filter((value) => value != null);
      row.complete_count = available.length;
      row.constituent_count = values.length;
      row.total = ready && available.length && (view === "preview" || available.length === values.length) ? available.reduce((a, b) => a + Number(b), 0) : null;
    }
    rankField(rows, "total");
    applyOverride(rows, entries);
    columns.push(["complete_count", "Đã đủ"], ["constituent_count", "Cấu phần"], ["total", "Tổng XT tháng"], ["override_rank", "XT nguồn ghi đè"], ["xt", "XT nửa học kỳ"]);
  } else if (mode === "hk") {
    title = `Học kỳ ${key}`;
    const options = optionsOf(con, namId, model, Number(key));
    const includeExam = model === "monthly" && key === "2" && Number(options.include_exam);
    const formula = yearFormulaOf(con, namId);
    const hkWeight = model === "monthly" ? formula.hk_month_weight : 2;
    const useDots = model === "monthly" && formula.hk_basis === "dots";
    const rankKey = useDots ? "xt_dot" : "xt";
    let constituents: [string, string, Dict][] = [];
    let weights: number[] = [];
    let ready = true;
    if (useDots) {
      source = `Tổng XT HK = Tổng XT theo đợt × ${hkWeight} + XT HĐTT.`;
      const dots = listTamKet(con, namId);
      constituents = DOT_8_TUAN.filter((spec) => spec.hk === Number(key)).map((spec) => {
        const ms = dots.find((row) => String(row.ma) === spec.ma);
        const table = ms ? milestoneTable(con, namId, Number(ms.id), view) : { rows: [] as Dict[] };
        return [spec.ma, spec.ten, table] as [string, string, Dict];
      });
      weights = constituents.map(() => 1);
      ready = constituents.every((c) => (c[2].rows as Dict[]).length > 0);
    } else if (model === "monthly") {
      source = `Tổng XT HK = Tổng XT theo tháng × ${hkWeight} + XT HĐTT.`;
      constituents = months.filter((m) => m.semester === Number(key)).map((m) => [m.key, `XT tháng ${m.key}`, periodTable(con, namId, "thang", m.key, model, view)]);
      weights = constituents.map(() => 1);
      ready = !months.some((m) => m.semester === Number(key) && m.conflict);
    } else {
      source = "Tổng học kỳ = cộng hạng tháng nhân hệ số, cộng hạng hoạt động tập thể.";
      constituents = ([["dau", "XT nửa đầu"], ["sau", "XT nửa sau"]] as const).map(([h, lab]) => [
        `${key}-${h}`,
        lab,
        periodTable(con, namId, "nua", `${key}-${h}`, model, view),
      ]);
      weights = [1, 2];
    }
    const maps = constituents.map((c) => Object.fromEntries((c[2].rows as Dict[]).map((r) => [r.lop_id, r])));
    for (const [name, label] of constituents) columns.push([`c_${name}`, label]);
    for (const row of rows) {
      const values = constituents.map((c, i) => {
        const value = maps[i][Number(row.lop_id)]?.[rankKey];
        row[`c_${c[0]}`] = value ?? null;
        return value == null ? null : Number(value) * weights[i];
      });
      const available = values.filter((value) => value != null);
      row.complete_count = available.length;
      row.constituent_count = values.length;
      row.td_total = ready && available.length && (view === "preview" || available.length === values.length) ? available.reduce((a, b) => a + Number(b), 0) : null;
    }
    rankField(rows, "td_total", "rank_td");
    const activities: Record<number, Dict> = {};
    const exams: Record<number, Dict> = {};
    for (const r of activityResults(con, namId, key)) activities[Number(r.lop_id)] = r;
    for (const r of examResults(con, namId, key)) exams[Number(r.lop_id)] = r;
    for (const row of rows) {
      row.rank_activity = activities[Number(row.lop_id)]?.xt ?? null;
      row.rank_exam = exams[Number(row.lop_id)]?.xt ?? null;
      if (model === "monthly") {
        const hdtt = Number(options.exclude_activity) ? 0 : row.rank_activity;
        const exam = includeExam ? row.rank_exam : 0;
        row.total = row.td_total == null
          || (!Number(options.exclude_activity) && row.rank_activity == null)
          || (includeExam && row.rank_exam == null)
          ? null
          : Number(row.td_total) * hkWeight + Number(hdtt) + Number(exam);
      } else {
        const values: (number | null)[] = [row.rank_td == null ? null : Number(row.rank_td) * 2];
        if (!Number(options.exclude_activity)) values.push(row.rank_activity == null ? null : Number(row.rank_activity));
        if (includeExam) values.push(row.rank_exam == null ? null : Number(row.rank_exam));
        row.total = values.every((v) => v != null) ? values.reduce((a, b) => a + Number(b), 0) : null;
      }
    }
    rankField(rows, "total");
    columns.push(
      ["complete_count", "Đã đủ"],
      ["constituent_count", "Cấu phần"],
      ["rank_td", "XT thi đua"],
      ["rank_exam", includeExam ? "XT thi (tính)" : "XT thi (tham khảo)"],
      ["rank_activity", Number(options.exclude_activity) ? "XT HĐTT (không tính)" : "XT HĐTT (tính)"],
      ["total", "Tổng XT chung"],
      ["xt", "XT học kỳ"],
    );
  } else {
    title = "Cả năm";
    source = "Hạng cả năm = hạng học kỳ I + hai lần hạng học kỳ II.";
    const maps = [1, 2].map((i) => Object.fromEntries((periodTable(con, namId, "hk", String(i), model, view).rows as Dict[]).map((r) => [r.lop_id, r])));
    for (const row of rows) {
      const first = maps[0][Number(row.lop_id)];
      const second = maps[1][Number(row.lop_id)];
      row.hk1 = first?.xt ?? null;
      row.hk2 = second?.xt ?? null;
      row.discipline_hk1 = first?.discipline ?? "";
      row.discipline_hk2 = second?.discipline ?? "";
      row.total = row.hk1 != null && row.hk2 != null ? Number(row.hk1) + 2 * Number(row.hk2) : null;
    }
    rankField(rows, "total");
    columns.push(["hk1", "XT HKI"], ["hk2", "XT HKII"], ["total", "HKI + 2 × HKII"], ["xt", "XT cả năm"]);
  }
  if (view === "official" && ((mode === "hk" && key === "2") || mode === "nam") && !schoolCalendar(con, namId).hk2_bd) {
    for (const row of rows) row.xt = null;
    notes.push("Chưa xác nhận ngày bắt đầu HKII; không có kết quả chính thức.");
  }
  for (const row of rows) {
    const entry = entries[Number(row.lop_id)] ?? {};
    for (const field of ["discipline", "reward", "notes"]) row[field] = entry[field] ?? "";
    row.status = row.xt != null
      ? view === "preview" && row.complete_count != null && row.complete_count < row.constituent_count ? `Xem trước ${row.complete_count}/${row.constituent_count}` : "Đã xếp hạng"
      : "Chờ đủ dữ liệu của nhóm";
  }
  columns.push(["input_source", "Nguồn XT"], ["status", "Trạng thái"], ["discipline", "Kỷ luật"], ["reward", "Khen thưởng"], ["notes", "Ghi chú"]);
  return { title, source, columns, rows, notes, view };
}

export function savePeriodConfig(con: Db, namId: number, form: Record<string, string>, months: Month[], model: string) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    if (!Object.hasOwn(MODELS, model)) throw new WorkflowError(400, "Mô hình tổng hợp không hợp lệ.");
    const action = form.action;
    if (action !== "add_month" && action !== "configure") throw new WorkflowError(400, "Thao tác không hợp lệ.");
    const knownMonths = new Set(monthsOf(con, namId).map((month) => month.key));
    const suppliedMonths = new Set(months.map((month) => month.key));
    for (const month of months) {
      if (!knownMonths.has(month.key)) throw new WorkflowError(404, "Không tìm thấy tháng trong năm học này.");
      for (const week of month.weeks) requireOwned(con, "tuan", Number(week.id), namId);
    }
    for (const [field, value] of Object.entries(form)) {
      if (typeof value !== "string") throw new WorkflowError(400, "Dữ liệu cấu hình không hợp lệ.");
      if (field.startsWith("week_")) {
        const id = field.slice(5);
        if (!/^[1-9]\d*$/.test(id)) throw new WorkflowError(404, "Không tìm thấy tuần.");
        requireOwned(con, "tuan", Number(id), namId);
        if (!["", "dau", "sau"].includes(value)) throw new WorkflowError(400, "Phân kỳ tuần không hợp lệ.");
      } else if (field.startsWith("included_")) {
        const id = field.slice(9);
        if (!/^[1-9]\d*$/.test(id)) throw new WorkflowError(404, "Không tìm thấy tuần.");
        requireOwned(con, "tuan", Number(id), namId);
        if (!["0", "1"].includes(value)) throw new WorkflowError(400, "Trạng thái tính tuần không hợp lệ.");
      } else if (field.startsWith("semester_") || field.startsWith("halfmonth_")) {
        const key = field.slice(field.indexOf("_") + 1);
        if (!knownMonths.has(key) || !suppliedMonths.has(key)) throw new WorkflowError(404, "Không tìm thấy tháng trong cấu hình năm học này.");
      } else if (field.startsWith("exam_") || field.startsWith("exclude_activity_")) {
        const semester = field.slice(field.lastIndexOf("_") + 1);
        if (!["1", "2"].includes(semester) || !["", "0", "1"].includes(value)) throw new WorkflowError(400, "Tùy chọn học kỳ không hợp lệ.");
      }
    }
    if (action === "add_month") {
      const monthKey = form.month_key ?? "";
      if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(monthKey)) throw new WorkflowError(400, "Tháng phải có dạng YYYY-MM.");
      if (form.semester !== "1" && form.semester !== "2") throw new WorkflowError(400, "Học kỳ không hợp lệ.");
      run(con, "INSERT INTO period_month(nam_id,month_key,semester) VALUES (?,?,?) ON CONFLICT(nam_id,month_key) DO NOTHING", [
        namId,
        monthKey,
        Number(form.semester),
      ]);
      return { mode: "thang", key: monthKey, model };
    }
    const monthEntries = months.map((month) => {
      const semester = form[`semester_${month.key}`];
      const half = form[`halfmonth_${month.key}`] ?? "";
      if ((semester !== "1" && semester !== "2") || !["", "dau", "sau"].includes(half)) throw new WorkflowError(400, "Phân kỳ không hợp lệ.");
      return { key: month.key, semester: Number(semester), half };
    });
    const weekEntries = listTuan(con, namId).map((week) => ({
      id: week.id,
      half: form[`week_${week.id}`] ?? "",
      included: form[`included_${week.id}`] == null ? Number(week.included) : form[`included_${week.id}`] === "1" ? 1 : 0,
    }));
    const options = [1, 2].map((semester) => {
      const exam = form[`exam_${semester}`] === "1" ? 1 : 0;
      const activity = form[`exclude_activity_${semester}`] === "1" ? 1 : 0;
      if (exam && (model !== "monthly" || semester !== 2)) {
        throw new WorkflowError(400, "Chỉ mô hình tháng HKII dùng xếp thứ thi.");
      }
      return { semester, exam, activity };
    });
    for (const month of monthEntries) {
      run(
        con,
        "INSERT INTO period_month(nam_id,month_key,semester,half) VALUES (?,?,?,?) ON CONFLICT(nam_id,month_key) DO UPDATE SET semester=excluded.semester,half=excluded.half",
        [namId, month.key, month.semester, month.half],
      );
    }
    for (const week of weekEntries) run(con, "UPDATE tuan SET included=? WHERE id=? AND nam_hoc_id=?", [week.included, week.id, namId]);
    run(con, "DELETE FROM period_week_half WHERE nam_id=?", [namId]);
    for (const week of weekEntries) {
      if (week.half) run(con, "INSERT INTO period_week_half(nam_id,tuan_id,half) VALUES (?,?,?)", [namId, week.id, week.half]);
    }
    for (const { semester, exam, activity } of options) {
      run(
        con,
        "INSERT INTO period_options(nam_id,model,semester,include_exam,exclude_activity) VALUES (?,?,?,?,?) ON CONFLICT(nam_id,model,semester) DO UPDATE SET include_exam=excluded.include_exam,exclude_activity=excluded.exclude_activity",
        [namId, model, semester, exam, activity],
      );
    }
    return null;
  });
}

export function savePeriodEntries(
  con: Db,
  namId: number,
  mode: string,
  key: string,
  model: string,
  form: Record<string, string>,
) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    if (!Object.hasOwn(MODELS, model) || !Object.hasOwn(MODES, mode)) {
      throw new WorkflowError(400, "Mô hình hoặc kỳ tổng hợp không hợp lệ.");
    }
    if (mode === "nua" && model === "monthly") throw new WorkflowError(400, "Mô hình theo tháng không có chế độ nửa học kỳ.");
    if (!periodKeys(con, namId, mode, model).some(([periodKey]) => periodKey === key)) {
      throw new WorkflowError(400, "Kỳ tổng hợp không hợp lệ.");
    }
    const storeModel = mode === "thang" ? "monthly" : model;
    for (const [field, value] of Object.entries(form)) {
      if (typeof value !== "string") throw new WorkflowError(400, "Dữ liệu tổng hợp không hợp lệ.");
      const match = /^(?:rank|discipline|reward|notes)_(.*)$/.exec(field);
      if (!match) continue;
      if (!/^[1-9]\d*$/.test(match[1])) throw new WorkflowError(404, "Không tìm thấy lớp.");
      requireOwned(con, "lop", Number(match[1]), namId);
    }
    const entries = listLop(con, namId).map((lop) => {
      const raw = (form[`rank_${lop.id}`] ?? "").trim();
      let rank: number | null = null;
      if (raw) {
        rank = Number(raw);
        if (!Number.isSafeInteger(rank) || rank < 1) throw new WorkflowError(400, "XT ghi đè phải là số nguyên dương.");
      }
      return [
        namId,
        storeModel,
        mode,
        key,
        lop.id,
        rank,
        (form[`discipline_${lop.id}`] ?? "").trim(),
        (form[`reward_${lop.id}`] ?? "").trim(),
        (form[`notes_${lop.id}`] ?? "").trim(),
      ];
    });
    for (const entry of entries) {
      run(
        con,
        "INSERT INTO period_entry(nam_id,model,mode,period_key,lop_id,override_rank,discipline,reward,notes) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(nam_id,model,mode,period_key,lop_id) DO UPDATE SET override_rank=excluded.override_rank,discipline=excluded.discipline,reward=excluded.reward,notes=excluded.notes",
        entry,
      );
    }
  });
}

export function periodKeys(con: Db, namId: number, mode: string, model: string) {
  const months = monthsOf(con, namId);
  if (mode === "thang") return months.map((m) => [m.key, `Tháng ${m.key} (HK${m.semester})`] as [string, string]);
  if (mode === "nam") return [["all", "Cả năm"] as [string, string]];
  if (mode === "nua" && model === "halves") {
    return (["1", "2"] as const).flatMap((hk) =>
      ([["dau", "đầu"], ["sau", "sau"]] as const).map(([h, lab]) => [`${hk}-${h}`, `HK${hk} — nửa ${lab}`] as [string, string]),
    );
  }
  return [
    ["1", "Học kỳ I"],
    ["2", "Học kỳ II"],
  ] as [string, string][];
}

export { optionsOf };
