"""Workbook period models: monthly 2017–18 and weighted halves 2016–17."""
from __future__ import annotations

import re
from collections import defaultdict

from flask import Blueprint, abort, current_app, flash, redirect, render_template, request, url_for

from . import db
from .db import SCORE_FIELDS
from .logic import results_for_tuan
from .scoring import competition_ranks
MODELS = {"monthly": "Theo tháng", "halves": "Theo nửa kỳ"}
MODES = {"thang": "Tháng", "nua": "Nửa kỳ", "hk": "Học kỳ", "nam": "Cả năm"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS period_month (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 month_key TEXT NOT NULL, semester INTEGER NOT NULL CHECK(semester IN (1,2)),
 half TEXT NOT NULL DEFAULT '' CHECK(half IN ('','dau','sau')),
 PRIMARY KEY(nam_id,month_key)
);
CREATE TABLE IF NOT EXISTS period_week_half (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
 half TEXT NOT NULL CHECK(half IN ('dau','sau')),
 PRIMARY KEY(nam_id,tuan_id)
);
CREATE TABLE IF NOT EXISTS period_options (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 model TEXT NOT NULL CHECK(model IN ('monthly','halves')),
 semester INTEGER NOT NULL CHECK(semester IN (1,2)),
 include_exam INTEGER NOT NULL DEFAULT 0 CHECK(include_exam IN (0,1)),
 exclude_activity INTEGER NOT NULL DEFAULT 0 CHECK(exclude_activity IN (0,1)),
 PRIMARY KEY(nam_id,model,semester)
);
CREATE TABLE IF NOT EXISTS period_entry (
 nam_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
 model TEXT NOT NULL CHECK(model IN ('monthly','halves')),
 mode TEXT NOT NULL CHECK(mode IN ('thang','nua','hk','nam')),
 period_key TEXT NOT NULL,
 lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
 override_rank INTEGER CHECK(override_rank > 0),
 discipline TEXT NOT NULL DEFAULT '', reward TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(nam_id,model,mode,period_key,lop_id)
);
"""


def _months(con, nam_id):
    months = {}
    for w in db.list_tuan(con, nam_id):
        key = f"{w['nam']:04d}-{w['thang']:02d}"
        m = months.setdefault(key, {"key": key, "semester": w["hoc_ky"], "half": "", "weeks": [], "conflict": False})
        m["conflict"] |= m["semester"] != w["hoc_ky"]
        m["weeks"].append(w)
    for row in con.execute("SELECT * FROM period_month WHERE nam_id=?", (nam_id,)):
        m = months.setdefault(row["month_key"], {"key": row["month_key"], "weeks": [], "conflict": False})
        m.update(semester=row["semester"], half=row["half"])
        m["conflict"] = any(w["hoc_ky"] != row["semester"] for w in m["weeks"])
    return [months[key] for key in sorted(months)]


def _options(con, nam_id, model, semester):
    row = con.execute("SELECT * FROM period_options WHERE nam_id=? AND model=? AND semester=?", (nam_id, model, semester)).fetchone()
    return dict(row) if row else {"include_exam": 0, "exclude_activity": 0}


def _entries(con, nam_id, mode, key, model):
    # Monthly source ranks are shared by both models; half ranks belong to 2016–17.
    if mode == "thang":
        model = "monthly"
    return {r["lop_id"]: dict(r) for r in con.execute(
        "SELECT * FROM period_entry WHERE nam_id=? AND model=? AND mode=? AND period_key=?",
        (nam_id, model, mode, key))}


def _week_xt(con, week):
    stored = {
        r["lop_id"]: r
        for r in con.execute("SELECT * FROM diem_tuan WHERE tuan_id=?", (week["id"],))
    }
    ranked = {r.lop_id: r.xt_chung for r in results_for_tuan(con, week["id"])}
    out = {}
    for lop_id, row in stored.items():
        if any((row[k] or 0) != 0 for k in SCORE_FIELDS if k != "ghi_chu"):
            out[lop_id] = ranked.get(lop_id)
    return out


def _rank(rows, field, output="xt"):
    groups = defaultdict(list)
    for row in rows:
        row[output] = None
        groups[row["nhom"]].append(row)
    for group in groups.values():
        if all(r.get(field) is not None for r in group):
            ranks = competition_ranks([r[field] for r in group], higher_better=False)
            for row, rank in zip(group, ranks):
                row[output] = rank


def _override(rows, entries):
    groups = defaultdict(list)
    for row in rows:
        row["override_rank"] = entries.get(row["lop_id"], {}).get("override_rank")
        groups[row["nhom"]].append(row)
    for group in groups.values():
        if any(r["override_rank"] is not None for r in group):
            values = sorted(r["override_rank"] for r in group if r["override_rank"] is not None)
            complete = len(values) == len(group) and all(v == i + 1 or (i > 0 and v == values[i - 1]) for i, v in enumerate(values))
            for row in group:
                row["xt"] = row["override_rank"] if complete else None
                row["input_source"] = "Ghi đè nguồn (cả nhóm)" if complete else "Chờ đủ XT ghi đè hợp lệ của cả nhóm"


def period_table(con, nam_id, mode, key, model="monthly"):
    """Return a table; keys: YYYY-MM, 1/2, 1-dau/.../2-sau, or all.

    Ranking requires a complete class group at every stage. Any source override
    selects manual ranks for that entire group, never blending partial cohorts.
    """
    if model not in MODELS or mode not in MODES:
        raise ValueError("Mô hình hoặc bảng tổng hợp không hợp lệ.")
    key = str(key)
    if mode == "nam":
        if key != "all":
            raise ValueError("Khóa cả năm phải là all.")
    elif mode == "thang":
        if not re.fullmatch(r"[1-9]\d{3}-(0[1-9]|1[0-2])", key):
            raise ValueError("Tháng phải có dạng YYYY-MM.")
    elif mode == "hk" or model == "monthly":
        if key not in ("1", "2"):
            raise ValueError("Học kỳ phải là 1 hoặc 2.")
    elif key not in ("1-dau", "1-sau", "2-dau", "2-sau"):
        raise ValueError("Nửa học kỳ không hợp lệ.")
    # The sheets named 'Thi dua nua dau/sau' are actual HK I/II in 2017–18.
    if mode == "nua" and model == "monthly":
        table = period_table(con, nam_id, "hk", key, model)
        table["notes"].insert(0, "Tên tab gốc 'Thi dua nua dau/sau' là bảng HỌC KỲ I/II năm 2017–2018, không phải nửa học kỳ.")
        return table
    rows = [{"lop_id": r["id"], "ten": r["ten"], "nhom": r["nhom"], "input_source": "Tính từ dữ liệu", "xt": None} for r in db.list_lop(con, nam_id)]
    columns = [("nhom", "Nhóm"), ("ten", "Lớp")]
    notes = ["Xếp thứ tăng dần riêng từng nhóm lớp, đồng hạng kiểu 1, 1, 3. Thiếu một lớp: cả nhóm chờ, không lấy ô trống làm 0."]
    source = ""
    months = _months(con, nam_id)
    entries = _entries(con, nam_id, mode, key, model)
    if mode == "thang":
        title = f"Tháng {key}"
        source = "Thi dua thang (2017–2018): F=SUM(B:E); G=RANK(F, nhóm, 1)."
        month = next((m for m in months if m["key"] == key), None)
        weeks = month["weeks"] if month else []
        week_results = {}
        for week in weeks:
            week_results[week["id"]] = _week_xt(con, week)
            columns.append((f"w_{week['id']}", f"XT tuần {week['so_tuan']}"))
        for row in rows:
            values = []
            for week in weeks:
                value = week_results[week["id"]].get(row["lop_id"])
                row[f"w_{week['id']}"] = value
                values.append(value)
            row["total"] = sum(values) if values and all(v is not None for v in values) else None
        _rank(rows, "total")
        _override(rows, entries)
        columns += [("total", "Tổng XT tuần"), ("override_rank", "XT nguồn ghi đè"), ("xt", "XT tháng")]
        notes.append("XT tháng = RANK(tổng XT chung các tuần). Ghi đè nguồn chỉ dùng khi nhập đủ thứ hạng hợp lệ cho cả nhóm; xóa tất cả ghi đè trong nhóm để trở lại tính từ tuần.")
    elif mode == "nua":
        semester, half = key.split("-")
        title = f"Nửa {'đầu' if half == 'dau' else 'sau'} HK {semester}"
        source = "Đầu vào B/C của Hoc ky I, Hoc ky II (2016–2017); XT nửa kỳ tính từ các XT tháng được phân vào nửa kỳ."
        mappings = {r["tuan_id"]: r["half"] for r in con.execute("SELECT * FROM period_week_half WHERE nam_id=?", (nam_id,))}
        selected = []
        ready = True
        for month in months:
            if month["semester"] != int(semester):
                continue
            assigned = {mappings.get(w["id"], "") for w in month["weeks"]} if month["weeks"] else {month["half"]}
            if month["conflict"] or "" in assigned or len(assigned) != 1:
                ready = False
                continue
            if half in assigned:
                selected.append(month)
        tables = [(m, period_table(con, nam_id, "thang", m["key"], model)) for m in selected]
        maps = [(m, {r["lop_id"]: r for r in t["rows"]}) for m, t in tables]
        for month in selected:
            columns.append((f"m_{month['key']}", f"XT tháng {month['key']}"))
        for row in rows:
            values = []
            for month, result in maps:
                value = result[row["lop_id"]]["xt"]
                row[f"m_{month['key']}"] = value
                values.append(value)
            row["total"] = sum(values) if ready and values and all(v is not None for v in values) else None
        _rank(rows, "total")
        _override(rows, entries)
        columns += [("total", "Tổng XT tháng"), ("override_rank", "XT nguồn ghi đè"), ("xt", "XT nửa học kỳ")]
        notes.append("Nửa học kỳ được cấu hình theo từng tuần, không tự chia theo lịch. Các tuần cùng tháng phải cùng một nửa để dùng nguyên XT tháng; tháng không có tuần dùng lựa chọn nửa kỳ của tháng lịch sử.")
        if not ready:
            notes.append("Chờ phân nửa kỳ: có tháng chưa phân đủ tuần, tuần cùng tháng thuộc hai nửa, hoặc học kỳ tháng không khớp tuần. Hai nửa chưa được xếp hạng tự động; có thể dùng ghi đè nguồn cả nhóm.")
    elif mode == "hk":
        title = f"Học kỳ {key}"
        options = _options(con, nam_id, model, int(key))
        include_exam = model == "monthly" and key == "2" and options["include_exam"]
        if model == "monthly":
            source = "Thi dua nua dau/sau (2017–2018), tiêu đề thực HKI/HKII: G=SUM(B:F), H=RANK(G); HKI K=H+J; HKII K=H+I+J; M=RANK(K)."
            constituents = [(m["key"], f"XT tháng {m['key']}", period_table(con, nam_id, "thang", m["key"], model)) for m in months if m["semester"] == int(key)]
            weights = [1] * len(constituents)
            notes.append("HKI cộng tất cả XT tháng rồi xếp thứ thi đua; tổng chung = XT thi đua + XT HĐTT. Cột I (thi) không tham gia công thức HKI.")
            notes.append("HKII có cột I trong H+I+J nhưng dữ liệu lưu trong tệp để trống: mặc định không tính thi. Bật tùy chọn tính thi sẽ yêu cầu đủ XT thi của cả nhóm.")
            ready = not any(m["conflict"] for m in months if m["semester"] == int(key))
        else:
            source = f"Hoc ky {'I' if key == '1' else 'II'} (2016–2017): E=B+2*C; F=RANK(E); J=2*F+H; K=RANK(J)."
            constituents = [(f"{key}-{half}", label, period_table(con, nam_id, "nua", f"{key}-{half}", model)) for half, label in (("dau", "XT nửa đầu"), ("sau", "XT nửa sau"))]
            weights = [1, 2]
            notes.append("Tổng thi đua = XT nửa đầu + 2 × XT nửa sau; xếp thứ thi đua từ tổng đó. Tổng chung = 2 × XT thi đua + XT HĐTT, không dùng XT thi.")
            ready = True
        constituent_maps = [{r["lop_id"]: r for r in table["rows"]} for _, _, table in constituents]
        columns += [(f"c_{name}", label) for name, label, _ in constituents]
        for row in rows:
            values = []
            for (name, _, _), result, weight in zip(constituents, constituent_maps, weights):
                value = result[row["lop_id"]]["xt"]
                row[f"c_{name}"] = value
                values.append(None if value is None else value * weight)
            row["td_total"] = sum(values) if ready and values and all(v is not None for v in values) else None
        _rank(rows, "td_total", "rank_td")
        from .assessments import activity_results, exam_results
        activities = {r["lop_id"]: r for r in activity_results(con, nam_id, key)}
        exams = {r["lop_id"]: r for r in exam_results(con, nam_id, key)}
        for row in rows:
            row["rank_activity"] = activities.get(row["lop_id"], {}).get("xt")
            row["rank_exam"] = exams.get(row["lop_id"], {}).get("xt")
            values = [None if row["rank_td"] is None else row["rank_td"] * (2 if model == "halves" else 1)]
            if not options["exclude_activity"]:
                values.append(row["rank_activity"])
            if include_exam:
                values.append(row["rank_exam"])
            row["total"] = sum(values) if all(v is not None for v in values) else None
        _rank(rows, "total")
        columns += [("td_total", "Tổng XT thi đua"), ("rank_td", "XT thi đua"), ("rank_exam", "XT thi (tham khảo)" if not include_exam else "XT thi (tính)"), ("rank_activity", "XT HĐTT (không tính)" if options["exclude_activity"] else "XT HĐTT (tính)"), ("total", "Tổng XT chung"), ("xt", "XT học kỳ")]
        notes.append("HĐTT: " + ("đã loại trừ rõ ràng vì không tổ chức." if options["exclude_activity"] else "đang tính; chưa đủ dữ liệu thì chờ xếp hạng."))
    else:
        title = "Cả năm"
        source = "Ca nam (2017–2018): D=B+2*C; E=RANK(D, nhóm, 1). Áp dụng hệ số 2 cho HKII ở cả hai mô hình."
        semesters = [period_table(con, nam_id, "hk", str(i), model) for i in (1, 2)]
        maps = [{r["lop_id"]: r for r in t["rows"]} for t in semesters]
        for row in rows:
            first, second = (result[row["lop_id"]] for result in maps)
            row.update(hk1=first["xt"], hk2=second["xt"], discipline_hk1=first["discipline"], discipline_hk2=second["discipline"])
            row["total"] = first["xt"] + 2 * second["xt"] if first["xt"] is not None and second["xt"] is not None else None
        _rank(rows, "total")
        columns += [("hk1", "XT HKI"), ("hk2", "XT HKII"), ("total", "HKI + 2 × HKII"), ("xt", "XT cả năm"), ("discipline_hk1", "Kỷ luật HKI"), ("discipline_hk2", "Kỷ luật HKII")]
        notes.append("Cả năm = RANK(XT HKI + 2 × XT HKII). Kỷ luật HKI/HKII sửa ở bảng học kỳ tương ứng; khen thưởng nhập thủ công, không tự gán theo thứ hạng.")
    for row in rows:
        entry = entries.get(row["lop_id"], {})
        for field in ("discipline", "reward", "notes"):
            row[field] = entry.get(field, "")
        row["status"] = "Đã xếp hạng" if row["xt"] is not None else "Chờ đủ dữ liệu của nhóm"
    columns += [("input_source", "Nguồn XT"), ("status", "Trạng thái"), ("discipline", "Kỷ luật"), ("reward", "Khen thưởng"), ("notes", "Ghi chú")]
    return {"title": title, "source": source, "columns": columns, "rows": rows, "notes": notes}


def _selection(con, nam_id):
    model = request.args.get("model", "monthly")
    mode = request.args.get("mode", "hk")
    if model not in MODELS or mode not in MODES:
        abort(400, "Mô hình hoặc phạm vi không hợp lệ.")
    months = _months(con, nam_id)
    if mode == "thang":
        keys = [(m["key"], f"Tháng {m['key']} (HK{m['semester']})") for m in months]
    elif mode == "nam":
        keys = [("all", "Cả năm")]
    elif mode == "nua" and model == "halves":
        keys = [(f"{hk}-{half}", f"HK{hk} — nửa {label}") for hk in (1, 2) for half, label in (("dau", "đầu"), ("sau", "sau"))]
    else:
        keys = [("1", "Học kỳ I"), ("2", "Học kỳ II")]
    key = request.args.get("key") or (keys[0][0] if keys else "")
    if key and key not in dict(keys):
        # A selector may change mode/model while retaining the previous key.
        if request.method == "POST":
            abort(400, "Kỳ không thuộc phạm vi năm học đang chọn.")
        key = keys[0][0] if keys else ""
    return mode, key, model, keys, months


def _save(con, nam_id, mode, key, model, months):
    form = request.form
    if form.get("nam_id") != str(nam_id):
        raise ValueError("Năm học đã thay đổi. Tải lại bảng trước khi lưu.")
    action = form.get("action")
    if action == "add_month":
        month_key = form.get("month_key", "")
        if not re.fullmatch(r"[1-9]\d{3}-(0[1-9]|1[0-2])", month_key):
            raise ValueError("Tháng phải có dạng YYYY-MM.")
        semester = form.get("semester")
        if semester not in ("1", "2"):
            raise ValueError("Học kỳ không hợp lệ.")
        with con:
            con.execute("INSERT INTO period_month(nam_id,month_key,semester) VALUES (?,?,?) ON CONFLICT(nam_id,month_key) DO NOTHING", (nam_id, month_key, int(semester)))
        return "thang", month_key, model
    if action == "configure":
        updates = []
        for month in months:
            semester = form.get(f"semester_{month['key']}")
            half = form.get(f"halfmonth_{month['key']}", "")
            if semester not in ("1", "2") or half not in ("", "dau", "sau"):
                raise ValueError("Phân học kỳ/nửa kỳ tháng không hợp lệ.")
            if any(w["hoc_ky"] != int(semester) for w in month["weeks"]):
                raise ValueError(f"Tháng {month['key']}: học kỳ phải khớp tất cả tuần. Sửa học kỳ tuần ở danh sách tuần nếu cần.")
            updates.append((nam_id, month["key"], int(semester), half))
        weeks = db.list_tuan(con, nam_id)
        memberships = []
        for week in weeks:
            half = form.get(f"week_{week['id']}", "")
            if half not in ("", "dau", "sau"):
                raise ValueError("Nửa kỳ của tuần không hợp lệ.")
            if half:
                memberships.append((nam_id, week["id"], half))
        for month in months:
            halves = {form.get(f"week_{w['id']}", "") for w in month["weeks"]} - {""}
            if len(halves) > 1:
                raise ValueError(f"Tháng {month['key']}: các tuần phải cùng một nửa, vì công thức cộng nguyên XT tháng.")
        options = []
        for semester in (1, 2):
            exam = form.get(f"exam_{semester}", "0")
            activity = form.get(f"exclude_activity_{semester}", "0")
            if exam not in ("0", "1") or activity not in ("0", "1"):
                raise ValueError("Tùy chọn tính điểm không hợp lệ.")
            if exam == "1" and (model != "monthly" or semester != 2):
                raise ValueError("Chỉ mô hình tháng HKII sử dụng xếp thứ thi.")
            options.append((nam_id, model, semester, int(exam), int(activity)))
        with con:
            con.executemany("INSERT INTO period_month(nam_id,month_key,semester,half) VALUES (?,?,?,?) ON CONFLICT(nam_id,month_key) DO UPDATE SET semester=excluded.semester,half=excluded.half", updates)
            con.execute("DELETE FROM period_week_half WHERE nam_id=?", (nam_id,))
            con.executemany("INSERT INTO period_week_half(nam_id,tuan_id,half) VALUES (?,?,?)", memberships)
            con.executemany("INSERT INTO period_options(nam_id,model,semester,include_exam,exclude_activity) VALUES (?,?,?,?,?) ON CONFLICT(nam_id,model,semester) DO UPDATE SET include_exam=excluded.include_exam,exclude_activity=excluded.exclude_activity", options)
    elif action == "entries" and key:
        if mode == "nua" and model == "monthly":
            mode = "hk"
        store_model = "monthly" if mode == "thang" else model
        lops = db.list_lop(con, nam_id)
        ids = {str(r["id"]) for r in lops}
        for field in form:
            if field.startswith(("rank_", "discipline_", "reward_", "notes_")) and field.split("_", 1)[1] not in ids:
                raise ValueError("Lớp không thuộc năm học đang chọn.")
        groups = defaultdict(list)
        updates = []
        for lop in lops:
            raw = form.get(f"rank_{lop['id']}", "").strip()
            rank = None
            if raw:
                if mode not in ("thang", "nua") or not re.fullmatch(r"[1-9]\d{0,5}", raw):
                    raise ValueError("XT ghi đè phải là số nguyên dương và chỉ nhập ở bảng tháng/nửa kỳ.")
                rank = int(raw)
                size = sum(r["nhom"] == lop["nhom"] for r in lops)
                if rank > size:
                    raise ValueError(f"XT của {lop['ten']} phải từ 1 đến {size} (số lớp trong nhóm).")
            groups[lop["nhom"]].append(rank)
            text = [form.get(f"{field}_{lop['id']}", "").strip() for field in ("discipline", "reward", "notes")]
            if any(len(value) > 2000 for value in text):
                raise ValueError("Mỗi ô ghi chú/kỷ luật/khen thưởng tối đa 2.000 ký tự.")
            updates.append((nam_id, store_model, mode, key, lop["id"], rank, *text))
        for ranks in groups.values():
            if all(rank is not None for rank in ranks):
                values = sorted(ranks)
                if not all(v == i + 1 or (i > 0 and v == values[i - 1]) for i, v in enumerate(values)):
                    raise ValueError("XT nguồn cả nhóm phải là thứ hạng đồng hạng hợp lệ, ví dụ 1, 1, 3; không dùng 1, 1, 2.")
        with con:
            con.executemany("INSERT INTO period_entry(nam_id,model,mode,period_key,lop_id,override_rank,discipline,reward,notes) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(nam_id,model,mode,period_key,lop_id) DO UPDATE SET override_rank=excluded.override_rank,discipline=excluded.discipline,reward=excluded.reward,notes=excluded.notes", updates)
    else:
        raise ValueError("Thao tác lưu không hợp lệ.")
    return mode, key, model


def register(app):
    app.config["CON"].executescript(SCHEMA)
    blueprint = Blueprint("periods", __name__)

    @blueprint.route("/tong-hop", methods=["GET", "POST"])
    def index():
        con = current_app.config["CON"]
        nam = db.get_active_nam(con)
        if nam is None:
            abort(400, "Chưa có năm học.")
        mode, key, model, keys, months = _selection(con, nam["id"])
        error = None
        if request.method == "POST":
            try:
                target = _save(con, nam["id"], mode, key, model, months)
            except ValueError as exc:
                error = str(exc)
            else:
                flash("Đã lưu cấu hình / dữ liệu tổng hợp.")
                return redirect(url_for("periods.index", mode=target[0], key=target[1], model=target[2]))
        table = period_table(con, nam["id"], mode, key, model) if key else None
        memberships = {r["tuan_id"]: r["half"] for r in con.execute("SELECT * FROM period_week_half WHERE nam_id=?", (nam["id"],))}
        return render_template("periods.html", active="periods", table=table, mode=mode, key=key, model=model, models=MODELS, modes=MODES, keys=keys, months=months, memberships=memberships, options={i: _options(con, nam["id"], model, i) for i in (1, 2)}, editable_rank=mode == "thang" or (mode == "nua" and model == "halves"), error=error, nam_id=nam["id"]), (400 if error else 200)

    @blueprint.get("/tong-hop/xuat")
    def export():
        con = current_app.config["CON"]
        nam = db.get_active_nam(con)
        if nam is None:
            abort(400, "Chưa có năm học.")
        mode, key, model, _, _ = _selection(con, nam["id"])
        if not key:
            abort(400, "Chưa có tháng. Thêm tháng lịch sử hoặc tạo tuần trước khi xuất.")
        from .workbook_export import send_tables
        return send_tables([period_table(con, nam["id"], mode, key, model)], f"Tong_hop_{mode}_{key}_{model}.xlsx")

    app.register_blueprint(blueprint)
