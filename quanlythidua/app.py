"""Ứng dụng desktop quản lý thi đua chi đoàn."""

from __future__ import annotations

import os
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from pathlib import Path


from . import db
from .export import export_tong_hop, export_tuan
from .scoring import (
    AggRow,
    ClassResult,
    HT_GIO_COLS,
    LOI_MAU,
    NN_COLS,
    competition_ranks,
    diem_gio,
    diem_ktm,
    diem_nn,
    score_all,
    so_gio,
    tb_hoc_tap,
    tb_nn,
    tong_cong,
    tong_net,
    tong_tru,
)


NAVY = "#1e3a5f"
NAVY_H = "#2e5984"
GOLD = "#c9a227"
BG = "#eef2f6"
RED = "#9b1c1c"
GREEN = "#1f7a4d"
WHITE = "#ffffff"
SIDE_W = 200


def parse_num(s, integer=False):
    s = (s or "").strip().replace(",", ".")
    if not s:
        return 0
    try:
        v = float(s)
    except ValueError:
        return 0
    return int(v) if integer else v


def results_for_tuan(con, tuan_id: int) -> list[ClassResult]:
    rows = db.get_diem_join(con, tuan_id)
    items = [
        ClassResult(
            lop_id=r["lop_id"],
            ten=r["ten"],
            nhom=int(r["nhom"]),
            si_so=int(r["si_so"] or 0),
            row=r,
        )
        for r in rows
    ]
    return score_all(items)


def aggregate_weeks(con, tuan_rows) -> list[AggRow]:
    """Cộng điểm cộng/trừ và XT tuần → xếp thứ kỳ."""
    if not tuan_rows:
        return []
    meta: dict[int, ClassResult] = {}
    week_map: dict[int, dict[int, int]] = {}
    tru: dict[int, float] = {}
    cong: dict[int, float] = {}
    net: dict[int, float] = {}
    for t in tuan_rows:
        for it in results_for_tuan(con, t["id"]):
            meta[it.lop_id] = it
            week_map.setdefault(it.lop_id, {})[t["so_tuan"]] = it.xt_chung
            tru[it.lop_id] = tru.get(it.lop_id, 0) + it.tong_tru
            cong[it.lop_id] = cong.get(it.lop_id, 0) + it.tong_cong
            net[it.lop_id] = net.get(it.lop_id, 0) + it.tong_net
    grouped: dict[int, list[int]] = {}
    for lop_id, it in meta.items():
        grouped.setdefault(it.nhom, []).append(lop_id)
    out: list[AggRow] = []
    for nhom in sorted(grouped):
        ids = grouped[nhom]
        tongs = [sum(week_map[i].values()) for i in ids]
        ranks = competition_ranks(tongs, higher_better=False)
        for lop_id, tong, xt in zip(ids, tongs, ranks):
            it = meta[lop_id]
            wmap = week_map[lop_id]
            out.append(
                AggRow(
                    nhom=it.nhom,
                    ten=it.ten,
                    lop_id=lop_id,
                    tong_tru=tru[lop_id],
                    tong_cong=cong[lop_id],
                    tong_net=net[lop_id],
                    tong_xt=tong,
                    xt=xt,
                    n_weeks=len(wmap),
                    wmap=wmap,
                )
            )
    return out



def tuan_label(t) -> str:
    if t is None:
        return "Chưa có tuần"
    return f"Tuần {t['so_tuan']} — Tháng {t['thang']}/{t['nam']}  (HK{t['hoc_ky']})"


def report_dir() -> Path:
    d = db.ROOT / "BaoCao"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ask_report_path(parent, initialfile: str) -> str:
    return filedialog.asksaveasfilename(
        parent=parent,
        defaultextension=".xlsx",
        filetypes=[("Excel", "*.xlsx")],
        initialdir=str(report_dir()),
        initialfile=initialfile,
    ) or ""


def finish_export(app, parent, path: Path):
    app.set_status(f"Đã xuất {path}")
    if messagebox.askyesno("Đã xuất báo cáo", f"Đã lưu:\n{path}\n\nMở file Excel?", parent=parent):
        os.startfile(str(path), "open")



