import { addColumn, all, get, getTuan, inTransaction, listLop, listTuan, requireActiveYear, requireOwned, run, SAMPLE_WEEK_NOTE, tableExists, transaction, upsertTuan, WorkflowError, yearFormulaOf, type Db, type Dict } from "./db.ts";
import { CATALOG_SCORE_KEYS, migrate } from "./migrate.ts";
import { GIO_KEYS, HOI_HOC_WEIGHTS, KTM_SCORE_KEYS, NN_KEYS, competitionRanks, scoreAll, type ClassResult, type Row } from "./scoring.ts";

export const TT_NHAP = "nhap";
export const TT_CHOT = "chot";
export const TT_CONG_BO = "cong_bo";
export const TT_LABEL: Record<string, string> = {
  nhap: "Đang nhập",
  chot: "Đã chốt",
  cong_bo: "Đã công bố",
};
export const RANK_STATUS_LABEL: Record<string, string> = {
  official: "Đã công bố",
  provisional: "Chưa công bố",
  missing: "Thiếu dữ liệu",
};

export const LOAI_NN: [string, string][] = [
  ["di_muon", "Đi học muộn"],
  ["trang_phuc", "Trang phục"],
  ["phu_hieu", "Thiếu phù hiệu"],
  ["vp_khac", "Vi phạm khác"],
];

const SEED: [string, string, string, number, string][] = [
  ["nghi_hoc", "Nghỉ học không lý do", "ne_nep", -10, "HS"],
  ["di_muon", "Đi học muộn", "ne_nep", -5, "HS"],
  ["trang_phuc", "Vi phạm trang phục", "ne_nep", -1, "HS"],
  ["phu_hieu", "Thiếu phù hiệu", "ne_nep", -1, "HS"],
  ["vp_khac", "Vi phạm khác", "ne_nep", -10, "HS"],
  ["thai_do", "Lỗi thái độ / ý thức giờ học", "hoc_tap", -1, "HS"],
  ["gio_tot", "Giờ tốt", "hoc_tap", 2, "giờ"],
  ["gio_kha", "Giờ khá", "hoc_tap", 1, "giờ"],
  ["gio_tb", "Giờ trung bình", "hoc_tap", 0, "giờ"],
  ["gio_yeu", "Giờ yếu", "hoc_tap", -1, "giờ"],
  ["gio_kem", "Giờ kém", "hoc_tap", -2, "giờ"],
  ["ktm_9_10", "Điểm kiểm tra 9–10", "hoc_tap", 2, "điểm"],
  ["ktm_7_8", "Điểm kiểm tra 7–8", "hoc_tap", 1, "điểm"],
  ["ktm_5_6", "Điểm kiểm tra 5–6", "hoc_tap", 0, "điểm"],
  ["ktm_3_4", "Điểm kiểm tra 3–4", "hoc_tap", -1, "điểm"],
  ["ktm_0_2", "Điểm kiểm tra 0–2", "hoc_tap", -2, "điểm"],
  ["ve_sinh", "Không vệ sinh", "khac", -10, "lỗi"],
  ["giao_thong", "Không đội mũ bảo hiểm", "khac", -30, "HS"],
  ["van_nghe", "Văn nghệ", "ne_nep", 5, "tiết mục"],
  ["phu_hieu_quen", "Phù hiệu quên hoặc mất", "ne_nep", -2, "HS"],
  ["phu_hieu_gia", "Phù hiệu giả / năm học trước", "ne_nep", -30, "HS"],
  ["ve_sinh_binh_nuoc_muon", "Vệ sinh muộn — bình nước", "ne_nep", -5, "lần"],
  ["ve_sinh_thieu_gay_coc", "Thiếu gậy / cốc uống nước", "ne_nep", -1, "lỗi"],
  ["chong_doi", "Chống đối cán bộ chấm thi đua", "ne_nep", -10, "HS"],
  ["thieu_sgk", "Không có SGK / đồ dùng học tập", "ne_nep", -1, "HS"],
];

