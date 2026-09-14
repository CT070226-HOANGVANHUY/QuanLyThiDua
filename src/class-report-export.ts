import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import type { ClassReportDocument, ClassReportLine } from "./report-data.ts";

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

function run(text: string, opts: { bold?: boolean; size?: number; italics?: boolean } = {}) {
  return new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size ?? 26, font: "Times New Roman" });
}

function p(text: string, opts: { bold?: boolean; center?: boolean; keepNext?: boolean; size?: number } = {}) {
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    keepNext: opts.keepNext,
    spacing: { after: 80, line: 276 },
    children: [run(text, { bold: opts.bold, size: opts.size })],
  });
}

function cell(text: string, opts: { bold?: boolean; width?: number; span?: number } = {}) {
  return new TableCell({
    borders: BORDERS,
    columnSpan: opts.span,
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ spacing: { after: 40, line: 240 }, children: [run(text, { bold: opts.bold, size: 22 })] })],
  });
}

function table(headers: string[], rows: string[][], widths: number[]) {
  const head = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: headers.map((label, i) => cell(label, { bold: true, width: widths[i] })),
  });
  const body = rows.length
    ? rows.map((row) => new TableRow({ cantSplit: true, children: row.map((value, i) => cell(value, { width: widths[i] })) }))
    : [new TableRow({ cantSplit: true, children: [cell("", { span: headers.length })] })];
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows: [head, ...body],
  });
}

function people(title: string, rows: ClassReportLine[], extra: "count" | "attitude") {
  const headers = extra === "attitude"
    ? ["Họ tên", "Tiết / môn", "Nội dung", "Ngày", "Ghi chú"]
    : ["Họ tên", "Ngày", "Số lượng", "Ghi chú"];
  const widths = extra === "attitude" ? [2200, 1600, 2600, 1600, 2200] : [2800, 1800, 1400, 4200];
  const data = rows.map((row) => extra === "attitude"
    ? [row.ho_ten, row.tiet_mon, row.noi_dung, row.ngay, row.ghi_chu]
    : [row.ho_ten, row.ngay, String(row.so_luong || ""), row.ghi_chu]);
  return [p(title, { bold: true, keepNext: true }), table(headers, data, widths)];
}

export async function classReportDocx(doc: ClassReportDocument) {
  const children = [
    new Table({
      width: { size: 10200, type: WidthType.DXA },
      columnWidths: [5100, 5100],
      rows: [new TableRow({
        children: [
          new TableCell({
            borders: { top: undefined, bottom: undefined, left: undefined, right: undefined },
            children: [p(doc.org.xa, { bold: true, center: true, size: 24 }), p(doc.org.truong, { bold: true, center: true, size: 24 })],
          }),
          new TableCell({
            borders: { top: undefined, bottom: undefined, left: undefined, right: undefined },
            children: [p(doc.org.doan, { bold: true, center: true, size: 24 }), p("****", { center: true, size: 22 })],
          }),
        ],
      })],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 },
      children: [run("BÁO CÁO THI ĐUA TUẦN", { bold: true, size: 32 })],
    }),
    p(`Lớp: ${doc.lop}     Năm học: ${doc.nam_hoc}`),
    p(`Tuần ${doc.calendar_no || "…"}     Từ ${doc.ngay_bd || "…"} đến ${doc.ngay_kt || "…"}`),
    p(`Trạng thái: ${doc.status}${doc.revision ? ` · lần lưu ${doc.revision}` : ""}`),
  ];
  if (doc.notice) children.push(p(doc.notice, { bold: true, center: true }));
  children.push(p("1. Nề nếp", { bold: true, size: 28 }));
  children.push(...people("1.1. Nghỉ không lý do", doc.absences, "count"));
  children.push(...people("1.2. Đi học muộn / trang phục / phù hiệu", [...doc.late, ...doc.uniform, ...doc.badge], "count"));
  children.push(...people("1.3. Vi phạm khác", doc.other, "count"));
  children.push(p("2. Học tập", { bold: true, size: 28 }));
  children.push(...people("2.1. Thái độ / ý thức giờ học", doc.attitude, "attitude"));
  children.push(p("2.2. Giờ học", { bold: true, keepNext: true }));
  children.push(table(
    ["Tổng giờ", "Tốt", "Khá", "Trung bình", "Yếu", "Kém"],
    [[String(doc.gio.tong), String(doc.gio.tot), String(doc.gio.kha), String(doc.gio.tb), String(doc.gio.yeu), String(doc.gio.kem)]],
    [1700, 1700, 1700, 1700, 1700, 1700],
  ));
  if (doc.gio.ghi_chu) children.push(p(`Ghi chú giờ: ${doc.gio.ghi_chu}`));
  children.push(p("2.3. Điểm kiểm tra miệng", { bold: true, keepNext: true }));
  children.push(table(
    ["9–10", "7–8", "5–6", "3–4", "0–2", "Trên TB", "Dưới TB"],
    [[String(doc.ktm.n910), String(doc.ktm.n78), String(doc.ktm.n56), String(doc.ktm.n34), String(doc.ktm.n02), String(doc.ktm.ge5), String(doc.ktm.lt5)]],
    [1450, 1450, 1450, 1450, 1450, 1475, 1475],
  ));
  if (doc.ktm.ghi_chu) children.push(p(`Ghi chú miệng: ${doc.ktm.ghi_chu}`));
  children.push(new Paragraph({ spacing: { before: 400 }, keepNext: true, children: [run(`${doc.org.dia_danh}, ngày ${doc.ngay_lap || "……"} tháng …… năm ……`, { italics: true })] }));
  children.push(new Paragraph({ keepNext: true, alignment: AlignmentType.RIGHT, children: [run("BÍ THƯ CHI ĐOÀN", { bold: true })] }));
  children.push(new Paragraph({ spacing: { before: 600 }, alignment: AlignmentType.RIGHT, children: [run(doc.bi_thu || "(Ký, ghi rõ họ tên)")] }));
  const document = new Document({
    creator: "Quản lý thi đua THPT Giao Thủy C",
    title: `Báo cáo chi đoàn ${doc.lop}`,
    styles: { default: { document: { run: { font: "Times New Roman", size: 26 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1134, right: 1134, bottom: 1134, left: 1418 },
        },
      },
      children,
    }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}
