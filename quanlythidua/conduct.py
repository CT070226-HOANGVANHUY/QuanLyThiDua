"""Nề nếp học kỳ và đánh giá GVCN theo các mô hình của sổ XLS."""
from __future__ import annotations

import math
from fractions import Fraction

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for

from . import db
from .scoring import diem_nn


SCHEMA = """
CREATE TABLE IF NOT EXISTS conduct_ratio (
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    hoc_ky INTEGER NOT NULL CHECK(hoc_ky IN (1, 2)),
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    model TEXT NOT NULL CHECK(model IN ('classic', 'teacher')),
    ratio REAL NOT NULL CHECK(ratio > 0),
    PRIMARY KEY(nam_hoc_id, hoc_ky, lop_id, model)
);
CREATE TABLE IF NOT EXISTS conduct_penalty (
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    hoc_ky INTEGER NOT NULL CHECK(hoc_ky IN (1, 2)),
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
    penalty REAL NOT NULL CHECK(penalty >= 0),
    source TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(nam_hoc_id, hoc_ky, lop_id, tuan_id)
);
"""

LINEAGE = (
    "Nguồn hiện tại: -diem_nn của điểm tuần đã lưu, ghép bằng mã lớp và mã tuần "
    "trong đúng năm học/học kỳ; số thay thế nhập riêng được ưu tiên và không sửa điểm tuần gốc."
)
EXTERNAL = (
    "Điểm NN mới (2) trong XLS lấy số âm từ liên kết <<external>> không còn truy cập được. "
    "Ứng dụng dùng nguồn nhập riêng/điểm tuần ở đây thay thế rõ ràng; không khẳng định "
    "liên kết gốc trỏ tới trang Dữ liệu trong cùng tệp. Không nhập dữ liệu lịch sử vào năm hiện tại."
)
MODE_LABELS = {
    "teacher": "Đánh giá GVCN",
    "classic": "Điểm nề nếp học kỳ",
    "data": "Dữ liệu điểm trừ tuần",
}


def _semester(value):
    if str(value) not in ("1", "2"):
        raise ValueError("Học kỳ chỉ nhận 1 hoặc 2.")
    return int(value)


def _number(value, label, positive=False):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{label} phải là số hữu hạn.") from None
    if not math.isfinite(number) or number < 0 or (positive and number == 0):
        qualifier = "lớn hơn 0" if positive else "không âm"
        raise ValueError(f"{label} phải hữu hạn và {qualifier}.")
    return number


def _feed(con, nam_id, hk):
    weeks = [dict(w) for w in db.list_tuan(con, nam_id) if w["hoc_ky"] == hk]
    raw = {
        (r["lop_id"], r["tuan_id"]): dict(r)
        for r in con.execute(
            "SELECT d.* FROM diem_tuan d JOIN tuan t ON t.id=d.tuan_id "
            "JOIN lop l ON l.id=d.lop_id "
            "WHERE t.nam_hoc_id=? AND l.nam_hoc_id=? AND t.hoc_ky=?",
            (nam_id, nam_id, hk),
        )
    }
    overrides = {
        (r["lop_id"], r["tuan_id"]): dict(r)
        for r in con.execute(
            "SELECT * FROM conduct_penalty WHERE nam_hoc_id=? AND hoc_ky=?",
            (nam_id, hk),
        )
    }
    ratios = {
        (r["lop_id"], r["model"]): r["ratio"]
        for r in con.execute(
            "SELECT * FROM conduct_ratio WHERE nam_hoc_id=? AND hoc_ky=?",
            (nam_id, hk),
        )
    }
    rows = []
    for lop in db.list_lop(con, nam_id):
        row = {"lop_id": lop["id"], "ten": lop["ten"], "nhom": lop["nhom"],
               "gvcn": lop["gvcn"], "cells": [], "missing": 0}
        total = Fraction(0)
        for week in weeks:
            key = (lop["id"], week["id"])
            recorded = raw.get(key)
            default = None
            if recorded is not None:
                try:
                    default = _number(-diem_nn(recorded), "Điểm tuần")
                except ValueError:
                    pass
            override = overrides.get(key)
            penalty = override["penalty"] if override else default
            source = ("Nhập riêng: " + (override["source"] or "không ghi chú")) if override else (
                "Điểm tuần đã lưu (-diem_nn)" if default is not None else "Chưa có điểm tuần hợp lệ"
            )
            cell = {"tuan_id": week["id"], "so_tuan": week["so_tuan"],
                    "default": default, "override": override["penalty"] if override else None,
                    "source_note": override["source"] if override else "", "source": source,
                    "penalty": penalty}
            row["cells"].append(cell)
            row[f"w_{week['id']}"] = penalty
            row[f"default_{week['id']}"] = default
            row[f"override_{week['id']}"] = cell["override"]
            row[f"source_{week['id']}"] = source
            if penalty is None:
                row["missing"] += 1
            else:
                total += Fraction(str(penalty))
        row["total"] = None
        row["status"] = "Chưa có tuần trong học kỳ." if not weeks else (
            f"Thiếu điểm của {row['missing']}/{len(weeks)} tuần." if row["missing"] else "Đủ dữ liệu tuần."
        )
        if weeks and not row["missing"]:
            try:
                row["total"] = _number(float(total), "Tổng điểm")
            except (ValueError, OverflowError):
                row["status"] = "Tổng điểm vượt phạm vi số hữu hạn; cần kiểm tra dữ liệu."
        row["classic_ratio"] = ratios.get((lop["id"], "classic"))
        row["teacher_ratio"] = ratios.get((lop["id"], "teacher"))
        rows.append(row)
    return weeks, rows