class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Quản lý thi đua — THPT Giao Thủy C")
        self.geometry("1280x800")
        self.minsize(1100, 680)
        self.configure(bg=BG)
        self.con = db.connect()
        db.init_db(self.con)
        self.nam = db.get_active_nam(self.con)
        self._page = None
        self._nav_btns: dict[str, tk.Button] = {}
        self._build_style()
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.show("home")

    def _build_style(self):
        st = ttk.Style(self)
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        st.configure(".", font=("Segoe UI", 10), background=BG)
        st.configure("TFrame", background=BG)
        st.configure("TLabel", background=BG, font=("Segoe UI", 10))
        st.configure("TButton", font=("Segoe UI", 10), padding=6)
        st.configure("Header.TLabel", background=NAVY, foreground=WHITE, font=("Segoe UI", 14, "bold"))
        st.configure("Sub.TLabel", background=NAVY, foreground="#dce6f2", font=("Segoe UI", 10))
        st.configure("Card.TLabelframe", background=WHITE, font=("Segoe UI", 10, "bold"))
        st.configure("Card.TLabelframe.Label", background=WHITE, foreground=NAVY)
        st.configure("Treeview", font=("Segoe UI", 10), rowheight=26, background=WHITE, fieldbackground=WHITE)
        st.configure("Treeview.Heading", font=("Segoe UI", 9, "bold"), background=NAVY, foreground=WHITE)
        st.map("Treeview", background=[("selected", NAVY)], foreground=[("selected", WHITE)])
        st.map("Treeview.Heading", background=[("active", NAVY_H)])
        st.configure("Accent.TButton", font=("Segoe UI", 10, "bold"))
        st.configure("TNotebook", background=BG)
        st.configure("TNotebook.Tab", font=("Segoe UI", 10), padding=[12, 6])

    def _build_ui(self):
        header = tk.Frame(self, bg=NAVY, height=64)
        header.pack(fill="x")
        header.pack_propagate(False)
        tk.Label(
            header,
            text="  ĐOÀN TRƯỜNG THPT GIAO THỦY C",
            bg=NAVY,
            fg=WHITE,
            font=("Segoe UI", 14, "bold"),
            anchor="w",
        ).pack(side="left", padx=8)
        tk.Label(header, text="Quản lý thi đua chi đoàn", bg=NAVY, fg="#f0d78c", font=("Segoe UI", 11)).pack(
            side="left", padx=12
        )

        right = tk.Frame(header, bg=NAVY)
        right.pack(side="right", padx=16)
        tk.Label(right, text="Năm học", bg=NAVY, fg="#dce6f2").pack(side="left", padx=(0, 6))
        self.nam_var = tk.StringVar()
        self.nam_cb = ttk.Combobox(right, textvariable=self.nam_var, width=12, state="readonly")
        self.nam_cb.pack(side="left")
        self.nam_cb.bind("<<ComboboxSelected>>", self._on_nam_change)
        ttk.Button(right, text="Năm mới", command=self._new_nam).pack(side="left", padx=8)

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True)

        side = tk.Frame(body, bg=NAVY, width=SIDE_W)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)
        items = [
            ("home", "Tổng quan"),
            ("lop", "Danh sách lớp"),
            ("nhap", "Nhập lỗi / điểm"),
            ("xep", "Kết quả tuần"),
            ("th", "Kết quả học kỳ"),
            ("bc", "Xuất báo cáo"),
            ("qc", "Quy chế thi đua"),
        ]

        for key, label in items:
            b = tk.Button(
                side,
                text="  " + label,
                anchor="w",
                bg=NAVY,
                fg=WHITE,
                activebackground=NAVY_H,
                activeforeground=WHITE,
                relief="flat",
                font=("Segoe UI", 11),
                cursor="hand2",
                command=lambda k=key: self.show(k),
            )
            b.pack(fill="x", pady=1, ipady=10)
            self._nav_btns[key] = b

        tk.Label(side, text="F5  làm mới\nCtrl+S  lưu lớp", bg=NAVY, fg="#8aa0b8", font=("Segoe UI", 8), justify="left").pack(
            side="bottom", pady=12, padx=12, anchor="w"
        )

        self.content = tk.Frame(body, bg=BG)
        self.content.pack(side="left", fill="both", expand=True)

        self.status = tk.Label(self, text="Sẵn sàng", anchor="w", bg="#d9e2ec", fg=NAVY, font=("Segoe UI", 9), padx=10)
        self.status.pack(fill="x", side="bottom")

        self.pages = {
            "home": HomePage(self.content, self),
            "lop": LopPage(self.content, self),
            "nhap": NhapPage(self.content, self),
            "xep": XepPage(self.content, self),
            "th": TongHopPage(self.content, self),
            "bc": BaoCaoPage(self.content, self),
            "qc": QuyChePage(self.content, self),
        }

        for p in self.pages.values():
            p.place(relx=0, rely=0, relwidth=1, relheight=1)

        self.bind("<F5>", lambda e: self.refresh())
        self.bind("<Control-s>", lambda e: self.pages["nhap"].save_current())
        self._reload_nam_combo()

    def _reload_nam_combo(self):
        rows = db.list_nam_hoc(self.con)
        self.nam_cb["values"] = [r["ten"] for r in rows]
        if self.nam:
            self.nam_var.set(self.nam["ten"])

    def _on_nam_change(self, _=None):
        ten = self.nam_var.get()
        for r in db.list_nam_hoc(self.con):
            if r["ten"] == ten:
                db.set_active_nam(self.con, r["id"])
                self.nam = r
                break
        self.refresh()
        self.set_status(f"Năm học {ten}")

    def _new_nam(self):
        dlg = tk.Toplevel(self)
        dlg.title("Thêm năm học")
        dlg.transient(self)
        dlg.grab_set()
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=16)
        frm.pack(fill="both", expand=True)
        ttk.Label(frm, text="Năm học (vd 2027-2028)").grid(row=0, column=0, sticky="w")
        var = tk.StringVar()
        ttk.Entry(frm, textvariable=var, width=22).grid(row=1, column=0, pady=6, sticky="w")
        copy = tk.BooleanVar(value=True)
        ttk.Checkbutton(frm, text="Sao chép danh sách lớp năm hiện tại", variable=copy).grid(row=2, column=0, sticky="w")

        def ok():
            ten = var.get().strip()
            if not ten:
                messagebox.showwarning("Thiếu dữ liệu", "Nhập tên năm học.", parent=dlg)
                return
            try:
                db.add_nam_hoc(self.con, ten, copy_from=self.nam["id"] if copy.get() and self.nam else None)
            except Exception as e:
                messagebox.showerror("Lỗi", str(e), parent=dlg)
                return
            dlg.destroy()
            self._reload_nam_combo()
            self.nam_var.set(ten)
            self._on_nam_change()

        ttk.Button(frm, text="Tạo", command=ok).grid(row=3, column=0, pady=10, sticky="e")
        dlg.wait_window()

    def nam_id(self) -> int:
        if not self.nam:
            raise RuntimeError("Chưa có năm học")
        return int(self.nam["id"])

    def show(self, key: str):
        if self._page == "nhap" and key != "nhap":
            if not self.pages["nhap"].confirm_leave():
                return
        self._page = key
        for k, b in self._nav_btns.items():
            if k == key:
                b.configure(bg=GOLD, fg=NAVY, font=("Segoe UI", 11, "bold"))
            else:
                b.configure(bg=NAVY, fg=WHITE, font=("Segoe UI", 11))
        self.pages[key].tkraise()
        self.pages[key].reload()

    def refresh(self):
        self.nam = db.get_active_nam(self.con)
        self._reload_nam_combo()
        if self._page:
            self.pages[self._page].reload()

    def set_status(self, text: str):
        self.status.configure(text=text)

    def latest_tuan(self):
        if not self.nam:
            return None
        rows = db.list_tuan(self.con, self.nam_id())
        return rows[-1] if rows else None

    def _on_close(self):
        if self._page == "nhap" and not self.pages["nhap"].confirm_leave():
            return
        try:
            self.con.close()
        except Exception:
            pass
        self.destroy()


class Page(tk.Frame):
    def __init__(self, parent, app: App):
        super().__init__(parent, bg=BG)
        self.app = app

    def reload(self):
        pass

    def _title(self, text: str) -> tk.Label:
        lb = tk.Label(self, text=text, bg=BG, fg=NAVY, font=("Segoe UI", 16, "bold"), anchor="w")
        lb.pack(fill="x", padx=20, pady=(16, 8))
        return lb


def _tree(parent, columns, headings, widths, stretch_last=True) -> ttk.Treeview:
    wrap = ttk.Frame(parent)
    wrap.pack(fill="both", expand=True)
    ysb = ttk.Scrollbar(wrap, orient="vertical")
    xsb = ttk.Scrollbar(wrap, orient="horizontal")
    tv = ttk.Treeview(
        wrap,
        columns=columns,
        show="headings",
        yscrollcommand=ysb.set,
        xscrollcommand=xsb.set,
        selectmode="browse",
    )
    ysb.config(command=tv.yview)
    xsb.config(command=tv.xview)
    tv.grid(row=0, column=0, sticky="nsew")
    ysb.grid(row=0, column=1, sticky="ns")
    xsb.grid(row=1, column=0, sticky="ew")
    wrap.rowconfigure(0, weight=1)
    wrap.columnconfigure(0, weight=1)
    for c, h, w in zip(columns, headings, widths):
        tv.heading(c, text=h)
        tv.column(c, width=w, anchor="center", stretch=(stretch_last and c == columns[-1]))
    tv.tag_configure("gold", background="#f7e7b0")
    tv.tag_configure("bad", background="#f8d0d0")
    tv.tag_configure("odd", background="#f4f7fa")
    tv.tag_configure("g1", background="#e8f0e8")
    return tv


