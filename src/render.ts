import fs from "node:fs";
import path from "node:path";
import nunjucks from "nunjucks";
import type { Request, Response } from "express";

const ROUTES: Record<string, string> = {
  home: "/",
  doi_nam: "/doi-nam",
  nam_moi: "/nam-moi",
  lop: "/lop",
  luu_lop: "/lop/luu",
  xoa_lop: "/lop/:lop_id/xoa",
  ap_dung_lop: "/lop/:lop_id/ap-dung",
  xoa_tuan_mau: "/tuan/xoa-mau",
  nhap: "/nhap",
  bao_cao_tuan: "/bao-cao-tuan",
  cham_tuan: "/cham-tuan",
  chot_tuan: "/chot-tuan",
  khen: "/khen",
  hoi_hoc: "/hoi-hoc",
  tieu_chi: "/tieu-chi",
  luu_tieu_chi: "/tieu-chi/luu",
  xoa_tieu_chi: "/tieu-chi/:id/xoa",
  diem_co_so: "/tieu-chi/diem-co-so",
  xep: "/ket-qua-tuan",
  xuat_tuan: "/xuat/tuan/:tuan_id",
  xuat_tuan_form: "/xuat/tuan",
  xuat_loi_hs: "/xuat/loi-hs",
  xuat_ban_in: "/xuat/ban-in",
  baocao: "/bao-cao",
  quyche: "/quy-che",
  "periods.index": "/tong-hop",
  "conduct.index": "/ne-nep-gvcn",
  "assessments.index": "/danh-gia",
  "assessments.export": "/danh-gia/export",
  "conduct.export": "/ne-nep-gvcn/xuat",
  nam_hoc: "/nam-hoc",
  nap_roster: "/nam-hoc/nap-roster",
  sao_luu: "/sao-luu",
  formulas: "/cong-thuc",
  huong_dan: "/huong-dan",
  class_report_word: "/bao-cao/lop/word",
  class_report_print: "/bao-cao/lop/in",
  "periods.export": "/tong-hop/xuat",
  xuat_hk: "/tong-hop/xuat",
  luu_diem: "/bao-cao-tuan",
  them_loi: "/bao-cao-tuan",
  xoa_loi: "/bao-cao-tuan",
  luu_quyche: "/quy-che/luu",
  xoa_quyche: "/quy-che/:id/xoa",
  static: "/static/:filename",
};

export function urlFor(name: string, kwargs: Record<string, unknown> = {}) {
  let pathName = ROUTES[name] ?? (name.includes(".") ? "" : `/${name.replaceAll("_", "-")}`);
  if (!pathName) throw new Error(`Unknown route ${name}`);
  const query: string[] = [];
  for (const [k, v] of Object.entries(kwargs)) {
    if (v == null) continue;
    const token = `:${k}`;
    if (pathName.includes(token)) pathName = pathName.replace(token, encodeURIComponent(String(v)));
    else if (name === "static" && k === "filename") pathName = `/static/${v}`;
    else query.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  pathName = pathName.replace(/:filename/, String(kwargs.filename ?? ""));
  return query.length ? `${pathName}?${query.join("&")}` : pathName;
}

function convertFlask(src: string) {
  let out = src.replace(/\.items\(\)/g, "");
  out = out.replace(/\{% with messages = get_flashed_messages\(\) %\}/g, "{% set messages = get_flashed_messages() %}");
  out = out.replace(/\{% endwith %\}/g, "");
  out = out.replace(/(\w+)\.get\(([^,]+),\s*([^)]+)\)/g, "($1[$2] if $1[$2] is defined else $3)");
  out = out.replace(/url_for\(\s*(['"][^'"]+['"])\s*(?:,\s*([^)]+))?\)/g, (_m, name: string, args?: string) => {
    if (!args) return `url_for(${name})`;
    const parts: string[] = [];
    let buf = "";
    let depth = 0;
    for (const ch of args) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    const obj = parts
      .map((p) => {
        const i = p.indexOf("=");
        return `${p.slice(0, i).trim()}: ${p.slice(i + 1).trim()}`;
      })
      .join(", ");
    return `url_for(${name}, {${obj}})`;
  });
  return out;
}

class FlaskLoader extends nunjucks.Loader {
  dir: string;
  constructor(dir: string) {
    super();
    this.dir = dir;
  }
  getSource(name: string) {
    const filePath = path.join(this.dir, name);
    if (!fs.existsSync(filePath)) return null;
    return {
      src: convertFlask(fs.readFileSync(filePath, "utf8")),
      path: filePath,
      noCache: true,
    };
  }
}

export function createEnv(views: string) {
  const env = new nunjucks.Environment(new FlaskLoader(views), { autoescape: true });
  env.addGlobal("url_for", urlFor);
  env.addFilter("tojson", (v: unknown) => new nunjucks.runtime.SafeString(JSON.stringify(v)));
  env.addFilter("int", (v: unknown) => Math.trunc(Number(v || 0)));
  env.addGlobal("number", (v: unknown) => Number(v ?? 0));
  env.addFilter("format", (fmt: string, v: unknown) => {
    const n = Number(v);
    const m = /%\.(\d+)f/.exec(fmt);
    if (m) return n.toFixed(Number(m[1]));
    if (fmt.includes("d")) return String(Math.trunc(n));
    return String(v ?? "");
  });
  env.addFilter("replace", (s: unknown, a: string, b: string) => String(s).replaceAll(a, b));
  env.addFilter("paper", (v: unknown) => {
    if (v == null || v === "") return v ?? "";
    if (typeof v !== "number" || !Number.isFinite(v)) return v;
    if (Number.isInteger(v)) return v;
    return Number(v.toFixed(3));
  });
  env.addTest("none", (v: unknown) => v === null || v === undefined);
  env.addTest("float", (v: unknown) => typeof v === "number" && !Number.isInteger(v));
  env.addTest("number", (v: unknown) => typeof v === "number");
  return env;
}

export function view(env: nunjucks.Environment, req: Request, res: Response, name: string, ctx: Record<string, unknown>) {
  const tagged = req as Request & { flashMsg?: string[]; flashKind?: string };
  const flashes: string[] = tagged.flashMsg ?? [];
  env.addGlobal("get_flashed_messages", () => flashes);
  env.addGlobal("flash_kind", tagged.flashKind === "error" ? "error" : "ok");
  res.send(env.render(name, ctx));
}
