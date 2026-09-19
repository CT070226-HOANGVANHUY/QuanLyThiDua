import { existsSync } from "node:fs";
import path from "node:path";
import { addColumn, all, applyLeftoverWeekClass, get, loadSeed, run, syncNhapWeekClass, tableExists, type Db } from "./db.ts";

function userVersion(con: Db): number {
  return Number(get(con, "PRAGMA user_version")?.user_version ?? 0);
}

function dbFilePath(con: Db): string {
  return String(get(con, "SELECT file FROM pragma_database_list WHERE name='main'")?.file ?? "");
}

function backupBeforeV5(con: Db) {
  const file = dbFilePath(con);
  if (!file) return;
  const backupPath = `${path.resolve(file)}.before-v5.db`;
  if (existsSync(backupPath)) return;
  con.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
}

function ensureV5Columns(con: Db) {
  if (tableExists(con, "lop")) {
    addColumn(con, "lop", "nu", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "lop", "kt", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "lop", "loai_hinh", "TEXT NOT NULL DEFAULT 'thuong' CHECK(loai_hinh IN ('chon','thuong'))");
    addColumn(con, "lop", "ap_dung", "INTEGER NOT NULL DEFAULT 1 CHECK(ap_dung IN (0,1))");
    addColumn(con, "lop", "gvcn_group_id", "INTEGER");
  }
  if (tableExists(con, "week_class")) {
    addColumn(con, "week_class", "thu_tu", "INTEGER NOT NULL DEFAULT 0");
    addColumn(con, "week_class", "loai_hinh", "TEXT NOT NULL DEFAULT 'thuong'");
    addColumn(con, "week_class", "gvcn_group_id", "INTEGER");
    addColumn(con, "week_class", "ap_dung", "INTEGER NOT NULL DEFAULT 1");
  }
}

function backfillV5(con: Db) {
  if (tableExists(con, "lop")) {
    run(con, "UPDATE lop SET loai_hinh=CASE WHEN nhom=1 THEN 'chon' ELSE 'thuong' END");
  }
  if (tableExists(con, "week_class") && tableExists(con, "lop")) {
    con.exec(`UPDATE week_class SET
      thu_tu=COALESCE((SELECT thu_tu FROM lop WHERE lop.id=week_class.lop_id), thu_tu),
      loai_hinh=COALESCE((SELECT loai_hinh FROM lop WHERE lop.id=week_class.lop_id), loai_hinh),
      gvcn_group_id=(SELECT gvcn_group_id FROM lop WHERE lop.id=week_class.lop_id),
      ap_dung=COALESCE((SELECT ap_dung FROM lop WHERE lop.id=week_class.lop_id), ap_dung)`);
  }
}

function rosterYearId(con: Db): number | undefined {
  const named = get(con, "SELECT id FROM nam_hoc WHERE ten=?", ["2026-2027"]);
  if (named) return Number(named.id);
  const years = all(con, "SELECT id FROM nam_hoc");
  if (years.length === 1) return Number(years[0].id);
  return undefined;
}

export function importRoster2026(con: Db, namId?: number) {
  if (!tableExists(con, "lop") || !tableExists(con, "nam_hoc")) return;
  const id = namId ?? rosterYearId(con);
  if (id == null) return;
  const seed = loadSeed();
  const names = new Set(seed.lop.map((row) => row.ten));
  for (const row of seed.lop) {
    const loaiHinh = row.loai_hinh === "chon" ? "chon" : "thuong";
    const nhom = loaiHinh === "chon" ? 1 : 2;
    const khoi = Number.parseInt(row.ten, 10);
    const existing = get(con, "SELECT id FROM lop WHERE nam_hoc_id=? AND ten=?", [id, row.ten]);
    if (existing) {
      run(con, `UPDATE lop SET si_so=?, gvcn=?, nu=?, kt=?, nhom=?, loai_hinh=?, thu_tu=?, ap_dung=1, khoi=?
        WHERE id=?`, [row.si_so, row.gvcn, row.nu, row.kt, nhom, loaiHinh, row.thu_tu, khoi, existing.id]);
    } else {
      run(con, `INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu, nu, kt, loai_hinh, ap_dung)
        VALUES (?,?,?,?,?,?,?,?,?,?,1)`, [
        id, row.ten, khoi, nhom, row.si_so, row.gvcn, row.thu_tu, row.nu, row.kt, loaiHinh,
      ]);
    }
  }
  for (const lop of all(con, "SELECT id, ten FROM lop WHERE nam_hoc_id=?", [id])) {
    if (!names.has(String(lop.ten))) run(con, "UPDATE lop SET ap_dung=0 WHERE id=?", [lop.id]);
  }
  applyLeftoverWeekClass(con, id);
  assignDefaultGvcnGroups(con, id);
  syncNhapWeekClass(con, id);
}

