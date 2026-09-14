import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, initDb, get, run, setActiveNam, transaction } from '../src/db.ts';
import { initPlan, saveReport, saveChamTay, loadReport, deleteTieuChi, parseReport, scoreWeek, setTuanStatus } from '../src/plan.ts';
import { initPeriods, periodTable } from '../src/periods.ts';
import { feed, initConduct, savePenalty } from '../src/conduct.ts';
import { buildClassReport } from '../src/report-data.ts';
import { classReportDocx } from '../src/class-report-export.ts';
import { reportTables } from '../src/report-export.ts';

process.env.THIDUA_EMPTY_DB = '1';

function fixture() {
  const db = new DatabaseSync(':memory:');
  initDb(db);
  initPlan(db);
  initPeriods(db);
  initConduct(db);
  return db;
}

test('empty initialization does not insert sample classes, weeks or scores', () => {
  const db = fixture();
  try {
    initDb(db);
    initPlan(db);
    for (const table of ['nam_hoc', 'lop', 'tuan', 'diem_tuan']) {
      assert.equal(get(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n, 0);
    }
    assert.ok(Number(get(db, 'SELECT COUNT(*) AS n FROM quy_che')?.n) > 0);
  } finally { db.close(); }
});

test('invalid year cannot clear the active year', () => {
  const db = fixture();
  try {
    run(db, "INSERT INTO nam_hoc(ten,active) VALUES ('2026-2027',1)");
    assert.throws(() => setActiveNam(db, 999), { status: 404 });
    assert.equal(get(db, 'SELECT active FROM nam_hoc')?.active, 1);
  } finally { db.close(); }
});

test('transaction failure rolls back changes and leaves connection usable', () => {
  const db = fixture();
  try {
    assert.throws(() => transaction(db, () => {
      run(db, "INSERT INTO nam_hoc(ten) VALUES ('2026-2027')");
      transaction(db, () => run(db, "INSERT INTO nam_hoc(ten) VALUES ('2027-2028')"));
      throw new Error('injected failure');
    }), /injected failure/);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM nam_hoc')?.n, 0);
    transaction(db, () => run(db, "INSERT INTO nam_hoc(ten) VALUES ('2026-2027')"));
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM nam_hoc')?.n, 1);
  } finally { db.close(); }
});

test('pre-migration backup includes committed WAL data', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'thidua-backup-'));
  const file = path.join(dir, 'fixture.db');
  const writer = new DatabaseSync(file);
  let reader: DatabaseSync | undefined;
  let backup: DatabaseSync | undefined;
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE nam_hoc(id INTEGER PRIMARY KEY,ten TEXT); INSERT INTO nam_hoc(ten) VALUES ('Dữ liệu trong WAL')");
    reader = connect(file);
    backup = new DatabaseSync(`${file}.before-workflow-v1.db`, { readOnly: true });
    assert.equal(get(backup, 'SELECT ten FROM nam_hoc')?.ten, 'Dữ liệu trong WAL');
    assert.equal(get(backup, 'PRAGMA integrity_check')?.integrity_check, 'ok');
  } finally {
    backup?.close(); reader?.close(); writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function reportForm(extra: Record<string, string> = {}) {
  return {
    gio_tong: '0', gio_tot: '0', gio_kha: '0', gio_tb: '0', gio_yeu: '0', gio_kem: '0',
    ktm_9_10: '0', ktm_7_8: '0', ktm_5_6: '0', ktm_3_4: '0', ktm_0_2: '0',
    bi_thu: '', ngay_lap: '', ghi_chu_gio: '', ghi_chu_ktm: '', ...extra,
  };
}
test('report child failure rolls back header, children and computed points', () => {
  const db = fixture();
  try {
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    run(db, "INSERT INTO tuan(id,nam_hoc_id,so_tuan,thang,nam) VALUES (1,1,1,9,2026)");
    initPlan(db);
    let form = reportForm({ nghi_0_ho_ten: 'A' });
    saveReport(db, 1, { tuan_id: 1 }, 1, 0, parseReport(form, get(db, "SELECT * FROM tuan WHERE id=1")!), 'save');
    const before = loadReport(db, 1, 1);
    const points = db.prepare('SELECT * FROM cham_dong').all();
    db.exec("CREATE TRIGGER fail_child BEFORE INSERT ON nghi_hoc BEGIN SELECT RAISE(ABORT,'injected child failure'); END");
    form = reportForm({ gio_tong: '5', nghi_0_ho_ten: 'B' });
    assert.throws(() => saveReport(db, 1, { tuan_id: 1 }, 1, 1, parseReport(form, get(db, "SELECT * FROM tuan WHERE id=1")!), 'save'), /injected child failure/);
    assert.deepEqual(loadReport(db, 1, 1), before);
    assert.deepEqual(db.prepare('SELECT * FROM cham_dong').all(), points);
  } finally { db.close(); }
});

test('cross-year writes fail and referenced criteria cannot be deleted', () => {
  const db = fixture();
  try {
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1),(2,'2027-2028',0)");
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30),(2,2,'10A1',10,1,30)");
    run(db, "INSERT INTO tuan(id,nam_hoc_id,so_tuan,thang,nam) VALUES (1,1,1,9,2026)");
    initPlan(db);
    const foreign = Number(get(db, 'SELECT id FROM tieu_chi WHERE nam_hoc_id=2 LIMIT 1')?.id);
    const foreignReport = parseReport(reportForm(), get(db, "SELECT * FROM tuan WHERE id=1")!);
    assert.throws(() => saveReport(db, 1, { tuan_id: 1 }, 2, 0, foreignReport, 'save'), { status: 404 });
    assert.throws(() => saveChamTay(db, 1, 1, 1, foreign, 1, 0, 'Đối chiếu'), { status: 404 });
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bao_cao_tuan')?.n, 0);
    const own = Number(get(db, "SELECT id FROM tieu_chi WHERE nam_hoc_id=1 AND score_key='nghi_hoc' LIMIT 1")?.id);
    saveChamTay(db, 1, 1, 1, own, 1, 0, 'Đối chiếu');
    assert.throws(() => deleteTieuChi(db, 1, own), { status: 409 });
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM cham_dong')?.n, 1);
  } finally { db.close(); }
});