const CRITERION_VARIANTS: [string, string, string, number, string][] = [
  ["trang_tri_thieu", "Trang trí lớp thiếu", "trang_tri", -5, "lỗi"],
  ["xep_hang_ca_nhan", "Xếp hàng — cá nhân", "xep_hang", -1, "HS"],
  ["xep_hang_tap_the", "Xếp hàng — tập thể", "xep_hang", -10, "lần"],
  ["hat_ca_nhan", "Hát đầu giờ — cá nhân", "hat", -1, "HS"],
  ["hat_tap_the", "Hát đầu giờ — tập thể", "hat", -10, "lần"],
  ["sh15_ra_ngoai", "SH 15 phút — ra ngoài / đi lại", "sh15", -1, "HS"],
  ["sh15_mat_trat_tu", "SH 15 phút — tập thể mất trật tự", "sh15", -10, "lần"],
  ["sh15_khong_kiem_tra", "SH 15 phút — không kiểm tra bài", "sh15", -5, "lần"],
  ["td_cc_ca_nhan", "Thể dục / chào cờ — cá nhân", "td_cc", -1, "HS"],
  ["td_cc_tap_the", "Thể dục / chào cờ — tập thể", "td_cc", -10, "lần"],
  ["giao_thong_mu_sai", "Đội mũ bảo hiểm không đúng", "giao_thong", -10, "HS"],
  ["giao_thong_sai_lan", "Sai làn đường / không xi nhan", "giao_thong", -5, "HS"],
  ["xe_dap_trong_san", "Đi xe trong sân trường", "xe_dap", -10, "HS"],
  ["xe_dap_de_sai", "Để xe không đúng quy định", "xe_dap", -1, "HS"],
  ["xe_dap_de_sai_tap_the", "Để xe không đúng quy định — tập thể", "xe_dap", -10, "lần"],
  ["xe_dap_khong_ve_sinh", "Không vệ sinh nhà xe", "xe_dap", -5, "lớp"],
  ["tnkt_muon", "TNKT làm nhiệm vụ muộn", "tnkt", -5, "HS"],
  ["tnkt_bo_nhiem_vu", "TNKT bỏ nhiệm vụ / không nộp sổ", "tnkt", -10, "HS"],
  ["ve_sinh_ban_muon", "Vệ sinh muộn / bẩn / rác / ghế", "ve_sinh", -5, "lỗi"],
  ["ve_sinh_binh_nuoc", "Không lấy / lấy sai bình nước", "ve_sinh", -10, "lần"],
  ["ve_sinh_noi_vu", "Không khóa cửa / tắt điện / giao chìa", "ve_sinh", -10, "lỗi"],
  ["sdb_y_thuc_ca_nhan", "Ghi SĐB ý thức — cá nhân", "sdb_y_thuc", -1, "HS"],
  ["sdb_y_thuc_tap_the", "Ghi SĐB ý thức — tập thể", "sdb_y_thuc", -10, "lần"],
  ["sdb_hoc_tap_ca_nhan", "Ghi SĐB học tập — cá nhân", "sdb_hoc_tap", -1, "HS"],
  ["sdb_hoc_tap_tap_the", "Ghi SĐB học tập — tập thể", "sdb_hoc_tap", -10, "lần"],
  ["bao_cao_bi_thu_khong_nop", "Bí thư không nộp / sai cao hơn", "bao_cao_bi_thu", -20, "lần"],
  ["bao_cao_bi_thu_sai_thap", "Bí thư tổng hợp sai thấp hơn", "bao_cao_bi_thu", -10, "lần"],
  ["ky_luat_muc_30", "Kỷ luật mức 30", "hs_ky_luat", -30, "HS"],
  ["ky_luat_muc_50", "Kỷ luật mức 50", "hs_ky_luat", -50, "HS"],
];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tieu_chi (
  id INTEGER PRIMARY KEY,
  nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
  ma TEXT NOT NULL,
  ten TEXT NOT NULL,
  nhom TEXT NOT NULL,
  diem REAL NOT NULL,
  don_vi TEXT NOT NULL,
  ap_dung INTEGER NOT NULL DEFAULT 1,
  ghi_chu TEXT NOT NULL DEFAULT '',
  UNIQUE(nam_hoc_id, ma)
);
CREATE TABLE IF NOT EXISTS bao_cao_tuan (
  id INTEGER PRIMARY KEY,
  tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
  lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
  gio_tong INTEGER NOT NULL DEFAULT 0,
  gio_tot INTEGER NOT NULL DEFAULT 0,
  gio_kha INTEGER NOT NULL DEFAULT 0,
  gio_tb INTEGER NOT NULL DEFAULT 0,
  gio_yeu INTEGER NOT NULL DEFAULT 0,
  ktm_9_10 INTEGER NOT NULL DEFAULT 0,
  ktm_7_8 INTEGER NOT NULL DEFAULT 0,
  ktm_5_6 INTEGER NOT NULL DEFAULT 0,
  ktm_3_4 INTEGER NOT NULL DEFAULT 0,
  ktm_0_2 INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tuan_id, lop_id)
);
CREATE TABLE IF NOT EXISTS nghi_hoc (
  id INTEGER PRIMARY KEY,
  bao_cao_id INTEGER NOT NULL REFERENCES bao_cao_tuan(id) ON DELETE CASCADE,
  ho_ten TEXT NOT NULL,
  ngay TEXT NOT NULL DEFAULT '',
  buoi TEXT NOT NULL DEFAULT '' CHECK(buoi IN ('','sang','chieu')),
  ghi_chu TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS su_kien (
  id INTEGER PRIMARY KEY,
  bao_cao_id INTEGER NOT NULL REFERENCES bao_cao_tuan(id) ON DELETE CASCADE,
  loai TEXT NOT NULL,
  ho_ten TEXT NOT NULL DEFAULT '',
  ngay TEXT NOT NULL DEFAULT '',
  so_luong REAL NOT NULL DEFAULT 1,
  tiet_mon TEXT NOT NULL DEFAULT '',
  noi_dung TEXT NOT NULL DEFAULT '',
  buoi TEXT NOT NULL DEFAULT '' CHECK(buoi IN ('','sang','chieu')),
  ghi_chu TEXT NOT NULL DEFAULT '',
  tieu_chi_id INTEGER REFERENCES tieu_chi(id),
  tap_the INTEGER NOT NULL DEFAULT 0 CHECK(tap_the IN (0,1)),
  gvcn_phat_hien INTEGER NOT NULL DEFAULT 0 CHECK(gvcn_phat_hien IN (0,1)),
  nguon TEXT NOT NULL DEFAULT 'tnkt' CHECK(nguon IN ('giay','tnkt','tay'))
);
CREATE TABLE IF NOT EXISTS cham_dong (
  id INTEGER PRIMARY KEY,
  tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
  lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
  tieu_chi_id INTEGER NOT NULL REFERENCES tieu_chi(id) ON DELETE CASCADE,
  so_luong REAL NOT NULL DEFAULT 0,
  diem_mot REAL NOT NULL,
  thanh_diem REAL NOT NULL,
  nguon TEXT NOT NULL DEFAULT 'auto'
);
CREATE TABLE IF NOT EXISTS khen_thuong (
  id INTEGER PRIMARY KEY,
  nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
  ky TEXT NOT NULL,
  lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
  ket_qua TEXT NOT NULL DEFAULT '',
  ghi_chu TEXT NOT NULL DEFAULT '',
  UNIQUE(nam_hoc_id, ky, lop_id)
);
`;


export function initPlan(con: Db) {
  addColumn(con, "nam_hoc", "diem_co_so", "REAL NOT NULL DEFAULT 0");
  addColumn(con, "tuan", "ngay_bd", "TEXT NOT NULL DEFAULT ''");
  addColumn(con, "tuan", "ngay_kt", "TEXT NOT NULL DEFAULT ''");
  addColumn(con, "tuan", "trang_thai", "TEXT NOT NULL DEFAULT 'nhap'");
  con.exec(SCHEMA);
  transaction(con, () => {
    addColumn(con, "tuan", "revision", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "tuan", "included", "INTEGER NOT NULL DEFAULT 1");
    addColumn(con, "tuan", "calendar_no", "INTEGER");
    addColumn(con, "bao_cao_tuan", "revision", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "bao_cao_tuan", "trang_thai", "TEXT NOT NULL DEFAULT 'nhap' CHECK(trang_thai IN ('nhap','da_gui'))");
    addColumn(con, "bao_cao_tuan", "bi_thu", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "bao_cao_tuan", "ngay_lap", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "bao_cao_tuan", "gio_kem", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "bao_cao_tuan", "ghi_chu_gio", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "bao_cao_tuan", "updated_at", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "bao_cao_tuan", "ghi_chu_ktm", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "tieu_chi", "score_key", "TEXT");
    addColumn(con, "cham_dong", "score_key", "TEXT");
    addColumn(con, "cham_dong", "ten_snapshot", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "cham_dong", "don_vi_snapshot", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "cham_dong", "reason", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "su_kien", "tieu_chi_id", "INTEGER REFERENCES tieu_chi(id)");
    addColumn(con, "su_kien", "buoi", "TEXT NOT NULL DEFAULT ''");
    addColumn(con, "nghi_hoc", "buoi", "TEXT NOT NULL DEFAULT ''");
    con.exec(`CREATE TABLE IF NOT EXISTS weekly_legacy_input(
      tuan_id INTEGER NOT NULL REFERENCES tuan(id), lop_id INTEGER NOT NULL REFERENCES lop(id),
      payload_json TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(tuan_id,lop_id)
    );
    CREATE TABLE IF NOT EXISTS manual_score_conflict(
      tuan_id INTEGER NOT NULL,lop_id INTEGER NOT NULL,tieu_chi_id INTEGER NOT NULL,
      PRIMARY KEY(tuan_id,lop_id,tieu_chi_id)
    )`);
    for (const row of all(con, `SELECT tuan_id,lop_id,COUNT(*) AS n FROM cham_dong WHERE nguon='tay'
      GROUP BY tuan_id,lop_id,tieu_chi_id HAVING COUNT(*)>1`)) {
      run(con, "INSERT OR IGNORE INTO manual_score_conflict(tuan_id,lop_id,tieu_chi_id) VALUES (?,?,?)", [row.tuan_id, row.lop_id, row.tieu_chi_id]);
    }
    if (!get(con, "SELECT 1 FROM manual_score_conflict LIMIT 1")) {
      con.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_cham_tay ON cham_dong(tuan_id,lop_id,tieu_chi_id,nguon) WHERE nguon='tay'");
    }
    const directKeys = [...NN_KEYS, ...GIO_KEYS, ...KTM_SCORE_KEYS, "ktm_5_6"];
    for (const key of directKeys) run(con, "UPDATE tieu_chi SET score_key=? WHERE ma=? AND (score_key IS NULL OR score_key='')", [key, key]);
    run(con, "UPDATE tieu_chi SET score_key='sdb_hoc_tap' WHERE ma='thai_do' AND (score_key IS NULL OR score_key='')");
    run(con, "UPDATE cham_dong SET score_key=(SELECT score_key FROM tieu_chi WHERE id=tieu_chi_id),ten_snapshot=(SELECT ten FROM tieu_chi WHERE id=tieu_chi_id),don_vi_snapshot=(SELECT don_vi FROM tieu_chi WHERE id=tieu_chi_id) WHERE score_key IS NULL");
    for (const legacy of all(con, "SELECT * FROM diem_tuan")) {
      run(con, "INSERT OR IGNORE INTO weekly_legacy_input(tuan_id,lop_id,payload_json) VALUES (?,?,?)", [legacy.tuan_id, legacy.lop_id, JSON.stringify(legacy)]);
    }
    run(con, `UPDATE tuan SET included=0 WHERE NOT EXISTS(SELECT 1 FROM bao_cao_tuan b WHERE b.tuan_id=tuan.id)
      AND NOT EXISTS(SELECT 1 FROM cham_dong c WHERE c.tuan_id=tuan.id)
      AND NOT EXISTS(SELECT 1 FROM weekly_legacy_input w WHERE w.tuan_id=tuan.id AND w.confirmed=1)`);
    con.exec(`CREATE TABLE IF NOT EXISTS week_class(
      tuan_id INTEGER NOT NULL REFERENCES tuan(id),lop_id INTEGER NOT NULL REFERENCES lop(id),
      ten TEXT NOT NULL,nhom INTEGER NOT NULL,si_so INTEGER NOT NULL,gvcn TEXT NOT NULL DEFAULT '',
      thu_tu INTEGER NOT NULL DEFAULT 0,
      loai_hinh TEXT NOT NULL DEFAULT 'thuong',
      gvcn_group_id INTEGER,
      ap_dung INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(tuan_id,lop_id)
    );
    CREATE TABLE IF NOT EXISTS week_status_log(
      id INTEGER PRIMARY KEY,tuan_id INTEGER NOT NULL REFERENCES tuan(id),from_status TEXT NOT NULL,to_status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',changed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS week_snapshot(
      tuan_id INTEGER PRIMARY KEY REFERENCES tuan(id),payload_json TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL
    )`);
    if (Number(get(con, "PRAGMA user_version")?.user_version ?? 0) < 4) con.exec("PRAGMA user_version=4");
    if (Number(get(con, "PRAGMA user_version")?.user_version ?? 0) < 3) con.exec("PRAGMA user_version=3");
    if (Number(get(con, "PRAGMA user_version")?.user_version ?? 0) < 1) con.exec("PRAGMA user_version=1");
    con.exec(`CREATE TABLE IF NOT EXISTS school_calendar(
      nam_id INTEGER PRIMARY KEY REFERENCES nam_hoc(id),
      ngay_bd TEXT, ngay_kt TEXT, hk2_bd TEXT,
      xa TEXT NOT NULL DEFAULT 'ĐOÀN XÃ GIAO HÒA',
      truong TEXT NOT NULL DEFAULT 'ĐOÀN TRƯỜNG THPT GIAO THỦY C',
      doan TEXT NOT NULL DEFAULT 'ĐOÀN TNCS HỒ CHÍ MINH',
      dia_danh TEXT NOT NULL DEFAULT 'Giao Hòa'
    )`);
    addColumn(con, "school_calendar", "xa", "TEXT NOT NULL DEFAULT 'ĐOÀN XÃ GIAO HÒA'");
    addColumn(con, "school_calendar", "truong", "TEXT NOT NULL DEFAULT 'ĐOÀN TRƯỜNG THPT GIAO THỦY C'");
    addColumn(con, "school_calendar", "doan", "TEXT NOT NULL DEFAULT 'ĐOÀN TNCS HỒ CHÍ MINH'");
    addColumn(con, "school_calendar", "dia_danh", "TEXT NOT NULL DEFAULT 'Giao Hòa'");
    if (Number(get(con, "PRAGMA user_version")?.user_version ?? 0) < 2) con.exec("PRAGMA user_version=2");
  });
  for (const nam of all(con, "SELECT id FROM nam_hoc")) {
    for (const [ma, ten, nhom, diem, donVi] of SEED) {
      const scoreKey = CATALOG_SCORE_KEYS[ma]
        ?? (ma === "thai_do" ? "sdb_hoc_tap"
          : ma === "van_nghe" ? "cong_ne_nep"
          : [...NN_KEYS, ...GIO_KEYS, ...KTM_SCORE_KEYS, "ktm_5_6"].includes(ma) ? ma : null);
      run(con, `INSERT INTO tieu_chi(nam_hoc_id,ma,ten,nhom,diem,don_vi,ap_dung,score_key) VALUES (?,?,?,?,?,?,1,?)
        ON CONFLICT(nam_hoc_id,ma) DO NOTHING`, [nam.id, ma, ten, nhom, diem, donVi, scoreKey]);
    }
    for (const [ma, ten, scoreKey, diem, donVi] of CRITERION_VARIANTS) {
      run(con, `INSERT INTO tieu_chi(nam_hoc_id,ma,ten,nhom,diem,don_vi,ap_dung,score_key) VALUES (?,?,?,'ne_nep',?,?,1,?)
        ON CONFLICT(nam_hoc_id,ma) DO NOTHING`, [nam.id, ma, ten, diem, donVi, scoreKey]);
    }
    run(con, "UPDATE tieu_chi SET ap_dung=0 WHERE ma IN ('giao_thong_khong_mu','ve_sinh_khong_lam')");
    run(con, `DELETE FROM tieu_chi
      WHERE ma IN ('giao_thong_khong_mu','ve_sinh_khong_lam')
      AND NOT EXISTS(SELECT 1 FROM cham_dong WHERE cham_dong.tieu_chi_id=tieu_chi.id)
      AND NOT EXISTS(SELECT 1 FROM su_kien WHERE su_kien.tieu_chi_id=tieu_chi.id)`);
  }
  migrate(con);
}

export function locked(tuan: Dict | undefined) {
  return Boolean(tuan && tuan.trang_thai && tuan.trang_thai !== TT_NHAP);
}

function ymd(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export type WeekSelection = { nam_id: number; week_start: string; tuan_id?: number; ngay_bd: string; ngay_kt: string };

function isoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new WorkflowError(400, "Ngày phải có định dạng YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new WorkflowError(400, "Ngày không hợp lệ.");
  return date;
}

function shiftDate(value: string, days: number) {
  const date = isoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const WEEKDAY_SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

export type WeekDayOption = { value: string; short: string; label: string };

export function weekDayOptions(week: Dict | undefined): WeekDayOption[] {
  const start = String(week?.ngay_bd || "");
  const end = String(week?.ngay_kt || "");
  if (!start || !end) return [];
  try {
    const out: WeekDayOption[] = [];
    for (let day = start; day <= end; day = shiftDate(day, 1)) {
      const date = isoDate(day);
      const short = WEEKDAY_SHORT[date.getUTCDay()];
      const label = `${short} ${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
      out.push({ value: day, short, label });
    }
    return out;
  } catch {
    return [];
  }
}