class HomePage(Page):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self._title("Tổng quan")
        self.body = ttk.Frame(self)
        self.body.pack(fill="both", expand=True, padx=20, pady=8)

    def reload(self):
        for w in self.body.winfo_children():
            w.destroy()
        nam = self.app.nam
        if not nam:
            ttk.Label(self.body, text="Chưa có năm học.").pack(anchor="w")
            return
        lops = db.list_lop(self.app.con, nam["id"])
        tuans = db.list_tuan(self.app.con, nam["id"])
        tuan = tuans[-1] if tuans else None

        top = ttk.Frame(self.body)
        top.pack(fill="x")
        for i, (label, value) in enumerate(
            [
                ("Năm học", nam["ten"]),
                ("Số lớp", str(len(lops))),
                ("Số tuần đã nhập", str(len(tuans))),
                ("Tuần hiện tại", tuan_label(tuan) if tuan else "—"),
            ]
        ):
            card = tk.Frame(top, bg=WHITE, highlightbackground="#c5d0dc", highlightthickness=1)
            card.grid(row=0, column=i, padx=6, sticky="nsew")
            top.columnconfigure(i, weight=1)
            tk.Label(card, text=label, bg=WHITE, fg="#5b6b7c", font=("Segoe UI", 9)).pack(anchor="w", padx=14, pady=(10, 0))
            tk.Label(card, text=value, bg=WHITE, fg=NAVY, font=("Segoe UI", 13, "bold"), wraplength=240, justify="left").pack(
                anchor="w", padx=14, pady=(2, 12)
            )

        tk.Label(
            self.body,
            text="Cô nhập lỗi/điểm trừ ở “Nhập lỗi / điểm” → xem tổng cộng-trừ và xếp thứ ở “Kết quả tuần” và “Kết quả học kỳ”.",
            bg=BG,
            fg=NAVY,
            font=("Segoe UI", 10),
            wraplength=1100,
            justify="left",
        ).pack(anchor="w", pady=(14, 0))

        if not tuan:
            ttk.Label(self.body, text="Chưa có tuần. Vào “Nhập lỗi / điểm” để tạo tuần đầu tiên.").pack(anchor="w", pady=20)
            ttk.Button(self.body, text="Tạo tuần", command=lambda: self.app.show("nhap")).pack(anchor="w")
            return


        results = results_for_tuan(self.app.con, tuan["id"])
        bad = [it for it in results if it.diem_nn < 0]
        tk.Label(self.body, text=f"Vi phạm tuần này: {len(bad)} lớp", bg=BG, fg=NAVY, font=("Segoe UI", 12, "bold")).pack(
            anchor="w", pady=(18, 6)
        )

        cols = ttk.Frame(self.body)
        cols.pack(fill="both", expand=True)
        for gi, nhom in enumerate((1, 2)):
            box = tk.LabelFrame(cols, text=f"Nhóm {nhom} — top 5", bg=WHITE, font=("Segoe UI", 10, "bold"), fg=NAVY, padx=8, pady=8)
            box.grid(row=0, column=gi, sticky="nsew", padx=6)
            cols.columnconfigure(gi, weight=1)
            cols.rowconfigure(0, weight=1)
            grp = sorted([it for it in results if it.nhom == nhom], key=lambda x: x.xt_chung)
            tv = ttk.Treeview(box, columns=("lop", "xt", "nn", "ht"), show="headings", height=8)
            for c, h, w in zip(("lop", "xt", "nn", "ht"), ("Lớp", "XT chung", "TB NN", "TB HT"), (70, 80, 80, 80)):
                tv.heading(c, text=h)
                tv.column(c, width=w, anchor="center")
            tv.tag_configure("gold", background="#f7e7b0")
            tv.tag_configure("bad", background="#f8d0d0")
            for it in grp[:5]:
                tag = "gold" if it.xt_chung == 1 else ("bad" if it.diem_nn < 0 else "")
                tv.insert("", "end", values=(it.ten, it.xt_chung, f"{it.tb_nn:.4f}", f"{it.tb_ht:.2f}"), tags=(tag,))
            tv.pack(fill="both", expand=True)

        if bad:
            tk.Label(self.body, text="Lớp bị trừ điểm", bg=BG, fg=RED, font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(12, 4))
            line = ",  ".join(f"{it.ten} ({it.diem_nn:g})" for it in bad)
            tk.Label(self.body, text=line, bg=BG, fg=RED, wraplength=1000, justify="left").pack(anchor="w")


class LopPage(Page):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self._title("Danh sách lớp")
        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=20)
        ttk.Button(bar, text="Thêm lớp", command=self._edit).pack(side="left")
        ttk.Button(bar, text="Sửa", command=lambda: self._edit(True)).pack(side="left", padx=6)
        ttk.Button(bar, text="Xóa", command=self._del).pack(side="left")
        self.tv = _tree(self, ("nhom", "ten", "khoi", "siso", "gvcn", "tt"), ("Nhóm", "Lớp", "Khối", "Sĩ số", "GVCN", "Thứ tự"), (70, 90, 70, 80, 200, 80))
        self.tv.master.pack(fill="both", expand=True, padx=20, pady=10)
        self.tv.bind("<Double-1>", lambda e: self._edit(True))

    def reload(self):
        self.tv.delete(*self.tv.get_children())
        if not self.app.nam:
            return
        for i, r in enumerate(db.list_lop(self.app.con, self.app.nam_id())):
            tag = "g1" if r["nhom"] == 1 else "odd"
            self.tv.insert("", "end", iid=str(r["id"]), values=(r["nhom"], r["ten"], r["khoi"], r["si_so"], r["gvcn"], r["thu_tu"]), tags=(tag,))

    def _sel_id(self):
        s = self.tv.selection()
        return int(s[0]) if s else None

    def _edit(self, existing=False):
        data = {"id": None, "ten": "", "khoi": 10, "nhom": 1, "si_so": 40, "gvcn": "", "thu_tu": 0}
        if existing:
            lid = self._sel_id()
            if not lid:
                messagebox.showinfo("Chọn lớp", "Hãy chọn một lớp.", parent=self)
                return
            row = next(r for r in db.list_lop(self.app.con, self.app.nam_id()) if r["id"] == lid)
            data = dict(row)
        dlg = tk.Toplevel(self)
        dlg.title("Lớp")
        dlg.transient(self.app)
        dlg.grab_set()
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=16)
        frm.pack()
        vars_ = {}
        fields = [("ten", "Tên lớp"), ("khoi", "Khối (10/11/12)"), ("nhom", "Nhóm (1/2)"), ("si_so", "Sĩ số"), ("gvcn", "GVCN"), ("thu_tu", "Thứ tự")]
        for i, (k, lab) in enumerate(fields):
            ttk.Label(frm, text=lab).grid(row=i, column=0, sticky="w", pady=3)
            v = tk.StringVar(value=str(data.get(k, "")))
            ttk.Entry(frm, textvariable=v, width=24).grid(row=i, column=1, pady=3)
            vars_[k] = v

        def ok():
            try:
                payload = {
                    "id": data.get("id"),
                    "ten": vars_["ten"].get().strip().upper(),
                    "khoi": int(vars_["khoi"].get()),
                    "nhom": int(vars_["nhom"].get()),
                    "si_so": int(vars_["si_so"].get()),
                    "gvcn": vars_["gvcn"].get().strip(),
                    "thu_tu": int(vars_["thu_tu"].get() or 0),
                }
            except ValueError:
                messagebox.showwarning("Sai số", "Khối, nhóm, sĩ số, thứ tự phải là số.", parent=dlg)
                return
            if not payload["ten"]:
                messagebox.showwarning("Thiếu tên", "Nhập tên lớp.", parent=dlg)
                return
            if payload["nhom"] not in (1, 2):
                messagebox.showwarning("Nhóm", "Nhóm chỉ nhận 1 hoặc 2.", parent=dlg)
                return
            try:
                db.upsert_lop(self.app.con, self.app.nam_id(), payload)
            except Exception as e:
                messagebox.showerror("Lỗi", str(e), parent=dlg)
                return
            dlg.destroy()
            self.reload()
            self.app.set_status(f"Đã lưu lớp {payload['ten']}")

        ttk.Button(frm, text="Lưu", command=ok).grid(row=len(fields), column=1, sticky="e", pady=10)

    def _del(self):
        lid = self._sel_id()
        if not lid:
            return
        ten = self.tv.item(str(lid), "values")[1]
        if not messagebox.askyesno("Xóa lớp", f"Xóa lớp {ten} và toàn bộ điểm tuần của lớp này?", parent=self):
            return
        db.delete_lop(self.app.con, lid)
        self.reload()
        self.app.set_status(f"Đã xóa {ten}")


