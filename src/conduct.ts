import {
  all,
  get,
  listLop,
  listTuan,
  parseGvcnGroupId,
  requireActiveYear,
  requireOwned,
  run,
  syncNhapWeekClass,
  tableExists,
  transaction,
  WorkflowError,
  yearFormulaOf,
  type Db,
  type Dict,
  type Gvcn51Window,
} from "./db.ts";
import { schoolCalendar, scoreWeek } from "./plan.ts";
import { num } from "./scoring.ts";

export const MODE_LABELS: Record<string, string> = {
  gvcn: "Công tác chủ nhiệm",
  data: "Dữ liệu điểm trừ tuần",
  teacher: "Đánh giá GVCN (Excel 2016)",
  classic: "Điểm nề nếp học kỳ (Excel 2016)",
};

export const GVCN_HINT =
  "Lớp chọn (10A1, 10A2, 10A3, 11A1, 11A8, 12A1, 12A2) vào nhóm A — cứ đủ 5 điểm nề nếp thì GVCN mất 0,1. Các lớp khác vào nhóm C — cứ đủ 10 điểm mất 0,1. Có thể đổi tay ở Danh sách lớp.";

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

const HEAVY_MA = new Set(["ky_luat_muc_30", "ky_luat_muc_50"]);

export function initConduct(con: Db) {
  con.exec(SCHEMA);
}

function truncTowardZero(n: number) {
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}

function tenths(n: number) {
  return Math.round(n * 10) / 10;
}

function isHeavy(ma: string, scoreKey: string, absDiem: number) {
  return HEAVY_MA.has(ma) || (scoreKey === "hs_ky_luat" && (absDiem === 30 || absDiem === 50));
}

function mappedTru(ma: string, absDiem: number) {
  if (ma === "ky_luat_muc_50" || absDiem === 50) return 15;
  if (ma === "ky_luat_muc_30" || absDiem === 30) return 10;
  return 0;
}

function decomposeHeavy(abs: number) {
  let rem = Math.max(0, Math.round(abs));
  let taken = 0;
  let tru = 0;
  while (rem >= 50) {
    rem -= 50;
    taken += 50;
    tru += 15;
  }
  while (rem >= 30) {
    rem -= 30;
    taken += 30;
    tru += 10;
  }
  return { abs: taken, tru };
}

function bonusOf(xt: number | null | undefined) {
  if (xt === 1) return 0.5;
  if (xt === 2) return 0.3;
  if (xt === 3) return 0.2;
  return 0;
}

function tru51(penalty: number, nguong: number) {
  if (!(nguong > 0) || penalty < nguong) return 0;
  return Math.floor(penalty / nguong) * 0.1;
}

type HeavyCell = { abs: number; tru: number };

function loadHeavyMap(con: Db, tuanIds: number[]): Record<string, HeavyCell> {
  const map: Record<string, HeavyCell> = {};
  const bump = (lopId: number, tuanId: number, abs: number, tru: number) => {
    const key = `${lopId}:${tuanId}`;
    const cur = map[key] ?? { abs: 0, tru: 0 };
    cur.abs += abs;
    cur.tru += tru;
    map[key] = cur;
  };
  if (!tuanIds.length) return map;
  const ph = tuanIds.map(() => "?").join(",");
  if (tableExists(con, "su_kien") && tableExists(con, "tieu_chi")) {
    for (const ev of all(con, `SELECT sk.so_luong, sk.gvcn_phat_hien, bc.tuan_id, bc.lop_id,
        tc.ma, tc.score_key, tc.diem
      FROM su_kien sk
      JOIN bao_cao_tuan bc ON bc.id=sk.bao_cao_id
      JOIN tieu_chi tc ON tc.id=sk.tieu_chi_id
      WHERE bc.tuan_id IN (${ph})`, tuanIds)) {
      const ma = String(ev.ma);
      const scoreKey = String(ev.score_key || "");
      const absUnit = Math.abs(Number(ev.diem));
      if (!isHeavy(ma, scoreKey, absUnit)) continue;
      const sl = Number(ev.so_luong || 1);
      const tru = Number(ev.gvcn_phat_hien) ? 0 : mappedTru(ma, absUnit) * sl;
      bump(Number(ev.lop_id), Number(ev.tuan_id), absUnit * sl, tru);
    }
  }
  if (tableExists(con, "cham_dong")) {
    for (const line of all(con, `SELECT c.so_luong, c.diem_mot, c.thanh_diem, c.tuan_id, c.lop_id, c.score_key, tc.ma
      FROM cham_dong c
      LEFT JOIN tieu_chi tc ON tc.id=c.tieu_chi_id
      WHERE c.nguon='tay' AND c.tuan_id IN (${ph})`, tuanIds)) {
      const ma = String(line.ma || "");
      const scoreKey = String(line.score_key || "");
      const absUnit = Math.abs(Number(line.diem_mot));
      if (!isHeavy(ma, scoreKey, absUnit)) continue;
      const sl = Number(line.so_luong || 1);
      bump(Number(line.lop_id), Number(line.tuan_id), Math.abs(Number(line.thanh_diem)), mappedTru(ma, absUnit) * sl);
    }
  }
  return map;
}