export type WeekFlowStep = {
  key: "nhap" | "chot" | "cong_bo" | "in";
  n: number;
  label: string;
  hint: string;
  href: string;
  state: "done" | "current" | "todo";
};

export type WeekFlow = {
  steps: WeekFlowStep[];
  current_key: WeekFlowStep["key"] | "";
  q: string;
  week_no: string;
  week_range: string;
  status_label: string;
  status_key: string;
  so_lop: number;
  da_bao: number;
  chua_bao: number;
  next: { title: string; text: string; href: string; label: string };
  prev_q: string;
  next_q: string;
};

function vnDay(iso: string) {
  if (!iso || iso.length < 10) return "";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function vnRange(start: string, end: string) {
  if (!start || !end) return "";
  if (start.slice(5, 7) === end.slice(5, 7) && start.slice(0, 4) === end.slice(0, 4)) {
    return `${start.slice(8, 10)}–${end.slice(8, 10)}/${start.slice(5, 7)}`;
  }
  return `${vnDay(start)} → ${vnDay(end)}`;
}

function weekQuery(opts: {
  namId: number;
  year?: number | string;
  month?: number | string;
  weekStart?: string;
  tuanId?: number;
}) {
  const q = new URLSearchParams();
  if (opts.namId) q.set("nam_id", String(opts.namId));
  if (opts.year) q.set("nam", String(opts.year));
  if (opts.month != null && opts.month !== "") q.set("thang", String(Number(opts.month)));
  if (opts.weekStart) q.set("week_start", opts.weekStart);
  if (opts.tuanId) q.set("tuan_id", String(opts.tuanId));
  return q.toString();
}

function neighborQuery(
  namId: number,
  weekStart: string,
  days: number,
  calendar?: { ngay_bd?: string; ngay_kt?: string },
) {
  if (!weekStart) return "";
  try {
    const start = shiftDate(weekStart, days);
    const end = shiftDate(start, 6);
    const bd = calendar?.ngay_bd || "";
    const kt = calendar?.ngay_kt || "";
    if (bd && end < bd) return "";
    if (kt && start > kt) return "";
    return weekQuery({
      namId,
      year: Number(start.slice(0, 4)),
      month: Number(start.slice(5, 7)),
      weekStart: start,
    });
  } catch {
    return "";
  }
}

export function weekFlow(input: {
  namId: number;
  tuan?: Dict;
  soLop: number;
  daBao: number;
  year?: number;
  month?: number;
  weekStart?: string;
  tuanId?: number;
  calendar?: { ngay_bd?: string; ngay_kt?: string };
}): WeekFlow {
  const tuan = input.tuan;
  const start = String(input.weekStart || tuan?.ngay_bd || "");
  const end = String(tuan?.ngay_kt || (start ? shiftDate(start, 6) : ""));
  const tuanId = input.tuanId || (tuan?.id != null ? Number(tuan.id) : undefined);
  const year = input.year ?? (tuan?.nam != null ? Number(tuan.nam) : start ? Number(start.slice(0, 4)) : undefined);
  const month = input.month ?? (tuan?.thang != null ? Number(tuan.thang) : start ? Number(start.slice(5, 7)) : undefined);
  const q = weekQuery({ namId: input.namId, year, month, weekStart: start, tuanId });
  const soLop = Math.max(0, Number(input.soLop) || 0);
  const daBao = Math.max(0, Number(input.daBao) || 0);
  const chuaBao = Math.max(0, soLop - daBao);
  const status = String(tuan?.trang_thai || "nhap");
  const allDone = soLop > 0 && chuaBao === 0;
  let current: WeekFlowStep["key"] = "nhap";
  if (soLop > 0 && allDone && status === "nhap") current = "chot";
  else if (status === "chot") current = "cong_bo";
  else if (status === "cong_bo") current = "in";
  const stateOf = (key: WeekFlowStep["key"]): WeekFlowStep["state"] => {
    const order = ["nhap", "chot", "cong_bo", "in"];
    const i = order.indexOf(key);
    const c = order.indexOf(current);
    if (i < c) return "done";
    if (i === c) return "current";
    return "todo";
  };
  const nhapHref = `/bao-cao-tuan${q ? `?${q}` : ""}`;
  const xepHref = `/ket-qua-tuan${q ? `?${q}` : ""}`;
  const inHref = "/bao-cao";
  const steps: WeekFlowStep[] = [
    {
      key: "nhap",
      n: 1,
      label: "Nhập tuần",
      hint: soLop ? `${daBao}/${soLop} lớp` : "Chưa có lớp",
      href: nhapHref,
      state: stateOf("nhap"),
    },
    {
      key: "chot",
      n: 2,
      label: "Chốt tuần",
      hint: status === "chot" || status === "cong_bo" ? "Đã chốt" : allDone ? "Sẵn sàng chốt" : "Nhập đủ lớp đã",
      href: xepHref,
      state: stateOf("chot"),
    },
    {
      key: "cong_bo",
      n: 3,
      label: "Công bố",
      hint: status === "cong_bo" ? "Đã công bố" : status === "chot" ? "Sẵn sàng công bố" : "Sau khi chốt",
      href: xepHref,
      state: stateOf("cong_bo"),
    },
    {
      key: "in",
      n: 4,
      label: "In bảng",
      hint: status === "cong_bo" ? "Tải file tuần này" : "Sau khi công bố",
      href: inHref,
      state: stateOf("in"),
    },
  ];
  let next = {
    title: chuaBao > 0 ? `Còn ${chuaBao} lớp chưa nhập` : "Nhập tuần",
    text: "",
    href: nhapHref,
    label: "Nhập tuần",
  };
  if (soLop <= 0) {
    next = {
      title: "Chưa có lớp",
      text: "",
      href: "/lop",
      label: "Thêm lớp",
    };
  } else if (current === "chot") {
    next = {
      title: "Chốt tuần",
      text: "",
      href: xepHref,
      label: "Xếp hạng",
    };
  } else if (current === "cong_bo") {
    next = {
      title: "Công bố tuần",
      text: "",
      href: xepHref,
      label: "Công bố",
    };
  } else if (current === "in") {
    next = {
      title: "Tuần đã công bố",
      text: "",
      href: inHref,
      label: "In / xuất",
    };
  }
  return {
    steps,
    current_key: soLop <= 0 ? "" : current,
    q,
    week_no: String(tuan?.calendar_no || tuan?.so_tuan || ""),
    week_range: vnRange(start, end),
    status_label: TT_LABEL[status] || TT_LABEL.nhap,
    status_key: status,
    so_lop: soLop,
    da_bao: daBao,
    chua_bao: chuaBao,
    next,
    prev_q: neighborQuery(input.namId, start, -7, input.calendar),
    next_q: neighborQuery(input.namId, start, 7, input.calendar),
  };
}

export function classNameHints(con: Db, namId: number, lopId: number): string[] {
  return all(con, `
    SELECT ho_ten FROM (
      SELECT TRIM(n.ho_ten) AS ho_ten FROM nghi_hoc n
        JOIN bao_cao_tuan b ON b.id = n.bao_cao_id
        JOIN tuan t ON t.id = b.tuan_id
        WHERE t.nam_hoc_id=? AND b.lop_id=?
      UNION
      SELECT TRIM(s.ho_ten) AS ho_ten FROM su_kien s
        JOIN bao_cao_tuan b ON b.id = s.bao_cao_id
        JOIN tuan t ON t.id = b.tuan_id
        WHERE t.nam_hoc_id=? AND b.lop_id=?
    ) WHERE ho_ten IS NOT NULL AND ho_ten != ''
    ORDER BY ho_ten COLLATE NOCASE
    LIMIT 200
  `, [namId, lopId, namId, lopId]).map((row) => String(row.ho_ten));
}

export function fridayOf(value: string) {
  return shiftDate(value, -(isoDate(value).getUTCDay() + 2) % 7);
}

export type SchoolCalendar = {
  nam_id: number; ngay_bd: string; ngay_kt: string; hk2_bd: string;
  org: { xa: string; truong: string; doan: string; dia_danh: string };
};
export function schoolCalendar(con: Db, namId: number): SchoolCalendar {
  const school = get(con, "SELECT * FROM nam_hoc WHERE id=?", [namId]);
  if (!school) throw new WorkflowError(404, "Không tìm thấy năm học.");
  const stored = get(con, "SELECT * FROM school_calendar WHERE nam_id=?", [namId]);
  const match = String(school.ten).match(/^(\d{4})-(\d{4})$/);
  const validName = match && Number(match[2]) === Number(match[1]) + 1;
  return {
    nam_id: namId,
    ngay_bd: String(stored?.ngay_bd || (validName ? `${match[1]}-09-01` : "")),
    ngay_kt: String(stored?.ngay_kt || (validName ? `${match[2]}-08-31` : "")),
    hk2_bd: String(stored?.hk2_bd || ""),
    org: {
      xa: String(stored?.xa || "ĐOÀN XÃ GIAO HÒA"),
      truong: String(stored?.truong || "ĐOÀN TRƯỜNG THPT GIAO THỦY C"),
      doan: String(stored?.doan || "ĐOÀN TNCS HỒ CHÍ MINH"),
      dia_danh: String(stored?.dia_danh || "Giao Hòa"),
    },
  };
}

function calendarWeek(week: Dict, calendar: SchoolCalendar) {
  const start = String(week.ngay_bd || "");
  const end = String(week.ngay_kt || "");
  try {
    return Boolean(start && end && calendar.ngay_bd && calendar.ngay_kt &&
      isoDate(start).getUTCDay() === 5 && shiftDate(start, 6) === end &&
      start <= calendar.ngay_kt && end >= calendar.ngay_bd);
  } catch { return false; }
}

export function weekFilter(con: Db, namId: number, q: { nam?: string; thang?: string; tuan_id?: string; week_start?: string }, today = ymd(new Date())) {
  isoDate(today);
  const calendar = schoolCalendar(con, namId);
  const existing = listTuan(con, namId);
  const valid = existing.filter((week) => calendarWeek(week, calendar) &&
    !existing.some((other) => other.id !== week.id && other.ngay_bd && other.ngay_kt &&
      String(other.ngay_bd) <= String(week.ngay_kt) && String(other.ngay_kt) >= String(week.ngay_bd)));
  const legacy = existing.filter((week) => !valid.includes(week));
  const years = [...new Set([
    ...(calendar.ngay_bd ? Array.from({ length: Number(calendar.ngay_kt.slice(0, 4)) - Number(calendar.ngay_bd.slice(0, 4)) + 1 }, (_, index) => Number(calendar.ngay_bd.slice(0, 4)) + index) : []),
    ...existing.map((week) => Number(week.nam)),
  ])].sort((a, b) => a - b);
  if (!years.length) years.push(Number(today.slice(0, 4)));
  const inside = Boolean(calendar.ngay_bd && today >= calendar.ngay_bd && today <= calendar.ngay_kt);
  const nearest = valid.slice().sort((a, b) => Math.abs(isoDate(String(a.ngay_bd)).getTime() - isoDate(today).getTime()) - Math.abs(isoDate(String(b.ngay_bd)).getTime() - isoDate(today).getTime()))[0];
  const requested = q.tuan_id ? requireOwned(con, "tuan", Number(q.tuan_id), namId) : undefined;
  const selectedStart = q.week_start || String(requested?.ngay_bd || "") || (inside ? fridayOf(today) : String(nearest?.ngay_bd || calendar.ngay_bd && fridayOf(calendar.ngay_bd) || ""));
  if (q.week_start) {
    if (isoDate(q.week_start).getUTCDay() !== 5) throw new WorkflowError(400, "Tuần phải bắt đầu thứ Sáu.");
    if (requested && requested.ngay_bd !== q.week_start) throw new WorkflowError(400, "Ngày và định danh tuần không khớp.");
  }
  const year = Number(q.nam || requested?.nam || selectedStart.slice(0, 4) || years[0]);
  const month = Number(q.thang || requested?.thang || selectedStart.slice(5, 7) || 9);
  if (!years.includes(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new WorkflowError(400, "Năm hoặc tháng không hợp lệ.");
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  if (requested && (q.nam || q.thang) &&
      (requested.ngay_bd && requested.ngay_kt ? !(String(requested.ngay_bd) <= last && String(requested.ngay_kt) >= first) : Number(requested.nam) !== year || Number(requested.thang) !== month)) {
    throw new WorkflowError(400, "Tuần không thuộc tháng đang chọn.");
  }
  const weeks: Dict[] = [];
  if (calendar.ngay_bd && calendar.ngay_kt) {
    for (let start = fridayOf(first); start <= last; start = shiftDate(start, 7)) {
      const end = shiftDate(start, 6);
      const saved = valid.find((week) => week.ngay_bd === start);
      const inRange = start <= calendar.ngay_kt && end >= calendar.ngay_bd;
      const overlap = legacy.some((week) => week.ngay_bd && week.ngay_kt && String(week.ngay_bd) <= end && String(week.ngay_kt) >= start);
      weeks.push(saved || {
        nam_hoc_id: namId, ngay_bd: start, ngay_kt: end, nam: Number(start.slice(0, 4)), thang: Number(start.slice(5, 7)),
        calendar_no: Math.round((isoDate(start).getTime() - isoDate(fridayOf(calendar.ngay_bd)).getTime()) / 604800000) + 1,
        trang_thai: TT_NHAP, revision: 0, virtual: true, outside: !inRange, conflict: overlap,
      });
    }
  }
  const legacyMonth = legacy.filter((week) => Number(week.nam) === year && Number(week.thang) === month).map((week) => ({ ...week, legacy: true }));
  weeks.push(...legacyMonth);
  let tuan = requested ? weeks.find((week) => week.id === requested.id) : weeks.find((week) => week.ngay_bd === selectedStart);
  if (requested && !tuan) tuan = { ...requested, legacy: true };
  if (q.week_start && !tuan) throw new WorkflowError(400, "Tuần không thuộc tháng đang chọn.");
  if (!requested && !q.week_start && !tuan) tuan = weeks.find((week) => !week.outside && !week.conflict) || weeks[0];
  const selection: WeekSelection = {
    nam_id: namId, week_start: String(tuan?.ngay_bd || ""), ngay_bd: String(tuan?.ngay_bd || ""), ngay_kt: String(tuan?.ngay_kt || ""),
    ...(tuan?.id ? { tuan_id: Number(tuan.id) } : {}),
  };
  const monthKeys: { nam: number; thang: number; key: string; label: string }[] = [];
  if (calendar.ngay_bd && calendar.ngay_kt) {
    let y = Number(calendar.ngay_bd.slice(0, 4));
    let m = Number(calendar.ngay_bd.slice(5, 7));
    const endY = Number(calendar.ngay_kt.slice(0, 4));
    const endM = Number(calendar.ngay_kt.slice(5, 7));
    while (y < endY || (y === endY && m <= endM)) {
      monthKeys.push({ nam: y, thang: m, key: `${y}-${String(m).padStart(2, "0")}`, label: `${m}/${y}` });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  } else {
    for (const y of years) for (let m = 1; m <= 12; m++) monthKeys.push({ nam: y, thang: m, key: `${y}-${String(m).padStart(2, "0")}`, label: `${m}/${y}` });
  }
  return { years, year, months: Array.from({ length: 12 }, (_, index) => index + 1), month, monthKeys, weeks, tuan, selection, legacy, calendar,
    notice: inside ? "" : "Ngày hôm nay ngoài năm học. Đang xem kỳ đã chọn, không phải tuần hiện tại." };
}

export function resolveWeekForWrite(con: Db, namId: number, selection: { tuan_id?: number; week_start?: string }): Dict {
  if (!inTransaction(con)) throw new Error("resolveWeekForWrite phải được gọi trong transaction.");
  requireActiveYear(con, namId);
  if (selection.tuan_id !== undefined) {
    const week = requireOwned(con, "tuan", selection.tuan_id, namId);
    if (selection.week_start && selection.week_start !== week.ngay_bd) throw new WorkflowError(400, "Ngày và định danh tuần không khớp.");
    return week;
  }
  const start = selection.week_start || "";
  const end = shiftDate(start, 6);
  const calendar = schoolCalendar(con, namId);
  if (!calendarWeek({ ngay_bd: start, ngay_kt: end }, calendar)) throw new WorkflowError(400, "Tuần phải bắt đầu thứ Sáu và giao khoảng năm học đã cấu hình.");
  const overlapping = all(con, "SELECT * FROM tuan WHERE nam_hoc_id=? AND ngay_bd<>'' AND ngay_kt<>'' AND ngay_bd<=? AND ngay_kt>=?", [namId, end, start]);
  if (overlapping.length === 1 && overlapping[0].ngay_bd === start && overlapping[0].ngay_kt === end) return overlapping[0];
  if (overlapping.length) throw new WorkflowError(409, "Dữ liệu cũ đè khoảng tuần. Cần đối chiếu trước khi lưu.");
  const calendarNo = Math.round((isoDate(start).getTime() - isoDate(fridayOf(calendar.ngay_bd)).getTime()) / 604800000) + 1;
  const legacyNo = Number(get(con, "SELECT COALESCE(MAX(so_tuan),0)+1 AS n FROM tuan WHERE nam_hoc_id=?", [namId])?.n);
  const result = run(con, `INSERT INTO tuan(nam_hoc_id,so_tuan,calendar_no,nam,thang,hoc_ky,ngay_bd,ngay_kt,trang_thai)
    VALUES (?,?,?,?,?,?,?,?,'nhap')`, [namId, legacyNo, calendarNo, Number(start.slice(0, 4)), Number(start.slice(5, 7)), calendar.hk2_bd && start >= calendar.hk2_bd ? 2 : 1, start, end]);
  return getTuan(con, Number(result.lastInsertRowid))!;
}

export function saveSchoolCalendar(con: Db, namId: number, data: Record<string, string>) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    isoDate(data.ngay_bd);
    isoDate(data.ngay_kt);
    if (data.ngay_bd > data.ngay_kt) throw new WorkflowError(400, "Ngày kết thúc phải sau ngày bắt đầu.");
    if (data.hk2_bd) {
      isoDate(data.hk2_bd);
      if (data.hk2_bd < data.ngay_bd || data.hk2_bd > data.ngay_kt) throw new WorkflowError(400, "Ngày bắt đầu HKII phải trong năm học.");
    }
    run(con, `INSERT INTO school_calendar(nam_id,ngay_bd,ngay_kt,hk2_bd,xa,truong,doan,dia_danh) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(nam_id) DO UPDATE SET ngay_bd=excluded.ngay_bd,ngay_kt=excluded.ngay_kt,hk2_bd=excluded.hk2_bd,
        xa=excluded.xa,truong=excluded.truong,doan=excluded.doan,dia_danh=excluded.dia_danh`,
      [namId, data.ngay_bd, data.ngay_kt, data.hk2_bd || null,
        (data.xa || "ĐOÀN XÃ GIAO HÒA").trim(),
        (data.truong || "ĐOÀN TRƯỜNG THPT GIAO THỦY C").trim(),
        (data.doan || "ĐOÀN TNCS HỒ CHÍ MINH").trim(),
        (data.dia_danh || "Giao Hòa").trim()]);
    run(con, "UPDATE tuan SET revision=revision+1 WHERE nam_hoc_id=? AND trang_thai='nhap'", [namId]);
  });
}

export function reconcileWeekDates(con: Db, namId: number, tuanId: number, revision: number, start: string) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    const week = requireOwned(con, "tuan", tuanId, namId);
    if (locked(week) || Number(week.revision) !== revision) throw new WorkflowError(409, "Tuần đã khóa hoặc đã được sửa ở nơi khác.");
    const end = shiftDate(start, 6);
    const calendar = schoolCalendar(con, namId);
    if (!calendarWeek({ ngay_bd: start, ngay_kt: end }, calendar)) throw new WorkflowError(400, "Ngày gán phải là thứ Sáu trong khoảng năm học.");
    if (get(con, "SELECT id FROM tuan WHERE nam_hoc_id=? AND id<>? AND ngay_bd<>'' AND ngay_kt<>'' AND ngay_bd<=? AND ngay_kt>=? LIMIT 1", [namId, tuanId, end, start])) {
      throw new WorkflowError(409, "Khoảng ngày đã được tuần khác sử dụng.");
    }
    const calendarNo = Math.round((isoDate(start).getTime() - isoDate(fridayOf(calendar.ngay_bd)).getTime()) / 604800000) + 1;
    run(con, "UPDATE tuan SET ngay_bd=?,ngay_kt=?,calendar_no=?,nam=?,thang=?,hoc_ky=?,revision=revision+1 WHERE id=?",
      [start, end, calendarNo, Number(start.slice(0, 4)), Number(start.slice(5, 7)), calendar.hk2_bd && start >= calendar.hk2_bd ? 2 : 1, tuanId]);
  });
}