def _model_rows(raw_rows, model):
    rows = []
    for raw in raw_rows:
        row = dict(raw)
        row.update(ratio=raw[f"{model}_ratio"], quotient=None, remainder=None,
                   deduction=None, helper_ab=None, final=None)
        if model == "teacher":
            row["total"] = -raw["total"] if raw["total"] is not None else None
            for cell in raw["cells"]:
                row[f"w_{cell['tuan_id']}"] = -cell["penalty"] if cell["penalty"] is not None else None
        if row["ratio"] is None:
            row["status"] += " Chưa nhập tỷ lệ riêng của mô hình này."
        if row["total"] is not None and row["ratio"] is not None:
            # Fraction preserves decimal inputs at truncation boundaries; int truncates toward zero.
            total, ratio = Fraction(str(row["total"])), Fraction(str(row["ratio"]))
            try:
                if model == "teacher":
                    quotient = int(total / ratio)
                    remainder = total - quotient * ratio
                    deduction = Fraction(quotient, 10)
                    values = {"quotient": float(quotient), "remainder": float(remainder),
                              "deduction": float(deduction),
                              "helper_ab": -0.1 if remainder < -ratio else 0.0,
                              "final": float(20 + deduction)}
                else:
                    quotient = total / ratio
                    values = {"quotient": float(quotient), "deduction": float(quotient),
                              "final": float(20 - quotient)}
                if not all(math.isfinite(v) for v in values.values()):
                    raise OverflowError
                row.update(values)
            except (OverflowError, ZeroDivisionError):
                row["status"] = "Kết quả vượt phạm vi số hữu hạn; kiểm tra điểm và tỷ lệ."
        rows.append(row)
    return rows


