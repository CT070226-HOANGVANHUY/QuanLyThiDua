"""Giao diện web — cùng dữ liệu SQLite với engine tính điểm."""

from __future__ import annotations

import webbrowser
from pathlib import Path
from threading import Timer

from flask import Flask, flash, redirect, render_template, request, send_file, url_for

from . import db
from .export import export_tuan
from .logic import results_for_tuan, tuan_label
from .scoring import HT_GIO_COLS, LOI_MAU, NN_COLS
from .db import SCORE_FIELDS as DIEM_FIELDS


ROOT = Path(__file__).resolve().parent
REPORT_DIR = ROOT.parent / "BaoCao"


def create_app(database_path: Path | None = None) -> Flask:
    app = Flask(
        __name__,
        template_folder=str(ROOT / "templates"),
        static_folder=str(ROOT / "static"),
    )
    app.secret_key = "thidua-giao-thuy-c"
    con = db.connect(database_path)
    db.init_db(con)
    app.config["CON"] = con
    from . import assessments, conduct, periods

    assessments.register(app)
    conduct.register(app)
    periods.register(app)

    def ctx():
        nam = db.get_active_nam(con)
        return {"nam": nam, "nam_hocs": db.list_nam_hoc(con)}

    def nam_id():
        n = db.get_active_nam(con)
        if not n:
            raise RuntimeError("Chưa có năm học")
        return int(n["id"])

    @app.context_processor
    def inject():
        return ctx()

    @app.post("/doi-nam")
    def doi_nam():
        db.set_active_nam(con, int(request.form["nam_id"]))
        return redirect(request.referrer or url_for("home"))

    @app.post("/nam-moi")
    def nam_moi():
        ten = (request.form.get("ten") or "").strip()
        if ten:
            copy = nam_id() if request.form.get("copy") else None
            new_id = db.add_nam_hoc(con, ten, copy_from=copy)
            db.set_active_nam(con, new_id)
            flash(f"Đã tạo năm học {ten}")
        return redirect(url_for("home"))

    @app.get("/")
    def home():
        n = db.get_active_nam(con)
        lops = db.list_lop(con, n["id"]) if n else []
        tuans = db.list_tuan(con, n["id"]) if n else []
        tuan = tuans[-1] if tuans else None
        results = results_for_tuan(con, tuan["id"]) if tuan else []
        chart = []
        for i, t in enumerate(tuans[-5:]):
            rs = results_for_tuan(con, t["id"])
            vp = sum(1 for it in rs if it.tong_tru)
            chart.append({"label": f"Tuần {t['so_tuan']}", "val": vp, "i": i})
        if not chart:
            chart = [{"label": f"Tuần {i}", "val": 0, "i": i} for i in range(1, 6)]
        chart_max = max((c["val"] for c in chart), default=1) or 1
        tops = []
        for g in (1, 2):
            grp = [it for it in results if it.nhom == g]
            grp = sorted(grp, key=lambda x: x.xt_chung)[:5]
            tops.append((g, grp))
        bad_list = [it for it in results if it.tong_tru]
        bad = ",  ".join(f"{it.ten} (−{it.tong_tru:g})" for it in bad_list)
        return render_template(
            "home.html",
            active="home",
            so_lop=len(lops),
            so_tuan=len(tuans),
            tuan_hien_tai=tuan_label(tuan) if tuan else "—",
            chart=chart,
            chart_max=chart_max,
            tops=tops,
            so_vp=len(bad_list),
            bad=bad,
        )

    @app.get("/lop")
    def lop():
        rows = [dict(r) for r in db.list_lop(con, nam_id())]
        return render_template("lop.html", active="lop", lops=rows)


    @app.post("/lop/luu")
    def luu_lop():
        fid = request.form.get("id") or None
        db.upsert_lop(
            con,
            nam_id(),
            {
                "id": int(fid) if fid else None,
                "ten": request.form["ten"].strip().upper(),
                "khoi": int(request.form.get("khoi") or 10),
                "nhom": int(request.form.get("nhom") or 1),
                "si_so": int(request.form.get("si_so") or 0),
                "gvcn": request.form.get("gvcn") or "",
                "thu_tu": int(request.form.get("thu_tu") or 0),
            },
        )
        flash("Đã lưu lớp")
        return redirect(url_for("lop"))

    @app.post("/lop/<int:lop_id>/xoa")
    def xoa_lop(lop_id):
        db.delete_lop(con, lop_id)
        flash("Đã xóa lớp")
        return redirect(url_for("lop"))

    @app.get("/nhap")
    def nhap():
        tuans = db.list_tuan(con, nam_id())
        tuan_id = request.args.get("tuan_id", type=int)
        tuan = db.get_tuan(con, tuan_id) if tuan_id else (tuans[-1] if tuans else None)
        results = results_for_tuan(con, tuan["id"]) if tuan else []
        lop_id = request.args.get("lop_id", type=int)
        if not lop_id and results:
            lop_id = results[0].lop_id
        lop_row = None
        diem = {}
        lois = []
        cur = None
        if tuan and lop_id:
            db.ensure_diem_rows(con, tuan["id"], nam_id())
            rows = db.get_diem_join(con, tuan["id"])
            diem = next((r for r in rows if r["lop_id"] == lop_id), {})
            lop_row = next((r for r in db.list_lop(con, nam_id()) if r["id"] == lop_id), None)
            lois = db.list_loi(con, tuan["id"], lop_id)
            cur = next((it for it in results if it.lop_id == lop_id), None)
        return render_template(
            "nhap.html",
            active="nhap",
            tuans=tuans,
            tuan=tuan,
            results=results,
            lop=lop_row,
            diem=diem,
            lois=lois,
            cur=cur,
            nn_cols=NN_COLS,
            gio_cols=HT_GIO_COLS,
            loi_mau=LOI_MAU,
        )

    @app.get("/nhap/tao-tuan")
    def tao_tuan():
        tuans = db.list_tuan(con, nam_id())
        prev = tuans[-1] if tuans else None
        return render_template(
            "tao_tuan.html",
            active="nhap",
            so_tuan=(prev["so_tuan"] + 1) if prev else 1,
            thang=prev["thang"] if prev else 9,
            nam_y=prev["nam"] if prev else 2026,
            hoc_ky=prev["hoc_ky"] if prev else 1,
        )

    @app.post("/nhap/tao-tuan")
    def tao_tuan_post():
        tid = db.upsert_tuan(
            con,
            nam_id(),
            {
                "so_tuan": int(request.form["so_tuan"]),
                "thang": int(request.form["thang"]),
                "nam": int(request.form["nam"]),
                "hoc_ky": int(request.form["hoc_ky"]),
                "ghi_chu": request.form.get("ghi_chu") or "",
            },
        )
        flash("Đã tạo tuần")
        return redirect(url_for("nhap", tuan_id=tid))

    @app.post("/nhap/luu-diem")
    def luu_diem():
        tuan_id = int(request.form["tuan_id"])
        lop_id = int(request.form["lop_id"])
        data = {}
        for k in DIEM_FIELDS:
            if k == "ghi_chu":
                data[k] = request.form.get(k) or ""
            else:
                raw = (request.form.get(k) or "0").strip() or "0"
                data[k] = float(raw)
        db.save_diem(con, tuan_id, lop_id, data)
        flash("Đã lưu lớp")
        return redirect(url_for("nhap", tuan_id=tuan_id, lop_id=lop_id))

    @app.post("/nhap/them-loi")
    def them_loi():
        tuan_id = int(request.form["tuan_id"])
        lop_id = int(request.form["lop_id"])
        idx = int(request.form.get("loi_idx") or 0)
        field, ten, diem_mot, _dv = LOI_MAU[idx]
        sl = float(request.form.get("so_luong") or 1)
        db.ensure_diem_rows(con, tuan_id, nam_id())
        db.add_loi(con, tuan_id, lop_id, field, ten, sl, diem_mot, request.form.get("ho_ten") or "")
        flash("Đã thêm lỗi")
        return redirect(url_for("nhap", tuan_id=tuan_id, lop_id=lop_id))

    @app.post("/nhap/loi/<int:loi_id>/xoa")
    def xoa_loi(loi_id):
        db.delete_loi(con, loi_id)
        flash("Đã xóa lỗi")
        return redirect(url_for("nhap", tuan_id=request.form.get("tuan_id"), lop_id=request.form.get("lop_id")))

    @app.get("/ket-qua-tuan")
    def xep():
        tuans = db.list_tuan(con, nam_id())
        tuan_id = request.args.get("tuan_id", type=int)
        tuan = db.get_tuan(con, tuan_id) if tuan_id else (tuans[-1] if tuans else None)
        nhom = request.args.get("nhom", default=0, type=int)
        results = results_for_tuan(con, tuan["id"]) if tuan else []
        if nhom in (1, 2):
            results = [it for it in results if it.nhom == nhom]
        return render_template("xep.html", active="xep", tuans=tuans, tuan=tuan, results=results, nhom=nhom)

    @app.get("/ket-qua-hoc-ky")
    def hocky():
        return redirect(url_for("periods.index", **request.args))


    def _send_xlsx(path: Path):
        return send_file(path, as_attachment=True, download_name=path.name)

    @app.get("/xuat/tuan/<int:tuan_id>")
    def xuat_tuan(tuan_id):
        t = db.get_tuan(con, tuan_id)
        results = results_for_tuan(con, tuan_id)
        lois = db.list_loi_tuan(con, tuan_id)
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        path = REPORT_DIR / f"Bao_cao_tuan_{t['so_tuan']}_thang_{t['thang']}_{t['nam']}.xlsx"
        export_tuan(path, db.get_active_nam(con)["ten"], tuan_label(t), results, lois=lois)
        return _send_xlsx(path)

    @app.get("/xuat/tuan")
    def xuat_tuan_form():
        return redirect(url_for("xuat_tuan", tuan_id=int(request.args["tuan_id"])))


    @app.get("/bao-cao")
    def baocao():
        tuans = db.list_tuan(con, nam_id())
        hks = sorted({t["hoc_ky"] for t in tuans})
        return render_template("baocao.html", active="bc", tuans=tuans, hks=hks)

    @app.get("/quy-che")
    def quyche():
        q = (request.args.get("q") or "").casefold()
        rows = []
        for r in db.list_quy_che(con):
            blob = " ".join(str(r[k]) for k in ("stt", "muc", "noi_dung", "diem", "ghi_chu")).casefold()
            if q and q not in blob:
                continue
            rows.append(r)
        return render_template("quyche.html", active="qc", rows=rows, q=request.args.get("q") or "")

    @app.get("/cong-thuc")
    def cong_thuc():
        return render_template("formulas.html", active="formulas")

    return app


def run():
    app = create_app()
    Timer(0.6, lambda: webbrowser.open("http://127.0.0.1:5050")).start()
    app.run(host="127.0.0.1", port=5050, debug=False, use_reloader=False)