export function listTieuChi(con: Db, namId: number, onlyOn = false) {
  const sql = onlyOn
    ? "SELECT * FROM tieu_chi WHERE nam_hoc_id=? AND ap_dung=1 ORDER BY nhom, id"
    : "SELECT * FROM tieu_chi WHERE nam_hoc_id=? ORDER BY nhom, id";
  return all(con, sql, [namId]);
}

export function mappedNnScoreKey(scoreKey: unknown) {
  const key = String(scoreKey || "");
  return NN_KEYS.includes(key) || key === "cong_ne_nep";
}

const PAPER_CATALOG_MA = new Set(["nghi_hoc", "di_muon", "trang_phuc", "phu_hieu", "vp_khac", "van_nghe", "thai_do"]);

export function catalogTieuChi(con: Db, namId: number) {
  return listTieuChi(con, namId, true).filter((criterion) =>
    mappedNnScoreKey(criterion.score_key) && !PAPER_CATALOG_MA.has(String(criterion.ma)));
}

export function entryTieuChi(con: Db, namId: number) {
  return listTieuChi(con, namId, true).filter((criterion) =>
    mappedNnScoreKey(criterion.score_key) || PAPER_CATALOG_MA.has(String(criterion.ma)));
}

export function upsertTieuChi(con: Db, namId: number, data: Dict) {
  return transaction(con, () => {
  requireActiveYear(con, namId);
  if (data.id) requireOwned(con, "tieu_chi", Number(data.id), namId);
  const ma = String(data.ma ?? "").trim() || `tc_${Date.now()}`;
  const ten = String(data.ten ?? "").trim();
  const nhom = String(data.nhom ?? "ne_nep");
  const diem = Number(data.diem);
  const donVi = String(data.don_vi ?? "HS").trim() || "HS";
  if (!ten || !Number.isFinite(diem)) throw new Error("Cần tên tiêu chí và điểm số.");
  if (!["ne_nep", "hoc_tap", "khac"].includes(nhom)) throw new Error("Nhóm không hợp lệ.");
  const apDung = data.ap_dung === 0 || data.ap_dung === "0" ? 0 : 1;
  if (data.id) {
    run(con, "UPDATE tieu_chi SET ma=?, ten=?, nhom=?, diem=?, don_vi=?, ap_dung=?, ghi_chu=? WHERE id=? AND nam_hoc_id=?", [
      ma,
      ten,
      nhom,
      diem,
      donVi,
      apDung,
      String(data.ghi_chu ?? ""),
      Number(data.id),
      namId,
    ]);
    return Number(data.id);
  }
  const r = run(con, "INSERT INTO tieu_chi(nam_hoc_id, ma, ten, nhom, diem, don_vi, ap_dung, ghi_chu) VALUES (?,?,?,?,?,?,?,?)", [
    namId,
    ma,
    ten,
    nhom,
    diem,
    donVi,
    apDung,
    String(data.ghi_chu ?? ""),
  ]);
  return Number(r.lastInsertRowid);
  });
}