class NhapPage(Page):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self._title("Nhập lỗi vi phạm / điểm trừ — hệ thống ra tổng cộng-trừ")

        self.tuan_id = None
        self.lop_id = None
        self.dirty = False
        self.si_so = 0
        self.vars: dict[str, tk.StringVar] = {}

        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=20)
        ttk.Label(bar, text="Tuần:").pack(side="left")
        self.tuan_var = tk.StringVar()
        self.tuan_cb = ttk.Combobox(bar, textvariable=self.tuan_var, width=48, state="readonly")
        self.tuan_cb.pack(side="left", padx=6)
        self.tuan_cb.bind("<<ComboboxSelected>>", self._on_tuan)
        ttk.Button(bar, text="Tạo tuần", command=self._new_tuan).pack(side="left", padx=4)
        ttk.Button(bar, text="Sửa tuần", command=self._edit_tuan).pack(side="left")
        ttk.Button(bar, text="Xóa tuần", command=self._del_tuan).pack(side="left", padx=4)

        pan = ttk.Panedwindow(self, orient="horizontal")
        pan.pack(fill="both", expand=True, padx=20, pady=10)

        left = ttk.Frame(pan)
        right = ttk.Frame(pan)
        pan.add(left, weight=1)
        pan.add(right, weight=3)

        ttk.Label(left, text="Lớp").pack(anchor="w")
        self.lop_tv = ttk.Treeview(left, columns=("ten", "nn"), show="headings", height=22, selectmode="browse")
        self.lop_tv.heading("ten", text="Lớp")
        self.lop_tv.heading("nn", text="Tổng trừ")


        self.lop_tv.column("ten", width=80, anchor="center")
        self.lop_tv.column("nn", width=80, anchor="center")
        self.lop_tv.tag_configure("bad", background="#f8d0d0")
        self.lop_tv.tag_configure("g1", background="#e8f0e8")
        sb = ttk.Scrollbar(left, command=self.lop_tv.yview)
        self.lop_tv.configure(yscrollcommand=sb.set)
        self.lop_tv.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.lop_tv.bind("<<TreeviewSelect>>", self._on_lop)

        self.form = ttk.Frame(right)
        self.form.pack(fill="both", expand=True)
        self.head = tk.Label(self.form, text="Chọn lớp", bg=BG, fg=NAVY, font=("Segoe UI", 13, "bold"))
        self.head.pack(anchor="w", pady=(0, 6))

        prev = tk.Frame(self.form, bg=WHITE, highlightbackground="#c5d0dc", highlightthickness=1)
        prev.pack(fill="x", pady=(0, 8))
        self.prev_tru = tk.Label(prev, text="Tổng trừ: 0", bg=WHITE, fg=RED, font=("Segoe UI", 11, "bold"))
        self.prev_cong = tk.Label(prev, text="Tổng cộng: 0", bg=WHITE, fg=GREEN, font=("Segoe UI", 11, "bold"))
        self.prev_net = tk.Label(prev, text="Tổng net: 0", bg=WHITE, fg=NAVY, font=("Segoe UI", 11, "bold"))
        self.prev_tb = tk.Label(prev, text="TB NN: 0", bg=WHITE, font=("Segoe UI", 10))
        self.prev_ht = tk.Label(prev, text="TB học tập: 0", bg=WHITE, font=("Segoe UI", 10))
        self.prev_tru.pack(side="left", padx=10, pady=8)
        self.prev_cong.pack(side="left", padx=10)
        self.prev_net.pack(side="left", padx=10)
        self.prev_tb.pack(side="left", padx=10)
        self.prev_ht.pack(side="left", padx=10)
        self.prev_nn = self.prev_tru


        canvas = tk.Canvas(self.form, bg=BG, highlightthickness=0)
        vsb = ttk.Scrollbar(self.form, orient="vertical", command=canvas.yview)
        inner = ttk.Frame(canvas)
        inner.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=inner, anchor="nw")
        canvas.configure(yscrollcommand=vsb.set)
        canvas.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        canvas.bind("<Enter>", lambda e: canvas.bind_all("<MouseWheel>", lambda ev: canvas.yview_scroll(int(-1 * (ev.delta / 120)), "units")))
        canvas.bind("<Leave>", lambda e: canvas.unbind_all("<MouseWheel>"))

        nn_box = ttk.LabelFrame(inner, text="1. Nề nếp — nhập ĐIỂM TRỪ (số dương)", padding=8)
        nn_box.pack(fill="x", pady=4)
        for i, (key, lab, hint) in enumerate(NN_COLS):
            r, c = divmod(i, 2)
            cell = ttk.Frame(nn_box)
            cell.grid(row=r, column=c, sticky="ew", padx=6, pady=3)
            nn_box.columnconfigure(c, weight=1)
            ttk.Label(cell, text=lab, width=18).pack(side="left")
            v = tk.StringVar(value="0")
            ttk.Entry(cell, textvariable=v, width=8).pack(side="left")
            ttk.Label(cell, text=hint, foreground="#667788").pack(side="left", padx=6)
            v.trace_add("write", lambda *_: self._mark_dirty())
            self.vars[key] = v

        ht_box = ttk.LabelFrame(inner, text="2. Học tập", padding=8)
        ht_box.pack(fill="x", pady=8)
        ttk.Label(ht_box, text="Số giờ xếp loại").grid(row=0, column=0, sticky="w")
        gio_fr = ttk.Frame(ht_box)
        gio_fr.grid(row=1, column=0, sticky="w", pady=4)
        for key, lab, w in HT_GIO_COLS:
            ttk.Label(gio_fr, text=f"{lab} ({w:+d})").pack(side="left")
            v = tk.StringVar(value="0")
            ttk.Entry(gio_fr, textvariable=v, width=6).pack(side="left", padx=(2, 10))
            v.trace_add("write", lambda *_: self._mark_dirty())
            self.vars[key] = v

        ttk.Label(ht_box, text="Kiểm tra miệng").grid(row=2, column=0, sticky="w", pady=(8, 0))
        ktm_fr = ttk.Frame(ht_box)
        ktm_fr.grid(row=3, column=0, sticky="w", pady=4)
        for key, lab in (("ktm_ge5", "Số ≥5"), ("ktm_lt5", "Số <5"), ("ktm_9_10", "9–10 (+2)"), ("ktm_7_8", "7–8 (+1)"), ("ktm_3_4", "3–4 (−1)"), ("ktm_0_2", "0–2 (−2)")):
            ttk.Label(ktm_fr, text=lab).pack(side="left")
            v = tk.StringVar(value="0")
            ttk.Entry(ktm_fr, textvariable=v, width=6).pack(side="left", padx=(2, 10))
            v.trace_add("write", lambda *_: self._mark_dirty())
            self.vars[key] = v

        ttk.Label(ht_box, text="Ghi chú (họ tên HS nghỉ, lỗi…)").grid(row=4, column=0, sticky="w", pady=(8, 0))
        self.ghi = tk.Text(ht_box, height=3, width=80, font=("Segoe UI", 10))
        self.ghi.grid(row=5, column=0, sticky="ew", pady=4)
        self.ghi.bind("<KeyRelease>", lambda e: self._mark_dirty())

        btn = ttk.Frame(inner)
        btn.pack(fill="x", pady=10)
        ttk.Button(btn, text="Thêm lỗi vi phạm", command=self._add_loi).pack(side="left")
        ttk.Button(btn, text="Xóa lỗi đã chọn", command=self._del_loi).pack(side="left", padx=6)
        ttk.Button(btn, text="Lưu lớp  (Ctrl+S)", command=self.save_current).pack(side="left", padx=8)
        ttk.Button(btn, text="Lưu và lớp tiếp", command=self._save_next).pack(side="left")

        log_box = ttk.LabelFrame(inner, text="Lỗi đã cập nhật tuần này (cô thêm ở đây)", padding=6)
        log_box.pack(fill="x", pady=6)
        self.loi_tv = ttk.Treeview(log_box, columns=("loi", "sl", "diem", "hs"), show="headings", height=5)
        for c, h, w in zip(("loi", "sl", "diem", "hs"), ("Lỗi", "SL", "Điểm trừ", "Họ tên HS"), (320, 50, 90, 180)):
            self.loi_tv.heading(c, text=h)
            self.loi_tv.column(c, width=w, anchor="center" if c != "loi" else "w")
        self.loi_tv.pack(fill="x")

        self._loading = False


    def _mark_dirty(self):
        if self._loading:
            return
        self.dirty = True
        self._preview()

    def _collect(self) -> dict:
        d = {k: parse_num(v.get()) for k, v in self.vars.items()}
        for k in ("gio_tot", "gio_kha", "gio_tb", "gio_yeu", "gio_kem", "ktm_ge5", "ktm_lt5", "ktm_9_10", "ktm_7_8", "ktm_3_4", "ktm_0_2"):
            if k in d:
                d[k] = int(d[k])
        d["ghi_chu"] = self.ghi.get("1.0", "end").strip()
        return d

    def _preview(self):
        d = self._collect()
        tru = tong_tru(d)
        cong = tong_cong(d)
        net = tong_net(d)
        tb = tb_nn(d, self.si_so)
        ht = tb_hoc_tap(d)
        self.prev_tru.configure(text=f"Tổng trừ: {tru:g}", fg=RED if tru else NAVY)
        self.prev_cong.configure(text=f"Tổng cộng: {cong:g}")
        self.prev_net.configure(text=f"Tổng net: {net:g}", fg=GREEN if net >= 0 else RED)
        self.prev_tb.configure(text=f"TB NN: {tb:.4f}  (sĩ số {self.si_so})")
        self.prev_ht.configure(text=f"TB học tập: {ht:.2f}  (giờ {so_gio(d):g})")


    def reload(self):
        if not self.confirm_leave():
            return
        self._fill_tuan_combo()
        self._load_lops()

    def _fill_tuan_combo(self, keep_id=None):
        self.tuan_cb["values"] = []
        if not self.app.nam:
            return
        rows = db.list_tuan(self.app.con, self.app.nam_id())
        self._tuan_rows = rows
        self.tuan_cb["values"] = [tuan_label(t) for t in rows]
        target = keep_id or self.tuan_id
        idx = -1
        if target:
            for i, t in enumerate(rows):
                if t["id"] == target:
                    idx = i
                    break
        if idx < 0 and rows:
            idx = len(rows) - 1
        if idx >= 0:
            self.tuan_cb.current(idx)
            self.tuan_id = rows[idx]["id"]
        else:
            self.tuan_id = None
            self.tuan_var.set("")

    def _on_tuan(self, _=None):
        if not self.confirm_leave():
            self._fill_tuan_combo(self.tuan_id)
            return
        i = self.tuan_cb.current()
        if i < 0:
            return
        self.tuan_id = self._tuan_rows[i]["id"]
        self._load_lops()

    def _load_lops(self):
        prev = self.lop_id
        self.lop_tv.delete(*self.lop_tv.get_children())
        self.lop_id = None
        if not self.tuan_id:
            self.head.configure(text="Chưa có tuần — bấm “Tạo tuần”")
            return
        db.ensure_diem_rows(self.app.con, self.tuan_id, self.app.nam_id())
        results = results_for_tuan(self.app.con, self.tuan_id)
        first = None
        for it in results:
            tag = "bad" if it.tong_tru else ("g1" if it.nhom == 1 else "")
            self.lop_tv.insert("", "end", iid=str(it.lop_id), values=(it.ten, f"{it.tong_tru:g}"), tags=(tag,))

            if first is None:
                first = it.lop_id
        pick = prev if prev and self.lop_tv.exists(str(prev)) else first
        if pick:
            self.lop_tv.selection_set(str(pick))
            self.lop_tv.see(str(pick))

    def _on_lop(self, _=None):
        s = self.lop_tv.selection()
        if not s:
            return
        new_id = int(s[0])
        if new_id == self.lop_id:
            return
        if not self.confirm_leave():
            if self.lop_id:
                self.lop_tv.selection_set(str(self.lop_id))
            return
        self._load_form(new_id)

    def _load_form(self, lop_id: int):
        self._loading = True
        self.lop_id = lop_id
        rows = db.get_diem_join(self.app.con, self.tuan_id)
        row = next(r for r in rows if r["lop_id"] == lop_id)
        self.si_so = int(row["si_so"] or 0)
        self.head.configure(text=f"Nhóm {row['nhom']}  ·  {row['ten']}  ·  sĩ số {self.si_so}")
        for k, v in self.vars.items():
            val = row.get(k, 0) or 0
            v.set(str(int(val) if float(val) == int(float(val)) else val))
        self.ghi.delete("1.0", "end")
        self.ghi.insert("1.0", row.get("ghi_chu") or "")
        self._loading = False
        self.dirty = False
        self._preview()
        self._reload_loi()


    def _reload_loi(self):
        self.loi_tv.delete(*self.loi_tv.get_children())
        if not self.tuan_id or not self.lop_id:
            return
        for r in db.list_loi(self.app.con, self.tuan_id, self.lop_id):
            sl = r["so_luong"]
            sl_s = str(int(sl) if float(sl) == int(float(sl)) else sl)
            self.loi_tv.insert(
                "",
                "end",
                iid=str(r["id"]),
                values=(r["ten_loi"], sl_s, f"{r['diem_tru']:g}", r["ho_ten"] or ""),
            )

    def _add_loi(self):
        if not self.tuan_id or not self.lop_id:
            messagebox.showinfo("Chưa chọn", "Chọn tuần và lớp trước.", parent=self)
            return
        if not self.save_current():
            return
        dlg = tk.Toplevel(self)
        dlg.title("Thêm lỗi vi phạm")
        dlg.transient(self.app)
        dlg.grab_set()
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=16)
        frm.pack()
        labels = [f"{ten}  (−{diem:g}/{dv})" for _k, ten, diem, dv in LOI_MAU]
        ttk.Label(frm, text="Loại lỗi").grid(row=0, column=0, sticky="w")
        loai = tk.StringVar(value=labels[0])
        cb = ttk.Combobox(frm, textvariable=loai, values=labels, width=52, state="readonly")
        cb.grid(row=0, column=1, pady=4)
        ttk.Label(frm, text="Số lượng").grid(row=1, column=0, sticky="w")
        sl = tk.StringVar(value="1")
        ttk.Entry(frm, textvariable=sl, width=12).grid(row=1, column=1, sticky="w", pady=4)
        ttk.Label(frm, text="Họ tên HS (nếu có)").grid(row=2, column=0, sticky="w")
        tenhs = tk.StringVar()
        ttk.Entry(frm, textvariable=tenhs, width=40).grid(row=2, column=1, sticky="w", pady=4)
        preview = ttk.Label(frm, text="Điểm trừ: 0")
        preview.grid(row=3, column=1, sticky="w", pady=6)

        def _prev(*_):
            i = cb.current()
            if i < 0:
                i = 0
            _k, _t, diem, dv = LOI_MAU[i]
            n = parse_num(sl.get())
            preview.configure(text=f"Điểm trừ: {n * diem:g}   ({n:g} {dv} × {diem:g})")

        sl.trace_add("write", _prev)
        cb.bind("<<ComboboxSelected>>", _prev)
        _prev()

        def ok():
            i = cb.current()
            if i < 0:
                i = 0
            field, ten_loi, diem_mot, _dv = LOI_MAU[i]
            n = parse_num(sl.get())
            if n <= 0:
                messagebox.showwarning("Số lượng", "Số lượng phải > 0.", parent=dlg)
                return
            try:
                db.ensure_diem_rows(self.app.con, self.tuan_id, self.app.nam_id())
                diem = db.add_loi(
                    self.app.con,
                    self.tuan_id,
                    self.lop_id,
                    field,
                    ten_loi,
                    n,
                    diem_mot,
                    tenhs.get().strip(),
                )
            except Exception as e:
                messagebox.showerror("Lỗi", str(e), parent=dlg)
                return
            dlg.destroy()
            self.dirty = False
            self._load_form(self.lop_id)
            self._load_lops()
            self.app.set_status(f"Đã thêm lỗi −{diem:g}")

        ttk.Button(frm, text="Cập nhật vào chi đoàn", command=ok).grid(row=4, column=1, sticky="e", pady=8)

    def _del_loi(self):
        s = self.loi_tv.selection()
        if not s:
            return
        if not messagebox.askyesno("Xóa lỗi", "Xóa lỗi này và trừ lại điểm?", parent=self):
            return
        if not self.save_current():
            return
        db.delete_loi(self.app.con, int(s[0]))
        self.dirty = False
        self._load_form(self.lop_id)
        self._load_lops()


    def confirm_leave(self) -> bool:
        if not self.dirty:
            return True
        ans = messagebox.askyesnocancel("Chưa lưu", "Lớp hiện tại chưa lưu. Lưu trước khi chuyển?", parent=self)
        if ans is None:
            return False
        if ans:
            return self.save_current()
        self.dirty = False
        return True

    def save_current(self, _=None) -> bool:
        if not self.tuan_id or not self.lop_id:
            return True
        try:
            db.save_diem(self.app.con, self.tuan_id, self.lop_id, self._collect())
        except Exception as e:
            messagebox.showerror("Lỗi lưu", str(e), parent=self)
            return False
        self.dirty = False
        d = self._collect()
        tru = tong_tru(d)
        ten = self.head.cget("text")
        tag = "bad" if tru else ""
        try:
            vals = self.lop_tv.item(str(self.lop_id), "values")
            self.lop_tv.item(str(self.lop_id), values=(vals[0], f"{tru:g}"), tags=(tag,))

        except tk.TclError:
            pass
        self.app.set_status(f"Đã lưu {ten}")
        self._preview()
        return True

    def _save_next(self):
        if not self.save_current():
            return
        kids = self.lop_tv.get_children()
        if not kids or not self.lop_id:
            return
        ids = [int(k) for k in kids]
        try:
            i = ids.index(self.lop_id)
        except ValueError:
            return
        nxt = ids[(i + 1) % len(ids)]
        self.lop_tv.selection_set(str(nxt))
        self.lop_tv.see(str(nxt))

    def _tuan_dialog(self, existing=None):
        dlg = tk.Toplevel(self)
        dlg.title("Tuần")
        dlg.transient(self.app)
        dlg.grab_set()
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=16)
        frm.pack()
        fields = [("so_tuan", "Tuần số"), ("thang", "Tháng"), ("nam", "Năm"), ("hoc_ky", "Học kỳ (1/2)"), ("ghi_chu", "Ghi chú")]
        defaults = existing or {"so_tuan": 1, "thang": 9, "nam": 2026, "hoc_ky": 1, "ghi_chu": ""}
        vs = {}
        for i, (k, lab) in enumerate(fields):
            ttk.Label(frm, text=lab).grid(row=i, column=0, sticky="w", pady=3)
            v = tk.StringVar(value=str(defaults.get(k, "")))
            ttk.Entry(frm, textvariable=v, width=28).grid(row=i, column=1)
            vs[k] = v

        def ok():
            try:
                payload = {
                    "id": defaults.get("id"),
                    "so_tuan": int(vs["so_tuan"].get()),
                    "thang": int(vs["thang"].get()),
                    "nam": int(vs["nam"].get()),
                    "hoc_ky": int(vs["hoc_ky"].get()),
                    "ghi_chu": vs["ghi_chu"].get().strip(),
                }
            except ValueError:
                messagebox.showwarning("Sai số", "Tuần, tháng, năm, học kỳ phải là số.", parent=dlg)
                return
            if payload["hoc_ky"] not in (1, 2):
                messagebox.showwarning("Học kỳ", "Học kỳ là 1 hoặc 2.", parent=dlg)
                return
            try:
                tid = db.upsert_tuan(self.app.con, self.app.nam_id(), payload)
            except Exception as e:
                messagebox.showerror("Lỗi", str(e), parent=dlg)
                return
            dlg.destroy()
            self.tuan_id = tid
            self._fill_tuan_combo(tid)
            self._load_lops()

        ttk.Button(frm, text="Lưu", command=ok).grid(row=len(fields), column=1, sticky="e", pady=10)

    def _new_tuan(self):
        if not self.confirm_leave():
            return
        prev = self.app.latest_tuan()
        data = {"so_tuan": 1, "thang": 9, "nam": 2026, "hoc_ky": 1, "ghi_chu": ""}
        if prev:
            data = {
                "so_tuan": prev["so_tuan"] + 1,
                "thang": prev["thang"],
                "nam": prev["nam"],
                "hoc_ky": prev["hoc_ky"],
                "ghi_chu": "",
            }
        self._tuan_dialog(data)

    def _edit_tuan(self):
        if not self.tuan_id:
            return
        t = db.get_tuan(self.app.con, self.tuan_id)
        self._tuan_dialog(dict(t))

    def _del_tuan(self):
        if not self.tuan_id:
            return
        if not messagebox.askyesno("Xóa tuần", "Xóa tuần này và toàn bộ điểm đã nhập?", parent=self):
            return
        db.delete_tuan(self.app.con, self.tuan_id)
        self.tuan_id = None
        self.dirty = False
        self._fill_tuan_combo()
        self._load_lops()



