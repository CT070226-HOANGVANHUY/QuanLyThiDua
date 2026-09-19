import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, getActiveNam, initDb } from "../src/db.ts";
import { initPlan } from "../src/plan.ts";
import { importPhanAnhFile } from "../src/phan-anh-import.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] || path.join(ROOT, "THEO DOI PHAN ANH_T9 (1).xlsx");
const con = connect();
initDb(con);
initPlan(con);
const nam = getActiveNam(con);
if (!nam) throw new Error("Chưa có năm học");
const result = await importPhanAnhFile(con, Number(nam.id), file);
console.log(JSON.stringify(result, null, 2));