function migrateV5(con: Db) {
  backupBeforeV5(con);
  ensureV5Columns(con);
  backfillV5(con);
  importRoster2026(con);
}

const YEAR_FORMULA_SQL = `CREATE TABLE IF NOT EXISTS year_formula (
  nam_id INTEGER PRIMARY KEY REFERENCES nam_hoc(id) ON DELETE CASCADE,
  ktm_divisor TEXT NOT NULL DEFAULT 'count' CHECK(ktm_divisor IN ('count','si_so')),
  hk_month_weight REAL NOT NULL DEFAULT 2,
  hoi_hoc_double TEXT NOT NULL DEFAULT 'none' CHECK(hoi_hoc_double IN ('none','hdtt','hdtt_only','week_xt')),
  gvcn_5_1_window TEXT NOT NULL DEFAULT 'semester' CHECK(gvcn_5_1_window IN ('semester','weekly')),
  hk_basis TEXT NOT NULL DEFAULT 'months' CHECK(hk_basis IN ('months','dots'))
)`;

export function ensureYearFormula(con: Db) {
  const sql = String(get(con, "SELECT sql FROM sqlite_master WHERE type='table' AND name='year_formula'")?.sql || "");
  if (sql && (!sql.includes("'hdtt'") || !sql.includes("hk_basis"))) {
    con.exec(YEAR_FORMULA_SQL.replace("year_formula", "year_formula_v11"));
    const hasBasis = all(con, "PRAGMA table_info(year_formula)").some((col) => col.name === "hk_basis");
    const hasWindow = all(con, "PRAGMA table_info(year_formula)").some((col) => col.name === "gvcn_5_1_window");
    run(con, `INSERT OR IGNORE INTO year_formula_v11(nam_id, ktm_divisor, hk_month_weight, hoi_hoc_double, gvcn_5_1_window, hk_basis)
      SELECT nam_id, ktm_divisor, hk_month_weight,
        CASE WHEN hoi_hoc_double IN ('none','hdtt','hdtt_only','week_xt') THEN hoi_hoc_double ELSE 'none' END,
        ${hasWindow ? "gvcn_5_1_window" : "'semester'"},
        ${hasBasis ? "CASE WHEN hk_basis IN ('months','dots') THEN hk_basis ELSE 'months' END" : "'months'"}
      FROM year_formula`);
    con.exec("DROP TABLE year_formula");
    con.exec("ALTER TABLE year_formula_v11 RENAME TO year_formula");
  } else {
    con.exec(YEAR_FORMULA_SQL);
  }
  if (tableExists(con, "nam_hoc")) {
    run(con, "INSERT OR IGNORE INTO year_formula(nam_id) SELECT id FROM nam_hoc");
  }
}

function hasColumn(con: Db, table: string, name: string) {
  return all(con, `PRAGMA table_info(${table})`).some((column) => column.name === name);
}

