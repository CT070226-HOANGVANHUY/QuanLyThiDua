"""SQLite: schema, seed, truy vấn."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .scoring import NN_KEYS, GIO_KEYS, KTM_SCORE_KEYS

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "thidua.db"

NN_SQL = ", ".join(f"{k} REAL NOT NULL DEFAULT 0" for k in NN_KEYS)
GIO_SQL = ", ".join(f"{k} INTEGER NOT NULL DEFAULT 0" for k in GIO_KEYS)
KTM_SQL = ", ".join(f"{k} INTEGER NOT NULL DEFAULT 0" for k in KTM_SCORE_KEYS)

SCHEMA = f"""
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS nam_hoc (
    id INTEGER PRIMARY KEY,
    ten TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lop (
    id INTEGER PRIMARY KEY,
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    ten TEXT NOT NULL,
    khoi INTEGER NOT NULL,
    nhom INTEGER NOT NULL,
    si_so INTEGER NOT NULL DEFAULT 0,
    gvcn TEXT NOT NULL DEFAULT '',
    thu_tu INTEGER NOT NULL DEFAULT 0,
    UNIQUE(nam_hoc_id, ten)
);

CREATE TABLE IF NOT EXISTS tuan (
    id INTEGER PRIMARY KEY,
    nam_hoc_id INTEGER NOT NULL REFERENCES nam_hoc(id) ON DELETE CASCADE,
    so_tuan INTEGER NOT NULL,
    thang INTEGER NOT NULL,
    nam INTEGER NOT NULL,
    hoc_ky INTEGER NOT NULL DEFAULT 1,
    ghi_chu TEXT NOT NULL DEFAULT '',
    UNIQUE(nam_hoc_id, so_tuan)
);

CREATE TABLE IF NOT EXISTS diem_tuan (
    id INTEGER PRIMARY KEY,
    tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    {NN_SQL},
    {GIO_SQL},
    ktm_ge5 INTEGER NOT NULL DEFAULT 0,
    ktm_lt5 INTEGER NOT NULL DEFAULT 0,
    {KTM_SQL},
    ghi_chu TEXT NOT NULL DEFAULT '',
    UNIQUE(tuan_id, lop_id)
);

CREATE TABLE IF NOT EXISTS quy_che (
    id INTEGER PRIMARY KEY,
    stt TEXT NOT NULL,
    muc TEXT NOT NULL,
    noi_dung TEXT NOT NULL,
    diem TEXT NOT NULL,
    ghi_chu TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS loi_vi_pham (
    id INTEGER PRIMARY KEY,
    tuan_id INTEGER NOT NULL REFERENCES tuan(id) ON DELETE CASCADE,
    lop_id INTEGER NOT NULL REFERENCES lop(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    ten_loi TEXT NOT NULL,
    so_luong REAL NOT NULL DEFAULT 1,
    diem_mot REAL NOT NULL,
    diem_tru REAL NOT NULL,
    ho_ten TEXT NOT NULL DEFAULT '',
    ghi_chu TEXT NOT NULL DEFAULT ''
);

"""

LOP_SEED = [
    # nhom, ten, si_so  — thứ tự Ban in tuần 3
    (1, "11A1", 47),
    (1, "11A2", 44),
    (1, "11A3", 47),
    (1, "11A4", 46),
    (1, "10A1", 44),
    (1, "10A2", 42),
    (1, "10A4", 43),
    (1, "10A6", 43),
    (1, "10A8", 42),
    (1, "12A1", 45),
    (1, "12A2", 45),
    (1, "12A4", 44),
    (1, "12A8", 42),
    (1, "11A8", 41),
    (2, "11A5", 45),
    (2, "11A6", 46),
    (2, "11A7", 44),
    (2, "11A9", 38),
    (2, "11A10", 41),
    (2, "10A3", 43),
    (2, "10A5", 43),
    (2, "10A7", 43),
    (2, "10A9", 41),
    (2, "10A10", 41),
    (2, "12A3", 45),
    (2, "12A5", 42),
    (2, "12A6", 42),
    (2, "12A7", 44),
    (2, "12A9", 43),
    (2, "12A10", 42),
]

QUY_CHE_SEED = [
    ("1", "Nề nếp", "Trang trí lớp (ảnh Bác, đồng hồ, khẩu hiệu Dạy tốt học tốt, nội quy…)", "−5 / 1 lỗi", "Thiếu 1 ứng với 1 lỗi"),
    ("2", "Nề nếp", "Xếp hàng (chào cờ, hoạt động tập thể): xếp ghế muộn, hàng không thẳng, sai khoảng cách…", "−1/HS; tập thể −10", ""),
    ("3", "Nề nếp", "Hát đầu giờ: không hát, sai bài, sai giờ, không nghiêm túc", "−1/HS; tập thể −10", ""),
    ("4", "Nề nếp", "Sinh hoạt 15 phút đầu giờ — HS ra ngoài / đi lại tự do", "−1/HS", ""),
    ("4", "Nề nếp", "Sinh hoạt 15 phút đầu giờ — lớp mất trật tự", "−10", ""),
    ("4", "Nề nếp", "Sinh hoạt 15 phút đầu giờ — không kiểm tra bài tập", "−5", "Báo TNKT nếu không có"),
    ("5", "Nề nếp", "TD giữa giờ, chào cờ: ra muộn, xếp hàng muộn, tập không nghiêm túc", "−1/HS; tập thể −10", ""),
    ("6", "Nề nếp", "Đi học muộn", "−5/HS", ""),
    ("7", "Nề nếp", "Phù hiệu: có mà không đeo / đeo trong áo", "−1/HS", ""),
    ("7", "Nề nếp", "Phù hiệu: quên hoặc mất", "−2/HS", ""),
    ("7", "Nề nếp", "Phù hiệu giả hoặc của năm học trước", "−10/HS", ""),
    ("8", "Nề nếp", "Trang phục không đúng (đồng phục, tóc, giày dép, nam đeo khuyên…)", "−1/HS", ""),
    ("9", "Xe", "Không đội mũ bảo hiểm (xe đạp điện…)", "−30/HS", "Đội không đúng −10"),
    ("9", "Xe", "Không đi đúng làn, nhiều hàng, không xi nhan", "−5/HS", ""),
    ("9", "Xe", "Đi xe trong sân trường", "−10/HS", ""),
    ("9", "Xe", "Để xe không đúng quy định", "−1/HS; tập thể −10", ""),
    ("9", "Xe", "Không vệ sinh nhà xe", "−5/lớp", ""),
    ("10", "Nề nếp", "Nghỉ học không lý do, bỏ giờ, không báo cáo sĩ số", "−10/HS", ""),
    ("11", "TNKT", "Làm nhiệm vụ muộn", "−5/HS", ""),
    ("11", "TNKT", "Không làm nhiệm vụ / bỏ qua lỗi khi kiểm tra", "−10/HS", ""),
    ("11", "TNKT", "Không nộp sổ", "−10/HS", ""),
    ("12", "Vệ sinh", "Không vệ sinh (trực nhật, lau bảng, giặt khăn, quét hiên, khu vực phân công)", "−10/lỗi", ""),
    ("12", "Vệ sinh", "Vệ sinh muộn hoặc bẩn", "−5", ""),
    ("12", "Vệ sinh", "Đổ rác không đúng / không đổ rác", "−5", ""),
    ("12", "Vệ sinh", "Đổ rác muộn", "−5", ""),
    ("12", "Vệ sinh", "Ghế nhựa xếp không đúng", "−5", ""),
    ("12", "Vệ sinh", "Không lấy bình nước", "−10", ""),
    ("12", "Vệ sinh", "Lấy bình nước muộn", "−5", ""),
    ("12", "Vệ sinh", "Lấy sai bình nước", "−10", ""),
    ("12", "Vệ sinh", "Không có xô đựng nước thừa", "−5", ""),
    ("12", "Vệ sinh", "Khay / cốc uống nước bẩn", "−5", ""),
    ("12", "Vệ sinh", "Thiếu gậy ngáng cửa sổ / buộc sai", "−1/gậy", ""),
    ("12", "Vệ sinh", "Thiếu cốc (phải đủ 6)", "−1/cốc", ""),
    ("12", "Vệ sinh", "Lấy sổ đầu bài muộn (trước trống truy bài)", "−5/lần", ""),
    ("12", "Vệ sinh", "Không khóa cửa, đóng cửa sổ, tắt điện, bàn giao chìa khóa", "−10/lỗi", ""),
    ("13", "Nề nếp", "Chống đối TNKT", "−10/HS", ""),
    ("14", "Học tập", "SGK, đồ dùng học tập không đúng, đủ", "−1/HS", ""),
    ("15", "Cộng điểm", "Tiết mục văn nghệ ngày lễ (khai giảng, 20-11, 26-3…)", "+5/tiết mục", ""),
    ("16", "Học tập", "Xếp loại giờ học — giờ tốt", "+2/giờ", ""),
    ("16", "Học tập", "Xếp loại giờ học — giờ khá", "+1/giờ", ""),
    ("16", "Học tập", "Xếp loại giờ học — giờ yếu", "−1/giờ", ""),
    ("16", "Học tập", "Xếp loại giờ học — giờ kém", "−2/giờ", ""),
    ("17", "Học tập", "Kiểm tra miệng — điểm 9 và 10", "+2/điểm", ""),
    ("17", "Học tập", "Kiểm tra miệng — điểm 7 và 8", "+1/điểm", ""),
    ("17", "Học tập", "Kiểm tra miệng — điểm 3 và 4", "−1/điểm", ""),
    ("17", "Học tập", "Kiểm tra miệng — điểm 0, 1 và 2", "−2/điểm", ""),
    ("17", "Học tập", "Ghi sổ đầu bài về ý thức học tập (cá nhân)", "−1/HS", ""),
    ("17", "Học tập", "Ghi sổ đầu bài về ý thức học tập (tập thể)", "−10", ""),
    ("18", "Bí thư", "Không nộp sổ tổng hợp, hoặc tổng hợp sai cao hơn thực tế", "−20", ""),
    ("18", "Bí thư", "Bí thư tổng hợp sai thấp hơn thực tế", "−10", ""),
    ("19", "Khác", "Mang / mua bánh kẹo, đồ ăn vào trường khi không được phép", "−10/HS", ""),
    ("19", "Khác", "Tự ý ra khỏi trường; vượt tường rào", "−10/HS/lỗi", ""),
    ("KL", "Kỷ luật", "Điều khiển xe máy >50cm³ không GPLX; xe 50cm³ / xe điện khi chưa đủ 16 tuổi", "−30/lỗi/HS", "Rèn luyện: Đạt"),
    ("KL", "Kỷ luật", "Vô lễ với thầy cô, CB-CNV", "−50/lỗi/HS", "Chưa đạt"),
    ("KL", "Kỷ luật", "Đánh nhau, gây rối an ninh trong trường và nơi công cộng", "−50/lỗi/HS", "Chưa đạt"),
    ("KL", "Kỷ luật", "Thái độ sai / không trung thực khi kiểm tra, thi, rèn luyện", "−30/lỗi/HS", "Đạt"),
    ("KL", "Kỷ luật", "Phá hoại tài sản", "−30/lỗi/HS", "Đạt"),
    ("KL", "Kỷ luật", "Vẽ, viết làm mất mỹ quan nhà trường", "−30/lỗi/HS", "Đạt"),
    ("KL", "Kỷ luật", "Vi phạm điều lệ trường THPT, vi phạm pháp luật", "−50/lỗi/HS", "Chưa đạt"),
    ("KL", "Kỷ luật", "Sử dụng điện thoại, máy nghe nhạc trong hoạt động giáo dục", "−30/lỗi/HS", "Đạt"),
    ("KL", "Kỷ luật", "Mang, tàng trữ, sử dụng, buôn bán thuốc lá (kể cả điện tử), rượu bia, chất cấm, hung khí…", "−50/lỗi/HS", "Chưa đạt"),
    ("KL", "Kỷ luật", "Các lỗi nghiêm trọng khác", "−30/lỗi/HS", "Đạt"),
    ("*", "Chú ý", "Trong 1 học kỳ, cứ sau 5 lỗi hoặc trừ 30 điểm (vi phạm có hệ thống) thì hạ một bậc kết quả rèn luyện.", "", ""),
]

# Điểm trừ tuần 3/2025 (Ban nhap) — chỉ lớp có số ≠ 0
WEEK3_SCORES = {
    "11A5": {"hs_ky_luat": 30, "gio_tot": 23, "ktm_ge5": 1},
    "11A9": {"hs_ky_luat": 30, "gio_tot": 23, "ktm_ge5": 1},
    "12A6": {"phu_hieu": 1, "gio_tot": 23, "ktm_ge5": 1},
    "12A7": {"vp_khac": 1, "gio_tot": 23, "ktm_ge5": 1},
}
WEEK3_DEFAULT_HT = {"gio_tot": 23, "ktm_ge5": 1}


def connect(path: Path | None = None) -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = path or DB_PATH
    con = sqlite3.connect(db, check_same_thread=False)

    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def _khoi(ten: str) -> int:
    return int(ten[:2])


def init_db(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    n = con.execute("SELECT COUNT(*) FROM nam_hoc").fetchone()[0]
    if n:
        con.commit()
        return
    _seed(con)
    con.commit()


def _seed(con: sqlite3.Connection) -> None:
    con.execute("INSERT INTO nam_hoc(ten, active) VALUES (?, 1)", ("2026-2027",))
    nam_id = con.execute("SELECT id FROM nam_hoc WHERE ten=?", ("2026-2027",)).fetchone()[0]
    for i, (nhom, ten, si_so) in enumerate(LOP_SEED, start=1):
        con.execute(
            "INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, thu_tu) VALUES (?,?,?,?,?,?)",
            (nam_id, ten, _khoi(ten), nhom, si_so, i),
        )
    con.executemany(
        "INSERT INTO quy_che(stt, muc, noi_dung, diem, ghi_chu) VALUES (?,?,?,?,?)",
        QUY_CHE_SEED,
    )
    con.execute(
        "INSERT INTO tuan(nam_hoc_id, so_tuan, thang, nam, hoc_ky, ghi_chu) VALUES (?,?,?,?,?,?)",
        (nam_id, 3, 9, 2026, 1, "Dữ liệu mẫu — Tuần 3 (theo file Excel cũ)"),
    )
    tuan_id = con.execute("SELECT id FROM tuan WHERE nam_hoc_id=? AND so_tuan=?", (nam_id, 3)).fetchone()[0]
    lops = con.execute("SELECT id, ten FROM lop WHERE nam_hoc_id=?", (nam_id,)).fetchall()
    fields = NN_KEYS + GIO_KEYS + ["ktm_ge5", "ktm_lt5"] + KTM_SCORE_KEYS
    placeholders = ", ".join(["?"] * (2 + len(fields)))
    col_sql = "tuan_id, lop_id, " + ", ".join(fields)
    for lop in lops:
        scores = dict(WEEK3_DEFAULT_HT)
        scores.update(WEEK3_SCORES.get(lop["ten"], {}))
        vals = [tuan_id, lop["id"]] + [scores.get(f, 0) for f in fields]
        con.execute(f"INSERT INTO diem_tuan({col_sql}) VALUES ({placeholders})", vals)


def list_nam_hoc(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute("SELECT * FROM nam_hoc ORDER BY ten DESC").fetchall()


def get_active_nam(con: sqlite3.Connection) -> sqlite3.Row | None:
    row = con.execute("SELECT * FROM nam_hoc WHERE active=1").fetchone()
    if row:
        return row
    return con.execute("SELECT * FROM nam_hoc ORDER BY id DESC LIMIT 1").fetchone()


def set_active_nam(con: sqlite3.Connection, nam_id: int) -> None:
    con.execute("UPDATE nam_hoc SET active=0")
    con.execute("UPDATE nam_hoc SET active=1 WHERE id=?", (nam_id,))
    con.commit()


def add_nam_hoc(con: sqlite3.Connection, ten: str, copy_from: int | None = None) -> int:
    con.execute("INSERT INTO nam_hoc(ten, active) VALUES (?, 0)", (ten,))
    new_id = con.execute("SELECT id FROM nam_hoc WHERE ten=?", (ten,)).fetchone()[0]
    if copy_from:
        lops = con.execute(
            "SELECT ten, khoi, nhom, si_so, gvcn, thu_tu FROM lop WHERE nam_hoc_id=?",
            (copy_from,),
        ).fetchall()
        for lop in lops:
            con.execute(
                "INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu) VALUES (?,?,?,?,?,?,?)",
                (new_id, lop["ten"], lop["khoi"], lop["nhom"], lop["si_so"], lop["gvcn"], lop["thu_tu"]),
            )
    con.commit()
    return new_id


def list_lop(con: sqlite3.Connection, nam_id: int) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM lop WHERE nam_hoc_id=? ORDER BY nhom, thu_tu, ten",
        (nam_id,),
    ).fetchall()


def upsert_lop(con: sqlite3.Connection, nam_id: int, data: dict) -> int:
    if data.get("id"):
        con.execute(
            """UPDATE lop SET ten=?, khoi=?, nhom=?, si_so=?, gvcn=?, thu_tu=?
               WHERE id=? AND nam_hoc_id=?""",
            (
                data["ten"],
                data["khoi"],
                data["nhom"],
                data["si_so"],
                data.get("gvcn", ""),
                data.get("thu_tu", 0),
                data["id"],
                nam_id,
            ),
        )
        lop_id = int(data["id"])
    else:
        con.execute(
            """INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so, gvcn, thu_tu)
               VALUES (?,?,?,?,?,?,?)""",
            (
                nam_id,
                data["ten"],
                data["khoi"],
                data["nhom"],
                data["si_so"],
                data.get("gvcn", ""),
                data.get("thu_tu", 0),
            ),
        )
        lop_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    con.commit()
    return lop_id


def delete_lop(con: sqlite3.Connection, lop_id: int) -> None:
    con.execute("DELETE FROM lop WHERE id=?", (lop_id,))
    con.commit()


def list_tuan(con: sqlite3.Connection, nam_id: int) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM tuan WHERE nam_hoc_id=? ORDER BY so_tuan",
        (nam_id,),
    ).fetchall()


def get_tuan(con: sqlite3.Connection, tuan_id: int) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM tuan WHERE id=?", (tuan_id,)).fetchone()


def upsert_tuan(con: sqlite3.Connection, nam_id: int, data: dict) -> int:
    if data.get("id"):
        con.execute(
            """UPDATE tuan SET so_tuan=?, thang=?, nam=?, hoc_ky=?, ghi_chu=?
               WHERE id=? AND nam_hoc_id=?""",
            (
                data["so_tuan"],
                data["thang"],
                data["nam"],
                data["hoc_ky"],
                data.get("ghi_chu", ""),
                data["id"],
                nam_id,
            ),
        )
        tuan_id = int(data["id"])
    else:
        con.execute(
            """INSERT INTO tuan(nam_hoc_id, so_tuan, thang, nam, hoc_ky, ghi_chu)
               VALUES (?,?,?,?,?,?)""",
            (
                nam_id,
                data["so_tuan"],
                data["thang"],
                data["nam"],
                data["hoc_ky"],
                data.get("ghi_chu", ""),
            ),
        )
        tuan_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        for lop in list_lop(con, nam_id):
            con.execute(
                "INSERT OR IGNORE INTO diem_tuan(tuan_id, lop_id) VALUES (?,?)",
                (tuan_id, lop["id"]),
            )
    con.commit()
    return tuan_id


def delete_tuan(con: sqlite3.Connection, tuan_id: int) -> None:
    con.execute("DELETE FROM tuan WHERE id=?", (tuan_id,))
    con.commit()


def ensure_diem_rows(con: sqlite3.Connection, tuan_id: int, nam_id: int) -> None:
    for lop in list_lop(con, nam_id):
        con.execute(
            "INSERT OR IGNORE INTO diem_tuan(tuan_id, lop_id) VALUES (?,?)",
            (tuan_id, lop["id"]),
        )
    con.commit()


SCORE_FIELDS = NN_KEYS + GIO_KEYS + ["ktm_ge5", "ktm_lt5"] + KTM_SCORE_KEYS + ["ghi_chu"]

def get_diem_join(con: sqlite3.Connection, tuan_id: int) -> list[dict]:
    tuan = get_tuan(con, tuan_id)
    if tuan is None:
        return []
    lops = list_lop(con, tuan["nam_hoc_id"])
    diems = {
        r["lop_id"]: dict(r)
        for r in con.execute("SELECT * FROM diem_tuan WHERE tuan_id=?", (tuan_id,)).fetchall()
    }
    out: list[dict] = []
    for lop in lops:
        d = dict(lop)
        d["lop_id"] = lop["id"]
        merged = diems.get(lop["id"], {})
        for k in SCORE_FIELDS:
            if k == "ghi_chu":
                d[k] = merged.get(k, "") or ""
            else:
                d[k] = merged.get(k, 0) or 0
        out.append(d)
    return out

def save_diem(con: sqlite3.Connection, tuan_id: int, lop_id: int, data: dict) -> None:
    sets = ", ".join(f"{k}=?" for k in SCORE_FIELDS)
    vals = [data.get(k, 0 if k != "ghi_chu" else "") for k in SCORE_FIELDS]
    exists = con.execute(
        "SELECT id FROM diem_tuan WHERE tuan_id=? AND lop_id=?",
        (tuan_id, lop_id),
    ).fetchone()
    if exists:
        con.execute(
            f"UPDATE diem_tuan SET {sets} WHERE tuan_id=? AND lop_id=?",
            vals + [tuan_id, lop_id],
        )
    else:
        cols = "tuan_id, lop_id, " + ", ".join(SCORE_FIELDS)
        ph = ", ".join(["?"] * (2 + len(SCORE_FIELDS)))
        con.execute(f"INSERT INTO diem_tuan({cols}) VALUES ({ph})", [tuan_id, lop_id] + vals)
    con.commit()


def list_quy_che(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute("SELECT * FROM quy_che ORDER BY id").fetchall()


def list_loi(con: sqlite3.Connection, tuan_id: int, lop_id: int) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM loi_vi_pham WHERE tuan_id=? AND lop_id=? ORDER BY id",
        (tuan_id, lop_id),
    ).fetchall()


def add_loi(
    con: sqlite3.Connection,
    tuan_id: int,
    lop_id: int,
    field: str,
    ten_loi: str,
    so_luong: float,
    diem_mot: float,
    ho_ten: str = "",
    ghi_chu: str = "",
) -> float:
    if field not in NN_KEYS:
        raise ValueError(f"Cột không hợp lệ: {field}")
    diem = float(so_luong) * float(diem_mot)
    con.execute(
        """INSERT INTO loi_vi_pham(tuan_id, lop_id, field, ten_loi, so_luong, diem_mot, diem_tru, ho_ten, ghi_chu)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (tuan_id, lop_id, field, ten_loi, so_luong, diem_mot, diem, ho_ten, ghi_chu),
    )
    con.execute(
        f"UPDATE diem_tuan SET {field} = {field} + ? WHERE tuan_id=? AND lop_id=?",
        (diem, tuan_id, lop_id),
    )
    con.commit()
    return diem


def delete_loi(con: sqlite3.Connection, loi_id: int) -> None:
    row = con.execute("SELECT * FROM loi_vi_pham WHERE id=?", (loi_id,)).fetchone()
    if not row:
        return
    field = row["field"]
    if field not in NN_KEYS:
        con.execute("DELETE FROM loi_vi_pham WHERE id=?", (loi_id,))
        con.commit()
        return
    con.execute(
        f"UPDATE diem_tuan SET {field} = CASE WHEN {field} - ? < 0 THEN 0 ELSE {field} - ? END "
        "WHERE tuan_id=? AND lop_id=?",
        (row["diem_tru"], row["diem_tru"], row["tuan_id"], row["lop_id"]),
    )
    con.execute("DELETE FROM loi_vi_pham WHERE id=?", (loi_id,))
    con.commit()


def list_loi_tuan(con: sqlite3.Connection, tuan_id: int) -> list[sqlite3.Row]:
    return con.execute(
        """
        SELECT l.ten AS ten_lop, l.nhom, v.ten_loi, v.so_luong, v.diem_tru, v.ho_ten, v.ghi_chu
        FROM loi_vi_pham v
        JOIN lop l ON l.id = v.lop_id
        WHERE v.tuan_id = ?
        ORDER BY l.nhom, l.thu_tu, l.ten, v.id
        """,
        (tuan_id,),
    ).fetchall()


