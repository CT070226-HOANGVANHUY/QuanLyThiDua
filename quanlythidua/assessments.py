"""Nhập và xếp thứ thi, hoạt động tập thể theo lớp và kỳ đánh giá."""

from __future__ import annotations

import math
import re

from flask import Blueprint, abort, current_app, flash, redirect, render_template, request, url_for

from . import db

PERIODS = {
    "1": "Học kỳ I",
    "2": "Học kỳ II",
    "1-dau": "Nửa đầu học kỳ I",
    "1-sau": "Nửa sau học kỳ I",
    "2-dau": "Nửa đầu học kỳ II",
    "2-sau": "Nửa sau học kỳ II",
}
KINDS = {"thi": "Thi", "hoat-dong": "HĐTT"}
SUBJECTS = (
    ("toan", "Toán"),
    ("van", "Ngữ văn"),
    ("anh", "Tiếng Anh"),
    ("ly", "Vật lý"),
    ("hoa", "Hóa học"),
    ("bo_sung", "Môn bổ sung"),
)
CLASSIFICATIONS = (
    ("gioi", "Giỏi", 3),
    ("kha", "Khá", 2),
    ("trung_binh", "Trung bình", 1),
    ("yeu", "Yếu", -2),
    ("kem", "Kém", -3),
)
ACTIVITIES = (("the_thao", "Xếp thứ thể thao"), ("van_nghe", "Xếp thứ văn nghệ"))
EXAM_FIELDS = tuple(key for key, _ in SUBJECTS) + tuple(key for key, _, _ in CLASSIFICATIONS)
ACTIVITY_FIELDS = tuple(key for key, _ in ACTIVITIES)
TABLES = {"thi": "assessment_exam", "hoat-dong": "assessment_activity"}
MAX_INTEGER = 2147483647


def _validate_selection(kind, period):
    if kind not in KINDS or period not in PERIODS:
        raise ValueError("Loại đánh giá hoặc kỳ đánh giá không hợp lệ.")


def _rank(rows, value_key, rank_key, descending=False):
    groups = {}
    for row in rows:
        row[rank_key] = None
        if row[value_key] is not None:
            groups.setdefault(row["nhom"], []).append(row)
    for members in groups.values():
        members.sort(key=lambda row: row[value_key], reverse=descending)
        previous = None
        rank = 0
        for position, row in enumerate(members, 1):
            if position == 1 or row[value_key] != previous:
                rank = position
            row[rank_key] = rank
            previous = row[value_key]


def _input_rows(con, nam_id, kind, period):
    _validate_selection(kind, period)
    fields = EXAM_FIELDS if kind == "thi" else ACTIVITY_FIELDS
    stored = {
        row["lop_id"]: row
        for row in con.execute(
            f"SELECT * FROM {TABLES[kind]} WHERE nam_hoc_id=? AND period=?",
            (nam_id, period),
        )
    }
    rows = []
    for lop in db.list_lop(con, nam_id):
        record = stored.get(lop["id"])
        row = {"lop_id": lop["id"], "ten": lop["ten"], "nhom": lop["nhom"], "si_so": lop["si_so"]}
        row.update({key: record[key] if record else None for key in fields})
        rows.append(row)
    return rows


def exam_results(con, nam_id, period):
    """Return all classes; only complete exam/classification rows receive final xt."""
    rows = _input_rows(con, nam_id, "thi", period)
    for row in rows:
        subjects = [row[key] for key, _ in SUBJECTS if row[key] is not None]
        counts = [row[key] for key, _, _ in CLASSIFICATIONS]
        row["so_mon"] = len(subjects)
        row["trung_binh_mon"] = sum(subjects) / len(subjects) if subjects else None
        row["tong_hs"] = sum(counts) if all(value is not None for value in counts) else None
        row["diem_xep_loai"] = None
        if row["si_so"] > 0 and row["tong_hs"] == row["si_so"]:
            row["diem_xep_loai"] = sum(row[key] * weight for key, _, weight in CLASSIFICATIONS) / row["si_so"]
        missing = []
        if not subjects:
            missing.append("Chưa nhập tỷ lệ môn thi")
        if row["si_so"] <= 0:
            missing.append("Cần sĩ số dương trong danh sách lớp")
        if row["tong_hs"] is None:
            missing.append("Chưa nhập đủ 5 số lượng xếp loại")
        elif row["tong_hs"] != row["si_so"]:
            missing.append("Tổng số học sinh xếp loại khác sĩ số hiện tại")
        row["trang_thai"] = "; ".join(missing) if missing else "Đủ dữ liệu"
    for key, _ in SUBJECTS:
        _rank(rows, key, f"xt_{key}", descending=True)
    _rank(rows, "trung_binh_mon", "xt_trung_binh", descending=True)
    _rank(rows, "diem_xep_loai", "xt_xep_loai", descending=True)
    for row in rows:
        row["tong_xt"] = (
            2 * row["xt_trung_binh"] + row["xt_xep_loai"]
            if row["xt_trung_binh"] is not None and row["xt_xep_loai"] is not None
            else None
        )
    _rank(rows, "tong_xt", "xt")
    return rows