function migrateCatalogV6(con: Db) {
  if (tableExists(con, "tieu_chi")) {
    run(con, "UPDATE tieu_chi SET diem=-30 WHERE ma='phu_hieu_gia'");
    const withScoreKey = hasColumn(con, "tieu_chi", "score_key");
    const extra: [string, string, string, number, string, string][] = [
      ["gio_kem", "Giờ kém", "hoc_tap", -2, "giờ", "gio_kem"],
      ["xe_dap_de_sai_tap_the", "Để xe không đúng quy định — tập thể", "ne_nep", -10, "lần", "xe_dap"],
    ];
    for (const nam of all(con, "SELECT id FROM nam_hoc")) {
      for (const [ma, ten, nhom, diem, donVi, scoreKey] of extra) {
        if (withScoreKey) {
          run(con, `INSERT INTO tieu_chi(nam_hoc_id,ma,ten,nhom,diem,don_vi,ap_dung,score_key) VALUES (?,?,?,?,?,?,1,?)
            ON CONFLICT(nam_hoc_id,ma) DO NOTHING`, [nam.id, ma, ten, nhom, diem, donVi, scoreKey]);
        } else {
          run(con, `INSERT INTO tieu_chi(nam_hoc_id,ma,ten,nhom,diem,don_vi,ap_dung) VALUES (?,?,?,?,?,?,1)
            ON CONFLICT(nam_hoc_id,ma) DO NOTHING`, [nam.id, ma, ten, nhom, diem, donVi]);
        }
      }
    }
  }
  if (tableExists(con, "quy_che")) {
    run(con, "UPDATE quy_che SET diem='−30/HS' WHERE noi_dung LIKE '%hù hiệu giả%'");
  }
}

function migrateV6(con: Db) {
  ensureYearFormula(con);
  migrateCatalogV6(con);
}

const PAPER_EVENT_LOAI = ["di_muon", "trang_phuc", "phu_hieu", "vp_khac", "thai_do"] as const;

/** Named catalog variants whose SEED ma is not itself an NN_KEYS score_key. */
export const CATALOG_SCORE_KEYS: Record<string, string> = {
  phu_hieu_quen: "phu_hieu",
  phu_hieu_gia: "phu_hieu",
  ve_sinh_binh_nuoc_muon: "ve_sinh",
  ve_sinh_thieu_gay_coc: "ve_sinh",
  chong_doi: "sdb_y_thuc",
  thieu_sgk: "sdb_hoc_tap",
};

export const HOI_HOC_MILESTONES: { ma: string; ten: string }[] = [
  { ma: "20-11", ten: "Hội học 20/11" },
  { ma: "26-3", ten: "Hội học 26/3" },
];

export const DOT_8_TUAN: { ma: string; ten: string; from: number; to: number; hk: 1 | 2 }[] = [
  { ma: "dot_1", ten: "Đợt 1 (tuần 1–8)", from: 1, to: 8, hk: 1 },
  { ma: "dot_2", ten: "Đợt 2 (tuần 9–18)", from: 9, to: 18, hk: 1 },
  { ma: "dot_3", ten: "Đợt 3 (tuần 19–26)", from: 19, to: 26, hk: 2 },
  { ma: "dot_4", ten: "Đợt 4 (tuần 27–34)", from: 27, to: 34, hk: 2 },
];

export function ensureCatalogScoreKeys(con: Db) {
  if (!tableExists(con, "tieu_chi") || !hasColumn(con, "tieu_chi", "score_key")) return;
  const byKey = new Map<string, string[]>();
  for (const [ma, key] of Object.entries(CATALOG_SCORE_KEYS)) {
    const group = byKey.get(key) ?? [];
    group.push(ma);
    byKey.set(key, group);
  }
  for (const [key, mas] of byKey) {
    run(con, `UPDATE tieu_chi SET score_key=?
      WHERE ma IN (${mas.map(() => "?").join(",")}) AND (score_key IS NULL OR score_key='')`, [key, ...mas]);
  }
}