import { weekFilter, resolveWeekForWrite } from '../src/plan.ts';

function calendarFixture() {
  const db = fixture();
  run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (1,'2026-2027',1)");
  initPlan(db);
  return db;
}

function serializeTables(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  return JSON.stringify(tables.map(({ name }) => {
    const quotedName = `"${String(name).replaceAll('"', '""')}"`;
    const rows = db.prepare(`SELECT * FROM ${quotedName}`).all().map((row) => JSON.stringify(row)).sort();
    return [name, rows];
  }));
}

test('calendar browsing September, December, February and September does not write any table', () => {
  const db = calendarFixture();
  try {
    run(db, `INSERT INTO tuan(nam_hoc_id,so_tuan,nam,thang,ngay_bd,ngay_kt)
      VALUES (1,1,2026,9,'2026-09-11','2026-09-17'),(1,2,2026,9,'','')`);
    const before = serializeTables(db);
    for (const [nam, thang] of [['2026', '9'], ['2026', '12'], ['2027', '2'], ['2026', '9']]) {
      const view = weekFilter(db, 1, { nam, thang }, '2026-09-13');
      assert.equal(view.year, Number(nam));
      assert.equal(view.month, Number(thang));
      assert.equal(serializeTables(db), before);
    }
  } finally { db.close(); }
});

