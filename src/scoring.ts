export type Col3 = [string, string, string];
export type ColW = [string, string, number];
export type KtmDivisor = "count" | "si_so";

export const NN_COLS: Col3[] = [
  ["trang_tri", "Trang trí", "−5 điểm / 1 lỗi"],
  ["xep_hang", "Xếp hàng", "−1/HS; tập thể −10"],
  ["hat", "Hát đầu giờ", "−1/HS; tập thể −10"],
  ["sh15", "SH 15 phút", "ra ngoài −1/HS; mất TT −10; không KT −5"],
  ["td_cc", "TD / chào cờ", "−1/HS; tập thể −10"],
  ["di_muon", "Đi muộn", "−5/HS"],
  ["phu_hieu", "Phù hiệu", "không đeo −1; quên −2; giả −30"],
  ["trang_phuc", "Trang phục", "−1/HS"],
  ["xe_dap", "Xe (sân / để xe / VS)", "sân −10; để sai −1; VS −5/lớp"],
  ["giao_thong", "Giao thông", "không mũ −30; đội sai −10; làn −5"],
  ["nghi_hoc", "Nghỉ / bỏ giờ", "−10/HS"],
  ["tnkt", "Thanh niên KT", "muộn −5; bỏ / không nộp sổ −10"],
  ["ve_sinh", "Vệ sinh nội vụ", "không VS −10/lỗi; bẩn/muộn −5"],
  ["sdb_y_thuc", "Ghi SĐB ý thức", "cá nhân −1; tập thể −10"],
  ["sdb_hoc_tap", "Ghi SĐB học tập", "cá nhân −1; tập thể −10"],
  ["bao_cao_bi_thu", "Báo cáo bí thư", "không nộp/sai cao −20; sai thấp −10"],
  ["hs_ky_luat", "HS kỷ luật", "theo mức −30 / −50"],
  ["vp_khac", "Vi phạm khác", "bánh kẹo / ra khỏi trường −10"],
];

export const HT_GIO_COLS: ColW[] = [
  ["gio_tot", "Giờ tốt", 2],
  ["gio_kha", "Giờ khá", 1],
  ["gio_tb", "Giờ TB", 0],
  ["gio_yeu", "Giờ yếu", -1],
  ["gio_kem", "Giờ kém", -2],
];

export const HT_KTM_COLS: ColW[] = [
  ["ktm_9_10", "Điểm 9–10", 2],
  ["ktm_7_8", "Điểm 7–8", 1],
  ["ktm_3_4", "Điểm 3–4", -1],
  ["ktm_0_2", "Điểm 0–2", -2],
];

export const NN_KEYS = NN_COLS.map((c) => c[0]);
export const GIO_KEYS = HT_GIO_COLS.map((c) => c[0]);
export const KTM_SCORE_KEYS = HT_KTM_COLS.map((c) => c[0]);

export const SCORE_FIELDS = [...NN_KEYS, ...GIO_KEYS, "ktm_ge5", "ktm_lt5", ...KTM_SCORE_KEYS, "ghi_chu"];

export type Row = Record<string, unknown>;

export function num(row: Row, key: string): number {
  const v = row[key];
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function tongTru(row: Row): number {
  return NN_KEYS.reduce((sum, key) => sum + Math.max(0, -num(row, key)), 0);
}
export function diemNn(row: Row): number {
  return NN_KEYS.reduce((sum, key) => sum + num(row, key), 0) + num(row, "cong_ne_nep");
}
export function tbNn(row: Row, siSo: number): number {
  const n = Number(siSo || 0);
  return n > 0 ? diemNn(row) / n : 0;
}
export function soGio(row: Row): number {
  return GIO_KEYS.reduce((s, k) => s + num(row, k), 0);
}
export function diemGio(row: Row): number {
  return HT_GIO_COLS.reduce((s, [k, , w]) => s + num(row, k) * w, 0);
}
export function tbGio(row: Row): number {
  const n = soGio(row);
  return n > 0 ? diemGio(row) / n : 0;
}
export function diemKtm(row: Row): number {
  return HT_KTM_COLS.reduce((s, [k, , w]) => s + num(row, k) * w, 0);
}
export function ktmCount(row: Row): number {
  return num(row, "ktm_9_10") + num(row, "ktm_7_8") + num(row, "ktm_5_6") + num(row, "ktm_3_4") + num(row, "ktm_0_2");
}
export function tbKtm(row: Row, divisor: KtmDivisor = "count", siSo = 0): number {
  const n = divisor === "si_so" ? Number(siSo || 0) : ktmCount(row);
  return n > 0 ? diemKtm(row) / n : 0;
}
export function tbHocTap(row: Row, divisor: KtmDivisor = "count", siSo = 0): number {
  return tbGio(row) + tbKtm(row, divisor, siSo);
}
export function tongCong(row: Row): number {
  return diemGio(row) + diemKtm(row);
}
export function tongNet(row: Row): number {
  return diemNn(row) + tongCong(row);
}

export function competitionRanks(scores: number[], higherBetter: boolean): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => (higherBetter ? scores[b] - scores[a] : scores[a] - scores[b]));
  const ranks = Array(scores.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && scores[order[j]] === scores[order[i]]) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) ranks[order[k]] = rank;
    i = j;
  }
  return ranks;
}

export type ClassResult = {
  lop_id: number;
  ten: string;
  nhom: number;
  si_so: number;
  row: Row;
  diem_nn: number;
  tb_nn: number;
  diem_gio: number;
  so_gio: number;
  tb_gio: number;
  diem_ktm: number;
  tb_ktm: number;
  tb_ht: number;
  tong_tru: number;
  tong_cong: number;
  tong_net: number;
  xt_nn: number;
  xt_ht: number;
  tong_xt: number;
  xt_chung: number;
  tb_ktm_divisor?: KtmDivisor;
};

export function scoreGroup(items: ClassResult[], ktmDivisor: KtmDivisor = "count"): ClassResult[] {
  for (const it of items) {
    const r = it.row;
    it.diem_nn = diemNn(r);
    it.tb_nn = tbNn(r, it.si_so);
    it.diem_gio = diemGio(r);
    it.so_gio = soGio(r);
    it.tb_gio = tbGio(r);
    it.diem_ktm = diemKtm(r);
    it.tb_ktm = tbKtm(r, ktmDivisor, it.si_so);
    it.tb_ht = tbHocTap(r, ktmDivisor, it.si_so);
    it.tb_ktm_divisor = ktmDivisor;
    it.tong_tru = tongTru(r);
    it.tong_cong = tongCong(r);
    it.tong_net = tongNet(r);
  }
  const nn = competitionRanks(items.map((i) => i.tb_nn), true);
  const ht = competitionRanks(items.map((i) => i.tb_ht), true);
  items.forEach((it, i) => {
    it.xt_nn = nn[i];
    it.xt_ht = ht[i];
    it.tong_xt = nn[i] + ht[i];
  });
  const chung = competitionRanks(items.map((i) => i.tong_xt), false);
  items.forEach((it, i) => {
    it.xt_chung = chung[i];
  });
  return items;
}

export function scoreAll(items: ClassResult[], ktmDivisor: KtmDivisor = "count"): ClassResult[] {
  const by = new Map<number, ClassResult[]>();
  for (const it of items) {
    const g = by.get(it.nhom) ?? [];
    g.push(it);
    by.set(it.nhom, g);
  }
  const out: ClassResult[] = [];
  for (const g of [...by.keys()].sort((a, b) => a - b)) out.push(...scoreGroup(by.get(g)!, ktmDivisor));
  return out;
}