class XepPage(Page):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self._title("Kết quả tuần — tổng cộng/trừ và xếp thứ chi đoàn")
        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=20)
        ttk.Label(bar, text="Tuần:").pack(side="left")
        self.tuan_var = tk.StringVar()
        self.tuan_cb = ttk.Combobox(bar, textvariable=self.tuan_var, width=48, state="readonly")
        self.tuan_cb.pack(side="left", padx=6)
        self.tuan_cb.bind("<<ComboboxSelected>>", lambda e: self._fill_table())
        ttk.Label(bar, text="Nhóm:").pack(side="left", padx=(12, 4))
        self.nhom_var = tk.StringVar(value="Tất cả")
        nh = ttk.Combobox(bar, textvariable=self.nhom_var, values=("Tất cả", "Nhóm 1", "Nhóm 2"), width=10, state="readonly")
        nh.pack(side="left")
        nh.bind("<<ComboboxSelected>>", lambda e: self._fill_table())
        ttk.Button(bar, text="Xuất Excel", command=self._export).pack(side="right")
        cols = ("nhom", "lop", "siso", "tru", "cong", "net", "tbnn", "xtnn", "tbht", "xtht", "tong", "xt")
        heads = ("Nhóm", "Lớp", "Sĩ số", "Tổng trừ", "Tổng cộng", "Tổng net", "TB NN", "XT NN", "TB HT", "XT HT", "Tổng XT", "XT tuần")
        widths = (55, 70, 60, 80, 90, 80, 80, 70, 70, 70, 80, 80)
        self.tv = _tree(self, cols, heads, widths)
        self.tv.master.pack(fill="both", expand=True, padx=20, pady=10)
        self._results: list[ClassResult] = []


    def reload(self):
        if not self.app.nam:
            return
        rows = db.list_tuan(self.app.con, self.app.nam_id())
        self._tuan_rows = rows
        self.tuan_cb["values"] = [tuan_label(t) for t in rows]
        if rows:
            self.tuan_cb.current(len(rows) - 1)
        else:
            self.tuan_var.set("")
        self._fill_table()

    def _fill_table(self):
        self.tv.delete(*self.tv.get_children())
        self._results = []
        i = self.tuan_cb.current()
        if i < 0:
            return
        tid = self._tuan_rows[i]["id"]
        results = results_for_tuan(self.app.con, tid)
        self._results = results
        filt = self.nhom_var.get()
        for n, it in enumerate(results):
            if filt == "Nhóm 1" and it.nhom != 1:
                continue
            if filt == "Nhóm 2" and it.nhom != 2:
                continue
            tag = "gold" if it.xt_chung == 1 else ("bad" if it.tong_tru else ("odd" if n % 2 else ""))
            self.tv.insert(
                "",
                "end",
                values=(
                    it.nhom,
                    it.ten,
                    it.si_so,
                    f"{it.tong_tru:g}",
                    f"{it.tong_cong:g}",
                    f"{it.tong_net:g}",
                    f"{it.tb_nn:.4f}",
                    it.xt_nn,
                    f"{it.tb_ht:.2f}",
                    it.xt_ht,
                    it.tong_xt,
                    it.xt_chung,
                ),
                tags=(tag,),
            )

    def _export(self):
        if not self._results:
            messagebox.showinfo("Trống", "Chưa có dữ liệu tuần.", parent=self)
            return
        i = self.tuan_cb.current()
        t = self._tuan_rows[i]
        path = ask_report_path(self, f"Bao_cao_tuan_{t['so_tuan']}_thang_{t['thang']}_{t['nam']}.xlsx")
        if not path:
            return
        lois = db.list_loi_tuan(self.app.con, t["id"])
        export_tuan(Path(path), self.app.nam["ten"], tuan_label(t), self._results, lois=lois)
        finish_export(self.app, self, Path(path))