test('today selects the Friday through Thursday virtual week without inventing an id', () => {
  const db = calendarFixture();
  try {
    const view = weekFilter(db, 1, {}, '2026-09-13');
    assert.equal(view.selection.nam_id, 1);
    assert.equal(view.selection.week_start, '2026-09-11');
    assert.equal(view.selection.ngay_bd, '2026-09-11');
    assert.equal(view.selection.ngay_kt, '2026-09-17');
    assert.equal(view.selection.tuan_id, undefined);
    assert.equal(view.tuan?.id, undefined);
    assert.equal(view.tuan?.virtual, true);
    assert.deepEqual(view.years, [2026, 2027]);
    assert.deepEqual(view.months, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  } finally { db.close(); }
});

test('October includes the September-owned cross-month week', () => {
  const db = calendarFixture();
  try {
    const view = weekFilter(db, 1, { nam: '2026', thang: '10', week_start: '2026-09-25' }, '2026-09-13');
    const crossing = view.weeks.find((week) => week.ngay_bd === '2026-09-25');
    assert.ok(crossing);
    assert.equal(crossing.ngay_kt, '2026-10-01');
    assert.equal(crossing.thang, 9);
    assert.equal(crossing.nam, 2026);
    assert.equal(view.month, 10);
    assert.equal(view.selection.week_start, '2026-09-25');
    const saved = transaction(db, () => resolveWeekForWrite(db, 1, view.selection));
    const selected = weekFilter(db, 1, { nam: '2026', thang: '10', tuan_id: String(saved.id) }, '2026-09-13');
    assert.equal(saved.thang, 9);
    assert.equal(selected.selection.tuan_id, Number(saved.id));
    assert.equal(selected.selection.ngay_kt, '2026-10-01');
  } finally { db.close(); }
});

test('materializing the same calendar week twice reuses its id and date-derived number', () => {
  const db = calendarFixture();
  try {
    transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-12-04' }));
    const first = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const second = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    assert.equal(first.id, second.id);
    assert.equal(first.calendar_no, 3);
    assert.equal(second.calendar_no, first.calendar_no);
    assert.equal(first.ngay_kt, '2026-09-17');
    assert.equal(get(db, "SELECT COUNT(*) AS n FROM tuan WHERE nam_hoc_id=1 AND ngay_bd='2026-09-11'")?.n, 1);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM tuan')?.n, 2);
  } finally { db.close(); }
});

test('invalid explicit week ids never fall back to a valid date or another week', () => {
  const db = calendarFixture();
  try {
    transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    run(db, "INSERT INTO nam_hoc(id,ten,active) VALUES (2,'2027-2028',0)");
    run(db, "INSERT INTO tuan(id,nam_hoc_id,so_tuan,nam,thang,ngay_bd,ngay_kt) VALUES (50,2,1,2027,9,'2027-09-10','2027-09-16')");
    const before = serializeTables(db);
    for (const id of [999, 0, -1, 50]) {
      assert.throws(() => weekFilter(db, 1, { tuan_id: String(id), week_start: '2026-09-11' }, '2026-09-13'), { status: 404 });
      assert.throws(() => transaction(db, () => resolveWeekForWrite(db, 1, { tuan_id: id, week_start: '2026-09-11' })), { status: 404 });
    }
    assert.equal(serializeTables(db), before);
  } finally { db.close(); }
});

test('an explicit week id must match the requested month and date', () => {
  const db = calendarFixture();
  try {
    const saved = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const id = Number(saved.id);
    const selected = weekFilter(db, 1, { nam: '2026', thang: '9', tuan_id: String(id) }, '2026-09-13');
    assert.equal(selected.selection.tuan_id, id);
    const before = serializeTables(db);
    assert.throws(() => weekFilter(db, 1, { nam: '2026', thang: '12', tuan_id: String(id) }, '2026-09-13'), { status: 400 });
    assert.throws(() => weekFilter(db, 1, { tuan_id: String(id), week_start: '2026-09-18' }, '2026-09-13'), { status: 400 });
    assert.throws(() => transaction(db, () => resolveWeekForWrite(db, 1, { tuan_id: id, week_start: '2026-09-18' })), { status: 400 });
    assert.equal(serializeTables(db), before);
  } finally { db.close(); }
});

test('new weeks reject non-Friday, invalid and wholly out-of-range dates without writes', () => {
  const db = calendarFixture();
  try {
    const before = serializeTables(db);
    for (const week_start of ['2026-09-13', '2026-02-30', '11/09/2026', '2026-08-21', '2027-09-03']) {
      assert.throws(() => transaction(db, () => resolveWeekForWrite(db, 1, { week_start })), { status: 400 });
      assert.equal(serializeTables(db), before);
    }
    const boundary = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-08-28' }));
    assert.equal(boundary.ngay_kt, '2026-09-03');
    assert.equal(boundary.calendar_no, 1);
  } finally { db.close(); }
});

test('an undated legacy week remains selectable and is not overwritten by calendar materialization', () => {
  const db = calendarFixture();
  try {
    run(db, "INSERT INTO tuan(id,nam_hoc_id,so_tuan,nam,thang,ngay_bd,ngay_kt) VALUES (40,1,3,2026,9,'','')");
    const before = get(db, 'SELECT * FROM tuan WHERE id=40');
    const legacy = weekFilter(db, 1, { nam: '2026', thang: '9', tuan_id: '40' }, '2026-09-13');
    assert.equal(legacy.selection.tuan_id, 40);
    assert.equal(legacy.selection.week_start, '');
    assert.equal(legacy.tuan?.legacy, true);
    const saved = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    assert.notEqual(saved.id, 40);
    assert.equal(saved.calendar_no, 3);
    assert.deepEqual(get(db, 'SELECT * FROM tuan WHERE id=40'), before);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM tuan')?.n, 2);
  } finally { db.close(); }
});

test('week materialization requires a transaction and rolls back with its caller', () => {
  const db = calendarFixture();
  try {
    const before = serializeTables(db);
    assert.throws(() => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    assert.equal(serializeTables(db), before);
    assert.throws(() => transaction(db, () => {
      resolveWeekForWrite(db, 1, { week_start: '2026-09-11' });
      throw new Error('injected week write failure');
    }), /injected week write failure/);
    assert.equal(serializeTables(db), before);
    const saved = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    assert.equal(saved.ngay_bd, '2026-09-11');
    assert.equal(saved.calendar_no, 3);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM tuan')?.n, 1);
  } finally { db.close(); }
});

test('report parser preserves non-contiguous row ids and rejects malformed values before writes', () => {
  const db = calendarFixture();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    const week = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const valid = reportForm({
      nghi_0_ho_ten: 'A', nghi_0_ngay: '2026-09-11',
      nghi_2_ho_ten: 'C', nghi_2_ngay: '2026-09-12',
      nghi_3_ho_ten: 'D', nghi_3_ngay: '2026-09-13',
    });
    const parsed = parseReport(valid, week);
    assert.deepEqual(parsed.nghi.map((row) => [row.index, row.ho_ten]), [[0, 'A'], [2, 'C'], [3, 'D']]);
    saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 0, parsed, 'save');
    assert.deepEqual(loadReport(db, Number(week.id), 1).nghi.map((row) => row.ho_ten), ['A', 'C', 'D']);
    const before = JSON.stringify(loadReport(db, Number(week.id), 1));
    for (const bad of [
      { gio_tong: '-1' }, { gio_tong: '1.5' }, { gio_tong: 'NaN' },
      { nghi_4_ngay: '2026-09-14' }, { nghi_4_ho_ten: 'E', nghi_4_ngay: '2026-09-20' },
      { gio_tong: '1', gio_tot: '2' },
    ]) {
      const invalid = parseReport(reportForm(bad), week);
      assert.ok(Object.keys(invalid.errors).length);
      assert.throws(() => saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 1, invalid, 'save'), { status: 400 });
      assert.equal(JSON.stringify(loadReport(db, Number(week.id), 1)), before);
    }
  } finally { db.close(); }
});