def conduct_tables(con, nam_id, hk):
    """Return raw feed, classic NN, and teacher NN export tables for one school semester."""
    hk = _semester(hk)
    weeks, rows = _feed(con, nam_id, hk)
    common = [("nhom", "Nhóm"), ("ten", "Lớp"), ("gvcn", "GVCN")]
    weekly = [(f"w_{w['id']}", f"Tuần {w['so_tuan']}") for w in weeks]
    raw_columns = list(common)
    for week in weeks:
        wid, number = week["id"], week["so_tuan"]
        raw_columns.extend([(f"default_{wid}", f"T{number}: điểm tuần gốc"),
                            (f"override_{wid}", f"T{number}: thay thế"),
                            (f"w_{wid}", f"T{number}: điểm sử dụng"),
                            (f"source_{wid}", f"T{number}: nguồn")])
    return [
        {"title": f"Dữ liệu HK{hk}", "source": LINEAGE,
         "columns": raw_columns + [("total", "Tổng điểm trừ dương"), ("status", "Trạng thái")],
         "rows": rows, "notes": [EXTERNAL, "Ô trống là thiếu dữ liệu; số 0 là điểm đã ghi nhận."]},
        {"title": "Điểm NN(HKI)" if hk == 1 else "Điểm NN (HKII)",
         "source": "Mẫu Điểm NN học kỳ, năm học 2017–2018. " + LINEAGE,
         "columns": common + weekly + [("total", "Tổng điểm dương"), ("ratio", "Điểm tỷ lệ"),
             ("quotient", "Thương (không TRUNC)"), ("deduction", "Điểm trừ"),
             ("final", "Điểm nề nếp"), ("status", "Trạng thái")],
         "rows": _model_rows(rows, "classic"),
         "notes": ["HKI: U=SUM(B:T), W=U/V, X=20-W. HKII: S=SUM(B:C:D:R), U=S/T, V=20-U.",
                   "Tổng các tuần thuộc học kỳ đang chọn; tỷ lệ nhập riêng, không suy ra từ tên lớp. Không chặn điểm âm."]},
        {"title": f"Điểm NN mới (2) HK{hk}", "source": EXTERNAL + " " + LINEAGE,
         "columns": common + weekly + [("total", "U: tổng điểm âm"), ("ratio", "V: tỷ lệ GVCN"),
             ("quotient", "Y: TRUNC(U/V,0)"), ("remainder", "Z: phần dư U-Y×tỷ lệ"),
             ("deduction", "AA = X: Y×0,1"), ("helper_ab", "AB: phụ, không cộng"),
             ("final", "AC: 20+AA"), ("status", "Trạng thái")],
         "rows": _model_rows(rows, "teacher"),
         "notes": ["Mẫu gốc GVCN HKII năm 2017–2018; chọn HKI là áp dụng cùng mô hình cho HKI.",
                   "Y=TRUNC(U/V,0) cắt về 0, không làm tròn xuống. Z=U-Y×tỷ lệ; AA=Y×0,1; X=AA; AB=IF(Z<-tỷ lệ,-0,1,0).",
                   "AC=20+AA, không cộng AB và không chặn điểm âm. Tỷ lệ GVCN lưu độc lập với tỷ lệ mẫu cũ."]},
    ]