class TongHopPage(Page):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self._title("Kết quả học kỳ — tổng cộng/trừ cả kỳ và xếp thứ")

        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=20)
        self.mode = tk.StringVar(value="hk")
        for val, lab in (("thang", "Theo tháng"), ("hk", "Theo học kỳ"), ("nam", "Cả năm")):
            ttk.Radiobutton(bar, text=lab, value=val, variable=self.mode, command=self._rebuild_filter).pack(side="left", padx=6)
        self.filter_var = tk.StringVar()
        self.filter_cb = ttk.Combobox(bar, textvariable=self.filter_var, width=24, state="readonly")
        self.filter_cb.pack(side="left", padx=12)
        self.filter_cb.bind("<<ComboboxSelected>>", lambda e: self._fill())
        ttk.Button(bar, text="Xuất Excel", command=self._export).pack(side="right")
        self.tv = _tree(self, ("nhom", "lop", "tong", "xt", "ntuan"), ("Nhóm", "Lớp", "Tổng XT tuần", "XT", "Số tuần"), (80, 90, 140, 80, 90))
        self.tv.master.pack(fill="both", expand=True, padx=20, pady=10)
        self.note = tk.Label(self, text="", bg=BG, fg="#555", font=("Segoe UI", 9), anchor="w")
        self.note.pack(fill="x", padx=20, pady=(0, 8))
        self._rows = []
        self._title_export = ""

    def reload(self):
        self._rebuild_filter()

    def _rebuild_filter(self):
        self.filter_cb["values"] = []
        if not self.app.nam:
            return
        tuans = db.list_tuan(self.app.con, self.app.nam_id())
        mode = self.mode.get()
        if mode == "thang":
            keys = sorted({(t["nam"], t["thang"]) for t in tuans})
            vals = [f"Tháng {th}/{na}" for na, th in keys]
            self._keys = keys
        elif mode == "hk":
            keys = sorted({t["hoc_ky"] for t in tuans})
            vals = [f"Học kỳ {k}" for k in keys]
            self._keys = keys
        else:
            keys = [self.app.nam["ten"]]
            vals = [f"Năm học {self.app.nam['ten']}"]
            self._keys = keys
        self.filter_cb["values"] = vals
        if vals:
            self.filter_cb.current(len(vals) - 1)
        else:
            self.filter_var.set("")
        self._fill()

    def _selected_tuans(self):
        tuans = db.list_tuan(self.app.con, self.app.nam_id())
        i = self.filter_cb.current()
        if i < 0:
            return [], ""
        mode = self.mode.get()
        if mode == "thang":
            nam, thang = self._keys[i]
            rows = [t for t in tuans if t["nam"] == nam and t["thang"] == thang]
            title = f"TỔNG HỢP THÁNG {thang}/{nam} — Năm học {self.app.nam['ten']}"
        elif mode == "hk":
            hk = self._keys[i]
            rows = [t for t in tuans if t["hoc_ky"] == hk]
            title = f"TỔNG HỢP HỌC KỲ {hk} — Năm học {self.app.nam['ten']}"
        else:
            rows = list(tuans)
            title = f"TỔNG HỢP CẢ NĂM — Năm học {self.app.nam['ten']}"
        return rows, title

    def _fill(self):
        self.tv.delete(*self.tv.get_children())
        tuans, title = self._selected_tuans()
        self._title_export = title
        self._rows = aggregate_weeks(self.app.con, tuans)
        week_keys = []
        if self._rows:
            week_keys = sorted(self._rows[0].wmap.keys())
        cols = ("nhom", "lop", "tru", "cong", "net") + tuple(f"t{k}" for k in week_keys) + ("tong", "xt")
        heads = ("Nhóm", "Lớp", "Tổng trừ", "Tổng cộng", "Tổng net") + tuple(f"XT T{k}" for k in week_keys) + (
            "Tổng XT tuần",
            "XT học kỳ",
        )
        widths = (55, 70, 80, 90, 80) + (70,) * len(week_keys) + (100, 90)
        self.tv["columns"] = cols
        for c in self.tv["columns"]:
            self.tv.heading(c, text="")
        for c, h, w in zip(cols, heads, widths):
            self.tv.heading(c, text=h)
            self.tv.column(c, width=w, anchor="center")
        for n, row in enumerate(self._rows):
            tag = "gold" if row.xt == 1 else ("bad" if row.tong_tru else ("odd" if n % 2 else ""))
            vals = (
                (row.nhom, row.ten, f"{row.tong_tru:g}", f"{row.tong_cong:g}", f"{row.tong_net:g}")
                + tuple(row.wmap.get(k, "") for k in week_keys)
                + (row.tong_xt, row.xt)
            )
            self.tv.insert("", "end", values=vals, tags=(tag,))
        self.note.configure(
            text="Tổng trừ/cộng/net = cộng các tuần. XT học kỳ = xếp lại theo tổng XT tuần (thấp hơn = tốt hơn). "
            + (title if title else "")
        )


    def _export(self):
        if not self._rows:
            messagebox.showinfo("Trống", "Chưa có dữ liệu.", parent=self)
            return
        path = ask_report_path(self, "Bao_cao_hoc_ky.xlsx")
        if not path:
            return
        export_tong_hop(Path(path), self.app.nam["ten"], self._title_export, self._rows)
        finish_export(self.app, self, Path(path))