test('report revision prevents stale overwrite and submit validates confirmation fields', () => {
  const db = calendarFixture();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    const week = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const draft = parseReport(reportForm({ nghi_0_ho_ten: 'A' }), week);
    const saved = saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 0, draft, 'save');
    assert.equal(saved.report.revision, 1);
    assert.throws(() => saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 0, draft, 'save'), { status: 409 });
    assert.throws(() => saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 1, draft, 'submit'), { status: 400 });
    const submitted = parseReport(reportForm({ bi_thu: 'Nguyễn Văn Bí thư', ngay_lap: '2026-09-13', ghi_chu_ktm: 'Không phát sinh' }), week);
    const done = saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 1, submitted, 'submit');
    assert.equal(done.report.trang_thai, 'da_gui');
    assert.equal(done.report.revision, 2);
  } finally { db.close(); }
});

test('weekly ranking uses normalized NN and learning formulas, not raw point totals', () => {
  const db = calendarFixture();
  try {
    run(db, `INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so,thu_tu) VALUES
      (1,1,'A',10,1,10,1),(2,1,'B',10,1,100,2),(3,1,'C',10,1,20,3),(4,1,'D',10,2,20,4)`);
    const week = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const reports = [
      [1, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0],
      [2, 100, 0, 0, 0, 0, 0, 0, 100, 0, 0],
      [3, 0, 0, 0, 10, 0, 0, 0, 0, 0, 10],
    ];
    for (const [lop,tot,kha,tb,yeu,kem,n910,n78,n56,n34,n02] of reports) {
      run(db, `INSERT INTO bao_cao_tuan(tuan_id,lop_id,trang_thai,gio_tong,gio_tot,gio_kha,gio_tb,gio_yeu,gio_kem,
        ktm_9_10,ktm_7_8,ktm_5_6,ktm_3_4,ktm_0_2) VALUES (?,?, 'da_gui',?,?,?,?,?,?,?,?,?,?,?)`,
        [week.id, lop, tot+kha+tb+yeu+kem, tot, kha, tb, yeu, kem, n910, n78, n56, n34, n02]);
    }
    const criterion = get(db, "SELECT * FROM tieu_chi WHERE nam_hoc_id=1 AND score_key='nghi_hoc'");
    for (const [lop,count] of [[1,1],[2,2]] as const) {
      run(db, `INSERT INTO cham_dong(tuan_id,lop_id,tieu_chi_id,so_luong,diem_mot,thanh_diem,nguon,score_key,ten_snapshot)
        VALUES (?,?,?,?,?,?,'auto',?,?)`, [week.id,lop,criterion?.id,count,-10,count*-10,'nghi_hoc','Nghỉ']);
    }
    const rows = scoreWeek(db, Number(week.id));
    const a = rows.find((row) => row.ten === 'A')!;
    const b = rows.find((row) => row.ten === 'B')!;
    const c = rows.find((row) => row.ten === 'C')!;
    const d = rows.find((row) => row.ten === 'D')!;
    assert.deepEqual([a.tb_nn,b.tb_nn,c.tb_nn], [-1,-0.2,0]);
    assert.deepEqual([a.xt_nn,b.xt_nn,c.xt_nn], [3,2,1]);
    assert.deepEqual([a.tb_ht,b.tb_ht,c.tb_ht], [4,2,-3]);
    assert.deepEqual([a.xt_ht,b.xt_ht,c.xt_ht], [1,2,3]);
    assert.deepEqual([a.tong_xt,b.tong_xt,c.tong_xt], [4,4,4]);
    assert.deepEqual([a.xt_chung,b.xt_chung,c.xt_chung], [1,1,1]);
    assert.equal(d.xt_chung, null);
    assert.equal(d.rank_status, 'missing');
    assert.equal(b.row.ktm_5_6, 100);
  } finally { db.close(); }
});