def activity_results(con, nam_id, period):
    """Return all classes; both positive activity ranks are required for final xt."""
    rows = _input_rows(con, nam_id, "hoat-dong", period)
    for row in rows:
        complete = all(row[key] is not None for key in ACTIVITY_FIELDS)
        row["tong_xt"] = sum(row[key] for key in ACTIVITY_FIELDS) if complete else None
        row["trang_thai"] = "Đủ dữ liệu" if complete else "Chưa nhập đủ xếp thứ thể thao và văn nghệ"
    _rank(rows, "tong_xt", "xt")
    return rows


def assessment_table(con, nam_id, kind, period):
    """Build the shared display/export contract without replacing missing values."""
    _validate_selection(kind, period)
    columns = [("nhom", "Nhóm"), ("ten", "Lớp")]
    notes = [
        "Xếp thứ riêng từng nhóm lớp, đồng hạng kiểu 1, 1, 3; chỉ so sánh các giá trị đã có.",
        "Ô trống là chưa nhập, khác số 0. Không xếp thứ chung khi thiếu dữ liệu bắt buộc.",
        "Dữ liệu tách biệt theo năm học và từng học kỳ/nửa học kỳ; không tự sao chép giữa các kỳ.",
    ]
    if kind == "thi":
        source = "Mô hình XT Thi — giữa học kỳ II, năm học 2016–2017"
        columns.append(("si_so", "Sĩ số"))
        for key, label in SUBJECTS:
            columns.extend(((key, f"{label} (%)"), (f"xt_{key}", f"XT {label}")))
        columns.extend((("so_mon", "Số môn đã nhập"), ("trung_binh_mon", "Tỷ lệ trung bình (%)"), ("xt_trung_binh", "XT tỷ lệ trung bình")))
        columns.extend((key, f"{label} ({weight:+d}đ)") for key, label, weight in CLASSIFICATIONS)
        columns.extend((("tong_hs", "Tổng HS xếp loại"), ("diem_xep_loai", "Điểm xếp loại"), ("xt_xep_loai", "XT xếp loại")))
        notes.extend([
            "Nguồn XT Thi: O = SUM(C,E,G,I,K,M)/COUNT(C,E,G,I,K,M); từng môn và O xếp giảm dần. Môn thứ sáu không có tên trong nguồn, hiển thị Môn bổ sung.",
            "V = (3 × Giỏi + 2 × Khá + Trung bình − 2 × Yếu − 3 × Kém) / sĩ số; V xếp giảm dần. Phải nhập đủ cả 5 số lượng, kể cả số 0; tổng phải bằng sĩ số dương.",
            "X = 2 × XT tỷ lệ trung bình + XT xếp loại; Y = RANK(X, nhóm, tăng dần). Tỷ lệ trung bình chỉ tính các môn đã nhập; không bắt buộc cả 6 môn.",
            "Tham chiếu sĩ số chéo sang Ban in trong XLS gốc bị lệch vị trí hàng; ứng dụng ghép bằng định danh lớp, lấy sĩ số hiện tại từ danh sách lớp. Khi sĩ số đổi, tổng xếp loại phải được cập nhật tương ứng.",
            "Giá trị bộ nhớ đệm 42 có kiểu lỗi trong XT Thi là #N/A, không phải điểm 42. Ứng dụng không nhập bộ nhớ đệm lỗi hay dữ liệu lịch sử vào năm hiện hành.",
        ])
        rows = exam_results(con, nam_id, period)
    else:
        source = "Mô hình XT HD TT — giữa học kỳ I, năm học 2017–2018"
        columns.extend(ACTIVITIES)
        notes.append("Nguồn XT HD TT: E = B + C (XT thể thao + XT văn nghệ); F = RANK(E, nhóm, tăng dần). Cả hai xếp thứ phải là số nguyên dương; thiếu một hoạt động thì chưa có tổng hoặc XT chung.")
        rows = activity_results(con, nam_id, period)
    columns.extend((("tong_xt", "Tổng XT"), ("xt", "XT chung"), ("trang_thai", "Trạng thái")))
    nam = con.execute("SELECT ten FROM nam_hoc WHERE id=?", (nam_id,)).fetchone()
    year = nam["ten"] if nam else "Chưa có năm học"
    return {"title": f"{KINDS[kind]} — {PERIODS[period]} — {year}", "source": source, "columns": columns, "rows": rows, "notes": notes}


