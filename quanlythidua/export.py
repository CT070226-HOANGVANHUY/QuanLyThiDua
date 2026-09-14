"""Xuất Excel bảng tuần / tổng hợp."""

from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .scoring import ClassResult, NN_COLS, HT_GIO_COLS

THIN = Border(
    left=Side(style="thin", color="7A8A99"),
    right=Side(style="thin", color="7A8A99"),
    top=Side(style="thin", color="7A8A99"),
    bottom=Side(style="thin", color="7A8A99"),
)
NAVY = PatternFill("solid", fgColor="1E3A5F")
NAVY2 = PatternFill("solid", fgColor="2E5984")
GOLD = PatternFill("solid", fgColor="F4E4B3")
RED = PatternFill("solid", fgColor="F8D0D0")
ZEBRA = PatternFill("solid", fgColor="F4F7FA")
WHITE = PatternFill("solid", fgColor="FFFFFF")
HEAD_FONT = Font(name="Calibri", bold=True, color="FFFFFF", size=10)
TITLE_FONT = Font(name="Calibri", bold=True, size=14, color="1E3A5F")
SUB_FONT = Font(name="Calibri", bold=True, size=11, color="1E3A5F")
CELL_FONT = Font(name="Calibri", size=10)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)


def _hdr(ws, row, col, value, fill=NAVY):
    cell = ws.cell(row, col, value)
    cell.fill = fill
    cell.font = HEAD_FONT
    cell.alignment = CENTER
    cell.border = THIN
    return cell


def _cell(ws, row, col, value, fill=None, bold=False, num=None):
    cell = ws.cell(row, col, value)
    cell.font = Font(name="Calibri", size=10, bold=bold)
    cell.alignment = CENTER
    cell.border = THIN
    if fill is not None:
        cell.fill = fill
    if num:
        cell.number_format = num
    return cell


def _row_fill(it: ClassResult, zebra: bool) -> PatternFill:
    if it.diem_nn < 0:
        return RED
    if it.xt_chung == 1:
        return GOLD
    return ZEBRA if zebra else WHITE


def export_tuan(
    path: Path,
    nam_hoc: str,
    tuan_label: str,
    results: list[ClassResult],
    month_rows=None,
    lois=None,
) -> Path:
    wb = Workbook()
    _sheet_xep_thu(wb.active, nam_hoc, tuan_label, results)
    _sheet_ban_nhap(wb.create_sheet("Ban nhap"), nam_hoc, tuan_label, results)
    _sheet_chi_tiet_nn(wb.create_sheet("Ne nep chi tiet"), nam_hoc, tuan_label, results)
    _sheet_loi(wb.create_sheet("Loi vi pham"), nam_hoc, tuan_label, lois or [])
    if month_rows:
        _sheet_month(wb.create_sheet("Tong hop"), nam_hoc, month_rows)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path



def _sheet_xep_thu(ws, nam_hoc, tuan_label, results):
    ws.title = "Xep thu"
    ws.merge_cells("A1:L1")
    ws["A1"] = "ĐOÀN TRƯỜNG THPT GIAO THỦY C"
    ws["A1"].font = TITLE_FONT
    ws.merge_cells("A2:L2")
    ws["A2"] = f"BẢNG TỔNG HỢP THI ĐUA CÁC CHI ĐOÀN — Năm học {nam_hoc}"
    ws["A2"].font = SUB_FONT
    ws.merge_cells("A3:L3")
    ws["A3"] = tuan_label
    ws["A3"].font = SUB_FONT

    headers = [
        "Nhóm",
        "Lớp",
        "Sĩ số",
        "Tổng trừ",
        "Tổng cộng",
        "Tổng net",
        "TB NN",
        "XT nề nếp",
        "TB học tập",
        "XT học tập",
        "Tổng XT",
        "XT tuần",
    ]
    for c, h in enumerate(headers, 1):
        _hdr(ws, 5, c, h)
    ws.row_dimensions[5].height = 28

    r = 6
    for i, it in enumerate(results):
        fill = _row_fill(it, i % 2 == 0)
        vals = [
            it.nhom,
            it.ten,
            it.si_so,
            it.tong_tru,
            it.tong_cong,
            it.tong_net,
            round(it.tb_nn, 4),
            it.xt_nn,
            round(it.tb_ht, 4),
            it.xt_ht,
            it.tong_xt,
            it.xt_chung,
        ]
        for c, v in enumerate(vals, 1):
            num = "0.00" if c in (4, 5, 6) else ("0.0000" if c in (7, 9) else None)
            _cell(ws, r, c, v, fill=fill, bold=(c == 12), num=num)
        r += 1

    r += 1
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=12)
    ws.cell(
        r,
        1,
        "Tổng trừ = điểm nề nếp. Tổng cộng = điểm giờ + miệng. Tổng net = cộng − trừ. "
        "Xếp thứ trong nhóm. XT tuần = XT nề nếp + XT học tập (thấp hơn = tốt hơn).",
    ).font = Font(name="Calibri", italic=True, size=9, color="555555")

    widths = [8, 10, 10, 12, 12, 12, 12, 12, 12, 12, 12, 12]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A6"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.print_title_rows = "1:5"


