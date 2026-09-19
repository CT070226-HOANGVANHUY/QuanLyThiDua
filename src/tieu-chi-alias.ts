import { all, get, requireActiveYear, requireOwned, run, transaction, WorkflowError, type Db, type Dict } from "./db.ts";
import { DEFAULT_LOI_ALIASES, copyAliases, ensureAliasSchema, foldAlias, seedDefaultAliases } from "./migrate.ts";

export { DEFAULT_LOI_ALIASES, copyAliases, ensureAliasSchema, foldAlias, seedDefaultAliases };

export function listAliases(con: Db, namId: number, tieuChiId?: number) {
  ensureAliasSchema(con);
  if (tieuChiId) {
    return all(con, `SELECT a.*, t.ma, t.ten AS tieu_chi_ten, t.diem
      FROM tieu_chi_alias a JOIN tieu_chi t ON t.id=a.tieu_chi_id
      WHERE a.nam_hoc_id=? AND a.tieu_chi_id=? ORDER BY a.alias`, [namId, tieuChiId]);
  }
  return all(con, `SELECT a.*, t.ma, t.ten AS tieu_chi_ten, t.diem
    FROM tieu_chi_alias a JOIN tieu_chi t ON t.id=a.tieu_chi_id
    WHERE a.nam_hoc_id=? ORDER BY t.ma, a.alias`, [namId]);
}

export function saveAlias(con: Db, namId: number, tieuChiId: number, alias: string) {
  return transaction(con, () => {
    requireActiveYear(con, namId);
    requireOwned(con, "tieu_chi", tieuChiId, namId);
    const text = alias.trim();
    const folded = foldAlias(text);
    if (!folded) throw new WorkflowError(400, "Bí danh lỗi không được trống.");
    const clash = get(con, "SELECT tieu_chi_id FROM tieu_chi_alias WHERE nam_hoc_id=? AND alias_fold=?", [namId, folded]);
    if (clash && Number(clash.tieu_chi_id) !== tieuChiId) {
      throw new WorkflowError(400, "Bí danh này đã gán cho tiêu chí khác.");
    }
    run(con, `INSERT INTO tieu_chi_alias(nam_hoc_id,tieu_chi_id,alias,alias_fold) VALUES (?,?,?,?)
      ON CONFLICT(nam_hoc_id, alias_fold) DO UPDATE SET tieu_chi_id=excluded.tieu_chi_id, alias=excluded.alias`,
      [namId, tieuChiId, text, folded]);
  });
}

export function deleteAlias(con: Db, namId: number, id: number) {
  transaction(con, () => {
    requireActiveYear(con, namId);
    const row = get(con, "SELECT id FROM tieu_chi_alias WHERE id=? AND nam_hoc_id=?", [id, namId]);
    if (!row) throw new WorkflowError(404, "Không tìm thấy bí danh.");
    run(con, "DELETE FROM tieu_chi_alias WHERE id=?", [id]);
  });
}

export type MatchedLoi = {
  tieu_chi_id: number;
  ma: string;
  ten: string;
  diem: number;
  tapThe: boolean;
};

export function matchLoi(con: Db, namId: number, loi: string, hoTen = ""): MatchedLoi | undefined {
  ensureAliasSchema(con);
  const folded = foldAlias(loi);
  if (!folded) return undefined;
  const named = hoTen.trim().length > 0;
  const exact = get(con, `SELECT a.tieu_chi_id, t.ma, t.ten, t.diem
    FROM tieu_chi_alias a JOIN tieu_chi t ON t.id=a.tieu_chi_id
    WHERE a.nam_hoc_id=? AND a.alias_fold=? AND t.ap_dung=1`, [namId, folded]);
  const hit = exact ?? longestContains(con, namId, folded);
  if (!hit) return undefined;
  return {
    tieu_chi_id: Number(hit.tieu_chi_id),
    ma: String(hit.ma),
    ten: String(hit.ten),
    diem: Number(hit.diem),
    tapThe: !named,
  };
}

function longestContains(con: Db, namId: number, folded: string): Dict | undefined {
  const rows = all(con, `SELECT a.alias_fold, a.tieu_chi_id, t.ma, t.ten, t.diem
    FROM tieu_chi_alias a JOIN tieu_chi t ON t.id=a.tieu_chi_id
    WHERE a.nam_hoc_id=? AND t.ap_dung=1`, [namId]);
  let best: Dict | undefined;
  let bestLen = 0;
  for (const row of rows) {
    const alias = String(row.alias_fold);
    if (!alias) continue;
    if (folded === alias || folded.includes(alias) || alias.includes(folded)) {
      if (alias.length > bestLen) {
        best = row;
        bestLen = alias.length;
      }
    }
  }
  return best;
}