def _integer(raw, label, minimum=0):
    if len(raw) > 10 or re.fullmatch(r"[0-9]+", raw) is None:
        raise ValueError(f"{label}: cần số nguyên từ {minimum} đến {MAX_INTEGER}.")
    value = int(raw)
    if not minimum <= value <= MAX_INTEGER:
        raise ValueError(f"{label}: cần số nguyên từ {minimum} đến {MAX_INTEGER}.")
    return value


def _parse_inputs(form, kind, si_so):
    values = {}
    if kind == "thi":
        for key, label in SUBJECTS:
            raw = form.get(key, "").strip()
            if not raw:
                values[key] = None
                continue
            try:
                value = float(raw)
            except ValueError:
                raise ValueError(f"{label}: tỷ lệ phải là số từ 0 đến 100.") from None
            if not math.isfinite(value) or not 0 <= value <= 100:
                raise ValueError(f"{label}: tỷ lệ phải hữu hạn, từ 0 đến 100.")
            values[key] = value
        for key, label, _ in CLASSIFICATIONS:
            raw = form.get(key, "").strip()
            values[key] = _integer(raw, label) if raw else None
        counts = [values[key] for key, _, _ in CLASSIFICATIONS]
        supplied_sum = sum(value for value in counts if value is not None)
        if si_so > 0 and supplied_sum > si_so:
            raise ValueError("Tổng số học sinh đã nhập không được vượt sĩ số lớp.")
        if all(value is not None for value in counts):
            if si_so <= 0:
                raise ValueError("Cần cập nhật sĩ số dương trong danh sách lớp trước khi lưu đủ số lượng xếp loại.")
            if supplied_sum != si_so:
                raise ValueError(f"Tổng 5 số lượng xếp loại phải bằng sĩ số lớp ({si_so}). Có thể để trống ô chưa biết để lưu bản nhập dở.")
    else:
        for key, label in ACTIVITIES:
            raw = form.get(key, "").strip()
            values[key] = _integer(raw, label, 1) if raw else None
    return values