test('week cannot close incomplete cohort and published snapshot is immutable', () => {
  const db = calendarFixture();
  try {
    run(db, `INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES
      (1,1,'10A1',10,1,30),(2,1,'10A2',10,1,30)`);
    const week = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const submitted = (name: string) => parseReport(reportForm({ bi_thu: name, ngay_lap: '2026-09-13', ghi_chu_ktm: 'Không phát sinh' }), week);
    saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 0, submitted('Bí thư 1'), 'submit');
    assert.throws(() => setTuanStatus(db, 1, Number(week.id), 1, 'chot'), { status: 409 });
    saveReport(db, 1, { tuan_id: Number(week.id) }, 2, 0, submitted('Bí thư 2'), 'submit');
    setTuanStatus(db, 1, Number(week.id), 2, 'chot');
    setTuanStatus(db, 1, Number(week.id), 3, 'cong_bo');
    const published = JSON.stringify(scoreWeek(db, Number(week.id)));
    run(db, 'UPDATE lop SET si_so=999,nhom=2 WHERE id=1');
    run(db, 'UPDATE tieu_chi SET diem=-999 WHERE nam_hoc_id=1');
    assert.equal(JSON.stringify(scoreWeek(db, Number(week.id))), published);
    assert.throws(() => saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 1, submitted('Ghi đè'), 'save'), { status: 409 });
    assert.throws(() => setTuanStatus(db, 1, Number(week.id), 4, 'nhap', 'bỏ qua chốt'), { status: 400 });
    setTuanStatus(db, 1, Number(week.id), 4, 'chot', 'Cần sửa dữ liệu');
    assert.throws(() => setTuanStatus(db, 1, Number(week.id), 5, 'nhap'), { status: 400 });
    setTuanStatus(db, 1, Number(week.id), 5, 'nhap', 'Cần tính lại');
    assert.equal(get(db, 'SELECT * FROM week_snapshot WHERE tuan_id=?', [week.id]), undefined);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM week_status_log WHERE tuan_id=?', [week.id])?.n, 4);
  } finally { db.close(); }
});