export function ensureV7Columns(con: Db) {
  if (!tableExists(con, "su_kien")) return;
  addColumn(con, "su_kien", "tieu_chi_id", "INTEGER REFERENCES tieu_chi(id)");
  addColumn(con, "su_kien", "tap_the", "INTEGER NOT NULL DEFAULT 0 CHECK(tap_the IN (0,1))");
  addColumn(con, "su_kien", "gvcn_phat_hien", "INTEGER NOT NULL DEFAULT 0 CHECK(gvcn_phat_hien IN (0,1))");
  addColumn(con, "su_kien", "nguon", "TEXT NOT NULL DEFAULT 'tnkt' CHECK(nguon IN ('giay','tnkt','tay'))");
}

export function ensureMilestoneSchema(con: Db) {
  con.exec(`CREATE TABLE IF NOT EXISTS milestone (
  id INTEGER PRIMARY KEY,
  nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
  loai TEXT NOT NULL CHECK(loai IN ('hoi_hoc','tam_ket')),
  ma TEXT NOT NULL,
  ten TEXT NOT NULL,
  nguon_tuan TEXT NOT NULL DEFAULT 'manual' CHECK(nguon_tuan IN ('manual','union')),
  UNIQUE(nam_hoc_id, ma)
);
CREATE TABLE IF NOT EXISTS milestone_week (
  milestone_id INTEGER NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
  thu_tu INTEGER NOT NULL,
  PRIMARY KEY(milestone_id, tuan_id)
);
CREATE TABLE IF NOT EXISTS milestone_entry (
  milestone_id INTEGER NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
  override_rank INTEGER CHECK(override_rank > 0),
  discipline TEXT NOT NULL DEFAULT '',
  reward TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(milestone_id, lop_id)
);
CREATE TABLE IF NOT EXISTS milestone_activity (
  milestone_id INTEGER NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
  the_thao INTEGER CHECK (the_thao IS NULL OR the_thao >= 1),
  van_nghe INTEGER CHECK (van_nghe IS NULL OR van_nghe >= 1),
  PRIMARY KEY(milestone_id, lop_id)
)`);
}

export function ensureHoiHocMilestones(con: Db) {
  if (!tableExists(con, "milestone") || !tableExists(con, "nam_hoc")) return;
  for (const nam of all(con, "SELECT id FROM nam_hoc")) {
    for (const row of HOI_HOC_MILESTONES) {
      run(con, `INSERT INTO milestone(nam_hoc_id,loai,ma,ten,nguon_tuan)
        VALUES (?,'hoi_hoc',?,?,'manual')
        ON CONFLICT(nam_hoc_id, ma) DO NOTHING`, [nam.id, row.ma, row.ten]);
    }
  }
}

export function ensureDotMilestones(con: Db, namId?: number) {
  if (!tableExists(con, "milestone") || !tableExists(con, "nam_hoc")) return;
  const years = namId != null
    ? all(con, "SELECT id FROM nam_hoc WHERE id=?", [namId])
    : all(con, "SELECT id FROM nam_hoc");
  for (const nam of years) {
    for (const row of DOT_8_TUAN) {
      run(con, `INSERT INTO milestone(nam_hoc_id,loai,ma,ten,nguon_tuan)
        VALUES (?,'tam_ket',?,?,'manual')
        ON CONFLICT(nam_hoc_id, ma) DO UPDATE SET ten=excluded.ten`, [nam.id, row.ma, row.ten]);
    }
  }
}

export function assignDefaultGvcnGroups(con: Db, namId?: number) {
  if (!tableExists(con, "lop") || !tableExists(con, "gvcn_ratio_group")) return;
  const years = namId != null
    ? all(con, "SELECT id FROM nam_hoc WHERE id=?", [namId])
    : all(con, "SELECT id FROM nam_hoc");
  for (const nam of years) {
    run(con, `UPDATE lop SET gvcn_group_id=(
        SELECT g.id FROM gvcn_ratio_group g
        WHERE g.nam_hoc_id=lop.nam_hoc_id
          AND g.ma=CASE WHEN lop.loai_hinh='chon' THEN 'A' ELSE 'C' END
      )
      WHERE nam_hoc_id=? AND gvcn_group_id IS NULL`, [nam.id]);
  }
}