export function deleteTieuChi(con: Db, namId: number, id: number) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "tieu_chi", id, namId);
    if (get(con, "SELECT id FROM cham_dong WHERE tieu_chi_id=? LIMIT 1", [id])) {
      throw new WorkflowError(409, "Tiêu chí đã có lịch sử. Hãy chuyển sang không áp dụng (ap_dung=0).");
    }
    run(con, "DELETE FROM tieu_chi WHERE id=? AND nam_hoc_id=?", [id, namId]);
  });
}

export function setTuanStatus(
  con: Db, namId: number, tuanId: number, expectedRevision: number, status: string, reason = "",
) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    const week = requireOwned(con, "tuan", tuanId, namId);
    if (Number(week.revision) !== expectedRevision) throw new WorkflowError(409, "Tuần đã được sửa ở nơi khác.");
    const from = String(week.trang_thai || TT_NHAP);
    const allowed = new Set([`${TT_NHAP}:${TT_CHOT}`, `${TT_CHOT}:${TT_CONG_BO}`, `${TT_CONG_BO}:${TT_CHOT}`, `${TT_CHOT}:${TT_NHAP}`]);
    if (!allowed.has(`${from}:${status}`)) throw new WorkflowError(400, "Chuyển trạng thái không hợp lệ.");
    if ((from === TT_CONG_BO || status === TT_NHAP) && !reason.trim()) throw new WorkflowError(400, "Cần ghi lý do khi lùi trạng thái.");
    freezeWeekClasses(con, namId, tuanId);
    if (from === TT_NHAP && status === TT_CHOT) {
      const results = scoreWeekCore(con, tuanId);
      const blockers = results.filter((row) => !row.complete);
      if (blockers.length) throw new WorkflowError(409, `Chưa thể chốt: ${blockers.map((row) => `${row.ten}: ${row.missing.join(", ")}`).join("; ")}`);
      for (const row of results) row.rank_status = "official";
      const payload = {
        version: 1, rule: "Quy chế 2026–2027; xếp NN/HT giảm dần, tổng hạng tăng dần",
        week: { ...week, trang_thai: TT_CHOT }, cohort: all(con, "SELECT * FROM week_class WHERE tuan_id=? AND ap_dung=1 ORDER BY thu_tu,ten", [tuanId]),
        criteria: all(con, "SELECT id,ma,ten,score_key,diem,don_vi FROM tieu_chi WHERE nam_hoc_id=? ORDER BY id", [namId]),
        results,
      };
      run(con, "INSERT OR REPLACE INTO week_snapshot(tuan_id,payload_json,revision,created_at) VALUES (?,?,?,datetime('now','localtime'))",
        [tuanId, JSON.stringify(payload), expectedRevision + 1]);
    }
    if (from === TT_CHOT && status === TT_NHAP) run(con, "DELETE FROM week_snapshot WHERE tuan_id=?", [tuanId]);
    run(con, "INSERT INTO week_status_log(tuan_id,from_status,to_status,reason) VALUES (?,?,?,?)", [tuanId, from, status, reason.trim()]);
    run(con, "UPDATE tuan SET trang_thai=?,revision=revision+1 WHERE id=?", [status, tuanId]);
  });
}

export function saveTuanMeta(con: Db, namId: number, tuanId: number, data: Dict) {
  transaction(con, () => {
  requireActiveYear(con, namId);
  const week = requireOwned(con, "tuan", tuanId, namId);
  if (locked(week)) throw new WorkflowError(409, "Tuần đã khóa.");
  run(con, "UPDATE tuan SET ngay_bd=?, ngay_kt=?, ghi_chu=? WHERE id=?", [
    String(data.ngay_bd ?? ""),
    String(data.ngay_kt ?? ""),
    String(data.ghi_chu ?? ""),
    tuanId,
  ]);
  run(con, "UPDATE tuan SET revision=revision+1 WHERE id=?", [tuanId]);
  });
}

const REPORT_COUNTS = ["gio_tong", "gio_tot", "gio_kha", "gio_tb", "gio_yeu", "gio_kem", "ktm_9_10", "ktm_7_8", "ktm_5_6", "ktm_3_4", "ktm_0_2"] as const;

export type ReportRow = Record<string, string> & { index: number };
export type ParsedReport = {
  header: Record<(typeof REPORT_COUNTS)[number], number> & {
    bi_thu: string; ngay_lap: string; ghi_chu_gio: string; ghi_chu_ktm: string;
  };
  nghi: ReportRow[];
  events: Record<string, ReportRow[]>;
  errors: Record<string, string>;
};

function reportInteger(value: string | undefined, field: string, errors: Record<string, string>) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    errors[field] = "Phải là số nguyên không âm.";
    return 0;
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) {
    errors[field] = "Số quá lớn.";
    return 0;
  }
  return number;
}

function reportDate(raw: string, week: Dict, field: string, errors: Record<string, string>) {
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    try {
      isoDate(raw);
      if (!week.ngay_bd || !week.ngay_kt || raw < String(week.ngay_bd) || raw > String(week.ngay_kt)) errors[field] = "Ngày phải nằm trong tuần báo cáo.";
      return raw;
    } catch { errors[field] = "Ngày không hợp lệ."; return raw; }
  }
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (match && week.ngay_bd && week.ngay_kt) {
    const candidates: string[] = [];
    for (let day = String(week.ngay_bd); day <= String(week.ngay_kt); day = shiftDate(day, 1)) {
      if (Number(day.slice(8, 10)) === Number(match[1]) && Number(day.slice(5, 7)) === Number(match[2])) candidates.push(day);
    }
    if (candidates.length === 1) return candidates[0];
  }
  errors[field] = "Ngày cũ chưa xác định được; hãy chọn lại ngày trong tuần.";
  return raw;
}

function parsedRows(form: Record<string, string>, prefix: string, fields: string[], required: string[], week: Dict, errors: Record<string, string>) {
  return indexed(form, prefix, fields).map((row) => {
    const index = Number(row.__index);
    delete row.__index;
    const present = fields.some((field) => row[field]);
    if (!present) return undefined;
    for (const field of required) if (!row[field]) errors[`${prefix}_${index}_${field}`] = "Cần nhập trường này.";
    if (row.ngay) row.ngay = reportDate(row.ngay, week, `${prefix}_${index}_ngay`, errors);
    if (fields.includes("so_luong")) {
      if (!row.so_luong) row.so_luong = "1";
      else {
        const count = reportInteger(row.so_luong, `${prefix}_${index}_so_luong`, errors);
        if (count < 1) errors[`${prefix}_${index}_so_luong`] = "Số lượng phải từ 1.";
        row.so_luong = String(count);
      }
    }
    return { ...row, index };
  }).filter((row): row is ReportRow => Boolean(row));
}

function flag01(value: string | undefined) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true" ? "1" : "0";
}

const VP_FIELDS = ["tieu_chi_id", "ho_ten", "ngay", "so_luong", "tap_the", "gvcn_phat_hien", "ghi_chu"];

function parsedCatalogRows(form: Record<string, string>, week: Dict, errors: Record<string, string>) {
  return indexed(form, "vp", VP_FIELDS).map((row) => {
    const index = Number(row.__index);
    delete row.__index;
    const present = VP_FIELDS.some((field) => row[field]);
    if (!present) return undefined;
    row.tap_the = flag01(row.tap_the);
    row.gvcn_phat_hien = flag01(row.gvcn_phat_hien);
    if (row.tap_the !== "1" && !row.ho_ten) errors[`vp_${index}_ho_ten`] = "Cần nhập trường này.";
    if (!row.tieu_chi_id) errors[`vp_${index}_tieu_chi_id`] = "Cần nhập trường này.";
    else if (!/^\d+$/.test(row.tieu_chi_id) || Number(row.tieu_chi_id) < 1) {
      errors[`vp_${index}_tieu_chi_id`] = "Tiêu chí không hợp lệ.";
    }
    if (row.ngay) row.ngay = reportDate(row.ngay, week, `vp_${index}_ngay`, errors);
    if (!row.so_luong) row.so_luong = "1";
    else {
      const count = reportInteger(row.so_luong, `vp_${index}_so_luong`, errors);
      if (count < 1) errors[`vp_${index}_so_luong`] = "Số lượng phải từ 1.";
      row.so_luong = String(count);
    }
    return { ...row, index };
  }).filter((row): row is ReportRow => Boolean(row));
}

