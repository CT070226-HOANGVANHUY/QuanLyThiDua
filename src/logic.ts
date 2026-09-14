import type { Dict } from "./db.ts";


export function tuanLabel(t: Dict | undefined) {
  if (!t) return "Chưa có tuần";
  return `Tuần ${t.so_tuan} — Tháng ${t.thang}/${t.nam} (HK${t.hoc_ky})`;
}