function migrateV7(con: Db) {
  ensureV7Columns(con);
  ensureCatalogScoreKeys(con);
  if (!tableExists(con, "su_kien")) return;
  const placeholders = PAPER_EVENT_LOAI.map(() => "?").join(",");
  run(con, `UPDATE su_kien SET nguon='giay'
    WHERE nguon='tnkt' AND tieu_chi_id IS NULL AND loai IN (${placeholders})`, [...PAPER_EVENT_LOAI]);
}

function migrateV8(con: Db) {
  ensureMilestoneSchema(con);
  ensureHoiHocMilestones(con);
}

export const GVCN_GROUP_SEED: readonly [ma: string, ten: string, nguong: number][] = [
  ["A", "Nhóm A — ngưỡng 5", 5],
  ["B", "Nhóm B — ngưỡng 7", 7],
  ["C", "Nhóm C — ngưỡng 10", 10],
];

export function ensureGvcnRatioGroups(con: Db, namId?: number) {
  con.exec(`CREATE TABLE IF NOT EXISTS gvcn_ratio_group (
    id INTEGER PRIMARY KEY,
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    ma TEXT NOT NULL,
    ten TEXT NOT NULL,
    nguong REAL NOT NULL CHECK(nguong > 0),
    UNIQUE(nam_hoc_id, ma)
  )`);
  if (tableExists(con, "lop")) addColumn(con, "lop", "gvcn_group_id", "INTEGER");
  if (tableExists(con, "week_class")) addColumn(con, "week_class", "gvcn_group_id", "INTEGER");
  if (!tableExists(con, "nam_hoc")) return;
  const years = namId != null
    ? all(con, "SELECT id FROM nam_hoc WHERE id=?", [namId])
    : all(con, "SELECT id FROM nam_hoc");
  for (const nam of years) {
    for (const [ma, ten, nguong] of GVCN_GROUP_SEED) {
      run(con, `INSERT INTO gvcn_ratio_group(nam_hoc_id, ma, ten, nguong) VALUES (?,?,?,?)
        ON CONFLICT(nam_hoc_id, ma) DO NOTHING`, [nam.id, ma, ten, nguong]);
    }
  }
}

function migrateV9(con: Db) {
  ensureGvcnRatioGroups(con);
}

export function copyGvcnGroups(con: Db, fromNamId: number, toNamId: number) {
  ensureGvcnRatioGroups(con, toNamId);
  if (!tableExists(con, "gvcn_ratio_group")) return;
  for (const g of all(con, "SELECT ma, ten, nguong FROM gvcn_ratio_group WHERE nam_hoc_id=?", [fromNamId])) {
    run(con, `INSERT INTO gvcn_ratio_group(nam_hoc_id, ma, ten, nguong) VALUES (?,?,?,?)
      ON CONFLICT(nam_hoc_id, ma) DO UPDATE SET ten=excluded.ten, nguong=excluded.nguong`,
      [toNamId, g.ma, g.ten, g.nguong]);
  }
}