export function parseReport(form: Record<string, string>, week: Dict): ParsedReport {
  const errors: Record<string, string> = {};
  const header = Object.fromEntries(REPORT_COUNTS.map((field) => [field, reportInteger(form[field], field, errors)])) as ParsedReport["header"];
  header.bi_thu = String(form.bi_thu ?? "").trim();
  header.ngay_lap = reportDate(String(form.ngay_lap ?? "").trim(), week, "ngay_lap", errors);
  header.ghi_chu_gio = String(form.ghi_chu_gio ?? "").trim();
  header.ghi_chu_ktm = String(form.ghi_chu_ktm ?? "").trim();
  const classified = header.gio_tot + header.gio_kha + header.gio_tb + header.gio_yeu + header.gio_kem;
  if (classified > header.gio_tong) errors.gio_tong = "Tổng các mức giờ không được vượt tổng giờ.";
  const nghi = parsedRows(form, "nghi", ["ho_ten", "ngay", "ghi_chu"], ["ho_ten"], week, errors);
  const events: Record<string, ReportRow[]> = {};
  for (const loai of ["di_muon", "trang_phuc", "phu_hieu", "vp_khac"]) {
    events[loai] = parsedRows(form, loai, ["ho_ten", "ngay", "so_luong", "ghi_chu"], ["ho_ten"], week, errors);
  }
  events.thai_do = parsedRows(form, "thai_do", ["ho_ten", "ngay", "tiet_mon", "noi_dung", "ghi_chu"], ["ho_ten", "noi_dung"], week, errors);
  events.vp = parsedCatalogRows(form, week, errors);
  return { header, nghi, events, errors };
}

export function getBaoCao(con: Db, tuanId: number, lopId: number) {
  return get(con, "SELECT * FROM bao_cao_tuan WHERE tuan_id=? AND lop_id=?", [tuanId, lopId]);
}

export function loadReport(con: Db, tuanId: number, lopId: number) {
  const bc = getBaoCao(con, tuanId, lopId);
  const nghi = bc ? all(con, "SELECT * FROM nghi_hoc WHERE bao_cao_id=? ORDER BY id", [bc.id]) : [];
  const sk = bc ? all(con, "SELECT * FROM su_kien WHERE bao_cao_id=? ORDER BY id", [bc.id]) : [];
  return { bc, nghi, sk };
}

