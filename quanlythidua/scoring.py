"""Tính điểm nề nếp / học tập và xếp thứ thi đua."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

NN_COLS: list[tuple[str, str, str]] = [
    ("trang_tri", "Trang trí", "−5 điểm / 1 lỗi"),
    ("xep_hang", "Xếp hàng", "−1/HS; tập thể −10"),
    ("hat", "Hát đầu giờ", "−1/HS; tập thể −10"),
    ("sh15", "SH 15 phút", "ra ngoài −1/HS; mất TT −10; không KT −5"),
    ("td_cc", "TD / chào cờ", "−1/HS; tập thể −10"),
    ("di_muon", "Đi muộn", "−5/HS"),
    ("phu_hieu", "Phù hiệu", "không đeo −1; quên −2; giả −10"),
    ("trang_phuc", "Trang phục", "−1/HS"),
    ("xe_dap", "Xe (sân / để xe / VS)", "sân −10; để sai −1; VS −5/lớp"),
    ("giao_thong", "Giao thông", "không mũ −30; đội sai −10; làn −5"),
    ("nghi_hoc", "Nghỉ / bỏ giờ", "−10/HS"),
    ("tnkt", "Thanh niên KT", "muộn −5; bỏ / không nộp sổ −10"),
    ("ve_sinh", "Vệ sinh nội vụ", "không VS −10/lỗi; bẩn/muộn −5"),
    ("sdb_y_thuc", "Ghi SĐB ý thức", "cá nhân −1; tập thể −10"),
    ("sdb_hoc_tap", "Ghi SĐB học tập", "cá nhân −1; tập thể −10"),
    ("bao_cao_bi_thu", "Báo cáo bí thư", "không nộp/sai cao −20; sai thấp −10"),
    ("hs_ky_luat", "HS kỷ luật", "theo mức −30 / −50"),
    ("vp_khac", "Vi phạm khác", "bánh kẹo / ra khỏi trường −10"),
]

HT_GIO_COLS: list[tuple[str, str, int]] = [
    ("gio_tot", "Giờ tốt", 2),
    ("gio_kha", "Giờ khá", 1),
    ("gio_tb", "Giờ TB", 0),
    ("gio_yeu", "Giờ yếu", -1),
    ("gio_kem", "Giờ kém", -2),
]

HT_KTM_COLS: list[tuple[str, str, int]] = [
    ("ktm_9_10", "Điểm 9–10", 2),
    ("ktm_7_8", "Điểm 7–8", 1),
    ("ktm_3_4", "Điểm 3–4", -1),
    ("ktm_0_2", "Điểm 0–2", -2),
]

KTM_COUNT_COLS: list[tuple[str, str]] = [
    ("ktm_ge5", "Số điểm ≥ 5"),
    ("ktm_lt5", "Số điểm < 5"),
]

NN_KEYS = [k for k, _, _ in NN_COLS]
GIO_KEYS = [k for k, _, _ in HT_GIO_COLS]
KTM_SCORE_KEYS = [k for k, _, _ in HT_KTM_COLS]

# (cột nề nếp, tên lỗi, điểm trừ / 1 đơn vị, đơn vị)
LOI_MAU: list[tuple[str, str, float, str]] = [
    ("di_muon", "Đi học muộn", 5, "HS"),
    ("nghi_hoc", "Nghỉ không lý do / bỏ giờ / không báo sĩ số", 10, "HS"),
    ("trang_phuc", "Trang phục không đúng", 1, "HS"),
    ("phu_hieu", "Phù hiệu có mà không đeo", 1, "HS"),
    ("phu_hieu", "Phù hiệu quên hoặc mất", 2, "HS"),
    ("phu_hieu", "Phù hiệu giả / năm học trước", 10, "HS"),
    ("trang_tri", "Trang trí lớp (thiếu 1 = 1 lỗi)", 5, "lỗi"),
    ("xep_hang", "Xếp hàng — theo học sinh", 1, "HS"),
    ("xep_hang", "Xếp hàng — tập thể", 10, "lần"),
    ("hat", "Hát đầu giờ — theo học sinh", 1, "HS"),
    ("hat", "Hát đầu giờ — tập thể", 10, "lần"),
    ("sh15", "SH 15 phút — ra ngoài / đi lại tự do", 1, "HS"),
    ("sh15", "SH 15 phút — lớp mất trật tự", 10, "lần"),
    ("sh15", "SH 15 phút — không kiểm tra bài", 5, "lần"),
    ("td_cc", "TD giữa giờ / chào cờ — theo HS", 1, "HS"),
    ("td_cc", "TD giữa giờ / chào cờ — tập thể", 10, "lần"),
    ("giao_thong", "Không đội mũ bảo hiểm", 30, "HS"),
    ("giao_thong", "Đội mũ bảo hiểm không đúng", 10, "HS"),
    ("giao_thong", "Sai làn đường / không xi nhan", 5, "HS"),
    ("xe_dap", "Đi xe trong sân trường", 10, "HS"),
    ("xe_dap", "Để xe không đúng quy định", 1, "HS"),
    ("xe_dap", "Không vệ sinh nhà xe", 5, "lớp"),
    ("tnkt", "TNKT làm nhiệm vụ muộn", 5, "HS"),
    ("tnkt", "TNKT bỏ nhiệm vụ / không nộp sổ", 10, "HS"),
    ("ve_sinh", "Không vệ sinh", 10, "lỗi"),
    ("ve_sinh", "Vệ sinh muộn / bẩn / rác / ghế", 5, "lỗi"),
    ("ve_sinh", "Không lấy / lấy sai bình nước", 10, "lần"),
    ("ve_sinh", "Không khóa cửa / tắt điện / giao chìa", 10, "lỗi"),
    ("sdb_y_thuc", "Ghi SĐB ý thức — cá nhân", 1, "HS"),
    ("sdb_y_thuc", "Ghi SĐB ý thức — tập thể", 10, "lần"),
    ("sdb_hoc_tap", "Ghi SĐB học tập — cá nhân", 1, "HS"),
    ("sdb_hoc_tap", "Ghi SĐB học tập — tập thể", 10, "lần"),
    ("bao_cao_bi_thu", "Bí thư không nộp sổ / sai cao hơn", 20, "lần"),
    ("bao_cao_bi_thu", "Bí thư tổng hợp sai thấp hơn", 10, "lần"),
    ("vp_khac", "Bánh kẹo / tự ý ra khỏi trường", 10, "HS"),
    ("hs_ky_luat", "Kỷ luật mức −30 (xe, gian lận, phá TS, ĐT…)", 30, "HS"),
    ("hs_ky_luat", "Kỷ luật mức −50 (vô lễ, đánh nhau, chất cấm…)", 50, "HS"),
]


def tong_tru(row: dict) -> float:
    """Tổng điểm trừ nề nếp (số dương)."""
    return sum(_num(row, k) for k in NN_KEYS)


def tong_cong(row: dict) -> float:
    """Tổng điểm cộng/trừ học tập (giờ + miệng)."""
    return diem_gio(row) + diem_ktm(row)


def tong_net(row: dict) -> float:
    return tong_cong(row) - tong_tru(row)



def _num(row: dict, key: str) -> float:
    v = row.get(key, 0)
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def diem_nn(row: dict) -> float:
    """Điểm nề nếp: tổng điểm trừ đã nhập, dấu âm."""
    return -sum(_num(row, k) for k in NN_KEYS)


def tb_nn(row: dict, si_so: int | float) -> float:
    n = float(si_so or 0)
    if n <= 0:
        return 0.0
    return diem_nn(row) / n


def so_gio(row: dict) -> float:
    return sum(_num(row, k) for k in GIO_KEYS)


def diem_gio(row: dict) -> float:
    return sum(_num(row, k) * w for k, _, w in HT_GIO_COLS)


def tb_gio(row: dict) -> float:
    n = so_gio(row)
    if n <= 0:
        return 0.0
    return diem_gio(row) / n



def diem_ktm(row: dict) -> float:
    return sum(_num(row, k) * w for k, _, w in HT_KTM_COLS)


def tb_ktm(row: dict) -> float:
    # Bao gồm điểm 5–6 (trọng số 0), như mẫu Ban in: AN/(AH+AI).
    n = _num(row, "ktm_ge5") + _num(row, "ktm_lt5")
    if n <= 0:
        return 0.0
    return diem_ktm(row) / n


def tb_hoc_tap(row: dict) -> float:
    return tb_gio(row) + tb_ktm(row)


def competition_ranks(scores: Iterable[float], *, higher_better: bool) -> list[int]:
    """Xếp thứ 1224: hòa cùng hạng, hạng sau = số người đứng trước + 1."""
    vals = list(scores)
    order = sorted(range(len(vals)), key=lambda i: vals[i], reverse=higher_better)
    ranks = [0] * len(vals)
    i = 0
    while i < len(order):
        j = i
        while j < len(order) and vals[order[j]] == vals[order[i]]:
            j += 1
        rank = i + 1
        for k in range(i, j):
            ranks[order[k]] = rank
        i = j
    return ranks


@dataclass
class ClassResult:
    lop_id: int
    ten: str
    nhom: int
    si_so: int
    row: dict = field(default_factory=dict)
    diem_nn: float = 0.0
    tb_nn: float = 0.0
    diem_gio: float = 0.0
    so_gio: float = 0.0
    tb_gio: float = 0.0
    diem_ktm: float = 0.0
    tb_ht: float = 0.0
    tong_tru: float = 0.0
    tong_cong: float = 0.0
    tong_net: float = 0.0
    xt_nn: int = 0
    xt_ht: int = 0
    tong_xt: int = 0
    xt_chung: int = 0


def score_group(items: list[ClassResult]) -> list[ClassResult]:
    """Tính điểm + xếp thứ trong một nhóm lớp."""
    for it in items:
        r = it.row
        it.diem_nn = diem_nn(r)
        it.tb_nn = tb_nn(r, it.si_so)
        it.diem_gio = diem_gio(r)
        it.so_gio = so_gio(r)
        it.tb_gio = tb_gio(r)
        it.diem_ktm = diem_ktm(r)
        it.tb_ht = tb_hoc_tap(r)
        it.tong_tru = tong_tru(r)
        it.tong_cong = tong_cong(r)
        it.tong_net = tong_net(r)

    nn_ranks = competition_ranks((it.tb_nn for it in items), higher_better=True)
    ht_ranks = competition_ranks((it.tb_ht for it in items), higher_better=True)
    for it, a, b in zip(items, nn_ranks, ht_ranks):
        it.xt_nn = a
        it.xt_ht = b
        it.tong_xt = a + b

    chung = competition_ranks((it.tong_xt for it in items), higher_better=False)
    for it, c in zip(items, chung):
        it.xt_chung = c
    return items


def score_all(items: list[ClassResult]) -> list[ClassResult]:
    by_group: dict[int, list[ClassResult]] = {}
    for it in items:
        by_group.setdefault(it.nhom, []).append(it)
    out: list[ClassResult] = []
    for g in sorted(by_group):
        out.extend(score_group(by_group[g]))
    return out


@dataclass
class AggRow:
    nhom: int
    ten: str
    lop_id: int
    tong_tru: float
    tong_cong: float
    tong_net: float
    tong_xt: int
    xt: int
    n_weeks: int
    wmap: dict