def register(app):
    app.config["CON"].executescript(SCHEMA)
    blueprint = Blueprint("conduct", __name__)

    @blueprint.route("/ne-nep-gvcn", methods=["GET", "POST"])
    def index():
        con = app.config["CON"]
        nam = db.get_active_nam(con)
        if nam is None:
            abort(400, "Chưa có năm học đang chọn.")
        try:
            hk = _semester(request.args.get("hk", "1"))
            mode = request.args.get("mode", "teacher")
            if mode not in MODE_LABELS:
                raise ValueError("Mô hình không hợp lệ.")
        except ValueError as exc:
            abort(400, str(exc))
        weeks, raw_rows = _feed(con, nam["id"], hk)
        classes = {r["lop_id"]: r for r in raw_rows}
        if request.method == "POST":
            try:
                if request.form.get("nam_id") != str(nam["id"]):
                    raise ValueError("Năm học đã thay đổi; tải lại trang trước khi lưu.")
                if request.form.get("hk") != str(hk):
                    raise ValueError("Học kỳ của biểu mẫu không khớp.")
                action = request.form.get("action")
                lop_id = None
                if action != "ratios_bulk":
                    lop_id = int(request.form.get("lop_id", ""))
                    if lop_id not in classes:
                        raise ValueError("Lớp không thuộc năm học đang chọn.")
                action = request.form.get("action")
                if action == "ratios_bulk":
                    if mode not in ("classic", "teacher"):
                        raise ValueError("Chọn đánh giá GVCN hoặc điểm nề nếp học kỳ để nhập tỷ lệ.")
                    updates = []
                    for lop_id in classes:
                        text = request.form.get(f"ratio_{lop_id}", "").strip()
                        ratio = _number(text, f"Tỷ lệ lớp {classes[lop_id]['ten']}", positive=True) if text else None
                        updates.append((lop_id, ratio))
                    with con:
                        for lop_id, ratio in updates:
                            if ratio is None:
                                con.execute(
                                    "DELETE FROM conduct_ratio WHERE nam_hoc_id=? AND hoc_ky=? AND lop_id=? AND model=?",
                                    (nam["id"], hk, lop_id, mode),
                                )
                            else:
                                con.execute(
                                    "INSERT INTO conduct_ratio(nam_hoc_id,hoc_ky,lop_id,model,ratio) VALUES(?,?,?,?,?) "
                                    "ON CONFLICT(nam_hoc_id,hoc_ky,lop_id,model) DO UPDATE SET ratio=excluded.ratio",
                                    (nam["id"], hk, lop_id, mode, ratio),
                                )
                elif action in ("ratio", "clear_ratio"):
                    if mode not in ("classic", "teacher"):
                        raise ValueError("Chọn đánh giá GVCN hoặc điểm nề nếp học kỳ để nhập tỷ lệ.")
                    text = request.form.get("ratio", "").strip()
                    ratio = _number(text, "Tỷ lệ", positive=True) if action == "ratio" and text else None
                    with con:
                        if ratio is None:
                            con.execute("DELETE FROM conduct_ratio WHERE nam_hoc_id=? AND hoc_ky=? AND lop_id=? AND model=?",
                                        (nam["id"], hk, lop_id, mode))
                        else:
                            con.execute("INSERT INTO conduct_ratio(nam_hoc_id,hoc_ky,lop_id,model,ratio) VALUES(?,?,?,?,?) "
                                        "ON CONFLICT(nam_hoc_id,hoc_ky,lop_id,model) DO UPDATE SET ratio=excluded.ratio",
                                        (nam["id"], hk, lop_id, mode, ratio))
                elif action == "penalties":
                    allowed_weeks = {str(w["id"]) for w in weeks}
                    submitted = request.form.getlist("tuan_id")
                    if len(set(submitted)) != len(submitted) or not set(submitted).issubset(allowed_weeks):
                        raise ValueError("Tuần không thuộc năm học/học kỳ đang chọn hoặc bị lặp.")
                    updates = []
                    for wid in submitted:
                        text = request.form.get(f"penalty_{wid}", "").strip()
                        penalty = _number(text, "Điểm trừ") if text else None
                        source = request.form.get(f"source_{wid}", "").strip()
                        if len(source) > 500:
                            raise ValueError("Ghi chú nguồn tối đa 500 ký tự.")
                        updates.append((int(wid), penalty, source))
                    with con:
                        for wid, penalty, source in updates:
                            if penalty is None:
                                con.execute("DELETE FROM conduct_penalty WHERE nam_hoc_id=? AND hoc_ky=? AND lop_id=? AND tuan_id=?",
                                            (nam["id"], hk, lop_id, wid))
                            else:
                                con.execute("INSERT INTO conduct_penalty(nam_hoc_id,hoc_ky,lop_id,tuan_id,penalty,source) VALUES(?,?,?,?,?,?) "
                                            "ON CONFLICT(nam_hoc_id,hoc_ky,lop_id,tuan_id) DO UPDATE SET penalty=excluded.penalty,source=excluded.source",
                                            (nam["id"], hk, lop_id, wid, penalty, source))
                else:
                    raise ValueError("Thao tác không hợp lệ.")
                flash("Đã lưu dữ liệu nề nếp riêng; không thay đổi điểm tuần gốc.")
                return redirect(url_for("conduct.index", hk=hk, mode=mode, lop_id=lop_id) if lop_id else url_for("conduct.index", hk=hk, mode=mode))
            except (ValueError, OverflowError) as exc:
                flash(str(exc) or "Dữ liệu không hợp lệ.")
                tables = conduct_tables(con, nam["id"], hk)
                table = tables[{"data": 0, "classic": 1, "teacher": 2}[mode]]
                return render_template("conduct.html", active="conduct", hk=hk, mode=mode,
                                       mode_labels=MODE_LABELS, tables=tables, table=table,
                                       weeks=weeks, raw_rows=raw_rows, selected=None), 400
        tables = conduct_tables(con, nam["id"], hk)
        selected_id = request.args.get("lop_id", type=int)
        if selected_id is not None and selected_id not in classes:
            abort(400, "Lớp không thuộc năm học đang chọn.")
        selected = classes.get(selected_id) if selected_id else (raw_rows[0] if raw_rows else None)
        table = tables[{"data": 0, "classic": 1, "teacher": 2}[mode]]
        return render_template("conduct.html", active="conduct", hk=hk, mode=mode,
                               mode_labels=MODE_LABELS, tables=tables, table=table,
                               weeks=weeks, raw_rows=raw_rows, selected=selected)

    @blueprint.get("/ne-nep-gvcn/xuat")
    def export():
        from .workbook_export import send_tables

        con = app.config["CON"]
        nam = db.get_active_nam(con)
        if nam is None:
            abort(400, "Chưa có năm học đang chọn.")
        try:
            hk = _semester(request.args.get("hk", "1"))
        except ValueError as exc:
            abort(400, str(exc))
        return send_tables(conduct_tables(con, nam["id"], hk), f"Ne_nep_GVCN_{nam['ten']}_HK{hk}.xlsx")

    app.register_blueprint(blueprint)