test('official month requires published constituents while preview exposes partial counts', () => {
  const db = calendarFixture();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    const first = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-18' }));
    const submitted = parseReport(reportForm({ bi_thu: 'Bí thư', ngay_lap: '2026-09-13', ghi_chu_ktm: 'Không phát sinh' }), first);
    saveReport(db, 1, { tuan_id: Number(first.id) }, 1, 0, submitted, 'submit');
    setTuanStatus(db, 1, Number(first.id), 1, 'chot');
    setTuanStatus(db, 1, Number(first.id), 2, 'cong_bo');
    const official = periodTable(db, 1, 'thang', '2026-09', 'monthly', 'official').rows[0];
    const preview = periodTable(db, 1, 'thang', '2026-09', 'monthly', 'preview').rows[0];
    assert.equal(official.xt, null);
    assert.equal(preview.xt, 1);
    assert.equal(preview.complete_count, 1);
    assert.equal(preview.constituent_count, 2);
    assert.equal(preview.status, 'Xem trước 1/2');
  } finally { db.close(); }
});

test('GVCN feed defaults to canonical weekly penalty and labels explicit override source', () => {
  const db = calendarFixture();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES (1,1,'10A1',10,1,30)");
    const week = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const report = parseReport(reportForm({
      bi_thu: 'Bí thư', ngay_lap: '2026-09-13', ghi_chu_ktm: 'Không phát sinh',
      nghi_0_ho_ten: 'Học sinh', nghi_0_ngay: '2026-09-12',
    }), week);
    saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 0, report, 'submit');
    const canonical = feed(db, 1, 1).rows[0].cells[0];
    assert.equal(canonical.penalty, 10);
    assert.match(String(canonical.source), /^Điểm tuần chuẩn:/);
    savePenalty(db, 1, 1, 1, Number(week.id), 7, 'Biên bản đối chiếu');
    const overridden = feed(db, 1, 1).rows[0].cells[0];
    assert.equal(overridden.penalty, 7);
    assert.equal(overridden.source, 'Nhập riêng: Biên bản đối chiếu');
  } finally { db.close(); }
});