function freezeWeekClasses(con: Db, namId: number, tuanId: number) {
  if (get(con, "SELECT 1 FROM week_class WHERE tuan_id=? LIMIT 1", [tuanId])) return;
  for (const lop of listLop(con, namId)) {
    run(con, `INSERT INTO week_class(tuan_id,lop_id,ten,nhom,si_so,gvcn,thu_tu,loai_hinh,gvcn_group_id,ap_dung)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tuanId, lop.id, lop.ten, lop.nhom, lop.si_so, lop.gvcn || "", lop.thu_tu ?? 0,
        lop.loai_hinh === "chon" ? "chon" : "thuong", lop.gvcn_group_id ?? null, Number(lop.ap_dung) === 0 ? 0 : 1]);
  }
}

export function frozenWeekClasses(con: Db, tuanId: number) {
  return all(con, `SELECT lop_id AS id,ten,nhom,si_so,gvcn,thu_tu,loai_hinh,ap_dung,gvcn_group_id
    FROM week_class WHERE tuan_id=? AND ap_dung=1 ORDER BY thu_tu,ten`, [tuanId]);
}

export function sampleWeek(con: Db, namId: number) {
  return get(con, "SELECT * FROM tuan WHERE nam_hoc_id=? AND so_tuan=3 AND ghi_chu=?", [namId, SAMPLE_WEEK_NOTE]);
}

export function deleteSampleWeek(con: Db, namId: number) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    const week = sampleWeek(con, namId);
    if (!week) throw new WorkflowError(404, "Không có tuần mẫu để xóa.");
    const id = Number(week.id);
    for (const table of ["week_snapshot", "week_status_log", "week_class", "weekly_legacy_input", "manual_score_conflict"]) {
      if (tableExists(con, table)) run(con, `DELETE FROM ${table} WHERE tuan_id=?`, [id]);
    }
    run(con, "DELETE FROM tuan WHERE id=? AND ghi_chu=?", [id, SAMPLE_WEEK_NOTE]);
  });
}
export function saveReport(
  con: Db,
  namId: number,
  selection: { tuan_id?: number; week_start?: string },
  lopId: number,
  expectedRevision: number,
  parsed: ParsedReport,
  action: "save" | "submit",
) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", lopId, namId);
    if (Object.keys(parsed.errors).length) throw new WorkflowError(400, "Báo cáo có trường chưa hợp lệ.");
    const week = resolveWeekForWrite(con, namId, selection);
    if (locked(week)) throw new WorkflowError(409, "Tuần đã khóa; nội dung chỉ có thể phục hồi.");
    freezeWeekClasses(con, namId, Number(week.id));
    const exist = getBaoCao(con, Number(week.id), lopId);
    if (Number(exist?.revision ?? 0) !== expectedRevision) throw new WorkflowError(409, "Báo cáo đã được sửa ở nơi khác; nội dung hiện tại không bị ghi đè.");
    const h = parsed.header;
    const classified = h.gio_tot + h.gio_kha + h.gio_tb + h.gio_yeu + h.gio_kem;
    if (action === "submit") {
      if (classified !== h.gio_tong && !h.ghi_chu_gio) throw new WorkflowError(400, "Cần ghi lý do cho số giờ chưa xếp loại.");
    }
    const values = REPORT_COUNTS.map((field) => h[field]);
    let id: number;
    if (exist) {
      run(con, `UPDATE bao_cao_tuan SET ${REPORT_COUNTS.map((field) => `${field}=?`).join(",")},
        bi_thu=?,ngay_lap=?,ghi_chu_gio=?,ghi_chu_ktm=?,trang_thai=?,revision=revision+1,updated_at=datetime('now','localtime') WHERE id=?`,
        [...values, h.bi_thu, h.ngay_lap, h.ghi_chu_gio, h.ghi_chu_ktm, action === "submit" ? "da_gui" : String(exist.trang_thai), exist.id]);
      id = Number(exist.id);
      run(con, "DELETE FROM nghi_hoc WHERE bao_cao_id=?", [id]);
      run(con, "DELETE FROM su_kien WHERE bao_cao_id=?", [id]);
    } else {
      const result = run(con, `INSERT INTO bao_cao_tuan(tuan_id,lop_id,${REPORT_COUNTS.join(",")},bi_thu,ngay_lap,ghi_chu_gio,ghi_chu_ktm,trang_thai,revision,updated_at)
        VALUES (${Array(2 + REPORT_COUNTS.length + 7).fill("?").join(",")})`,
        [week.id, lopId, ...values, h.bi_thu, h.ngay_lap, h.ghi_chu_gio, h.ghi_chu_ktm, action === "submit" ? "da_gui" : "nhap", 1, new Date().toISOString()]);
      id = Number(result.lastInsertRowid);
    }
    for (const row of parsed.nghi) {
      run(con, "INSERT INTO nghi_hoc(bao_cao_id,ho_ten,ngay,ghi_chu) VALUES (?,?,?,?)", [id, row.ho_ten, row.ngay, row.ghi_chu]);
    }
    for (const [loai, rows] of Object.entries(parsed.events)) for (const row of rows) {
      insertSuKien(con, namId, id, loai, row);
    }
    rebuildAuto(con, Number(week.id), lopId);
    run(con, "UPDATE tuan SET revision=revision+1 WHERE id=?", [week.id]);
    return { week, report: getBaoCao(con, Number(week.id), lopId)! };
  });
}

function ensureDraftReport(con: Db, week: Dict, lopId: number) {
  const exist = getBaoCao(con, Number(week.id), lopId);
  if (exist) return Number(exist.id);
  const zeros = REPORT_COUNTS.map(() => 0);
  const result = run(con, `INSERT INTO bao_cao_tuan(tuan_id,lop_id,${REPORT_COUNTS.join(",")},bi_thu,ngay_lap,ghi_chu_gio,ghi_chu_ktm,trang_thai,revision,updated_at)
    VALUES (${Array(2 + REPORT_COUNTS.length + 7).fill("?").join(",")})`,
    [week.id, lopId, ...zeros, "", String(week.ngay_bd || ""), "Nhập lỗi tuần", "Nhập lỗi tuần", "nhap", 1, new Date().toISOString()]);
  return Number(result.lastInsertRowid);
}

export function parseBuoi(raw: string | undefined): "sang" | "chieu" | "" {
  const text = String(raw || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (text === "sang") return "sang";
  if (text === "chieu") return "chieu";
  return "";
}

export type WeekLoiInput = {
  lop_id: number;
  ngay: string;
  ho_ten: string;
  tieu_chi_id: number;
  so_luong?: number;
  tap_the?: boolean;
  gvcn_phat_hien?: boolean;
  ghi_chu?: string;
  buoi?: string;
};

export function appendWeekLoi(
  con: Db,
  namId: number,
  selection: { tuan_id?: number; week_start?: string },
  input: WeekLoiInput,
) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "lop", input.lop_id, namId);
    const week = resolveWeekForWrite(con, namId, selection);
    if (locked(week)) throw new WorkflowError(409, "Tuần đã khóa; không thêm lỗi.");
    freezeWeekClasses(con, namId, Number(week.id));
    const criterion = requireOwned(con, "tieu_chi", input.tieu_chi_id, namId);
    if (!Number(criterion.ap_dung)) throw new WorkflowError(400, "Tiêu chí không áp dụng.");
    const ngay = String(input.ngay || "").trim();
    if (!week.ngay_bd || !week.ngay_kt || ngay < String(week.ngay_bd) || ngay > String(week.ngay_kt)) {
      throw new WorkflowError(400, "Ngày phải nằm trong tuần báo cáo.");
    }
    const tapThe = Boolean(input.tap_the);
    let hoTen = String(input.ho_ten || "").trim();
    if (!tapThe && !hoTen && String(criterion.ma) !== "nghi_hoc") {
      throw new WorkflowError(400, "Cần họ tên hoặc đánh dấu tập thể.");
    }
    if (tapThe && !hoTen) hoTen = "Tập thể";
    const soLuong = input.so_luong == null ? 1 : Number(input.so_luong);
    if (!Number.isSafeInteger(soLuong) || soLuong < 1) throw new WorkflowError(400, "Số lượng phải từ 1.");
    const baoCaoId = ensureDraftReport(con, week, input.lop_id);
    const ma = String(criterion.ma);
    const ghiChu = String(input.ghi_chu || "").trim();
    const buoi = parseBuoi(input.buoi);
    if (!buoi) throw new WorkflowError(400, "Cần chọn buổi sáng hoặc chiều.");
    const row: ReportRow = {
      index: 0,
      tieu_chi_id: String(criterion.id),
      ho_ten: hoTen,
      ngay,
      so_luong: String(soLuong),
      tap_the: tapThe ? "1" : "0",
      gvcn_phat_hien: input.gvcn_phat_hien ? "1" : "0",
      ghi_chu: ghiChu,
      noi_dung: ghiChu,
      tiet_mon: "",
      buoi,
    };
    if (ma === "nghi_hoc") {
      if (!hoTen) throw new WorkflowError(400, "Nghỉ học cần họ tên.");
      run(con, "INSERT INTO nghi_hoc(bao_cao_id,ho_ten,ngay,buoi,ghi_chu) VALUES (?,?,?,?,?)", [baoCaoId, hoTen, ngay, buoi, ghiChu]);
    } else if (PAPER_CATALOG_MA.has(ma) && ma !== "van_nghe") {
      insertSuKien(con, namId, baoCaoId, ma, row);
    } else {
      insertSuKien(con, namId, baoCaoId, "vp", row);
    }
    rebuildAuto(con, Number(week.id), input.lop_id);
    run(con, "UPDATE tuan SET revision=revision+1 WHERE id=?", [week.id]);
    run(con, "UPDATE bao_cao_tuan SET revision=revision+1, updated_at=datetime('now','localtime') WHERE id=?", [baoCaoId]);
    return { week, lop_id: input.lop_id, ten: String(criterion.ten), diem: Number(criterion.diem) };
  });
}

export function listWeekLoi(con: Db, tuanId: number) {
  const nghi = all(con, `SELECT 'nghi' AS kind, n.id, bc.lop_id, l.ten AS lop_ten, l.thu_tu,
      n.ho_ten, n.ngay, 1 AS so_luong, n.ghi_chu, 'nghi_hoc' AS ma, 'Nghỉ học không lý do' AS tieu_chi_ten,
      COALESCE(tc.diem, -10) AS diem, 0 AS tap_the
    FROM nghi_hoc n
    JOIN bao_cao_tuan bc ON bc.id=n.bao_cao_id
    JOIN lop l ON l.id=bc.lop_id
    LEFT JOIN tieu_chi tc ON tc.nam_hoc_id=l.nam_hoc_id AND tc.ma='nghi_hoc'
    WHERE bc.tuan_id=?`, [tuanId]);
  const sk = all(con, `SELECT 'su_kien' AS kind, sk.id, bc.lop_id, l.ten AS lop_ten, l.thu_tu,
      sk.ho_ten, sk.ngay, sk.so_luong, sk.ghi_chu, COALESCE(tc.ma, sk.loai) AS ma,
      COALESCE(tc.ten, sk.loai) AS tieu_chi_ten, COALESCE(tc.diem, 0) AS diem, sk.tap_the
    FROM su_kien sk
    JOIN bao_cao_tuan bc ON bc.id=sk.bao_cao_id
    JOIN lop l ON l.id=bc.lop_id
    LEFT JOIN tieu_chi tc ON tc.id=sk.tieu_chi_id
    WHERE bc.tuan_id=?`, [tuanId]);
  return [...nghi, ...sk].sort((a, b) =>
    Number(a.thu_tu) - Number(b.thu_tu)
    || String(a.ngay).localeCompare(String(b.ngay))
    || String(a.ho_ten).localeCompare(String(b.ho_ten), "vi"));
}

export function indexed(f: Record<string, string>, prefix: string, fields: string[]) {
  const indexes = new Set<number>();
  for (const key of Object.keys(f)) {
    const match = key.match(new RegExp(`^${prefix}_(\\d+)_`));
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => {
    const row: Record<string, string> = { __index: String(index) };
    for (const field of fields) row[field] = String(f[`${prefix}_${index}_${field}`] ?? "").trim();
    return row;
  });
}

function rule(con: Db, namId: number, ma: string) {
  return get(con, "SELECT * FROM tieu_chi WHERE nam_hoc_id=? AND ma=? AND ap_dung=1", [namId, ma]);
}

function catalogEvent(row: Dict) {
  const id = row.tieu_chi_id;
  return id != null && id !== "" && Number(id) > 0;
}

function insertSuKien(con: Db, namId: number, baoCaoId: number, loai: string, row: ReportRow) {
  const tapThe = flag01(row.tap_the) === "1" ? 1 : 0;
  const gvcn = flag01(row.gvcn_phat_hien) === "1" ? 1 : 0;
  const hoTen = row.ho_ten || "";
  if (loai === "vp") {
    const tieuChiId = Number(row.tieu_chi_id);
    const criterion = get(con, "SELECT * FROM tieu_chi WHERE id=? AND nam_hoc_id=? AND ap_dung=1", [tieuChiId, namId]);
    if (!criterion) throw new WorkflowError(400, "Tiêu chí không hợp lệ.");
    if (!mappedNnScoreKey(criterion.score_key) || PAPER_CATALOG_MA.has(String(criterion.ma))) {
      throw new WorkflowError(400, "Tiêu chí chưa ánh xạ.");
    }
    const storedLoai = String(criterion.score_key || "vp");
    run(con, `INSERT INTO su_kien(bao_cao_id,loai,ho_ten,ngay,so_luong,tiet_mon,noi_dung,ghi_chu,tieu_chi_id,tap_the,gvcn_phat_hien,nguon,buoi)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'tnkt',?)`,
      [baoCaoId, storedLoai, hoTen, row.ngay || "", Number(row.so_luong || 1), row.tiet_mon || "", row.noi_dung || "",
        row.ghi_chu || "", tieuChiId, tapThe, gvcn, parseBuoi(row.buoi)]);
    return;
  }
  run(con, `INSERT INTO su_kien(bao_cao_id,loai,ho_ten,ngay,so_luong,tiet_mon,noi_dung,ghi_chu,tieu_chi_id,tap_the,gvcn_phat_hien,nguon,buoi)
    VALUES (?,?,?,?,?,?,?,?,NULL,?,?,'giay',?)`,
    [baoCaoId, loai, hoTen, row.ngay || "", Number(row.so_luong || 1), row.tiet_mon || "", row.noi_dung || "",
      row.ghi_chu || "", tapThe, gvcn, parseBuoi(row.buoi)]);
}

function addAuto(con: Db, tuanId: number, lopId: number, tc: Dict, sl: number) {
  if (!sl) return;
  const thanh = sl * Number(tc.diem);
  run(con, `INSERT INTO cham_dong(tuan_id,lop_id,tieu_chi_id,so_luong,diem_mot,thanh_diem,nguon,score_key,ten_snapshot,don_vi_snapshot)
    VALUES (?,?,?,?,?,?,'auto',?,?,?)`, [tuanId, lopId, tc.id, sl, tc.diem, thanh, tc.score_key, tc.ten, tc.don_vi]);
}

export function rebuildAuto(con: Db, tuanId: number, lopId: number) {
  const tuan = get(con, "SELECT * FROM tuan WHERE id=?", [tuanId]);
  if (!tuan) return;
  const namId = Number(tuan.nam_hoc_id);
  run(con, "DELETE FROM cham_dong WHERE tuan_id=? AND lop_id=? AND nguon='auto'", [tuanId, lopId]);
  const { bc, nghi, sk } = loadReport(con, tuanId, lopId);
  if (!bc) return;
  const nghiRule = rule(con, namId, "nghi_hoc");
  if (nghiRule) addAuto(con, tuanId, lopId, nghiRule, nghi.length);
  const byCriterion: Record<number, number> = {};
  const byLoai: Record<string, number> = {};
  for (const event of sk) {
    const sl = Number(event.so_luong || 1);
    if (catalogEvent(event)) {
      const id = Number(event.tieu_chi_id);
      byCriterion[id] = (byCriterion[id] ?? 0) + sl;
    } else {
      const loai = String(event.loai);
      byLoai[loai] = (byLoai[loai] ?? 0) + sl;
    }
  }
  for (const [id, sl] of Object.entries(byCriterion)) {
    const criterion = get(con, "SELECT * FROM tieu_chi WHERE id=?", [Number(id)]);
    if (criterion) addAuto(con, tuanId, lopId, criterion, sl);
  }
  for (const loai of Object.keys(byLoai)) {
    const criterion = rule(con, namId, loai);
    if (criterion) addAuto(con, tuanId, lopId, criterion, byLoai[loai]);
  }
}

export function saveChamTay(
  con: Db, namId: number, tuanId: number, lopId: number, tieuChiId: number,
  soLuong: number, expectedRevision: number, reason: string,
) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    const week = requireOwned(con, "tuan", tuanId, namId);
    freezeWeekClasses(con, namId, tuanId);
    requireOwned(con, "lop", lopId, namId);
    const criterion = requireOwned(con, "tieu_chi", tieuChiId, namId);
    if (locked(week) || Number(week.revision) !== expectedRevision) throw new WorkflowError(409, "Tuần đã khóa hoặc đã được sửa ở nơi khác.");
    if (!Number(criterion.ap_dung) || (!NN_KEYS.includes(String(criterion.score_key)) && criterion.score_key !== "cong_ne_nep")) throw new WorkflowError(400, "Chấm bổ sung chỉ nhận tiêu chí nề nếp đã ánh xạ.");
    if (!Number.isSafeInteger(soLuong) || soLuong < 0) throw new WorkflowError(400, "Số lượng phải là số nguyên không âm.");
    if (!reason.trim()) throw new WorkflowError(400, "Cần ghi lý do điều chỉnh.");
    if (get(con, "SELECT 1 FROM manual_score_conflict WHERE tuan_id=? AND lop_id=? AND tieu_chi_id=?", [tuanId, lopId, tieuChiId])) {
      throw new WorkflowError(409, "Điểm tay cũ bị trùng, cần đối chiếu trước khi sửa.");
    }
    run(con, "DELETE FROM cham_dong WHERE tuan_id=? AND lop_id=? AND tieu_chi_id=? AND nguon='tay'", [tuanId, lopId, tieuChiId]);
    if (soLuong) run(con, `INSERT INTO cham_dong(tuan_id,lop_id,tieu_chi_id,so_luong,diem_mot,thanh_diem,nguon,score_key,ten_snapshot,don_vi_snapshot,reason)
      VALUES (?,?,?,?,?,?,'tay',?,?,?,?)`, [tuanId, lopId, tieuChiId, soLuong, criterion.diem, soLuong * Number(criterion.diem),
      criterion.score_key, criterion.ten, criterion.don_vi, reason.trim()]);
    run(con, "UPDATE tuan SET revision=revision+1 WHERE id=?", [tuanId]);
  });
}

export type ClassWeek = Omit<ClassResult, "xt_nn" | "xt_ht" | "tong_xt" | "xt_chung"> & {
  xt_nn: number | null; xt_ht: number | null; tong_xt: number | null; xt_chung: number | null;
  bao_cao: boolean; report_status: "nhap" | "da_gui" | "legacy" | "missing";
  complete: boolean; missing: string[]; lines: Dict[];
  rank_status: "provisional" | "official" | "missing"; delta: number | null; provenance: string[];
};

function blankResult(lop: Dict, row: Row): ClassResult {
  return {
    lop_id: Number(lop.id), ten: String(lop.ten), nhom: Number(lop.nhom), si_so: Number(lop.si_so || 0), row,
    diem_nn: 0, tb_nn: 0, diem_gio: 0, so_gio: 0, tb_gio: 0, diem_ktm: 0, tb_ktm: 0, tb_ht: 0,
    tong_tru: 0, tong_cong: 0, tong_net: 0, xt_nn: 0, xt_ht: 0, tong_xt: 0, xt_chung: 0,
  };
}

export function buildWeekInputs(con: Db, namId: number, tuanId: number) {
  const week = requireOwned(con, "tuan", tuanId, namId);
  const reports: Record<number, Dict> = {};
  for (const report of all(con, "SELECT * FROM bao_cao_tuan WHERE tuan_id=?", [tuanId])) reports[Number(report.lop_id)] = report;
  const frozen = frozenWeekClasses(con, tuanId);
  const roster = frozen.length ? frozen : listLop(con, namId);
  const linesByClass: Record<number, Dict[]> = {};
  for (const line of all(con, "SELECT * FROM cham_dong WHERE tuan_id=? ORDER BY lop_id,id", [tuanId])) {
    (linesByClass[Number(line.lop_id)] ??= []).push(line);
  }
  const legacy: Record<number, Dict> = {};
  for (const item of all(con, "SELECT * FROM weekly_legacy_input WHERE tuan_id=?", [tuanId])) legacy[Number(item.lop_id)] = item;
  return roster.map((lop) => {
    const report = reports[Number(lop.id)];
    const old = legacy[Number(lop.id)];
    const row: Row = Object.fromEntries([...NN_KEYS, ...GIO_KEYS, "ktm_9_10", "ktm_7_8", "ktm_5_6", "ktm_3_4", "ktm_0_2"].map((key) => [key, 0]));
    const missing: string[] = [];
    const provenance: string[] = [];
    if (report) {
      for (const key of [...GIO_KEYS, "ktm_9_10", "ktm_7_8", "ktm_5_6", "ktm_3_4", "ktm_0_2"]) row[key] = Number(report[key] || 0);
      provenance.push("Báo cáo tuần");
    } else if (old && Number(old.confirmed)) {
      const payload = JSON.parse(String(old.payload_json)) as Row;
      for (const key of [...NN_KEYS, ...GIO_KEYS, "ktm_9_10", "ktm_7_8", "ktm_5_6", "ktm_3_4", "ktm_0_2"]) row[key] = Number(payload[key] || 0);
      provenance.push("Nguồn cũ đã xác nhận");
    } else {
      missing.push(old ? "Nguồn cũ chưa xác nhận" : "Chưa có báo cáo");
    }
    row.ktm_ge5 = Number(row.ktm_9_10) + Number(row.ktm_7_8) + Number(row.ktm_5_6);
    row.ktm_lt5 = Number(row.ktm_3_4) + Number(row.ktm_0_2);
    const lines = linesByClass[Number(lop.id)] ?? [];
    for (const line of lines) {
      const key = String(line.score_key || "");
      if (NN_KEYS.includes(key)) row[key] = Number(row[key] || 0) + Number(line.thanh_diem);
      else if (key === "cong_ne_nep") row.cong_ne_nep = Number(row.cong_ne_nep || 0) + Number(line.thanh_diem);
      else if (Number(line.thanh_diem) && ![...GIO_KEYS, ...KTM_SCORE_KEYS, "ktm_5_6"].includes(key)) missing.push(`Tiêu chí chưa ánh xạ: ${line.ten_snapshot || line.tieu_chi_id}`);
      provenance.push(line.nguon === "tay" ? `Chấm bổ sung: ${line.reason || "thiếu lý do"}` : "Tự tính từ báo cáo");
    }
    if (Number(lop.si_so) <= 0) missing.push("Sĩ số không hợp lệ");
    if (!week.ngay_bd || !week.ngay_kt) missing.push("Tuần chưa đối chiếu lịch");
    const reportStatus = report ? String(report.trang_thai) as "nhap" | "da_gui" : old && Number(old.confirmed) ? "legacy" : "missing";
    if (report && reportStatus !== "da_gui") missing.push("Báo cáo chưa gửi");
    return { lop, row, report, reportStatus, lines, missing: [...new Set(missing)], provenance: [...new Set(provenance)] };
  });
}

function scoreWeekCore(con: Db, tuanId: number): ClassWeek[] {
  const week = getTuan(con, tuanId);
  if (!week) return [];
  const inputs = buildWeekInputs(con, Number(week.nam_hoc_id), tuanId);
  const available = inputs.filter((input) => Boolean(input.report) || input.reportStatus === "legacy");
  const ktmDivisor = yearFormulaOf(con, Number(week.nam_hoc_id)).ktm_divisor;
  const hoiMa = tableExists(con, "milestone_week")
    ? get(con, `SELECT m.ma FROM milestone_week mw JOIN milestone m ON m.id=mw.milestone_id
        WHERE mw.tuan_id=? AND m.loai='hoi_hoc' AND m.ma IN ('20-11','26-3') ORDER BY m.ma LIMIT 1`, [tuanId])
    : undefined;
  const weights = hoiMa ? HOI_HOC_WEIGHTS[String(hoiMa.ma)] : undefined;
  const scored = scoreAll(available.map((input) => blankResult(input.lop, input.row)), ktmDivisor, weights);
  const scoredById = new Map(scored.map((result) => [result.lop_id, result]));
  const groupComplete = new Map<number, boolean>();
  for (const input of inputs) {
    const group = Number(input.lop.nhom);
    groupComplete.set(group, (groupComplete.get(group) ?? true) && input.missing.length === 0);
  }
  return inputs.map((input) => {
    const base = scoredById.get(Number(input.lop.id)) ?? blankResult(input.lop, input.row);
    const hasData = scoredById.has(Number(input.lop.id));
    const official = hasData && groupComplete.get(Number(input.lop.nhom)) && week.trang_thai !== TT_NHAP;
    return {
      ...base,
      xt_nn: hasData ? base.xt_nn : null, xt_ht: hasData ? base.xt_ht : null,
      tong_xt: hasData ? base.tong_xt : null, xt_chung: hasData ? base.xt_chung : null,
      bao_cao: Boolean(input.report), report_status: input.reportStatus,
      complete: input.missing.length === 0, missing: input.missing, lines: input.lines,
      rank_status: hasData ? official ? "official" : "provisional" : "missing",
      delta: null, provenance: input.provenance,
    };
  });
}

function isClassWeek(value: unknown): value is ClassWeek {
  return Boolean(value && typeof value === "object" && "lop_id" in value && typeof value.lop_id === "number" &&
    "rank_status" in value && ["provisional", "official", "missing"].includes(String(value.rank_status)));
}
function snapshotResults(payload: string): ClassWeek[] {
  const value: unknown = JSON.parse(payload);
  if (!value || typeof value !== "object" || !("results" in value) || !Array.isArray(value.results) ||
      !value.results.every(isClassWeek)) {
    throw new WorkflowError(500, "Snapshot tuần bị hỏng.");
  }
  const validated: ClassWeek[] = value.results;
  return validated;
}
export function scoreWeek(con: Db, tuanId: number): ClassWeek[] {
  const frozen = get(con, "SELECT payload_json FROM week_snapshot WHERE tuan_id=?", [tuanId]);
  if (frozen) return snapshotResults(String(frozen.payload_json));
  const out = scoreWeekCore(con, tuanId);
  const week = getTuan(con, tuanId);
  if (!week) return out;
  const weeks = listTuan(con, Number(week.nam_hoc_id)).filter((item) => item.ngay_bd);
  const index = weeks.findIndex((item) => Number(item.id) === tuanId);
  if (index > 0) {
    const previous = new Map(scoreWeekCore(con, Number(weeks[index - 1].id)).map((row) => [row.lop_id, row]));
    for (const row of out) {
      const old = previous.get(row.lop_id);
      if (row.xt_chung != null && old?.xt_chung != null && old.nhom === row.nhom) row.delta = old.xt_chung - row.xt_chung;
    }
  }
  return out;
}

export function reportedCount(con: Db, tuanId: number) {
  return Number(get(con, "SELECT COUNT(*) AS c FROM bao_cao_tuan WHERE tuan_id=? AND trang_thai='da_gui'", [tuanId])?.c ?? 0);
}

export function popularViolations(con: Db, tuanId: number) {
  return all(
    con,
    `SELECT t.ten, SUM(c.so_luong) AS sl
     FROM cham_dong c JOIN tieu_chi t ON t.id=c.tieu_chi_id
     WHERE c.tuan_id=? AND t.nhom='ne_nep' AND c.thanh_diem < 0
     GROUP BY t.id ORDER BY sl DESC LIMIT 6`,
    [tuanId],
  );
}

export function aggregate(con: Db, namId: number, tuanIds: number[]) {
  const lops = listLop(con, namId);
  const acc: Record<number, { cong: number; tru: number; tong: number; n: number }> = {};
  for (const id of tuanIds) {
    const rows = scoreWeek(con, id);
    for (const r of rows) {
      const a = (acc[r.lop_id] ??= { cong: 0, tru: 0, tong: 0, n: 0 });
      a.cong += r.tong_cong;
      a.tru += r.tong_tru;
      a.tong += r.tong;
      a.n += 1;
    }
  }
  const out = lops.map((lop) => {
    const a = acc[Number(lop.id)] ?? { cong: 0, tru: 0, tong: 0, n: 0 };
    return {
      lop_id: Number(lop.id),
      ten: String(lop.ten),
      nhom: Number(lop.nhom),
      tong_cong: a.cong,
      tong_tru: a.tru,
      tong: a.tong,
      n_weeks: a.n,
      hang: 0,
    };
  });
  const groups: Record<number, typeof out> = {};
  for (const it of out) (groups[it.nhom] ??= []).push(it);
  for (const g of Object.values(groups)) {
    const ranks = competitionRanks(
      g.map((x) => x.tong),
      true,
    );
    g.forEach((it, i) => {
      it.hang = ranks[i];
    });
  }
  return out;
}

export function saveKhen(con: Db, namId: number, ky: string, lopId: number, ketQua: string, ghiChu: string) {
  transaction(con, () => {
  requireActiveYear(con, namId);
  requireOwned(con, "lop", lopId, namId);
  run(
    con,
    "INSERT INTO khen_thuong(nam_hoc_id, ky, lop_id, ket_qua, ghi_chu) VALUES (?,?,?,?,?) ON CONFLICT(nam_hoc_id, ky, lop_id) DO UPDATE SET ket_qua=excluded.ket_qua, ghi_chu=excluded.ghi_chu",
    [namId, ky, lopId, ketQua, ghiChu],
  );
  });
}

export function listKhen(con: Db, namId: number, ky: string) {
  const map: Record<number, Dict> = {};
  for (const r of all(con, "SELECT * FROM khen_thuong WHERE nam_hoc_id=? AND ky=?", [namId, ky])) {
    map[Number(r.lop_id)] = r;
  }
  return map;
}

export function diemCoSo(con: Db, namId: number) {
  return Number(get(con, "SELECT diem_co_so FROM nam_hoc WHERE id=?", [namId])?.diem_co_so ?? 0);
}

export function setDiemCoSo(con: Db, namId: number, v: number) {
  transaction(con, () => {
  requireActiveYear(con, namId);
  if (!Number.isFinite(v)) throw new Error("Điểm cơ sở không hợp lệ.");
  run(con, "UPDATE nam_hoc SET diem_co_so=? WHERE id=?", [v, namId]);
  });
}

export function padRows(rows: Dict[], n: number) {
  const out = rows.slice();
  while (out.length < n) out.push({});
  return out;
}