def register(app):
    """Create only assessment-owned tables and attach routes to the host app."""
    con = app.config["CON"]
    periods_sql = ",".join(f"'{period}'" for period in PERIODS)
    exam_sql = ",\n".join(
        [f"{key} REAL CHECK ({key} IS NULL OR {key} BETWEEN 0 AND 100)" for key, _ in SUBJECTS]
        + [f"{key} INTEGER CHECK ({key} IS NULL OR (typeof({key})='integer' AND {key} BETWEEN 0 AND {MAX_INTEGER}))" for key, _, _ in CLASSIFICATIONS]
    )
    activity_sql = ",\n".join(f"{key} INTEGER CHECK ({key} IS NULL OR (typeof({key})='integer' AND {key} BETWEEN 1 AND {MAX_INTEGER}))" for key in ACTIVITY_FIELDS)
    with con:
        for table, fields_sql in ((TABLES["thi"], exam_sql), (TABLES["hoat-dong"], activity_sql)):
            con.execute(f"""CREATE TABLE IF NOT EXISTS {table} (
                nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
                period TEXT NOT NULL CHECK (period IN ({periods_sql})),
                lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
                {fields_sql},
                PRIMARY KEY (nam_hoc_id, period, lop_id)
            )""")
    bp = Blueprint("assessments", __name__)

    def selection():
        kind = request.args.get("kind", "thi")
        period = request.args.get("period", "1")
        try:
            _validate_selection(kind, period)
        except ValueError as exc:
            abort(400, description=str(exc))
        return kind, period

    @bp.route("/danh-gia", methods=["GET", "POST"])
    def index():
        con = current_app.config["CON"]
        kind, period = selection()
        nam = db.get_active_nam(con)
        if nam is None:
            abort(400, description="Chưa có năm học. Hãy tạo năm học trước khi nhập đánh giá.")
        nam_id = nam["id"]
        lops = db.list_lop(con, nam_id)
        fields = EXAM_FIELDS if kind == "thi" else ACTIVITY_FIELDS
        raw_id = request.form.get("lop_id", "") if request.method == "POST" else request.args.get("lop_id", "")
        try:
            lop_id = _integer(raw_id, "Lớp", 1) if raw_id else (lops[0]["id"] if lops else None)
        except ValueError as exc:
            abort(400, description=str(exc))
        selected = next((lop for lop in lops if lop["id"] == lop_id), None)
        if lop_id is not None and selected is None:
            abort(400, description="Lớp không thuộc năm học đang chọn.")
        error = None
        form_values = None
        if request.method == "POST":
            form_values = {key: request.form.get(key, "") for key in fields}
            try:
                if request.form.get("nam_id") != str(nam_id):
                    raise ValueError("Năm học đã thay đổi. Hãy mở lại trang trước khi lưu hoặc xóa.")
                if not raw_id or selected is None:
                    raise ValueError("Hãy chọn lớp thuộc năm học hiện tại.")
                action = request.form.get("action", "save")
                if action not in ("save", "clear"):
                    raise ValueError("Thao tác không hợp lệ.")
                values = _parse_inputs(request.form, kind, selected["si_so"]) if action == "save" else None
                with con:
                    if action == "clear":
                        con.execute(f"DELETE FROM {TABLES[kind]} WHERE nam_hoc_id=? AND period=? AND lop_id=?", (nam_id, period, lop_id))
                    else:
                        columns = ",".join(fields)
                        placeholders = ",".join("?" for _ in fields)
                        updates = ",".join(f"{key}=excluded.{key}" for key in fields)
                        con.execute(
                            f"INSERT INTO {TABLES[kind]} (nam_hoc_id,period,lop_id,{columns}) VALUES (?,?,?,{placeholders}) ON CONFLICT(nam_hoc_id,period,lop_id) DO UPDATE SET {updates}",
                            (nam_id, period, lop_id, *(values[key] for key in fields)),
                        )
                flash("Đã xóa dữ liệu đánh giá của lớp trong kỳ này." if action == "clear" else "Đã lưu đánh giá. Ô trống vẫn là chưa nhập.")
                return redirect(url_for("assessments.index", kind=kind, period=period, lop_id=lop_id))
            except ValueError as exc:
                error = str(exc)
        table = assessment_table(con, nam_id, kind, period)
        selected_result = next((row for row in table["rows"] if row["lop_id"] == lop_id), None)
        if form_values is None:
            form_values = {key: selected_result[key] if selected_result and selected_result[key] is not None else "" for key in fields}
        return render_template(
            "assessments.html", active="assessments", kind=kind, kinds=KINDS,
            period=period, periods=PERIODS, lops=lops, selected=selected,
            assessment_nam_id=nam_id, values=form_values, error=error,
            subjects=SUBJECTS, classifications=CLASSIFICATIONS, activities=ACTIVITIES,
            table=table,
        ), 400 if error else 200

    @bp.get("/danh-gia/export")
    def export():
        from .workbook_export import send_tables

        con = current_app.config["CON"]
        kind, period = selection()
        nam = db.get_active_nam(con)
        if nam is None:
            abort(400, description="Chưa có năm học để xuất báo cáo.")
        table = assessment_table(con, nam["id"], kind, period)
        return send_tables([table], f"danh-gia-{kind}-{nam['id']}-{period}.xlsx")

    app.register_blueprint(bp)