test('class Word uses saved report rows and blank template does not write', async () => {
  const db = calendarFixture();
  try {
    run(db, "INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so,gvcn) VALUES (1,1,'10A1',10,1,30,'Cô GVCN')");
    const week = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const extra = {
      bi_thu: 'Bí thư Nguyễn', ngay_lap: '2026-09-13', ghi_chu_ktm: 'Không phát sinh',
      gio_tong: '10', gio_tot: '8', gio_kem: '2',
      ktm_9_10: '1', ktm_7_8: '1', ktm_5_6: '1', ktm_3_4: '1', ktm_0_2: '1',
      di_muon_0_ho_ten: 'Muộn', di_muon_0_ngay: '2026-09-11',
      trang_phuc_0_ho_ten: 'Áo', trang_phuc_0_ngay: '2026-09-11',
      phu_hieu_0_ho_ten: 'Phù hiệu', phu_hieu_0_ngay: '2026-09-11',
      vp_khac_0_ho_ten: 'Khác', vp_khac_0_ngay: '2026-09-11',
      thai_do_0_ho_ten: 'Thái độ', thai_do_0_noi_dung: 'Nói chuyện', thai_do_0_ngay: '2026-09-11', thai_do_0_tiet_mon: 'Toán',
    };
    const form: Record<string, string> = { ...reportForm(extra) };
    for (let i = 0; i < 60; i++) {
      form[`nghi_${i}_ho_ten`] = `Nguyễn Văn ${i}`;
      form[`nghi_${i}_ngay`] = '2026-09-12';
    }
    saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 0, parseReport(form, week), 'submit');
    const before = serializeTables(db);
    const doc = buildClassReport(db, 1, { tuan_id: Number(week.id), lop_id: 1 });
    assert.equal(doc.absences.length, 60);
    assert.equal(doc.bi_thu, 'Bí thư Nguyễn');
    assert.equal(doc.late[0].ho_ten, 'Muộn');
    assert.equal(doc.gio.kem, 2);
    assert.equal(doc.ktm.ge5, 3);
    const buffer = await classReportDocx(doc);
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');
    const blank = buildClassReport(db, 1, { week_start: '2026-09-18', lop_id: 1, blank: true });
    assert.equal(blank.notice, 'MẪU TRỐNG');
    assert.equal(serializeTables(db), before);
    assert.throws(() => buildClassReport(db, 1, { tuan_id: Number(week.id), lop_id: 99 }), { status: 404 });
  } finally { db.close(); }
});

test('class-scope Excel keeps school rank and treats leading equals as text', () => {
  const db = calendarFixture();
  try {
    run(db, `INSERT INTO lop(id,nam_hoc_id,ten,khoi,nhom,si_so) VALUES
      (1,1,'A',10,1,10),(2,1,'B',10,1,10)`);
    const week = transaction(db, () => resolveWeekForWrite(db, 1, { week_start: '2026-09-11' }));
    const submitted = (note: string) => parseReport(reportForm({ bi_thu: note, ngay_lap: '2026-09-13', ghi_chu_ktm: 'Không phát sinh' }), week);
    saveReport(db, 1, { tuan_id: Number(week.id) }, 1, 0, submitted('A'), 'submit');
    saveReport(db, 1, { tuan_id: Number(week.id) }, 2, 0, submitted('=HYPERLINK(1)'), 'submit');
    const tables = reportTables(db, 1, { scope: 'tuan', key: String(week.id), model: 'monthly', view: 'preview', cut: 'class', lop_id: 2 });
    assert.equal(tables[0].rows.length, 1);
    assert.equal(tables[0].rows[0].ten, 'B');
    assert.equal(tables[0].rows[0].xt_chung, 1);
  } finally { db.close(); }
});