export function remapGvcnGroupId(con: Db, toNamId: number, oldGroupId: unknown): number | null {
  if (oldGroupId == null || oldGroupId === "") return null;
  const id = Number(oldGroupId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const src = get(con, "SELECT ma FROM gvcn_ratio_group WHERE id=?", [id]);
  if (!src) return null;
  const dst = get(con, "SELECT id FROM gvcn_ratio_group WHERE nam_hoc_id=? AND ma=?", [toNamId, src.ma]);
  return dst ? Number(dst.id) : null;
}

export const APP_SCHEMA_MAX = 12;

export function ensureClarificationCalendar(con: Db) {
  if (!tableExists(con, "nam_hoc") || !tableExists(con, "school_calendar")) return;
  for (const nam of all(con, "SELECT id FROM nam_hoc WHERE ten=?", ["2026-2027"])) {
    if (!get(con, "SELECT nam_id FROM school_calendar WHERE nam_id=?", [nam.id])) {
      run(con, `INSERT INTO school_calendar(nam_id,ngay_bd,ngay_kt,hk2_bd) VALUES (?,?,?,?)`,
        [nam.id, "2026-09-07", "2027-05-31", "2027-01-08"]);
    }
  }
}

function applyClarification2026(con: Db) {
  if (!tableExists(con, "nam_hoc") || !tableExists(con, "year_formula")) return;
  for (const nam of all(con, "SELECT id FROM nam_hoc WHERE ten=?", ["2026-2027"])) {
    run(con, `UPDATE year_formula SET ktm_divisor='si_so', hoi_hoc_double='hdtt', hk_basis='dots' WHERE nam_id=?`, [nam.id]);
  }
  ensureClarificationCalendar(con);
}

function migrateV11(con: Db) {
  ensureYearFormula(con);
  ensureMilestoneSchema(con);
  ensureDotMilestones(con);
  ensureGvcnRatioGroups(con);
  assignDefaultGvcnGroups(con);
  importRoster2026(con);
  applyClarification2026(con);
}

export function foldAlias(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const DEFAULT_LOI_ALIASES: [ma: string, alias: string][] = [
  ["trang_phuc", "dép sai quy định"],
  ["trang_phuc", "dép lê"],
  ["trang_phuc", "không sơ vin"],
  ["trang_phuc", "không sơ vin trước khi ra khỏi cổng trường"],
  ["trang_phuc", "không sơ vin trong giờ"],
  ["trang_phuc", "trang phục không đúng quy định"],
  ["trang_phuc", "trang phục không đúng"],
  ["di_muon", "đi muộn"],
  ["di_muon", "đi học muộn"],
  ["nghi_hoc", "nghỉ học không phép"],
  ["nghi_hoc", "nghỉ học không lý do"],
  ["nghi_hoc", "nghỉ học không phép tiết 1"],
  ["phu_hieu", "không phù hiệu"],
  ["phu_hieu", "không đeo phù hiệu"],
  ["phu_hieu_quen", "quen phù hiệu"],
  ["phu_hieu_quen", "mất phù hiệu"],
  ["phu_hieu_quen", "chưa có phù hiệu"],
  ["phu_hieu_gia", "phù hiệu giả"],
  ["ve_sinh_ban_muon", "chưa đổ rác"],
  ["ve_sinh_ban_muon", "không đổ rác"],
  ["ve_sinh_ban_muon", "đổ rác không đúng"],
  ["ve_sinh_noi_vu", "chưa trực nhật"],
  ["ve_sinh_noi_vu", "chưa mở cửa"],
  ["ve_sinh_noi_vu", "không khóa cửa"],
  ["tnkt_bo_nhiem_vu", "không làm nhiệm vụ"],
  ["tnkt_bo_nhiem_vu", "bỏ nhiệm vụ"],
  ["tnkt_muon", "làm nhiệm vụ muộn"],
  ["tnkt_muon", "tnkt làm nhiệm vụ muộn"],
  ["tnkt_muon", "tnkt làm nhiệm vụ muộn 15p"],
  ["giao_thong_sai_lan", "không xi nhan"],
  ["giao_thong_sai_lan", "sai làn"],
  ["giao_thong_sai_lan", "xe"],
  ["xe_dap_trong_san", "đi xe trong sân trường"],
  ["sh15_mat_trat_tu", "lớp mất trật tự"],
  ["sh15_mat_trat_tu", "mất trật tự giờ truy bài"],
  ["sdb_hoc_tap_ca_nhan", "không học bài"],
  ["sdb_hoc_tap_ca_nhan", "không chuẩn bị bài về nhà"],
  ["sdb_hoc_tap_ca_nhan", "không chuẩn bị bài"],
];

export function ensureAliasSchema(con: Db) {
  con.exec(`CREATE TABLE IF NOT EXISTS tieu_chi_alias (
    id INTEGER PRIMARY KEY,
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    tieu_chi_id INTEGER NOT NULL REFERENCES tieu_chi(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    alias_fold TEXT NOT NULL,
    UNIQUE(nam_hoc_id, alias_fold)
  )`);
}

export function seedDefaultAliases(con: Db, namId?: number) {
  ensureAliasSchema(con);
  if (!tableExists(con, "tieu_chi") || !tableExists(con, "nam_hoc")) return;
  const years = namId != null
    ? all(con, "SELECT id FROM nam_hoc WHERE id=?", [namId])
    : all(con, "SELECT id FROM nam_hoc");
  for (const nam of years) {
    const id = Number(nam.id);
    for (const row of all(con, "SELECT id, ma, ten FROM tieu_chi WHERE nam_hoc_id=? AND ap_dung=1", [id])) {
      const folded = foldAlias(String(row.ten));
      if (folded) {
        run(con, `INSERT OR IGNORE INTO tieu_chi_alias(nam_hoc_id,tieu_chi_id,alias,alias_fold) VALUES (?,?,?,?)`,
          [id, row.id, String(row.ten).trim(), folded]);
      }
    }
    for (const [ma, alias] of DEFAULT_LOI_ALIASES) {
      const folded = foldAlias(alias);
      if (!folded) continue;
      const tc = get(con, "SELECT id FROM tieu_chi WHERE nam_hoc_id=? AND ma=?", [id, ma]);
      if (!tc) continue;
      run(con, `INSERT OR IGNORE INTO tieu_chi_alias(nam_hoc_id,tieu_chi_id,alias,alias_fold) VALUES (?,?,?,?)`,
        [id, tc.id, alias, folded]);
    }
  }
}

export function copyAliases(con: Db, fromNamId: number, toNamId: number) {
  ensureAliasSchema(con);
  seedDefaultAliases(con, toNamId);
  for (const row of all(con, `SELECT a.alias, a.alias_fold, t.ma
    FROM tieu_chi_alias a JOIN tieu_chi t ON t.id=a.tieu_chi_id
    WHERE a.nam_hoc_id=?`, [fromNamId])) {
    const tc = get(con, "SELECT id FROM tieu_chi WHERE nam_hoc_id=? AND ma=?", [toNamId, row.ma]);
    if (!tc) continue;
    run(con, `INSERT OR IGNORE INTO tieu_chi_alias(nam_hoc_id,tieu_chi_id,alias,alias_fold) VALUES (?,?,?,?)`,
      [toNamId, tc.id, row.alias, row.alias_fold]);
  }
}

function migrateV12(con: Db) {
  ensureAliasSchema(con);
  seedDefaultAliases(con);
}

export function ensureAppMeta(con: Db) {
  con.exec(`CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  run(con, `INSERT INTO app_meta(key, value) VALUES ('schema_max', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(APP_SCHEMA_MAX)]);
}

function migrateV10(con: Db) {
  ensureAppMeta(con);
}

export function migrate(con: Db): void {
  const steps: [number, (con: Db) => void][] = [
    [5, migrateV5],
    [6, migrateV6],
    [7, migrateV7],
    [8, migrateV8],
    [9, migrateV9],
    [10, migrateV10],
    [11, migrateV11],
    [12, migrateV12],
  ];
  for (const [n, step] of steps) {
    if (userVersion(con) < n) {
      step(con);
      con.exec(`PRAGMA user_version=${n}`);
    }
  }
  ensureV5Columns(con);
  ensureYearFormula(con);
  ensureV7Columns(con);
  ensureCatalogScoreKeys(con);
  ensureMilestoneSchema(con);
  ensureHoiHocMilestones(con);
  ensureDotMilestones(con);
  ensureGvcnRatioGroups(con);
  ensureAliasSchema(con);
  seedDefaultAliases(con);
  ensureAppMeta(con);
}
