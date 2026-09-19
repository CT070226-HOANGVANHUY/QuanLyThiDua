import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { paperNumber, type Table as ReportTable } from "./workbook-export.ts";

function cell(value: unknown, bold = false, shade?: string) {
  return new TableCell({
    shading: shade ? { fill: shade } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: value == null ? "" : String(paperNumber(value)), bold, size: 18 })] })],
  });
}

export async function documentBuffer(tables: ReportTable[]) {
  const children: (Paragraph | Table)[] = [];
  for (const [tableIndex, table] of tables.entries()) {
    if (tableIndex) children.push(new Paragraph({ pageBreakBefore: true }));
    children.push(new Paragraph({ text: table.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
    for (const note of [table.source ?? "", ...(table.notes ?? [])].filter(Boolean)) {
      children.push(new Paragraph({ text: note, alignment: AlignmentType.LEFT }));
    }
    const rows = [
      new TableRow({ tableHeader: true, children: table.columns.map(([, label]) => cell(label, true, "D9EAF7")) }),
      ...table.rows.map((record) => new TableRow({ children: table.columns.map(([key]) => cell(Array.isArray(record[key]) ? "" : record[key])) })),
    ];
    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  }
  const document = new Document({
    creator: "Quản lý thi đua THPT Giao Thủy C",
    title: tables.map((table) => table.title).join("; "),
    sections: [{ properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } }, children }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}
