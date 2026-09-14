import ExcelJS from "exceljs";
import type { Dict } from "./db.ts";

export type Table = {
  title: string;
  source?: string;
  columns: [string, string][];
  rows: Dict[];
  notes?: string[];
};

export async function workbookBuffer(tables: Table[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Quản lý thi đua THPT Giao Thủy C";
  wb.subject = "Báo cáo thi đua";
  const used = new Set<string>();
  for (const table of tables) {
    let name = table.title.replace(/[\\/*?:\[\]]/g, "-").slice(0, 31) || "Bang";
    let suffix = 2;
    while (used.has(name)) {
      const tag = `-${suffix++}`;
      name = `${name.slice(0, Math.max(1, 31 - tag.length))}${tag}`;
    }
    used.add(name);
    const ws = wb.addWorksheet(name);
    const cols = table.columns;
    const width = Math.max(1, cols.length);
    ws.mergeCells(1, 1, 1, width);
    ws.getCell(1, 1).value = table.title;
    ws.getCell(1, 1).font = { size: 15, bold: true, color: { argb: "FF17365D" } };
    const notes = [table.source ?? "", ...(table.notes ?? [])].filter(Boolean);
    notes.forEach((note, i) => {
      const row = i + 2;
      ws.mergeCells(row, 1, row, width);
      ws.getCell(row, 1).value = note;
      ws.getCell(row, 1).alignment = { wrapText: true, vertical: "top" };
    });
    const headerRow = notes.length + 2;
    cols.forEach(([_, label], i) => {
      const cell = ws.getCell(headerRow, i + 1);
      cell.value = label;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17365D" } };
      cell.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
      ws.getColumn(i + 1).width = Math.min(35, Math.max(13, label.length + 2));
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
    table.rows.forEach((record, r) => {
      const rowIdx = headerRow + 1 + r;
      cols.forEach(([key], c) => {
        const cell = ws.getCell(rowIdx, c + 1);
        const v = record[key];
        if (typeof v === "string" && /^[=+\-@]/.test(v)) {
          cell.value = v;
          cell.numFmt = "@";
        } else {
          cell.value = v == null || Array.isArray(v) || typeof v === "object" ? null : (v as string | number | boolean);
        }
        cell.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
        if ((r + 1) % 2 === 0) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF3F8" } };
        cell.alignment = { vertical: "top", wrapText: true };
        if (typeof v === "number" && !Number.isInteger(v)) cell.numFmt = "0.0000";
      });
    });
    const last = headerRow + Math.max(1, table.rows.length);
    ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: width } };
    ws.views = [{ state: "frozen", xSplit: Math.min(2, width), ySplit: headerRow }];
    ws.pageSetup = {
      orientation: width > 10 ? "landscape" : "portrait",
      fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9,
      printArea: `A1:${ws.getColumn(width).letter}${last}`,
      printTitlesRow: `${headerRow}:${headerRow}`,
    };
    ws.headerFooter.oddFooter = "Trang &P / &N";
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
