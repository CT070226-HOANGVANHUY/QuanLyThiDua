import { connect, getActiveNam, listTuan } from "../src/db.ts";

process.env.DESKTOP = "1";
process.env.PORT = process.env.PORT || "5055";

const { startServer } = await import("../src/server.ts");

const PORT = Number(process.env.PORT);
const { server, url } = await startServer(PORT);
const failures: string[] = [];

function fail(msg: string) {
  failures.push(msg);
  console.error("FAIL", msg);
}

async function grab(path: string, expect = 200) {
  const res = await fetch(`${url}${path}`, { redirect: "manual" });
  const text = await res.text();
  if (res.status !== expect) fail(`${path} → ${res.status} (want ${expect}) ${text.slice(0, 180)}`);
  if (res.status >= 500) fail(`${path} 5xx: ${text.slice(0, 300)}`);
  if (/Không thể lưu|Error:|SQLITE_/i.test(text) && res.status === 200) fail(`${path} body looks like an error: ${text.slice(0, 200)}`);
  return { res, text };
}

try {
  const con = connect();
  const nam = getActiveNam(con);
  const weeks = listTuan(con, Number(nam!.id));
  const published = weeks.find((w) => w.trang_thai === "cong_bo");
  const open = weeks.find((w) => w.trang_thai === "nhap");
  const chot = weeks.find((w) => w.trang_thai === "chot");
  if (!published || !open || !chot) fail("Missing mock weeks in live DB");

  const pages = [
    "/",
    "/huong-dan",
    "/bao-cao-tuan",
    "/cham-tuan",
    "/ket-qua-tuan",
    "/hoi-hoc",
    "/tong-hop",
    "/danh-gia",
    "/ne-nep-gvcn",
    "/khen",
    "/bao-cao",
    "/lop",
    "/tieu-chi",
    "/cong-thuc",
    "/nam-hoc",
    "/sao-luu",
  ];
  for (const path of pages) {
    const { text } = await grab(path);
    if (path === "/" && !text.includes("themeToggle")) fail("Home missing theme toggle");
    if (path === "/" && !text.includes("Còn phải nhập")) fail("Home missing remaining-class stat");
    if (path === "/" && !text.includes("week-flow")) fail("Home missing week steps");
  }

  const css = await grab("/static/css/app.css");
  if (!css.text.includes('html[data-theme="dark"]')) fail("CSS missing dark theme");
  const theme = await grab("/static/js/theme.js");
  if (!theme.text.includes("thidua-theme")) fail("theme.js missing storage key");
  await grab("/static/js/forms.js");

  const openQ = `nam=2026&thang=9&week_start=${open!.ngay_bd}&tuan_id=${open!.id}`;
  const report = await grab(`/bao-cao-tuan?${openQ}`);
  const jsonMatch = report.text.match(/id="click-entry-data">([\s\S]*?)<\/script>/);
  if (!jsonMatch) fail("Nhập tuần missing click-entry-data");
  else {
    const raw = jsonMatch[1].trim();
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data.days) || data.days.length !== 7) fail(`click-entry days=${data.days?.length}`);
    } catch (error) {
      fail(`click-entry JSON: ${error} :: ${raw.slice(0, 120)}`);
    }
  }
  if (!report.text.includes("data-composer") || !report.text.includes("stepper")) fail("Nhập tuần missing click UI");
  if (!report.text.includes("week-flow") || !report.text.includes("entry-block")) fail("Nhập tuần missing step UI");

  const locked = await grab(`/bao-cao-tuan?nam=2026&thang=9&week_start=${published!.ngay_bd}&tuan_id=${published!.id}`);
  if (!locked.text.includes("disabled") && !locked.text.includes("Tuần đã khóa")) fail("Published week form not locked");

  const rank = await grab(`/ket-qua-tuan?nam=2026&thang=9&week_start=${published!.ngay_bd}&tuan_id=${published!.id}`);
  if (!rank.text.includes("Đã công bố") && !rank.text.includes("Hạng tuần")) fail("Ranking page missing published ranks");

  const chotPage = await grab(`/ket-qua-tuan?nam=2026&thang=9&week_start=${chot!.ngay_bd}&tuan_id=${chot!.id}`);
  if (!chotPage.text.includes("Công bố")) fail("Chốt week missing Công bố button");

  await grab(`/xuat/loi-hs?tuan_id=${published!.id}`);
  await grab(`/xuat/ban-in?tuan_id=${published!.id}`);
  await grab(`/xuat/bao-cao?scope=tuan&key=${published!.id}&model=monthly&view=official&format=xlsx`);
  const banPreview = await grab(`/xuat/ban-in?tuan_id=${published!.id}&format=print`);
  if (!banPreview.text.includes("Tải Excel") || !banPreview.text.includes("xem trước")) fail("Ban in preview missing download/preview chrome");
  const vpPreview = await grab(`/xuat/loi-hs?tuan_id=${published!.id}&format=print`);
  if (!vpPreview.text.includes("Tải Excel") || !vpPreview.text.includes("xem trước")) fail("Violation preview missing download/preview chrome");
  const reportPreview = await grab(`/xuat/bao-cao?scope=tuan&key=${published!.id}&model=monthly&view=official&format=print`);
  if (!reportPreview.text.includes("Tải Excel") || !reportPreview.text.includes("Tải Word")) fail("Report preview missing Excel/Word links");
  await grab("/tong-hop?mode=thang&key=2026-09&model=monthly&view=preview");
  await grab("/ne-nep-gvcn?hk=1&view=preview");
  await grab("/danh-gia?kind=thi&period=1");
  await grab("/no-such-page", 404);

  const bogus = await fetch(`${url}/chot-tuan`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `nam_id=${nam!.id}&tuan_id=${open!.id}&revision=0&trang_thai=chot`,
  });
  const bogusText = await bogus.text();
  if (bogus.status === 200 && /Đã cập nhật trạng thái tuần/.test(bogusText)) fail("Open week was chốt by incomplete POST");
} finally {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

if (failures.length) {
  console.error(`\n${failures.length} HTTP smoke failure(s)`);
  process.exit(1);
}
console.log(`HTTP smoke OK at ${url}`);