function weekDisplayNo(week: Dict, schoolFriday: Date | null) {
  const datedNo = schoolFriday && week.ngay_bd
    ? Math.round((new Date(`${week.ngay_bd}T00:00:00Z`).getTime() - schoolFriday.getTime()) / 604800000) + 1
    : 0;
  return Number(week.calendar_no) || datedNo || Number(week.so_tuan);
}

export function includedWeeks(con: Db, namId: number, hk: number) {
  const calendar = schoolCalendar(con, namId);
  const schoolFriday = calendar.ngay_bd ? new Date(`${calendar.ngay_bd}T00:00:00Z`) : null;
  if (schoolFriday) schoolFriday.setUTCDate(schoolFriday.getUTCDate() - ((schoolFriday.getUTCDay() + 2) % 7));
  return listTuan(con, namId)
    .filter((week) => Number(week.hoc_ky) === hk && Number(week.included) === 1)
    .map((week) => ({ ...week, display_no: weekDisplayNo(week, schoolFriday) }));
}

export function listGvcnGroups(con: Db, namId: number) {
  if (!tableExists(con, "gvcn_ratio_group")) return [];
  return all(con, "SELECT * FROM gvcn_ratio_group WHERE nam_hoc_id=? ORDER BY ma", [namId]);
}

export function feed(con: Db, namId: number, hk: number) {
  const weeks = includedWeeks(con, namId, hk);
  const tuanIds = weeks.map((week) => Number(week.id));
  const heavy = loadHeavyMap(con, tuanIds);
  const canonical: Record<string, Dict> = {};
  for (const week of weeks) {
    for (const result of scoreWeek(con, Number(week.id))) {
      canonical[`${result.lop_id}:${week.id}`] = result as unknown as Dict;
    }
  }
  const overrides: Record<string, Dict> = {};
  for (const r of all(con, "SELECT * FROM conduct_penalty WHERE nam_hoc_id=? AND hoc_ky=?", [namId, hk])) {
    overrides[`${r.lop_id}:${r.tuan_id}`] = r;
  }
  const ratios: Record<string, number> = {};
  for (const r of all(con, "SELECT * FROM conduct_ratio WHERE nam_hoc_id=? AND hoc_ky=?", [namId, hk])) {
    ratios[`${r.lop_id}:${r.model}`] = Number(r.ratio);
  }
  const groups = Object.fromEntries(listGvcnGroups(con, namId).map((g) => [Number(g.id), g]));
  const rows: Dict[] = [];
  for (const lop of listLop(con, namId)) {
    const group = lop.gvcn_group_id != null ? groups[Number(lop.gvcn_group_id)] : undefined;
    const row: Dict = {
      lop_id: lop.id,
      ten: lop.ten,
      nhom: lop.nhom,
      gvcn: lop.gvcn,
      gvcn_group_id: lop.gvcn_group_id ?? null,
      group_ma: group ? String(group.ma) : "",
      group_ten: group ? String(group.ten) : "",
      nguong: group ? Number(group.nguong) : null,
      cells: [],
      missing: 0,
    };
    let total = 0;
    const cells: Dict[] = [];
    for (const week of weeks) {
      const key = `${lop.id}:${week.id}`;
      const recorded = canonical[key];
      const tongTru = recorded ? Number(recorded.tong_tru) : null;
      const rowHs = recorded?.row ? Math.max(0, -num(recorded.row as Dict, "hs_ky_luat")) : 0;
      const tracked = heavy[key] ?? { abs: 0, tru: 0 };
      const leftover = decomposeHeavy(rowHs - tracked.abs);
      const heavyAbs = tracked.abs + leftover.abs;
      const computedTruNang = tracked.tru + leftover.tru;
      const computedPenalty = tongTru == null ? null : Math.max(0, tongTru - heavyAbs);
      const override = overrides[key];
      const penalty = override ? Number(override.penalty) : computedPenalty;
      const truNang = override ? 0 : computedTruNang;
      const published = String(week.trang_thai) === "cong_bo";
      const xt = published && recorded?.xt_chung != null ? Number(recorded.xt_chung) : null;
      const bonus = published ? bonusOf(xt) : 0;
      const cell = {
        tuan_id: week.id,
        so_tuan: week.display_no,
        default: computedPenalty,
        tong_tru: tongTru,
        heavy_abs: heavyAbs,
        tru_nang: truNang,
        bonus,
        xt_chung: xt,
        published,
        override: override ? Number(override.penalty) : null,
        source_note: override ? String(override.source ?? "") : "",
        source: override
          ? `Nhập riêng: ${override.source || "không ghi chú"}`
          : computedPenalty != null
            ? `Điểm tuần chuẩn: ${String(recorded?.provenance || "")}`
            : "Chưa có điểm tuần hợp lệ",
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

export function gvcnScores(con: Db, namId: number, hk: number, view: "official" | "preview" = "official") {
  const window: Gvcn51Window = yearFormulaOf(con, namId).gvcn_5_1_window;
  const { weeks, rows } = feed(con, namId, hk);
  const unpublished = weeks.filter((week) => String(week.trang_thai) !== "cong_bo");
  const officialReady = unpublished.length === 0;
  const scored = rows.map((raw) => {
    const nguong = raw.nguong == null ? null : Number(raw.nguong);
    const viewCells = (raw.cells as Dict[]).filter((cell) => view === "official" || cell.published);
    let penaltyHk = 0;
    let truNangHk = 0;
    let congHk = 0;
    let used = 0;
    let weekly51 = 0;
    const missingPenalty = viewCells.some((cell) => cell.penalty == null);
    for (const cell of viewCells) {
      if (cell.penalty == null) continue;
      const p = Number(cell.penalty);
      penaltyHk += p;
      truNangHk += Number(cell.tru_nang || 0);
      congHk += Number(cell.bonus || 0);
      used += 1;
      if (nguong != null) weekly51 += tru51(p, nguong);
    }
    const tru51Val = nguong == null ? null : tenths(window === "weekly" ? weekly51 : tru51(penaltyHk, nguong));
    const cong = tenths(congHk);
    const truNang = tenths(truNangHk);
    let diem: number | null = null;
    let diemRaw: number | null = null;
    let capped = false;
    let negative = false;
    const missingGroup = raw.gvcn_group_id == null;
    if (!missingGroup && tru51Val != null && !missingPenalty) {
      diemRaw = 20 - tru51Val - truNang + cong;
      if (diemRaw < 0) negative = true;
      if (diemRaw > 20) capped = true;
      diem = tenths(Math.min(20, Math.max(0, diemRaw)));
    }
    if (missingGroup) diem = null;
    if (view === "official" && !officialReady) diem = null;
    let status: string;
    if (missingGroup) status = "Chưa gán nhóm A/B/C.";
    else if (view === "official" && !officialReady) {
      status = `Chưa đủ tuần công bố (${weeks.length - unpublished.length}/${weeks.length}).`;
    } else if (missingPenalty) status = `Thiếu điểm trừ của ${viewCells.filter((c) => c.penalty == null).length} tuần.`;
    else if (view === "preview") status = `Xem trước ${used}/${weeks.length} tuần đã công bố.`;
    else if (negative) status = "Điểm âm — xuất 0.";
    else if (capped) status = "Đủ dữ liệu. Trần 20 sau điểm thưởng.";
    else status = "Đủ dữ liệu tuần.";
    return {
      ...raw,
      window,
      penalty_hk: missingPenalty ? null : tenths(penaltyHk),
      tru_5_1: tru51Val,
      tru_nang_hk: truNang,
      cong_hk: cong,
      diem,
      diem_raw: diemRaw,
      capped,
      negative,
      missing_group: missingGroup,
      official_ready: officialReady,
      status,
    };
  });
  return { weeks, rows: scored, window, officialReady, unpublished: unpublished.length };
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

export function conductTables(con: Db, namId: number, hk: number, view: "official" | "preview" = "official") {
  const scored = gvcnScores(con, namId, hk, view);
  const { weeks, rows } = feed(con, namId, hk);
  const common: [string, string][] = [
    ["ten", "Lớp"],
    ["gvcn", "GVCN"],
    ["group_ma", "Nhóm"],
  ];
  const weekly: [string, string][] = weeks.map((w) => [`w_${w.id}`, `Tuần ${w.display_no}`]);
  const windowLabel = scored.window === "weekly" ? "từng tuần" : "cả học kỳ";
  return [
    {
      title: `Công tác chủ nhiệm HK${hk}`,
      source: `20 − trừ 5.1 (cửa sổ ${windowLabel}) − trừ lỗi nặng + thưởng hạng tuần; trần 20.`,
      columns: [
        ...common,
        ["penalty_hk", "Điểm trừ ngưỡng"],
        ["tru_5_1", "Trừ 5.1"],
        ["tru_nang_hk", "Trừ lỗi nặng"],
        ["cong_hk", "Cộng 5.2"],
        ["diem", "Điểm / 20"],
        ["status", "Trạng thái"],
      ],
      rows: scored.rows,
      notes: [
        "Lỗi −30/−50 được rút khỏi 5.1 và quy thành 10/15, trừ khi GVCN phát hiện.",
        "Tuần không tính không vào tổng và không làm điểm chính thức thành trống.",
        view === "preview" ? "Xem thử: chỉ tuần đã công bố." : "Chính thức: mọi tuần được tính của học kỳ phải đã công bố.",
      ],
    },
    {
      title: `Dữ liệu HK${hk}`,
      source: "Điểm tuần đã lưu / nguồn nhập riêng (đã rút lỗi nặng khỏi điểm ngưỡng).",
      columns: [...common, ...weekly, ["total", "Tổng điểm trừ dương"], ["status", "Trạng thái"]],
      rows,
      notes: ["Ô trống là thiếu dữ liệu. Tuần included=0 không hiện."],
    },
    {
      title: hk === 1 ? "Điểm NN(HKI) — Excel 2016" : "Điểm NN (HKII) — Excel 2016",
      source: "20 − (tổng / tỷ lệ). Mô hình cũ, không dùng cho 2026–2027.",
      columns: [...common, ...weekly, ["total", "Tổng điểm dương"], ["ratio", "Điểm tỷ lệ"], ["deduction", "Điểm trừ"], ["final", "Điểm nề nếp"], ["status", "Trạng thái"]],
      rows: modelRows(rows, "classic"),
      notes: ["Ẩn mặc định. Tỷ lệ nhập riêng từng lớp."],
    },
    {
      title: `Đánh giá GVCN HK${hk} — Excel 2016`,
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
      notes: ["Ẩn mặc định. Không phải công thức Công tác chủ nhiệm 20 điểm."],
    },
  ];
}

export function listHeavyEvents(con: Db, namId: number, hk: number) {
  const weeks = includedWeeks(con, namId, hk);
  if (!weeks.length || !tableExists(con, "su_kien")) return [];
  const ids = weeks.map((w) => Number(w.id));
  const ph = ids.map(() => "?").join(",");
  const byWeek = Object.fromEntries(weeks.map((w) => [Number(w.id), w]));
  return all(con, `SELECT sk.id, sk.ho_ten, sk.so_luong, sk.gvcn_phat_hien, sk.ngay,
      bc.tuan_id, bc.lop_id, lop.ten AS lop_ten, lop.gvcn,
      tc.ma, tc.ten AS tc_ten, tc.score_key, tc.diem
    FROM su_kien sk
    JOIN bao_cao_tuan bc ON bc.id=sk.bao_cao_id
    JOIN lop ON lop.id=bc.lop_id
    JOIN tieu_chi tc ON tc.id=sk.tieu_chi_id
    WHERE bc.tuan_id IN (${ph})
    ORDER BY bc.tuan_id, lop.thu_tu, lop.ten, sk.id`, ids).flatMap((ev) => {
    const ma = String(ev.ma);
    const absUnit = Math.abs(Number(ev.diem));
    if (!isHeavy(ma, String(ev.score_key || ""), absUnit)) return [];
    const sl = Number(ev.so_luong || 1);
    const mapped = mappedTru(ma, absUnit) * sl;
    const week = byWeek[Number(ev.tuan_id)];
    return [{
      ...ev,
      so_tuan: week?.display_no ?? ev.tuan_id,
      abs: absUnit * sl,
      mapped,
      waived: Number(ev.gvcn_phat_hien) ? mapped : 0,
    }];
  });
}

export function saveGvcnGroup(con: Db, namId: number, lopId: number, groupId: number | null) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", lopId, namId);
    const id = parseGvcnGroupId(con, namId, groupId);
    run(con, "UPDATE lop SET gvcn_group_id=? WHERE id=? AND nam_hoc_id=?", [id, lopId, namId]);
    syncNhapWeekClass(con, namId, lopId);
  });
}

export function saveGvcnPhatHien(con: Db, namId: number, eventId: number, flag: number) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new WorkflowError(404, "Không tìm thấy sự kiện.");
    const row = get(con, `SELECT sk.id, t.nam_hoc_id FROM su_kien sk
      JOIN bao_cao_tuan bc ON bc.id=sk.bao_cao_id
      JOIN tuan t ON t.id=bc.tuan_id
      WHERE sk.id=?`, [eventId]);
    if (!row || Number(row.nam_hoc_id) !== namId) throw new WorkflowError(404, "Không tìm thấy sự kiện trong năm học này.");
    run(con, "UPDATE su_kien SET gvcn_phat_hien=? WHERE id=?", [flag ? 1 : 0, eventId]);
  });
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
    if (Number(week.included) !== 1) throw new WorkflowError(400, "Tuần không nằm trong tập công tác chủ nhiệm.");
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