def _sheet_ban_nhap(ws, nam_hoc, tuan_label, results):
    ws.merge_cells("A1:Y1")
    ws["A1"] = f"BẢN NHẬP — {tuan_label} — Năm học {nam_hoc}"
    ws["A1"].font = TITLE_FONT

    headers = ["Nhóm", "Lớp", "Sĩ số"] + [lab for _, lab, _ in NN_COLS]
    headers += [lab for _, lab, _ in HT_GIO_COLS]
    headers += ["Điểm ≥5", "Điểm <5", "Điểm 9–10", "Điểm 7–8", "Điểm 3–4", "Điểm 0–2", "Ghi chú"]
    for c, h in enumerate(headers, 1):
        _hdr(ws, 3, c, h, fill=NAVY2 if c > 3 else NAVY)
    ws.row_dimensions[3].height = 36

    extra_keys = ["ktm_ge5", "ktm_lt5", "ktm_9_10", "ktm_7_8", "ktm_3_4", "ktm_0_2"]
    keys = [k for k, _, _ in NN_COLS] + [k for k, _, _ in HT_GIO_COLS] + extra_keys

    r = 4
    for i, it in enumerate(results):
        fill = _row_fill(it, i % 2 == 0)
        row = it.row
        vals = [it.nhom, it.ten, it.si_so] + [row.get(k, 0) or 0 for k in keys]
        vals.append(row.get("ghi_chu", "") or "")
        for c, v in enumerate(vals, 1):
            _cell(ws, r, c, v, fill=fill)
        r += 1

    for i in range(1, len(headers) + 1):
        ws.column_dimensions[get_column_letter(i)].width = 12 if i > 3 else 9
    ws.freeze_panes = "D4"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.print_title_rows = "1:3"
    ws.auto_filter.ref = f"A3:{get_column_letter(len(headers))}{max(3, r - 1)}"


def _sheet_chi_tiet_nn(ws, nam_hoc, tuan_label, results):
    ws.merge_cells("A1:U1")
    ws["A1"] = f"NỀ NẾP CHI TIẾT — {tuan_label} — {nam_hoc}"
    ws["A1"].font = TITLE_FONT
    headers = ["Nhóm", "Lớp", "Sĩ số"] + [lab for _, lab, _ in NN_COLS] + ["Điểm NN", "TB NN"]
    for c, h in enumerate(headers, 1):
        _hdr(ws, 3, c, h)
    r = 4
    for i, it in enumerate(results):
        fill = _row_fill(it, i % 2 == 0)
        vals = [it.nhom, it.ten, it.si_so]
        vals += [it.row.get(k, 0) or 0 for k, _, _ in NN_COLS]
        vals += [it.diem_nn, round(it.tb_nn, 4)]
        for c, v in enumerate(vals, 1):
            _cell(ws, r, c, v, fill=fill)
        r += 1
    for i in range(1, len(headers) + 1):
        ws.column_dimensions[get_column_letter(i)].width = 11
    ws.freeze_panes = "D4"


def _sheet_loi(ws, nam_hoc, tuan_label, lois):
    ws.merge_cells("A1:G1")
    ws["A1"] = f"DANH SÁCH LỖI VI PHẠM — {tuan_label} — {nam_hoc}"
    ws["A1"].font = TITLE_FONT
    headers = ["Nhóm", "Lớp", "Lỗi", "Số lượng", "Điểm trừ", "Họ tên HS", "Ghi chú"]
    for c, h in enumerate(headers, 1):
        _hdr(ws, 3, c, h)
    r = 4
    if not lois:
        _cell(ws, r, 1, "Không có lỗi ghi nhận")
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=7)
    else:
        for i, row in enumerate(lois):
            d = dict(row)
            fill = RED if d.get("diem_tru") else (ZEBRA if i % 2 == 0 else WHITE)
            vals = [
                d.get("nhom", ""),
                d.get("ten_lop", ""),
                d.get("ten_loi", ""),
                d.get("so_luong", 0),
                d.get("diem_tru", 0),
                d.get("ho_ten", ""),
                d.get("ghi_chu", ""),
            ]
            for c, v in enumerate(vals, 1):
                _cell(ws, r, c, v, fill=fill)
            r += 1
    widths = [8, 10, 42, 12, 12, 22, 22]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A4"


def _sheet_month(ws, nam_hoc, month_rows):
    ws.merge_cells("A1:L1")
    ws["A1"] = f"TỔNG HỢP — Năm học {nam_hoc}"
    ws["A1"].font = TITLE_FONT
    if not month_rows:
        return
    row0 = month_rows[0]
    week_keys = sorted(row0.wmap.keys()) if hasattr(row0, "wmap") else []
    headers = ["Nhóm", "Lớp", "Tổng trừ", "Tổng cộng", "Tổng net"] + [f"XT T{k}" for k in week_keys] + [
        "Tổng XT tuần",
        "XT học kỳ",
    ]
    for c, h in enumerate(headers, 1):
        _hdr(ws, 3, c, h)
    r = 4
    for i, row in enumerate(month_rows):
        fill = GOLD if row.xt == 1 else (RED if row.tong_tru else (ZEBRA if i % 2 == 0 else WHITE))
        vals = [row.nhom, row.ten, row.tong_tru, row.tong_cong, row.tong_net]
        vals += [row.wmap.get(k, "") for k in week_keys]
        vals += [row.tong_xt, row.xt]
        for c, v in enumerate(vals, 1):
            _cell(ws, r, c, v, fill=fill, bold=(c == len(vals)))
        r += 1
    for i in range(1, len(headers) + 1):
        ws.column_dimensions[get_column_letter(i)].width = 12



def export_tong_hop(path: Path, nam_hoc: str, title: str, month_rows: list) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Tong hop"
    _sheet_month(ws, nam_hoc, month_rows)
    ws["A1"] = title
    ws["A1"].font = TITLE_FONT
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path