class BaoCaoPage(Page):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self._title("Xuất báo cáo Excel")
        tk.Label(
            self,
            text="Chọn tuần / học kỳ rồi bấm nút. File mặc định lưu trong thư mục BaoCao.",
            bg=BG,
            fg="#445566",
            font=("Segoe UI", 10),
            anchor="w",
        ).pack(fill="x", padx=20)

        box = ttk.Frame(self)
        box.pack(fill="x", padx=20, pady=16)

        row1 = ttk.Frame(box)
        row1.pack(fill="x", pady=8)
        ttk.Label(row1, text="Tuần:").pack(side="left")
        self.tuan_var = tk.StringVar()
        self.tuan_cb = ttk.Combobox(row1, textvariable=self.tuan_var, width=50, state="readonly")
        self.tuan_cb.pack(side="left", padx=8)
        ttk.Button(row1, text="Xuất báo cáo tuần", command=self._xuat_tuan).pack(side="left", padx=8)

        row2 = ttk.Frame(box)
        row2.pack(fill="x", pady=8)
        ttk.Label(row2, text="Học kỳ:").pack(side="left")
        self.hk_var = tk.StringVar()
        self.hk_cb = ttk.Combobox(row2, textvariable=self.hk_var, width=20, state="readonly")
        self.hk_cb.pack(side="left", padx=8)
        ttk.Button(row2, text="Xuất báo cáo học kỳ", command=self._xuat_hk).pack(side="left", padx=8)
        ttk.Button(row2, text="Xuất cả năm", command=self._xuat_nam).pack(side="left")

        ttk.Button(box, text="Mở thư mục BaoCao", command=self._open_folder).pack(anchor="w", pady=16)

        self.hint = tk.Label(self, text="", bg=BG, fg=NAVY, font=("Segoe UI", 10), justify="left", anchor="w")
        self.hint.pack(fill="x", padx=20)

    def reload(self):
        if not self.app.nam:
            return
        tuans = db.list_tuan(self.app.con, self.app.nam_id())
        self._tuans = tuans
        self.tuan_cb["values"] = [tuan_label(t) for t in tuans]
        if tuans:
            self.tuan_cb.current(len(tuans) - 1)
        else:
            self.tuan_var.set("")
        hks = sorted({t["hoc_ky"] for t in tuans})
        self.hk_cb["values"] = [f"Học kỳ {k}" for k in hks]
        self._hks = hks
        if hks:
            self.hk_cb.current(len(hks) - 1)
        else:
            self.hk_var.set("")
        self.hint.configure(text=f"Thư mục lưu: {report_dir()}")

    def _xuat_tuan(self):
        i = self.tuan_cb.current()
        if i < 0:
            messagebox.showinfo("Chưa có tuần", "Tạo tuần và nhập điểm trước.", parent=self)
            return
        t = self._tuans[i]
        results = results_for_tuan(self.app.con, t["id"])
        path = ask_report_path(self, f"Bao_cao_tuan_{t['so_tuan']}_thang_{t['thang']}_{t['nam']}.xlsx")
        if not path:
            return
        lois = db.list_loi_tuan(self.app.con, t["id"])
        export_tuan(Path(path), self.app.nam["ten"], tuan_label(t), results, lois=lois)
        finish_export(self.app, self, Path(path))

    def _xuat_hk(self):
        i = self.hk_cb.current()
        if i < 0:
            messagebox.showinfo("Trống", "Chưa có tuần nào trong học kỳ.", parent=self)
            return
        hk = self._hks[i]
        tuans = [t for t in self._tuans if t["hoc_ky"] == hk]
        rows = aggregate_weeks(self.app.con, tuans)
        title = f"TỔNG HỢP HỌC KỲ {hk} — Năm học {self.app.nam['ten']}"
        path = ask_report_path(self, f"Bao_cao_hoc_ky_{hk}.xlsx")
        if not path:
            return
        export_tong_hop(Path(path), self.app.nam["ten"], title, rows)
        finish_export(self.app, self, Path(path))

    def _xuat_nam(self):
        if not getattr(self, "_tuans", None):
            messagebox.showinfo("Trống", "Chưa có dữ liệu năm học.", parent=self)
            return
        rows = aggregate_weeks(self.app.con, self._tuans)
        title = f"TỔNG HỢP CẢ NĂM — Năm học {self.app.nam['ten']}"
        path = ask_report_path(self, f"Bao_cao_ca_nam_{self.app.nam['ten']}.xlsx")
        if not path:
            return
        export_tong_hop(Path(path), self.app.nam["ten"], title, rows)
        finish_export(self.app, self, Path(path))

    def _open_folder(self):
        os.startfile(str(report_dir()), "open")


