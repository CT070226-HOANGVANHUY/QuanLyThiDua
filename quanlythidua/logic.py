"""Tính xếp thứ tuần / học kỳ — dùng chung web và desktop."""

from __future__ import annotations

from . import db
from .scoring import AggRow, ClassResult, competition_ranks, score_all


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
    return f"Tuần {t['so_tuan']} — Tháng {t['thang']}/{t['nam']} (HK{t['hoc_ky']})"