class QuyChePage(Page):
    def __init__(self, parent, app):
        super().__init__(parent, app)
        self._title("Quy chế thi đua năm học 2026–2027")
        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=20)
        ttk.Label(bar, text="Tìm:").pack(side="left")
        self.q = tk.StringVar()
        ent = ttk.Entry(bar, textvariable=self.q, width=40)
        ent.pack(side="left", padx=6)
        ent.bind("<KeyRelease>", lambda e: self.reload())
        self.tv = _tree(
            self,
            ("stt", "muc", "nd", "diem", "gc"),
            ("STT", "Mục", "Nội dung", "Điểm", "Ghi chú"),
            (50, 90, 640, 160, 180),
        )
        self.tv.master.pack(fill="both", expand=True, padx=20, pady=10)
        tk.Label(
            self,
            text="Cách dùng: “Nhập lỗi / điểm” → Thêm lỗi vi phạm (chọn loại, số lượng) hoặc gõ điểm trừ. Hệ thống ra tổng cộng/trừ và xếp thứ tuần + học kỳ.",
            bg=BG,
            fg="#555",
            anchor="w",
        ).pack(fill="x", padx=20, pady=(0, 10))


    def reload(self):
        self.tv.delete(*self.tv.get_children())
        q = (self.q.get() or "").casefold()
        for i, r in enumerate(db.list_quy_che(self.app.con)):
            blob = " ".join(str(r[k]) for k in ("stt", "muc", "noi_dung", "diem", "ghi_chu")).casefold()
            if q and q not in blob:
                continue
            tag = "odd" if i % 2 else ""
            self.tv.insert("", "end", values=(r["stt"], r["muc"], r["noi_dung"], r["diem"], r["ghi_chu"]), tags=(tag,))


def main():
    try:
        from ctypes import windll

        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
