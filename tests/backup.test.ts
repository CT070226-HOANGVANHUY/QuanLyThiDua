import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyRestoreIntent, intentPath, sameFsPath, writeRestoreIntent } from "../electron/restore-intent.mjs";
import { APP_SCHEMA_MAX, checkRestoreCandidate, lastBackupInfo, vacuumBackup } from "../src/backup.ts";
import { connect, get, initDb, run } from "../src/db.ts";

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "thidua-backup-"));
}

function writeCandidate(dir: string, name: string, sql: string) {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
  return file;
}

test("VACUUM INTO while WAL captures committed rows and records last_backup_at", () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "thidua.db");
  const prev = process.env.THIDUA_EMPTY_DB;
  process.env.THIDUA_EMPTY_DB = "1";
  const db = connect(dbPath);
  try {
    initDb(db);
    run(db, "INSERT INTO nam_hoc(ten, active) VALUES ('2026-2027', 1)");
    run(db, "INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so) VALUES (1, '10A1', 10, 1, 40)");
    assert.equal(get(db, "PRAGMA journal_mode")?.journal_mode, "wal");
    const dest = path.join(dir, "backups", "snap.db");
    const out = vacuumBackup(db, dest);
    assert.equal(out, dest);
    assert.ok(existsSync(dest));
    const info = lastBackupInfo(db);
    assert.ok(info.at);
    assert.equal(info.path, dest);
    const bak = new DatabaseSync(dest, { readOnly: true });
    try {
      assert.equal(get(bak, "SELECT ten FROM lop WHERE ten='10A1'")?.ten, "10A1");
      assert.equal(get(bak, "PRAGMA user_version")?.user_version, APP_SCHEMA_MAX);
    } finally { bak.close(); }
    run(db, "INSERT INTO lop(nam_hoc_id, ten, khoi, nhom, si_so) VALUES (1, '10A2', 10, 1, 41)");
    const bak2 = new DatabaseSync(dest, { readOnly: true });
    try {
      assert.equal(get(bak2, "SELECT ten FROM lop WHERE ten='10A2'"), undefined);
    } finally { bak2.close(); }
  } finally {
    db.close();
    if (prev == null) delete process.env.THIDUA_EMPTY_DB;
    else process.env.THIDUA_EMPTY_DB = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kiem-tra rejects user_version above APP_SCHEMA_MAX", () => {
  const dir = tempDir();
  try {
    const file = writeCandidate(dir, "future.db", `
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT, active INTEGER DEFAULT 1);
      INSERT INTO nam_hoc(ten) VALUES ('2099-2100');
      PRAGMA user_version=${APP_SCHEMA_MAX + 1};
    `);
    assert.throws(() => checkRestoreCandidate(file), { status: 400, message: /lớn hơn ứng dụng/ });
    assert.equal(existsSync(intentPath(dir)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("kiem-tra rejects corrupt file and does not write restore-intent", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "junk.db");
    writeFileSync(file, "not a database");
    assert.throws(() => checkRestoreCandidate(file), { status: 400 });
    assert.equal(existsSync(intentPath(dir)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("kiem-tra accepts older user_version when nam_hoc is present", () => {
  const dir = tempDir();
  try {
    const file = writeCandidate(dir, "old.db", `
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT, active INTEGER DEFAULT 1);
      INSERT INTO nam_hoc(ten) VALUES ('2025-2026');
      PRAGMA user_version=4;
    `);
    const result = checkRestoreCandidate(file);
    assert.equal(result.user_version, 4);
    assert.equal(result.nam_hoc, "2025-2026");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restore-intent copies db, drops wal/shm, copies BaoCao, then deletes the intent", () => {
  const dir = tempDir();
  try {
    const srcDir = path.join(dir, "usb");
    const destDir = path.join(dir, "data");
    mkdirSync(path.join(srcDir, "BaoCao"), { recursive: true });
    mkdirSync(destDir, { recursive: true });
    const sourceDb = writeCandidate(srcDir, "thidua.db", `
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT);
      INSERT INTO nam_hoc(ten) VALUES ('restored');
    `);
    writeFileSync(path.join(srcDir, "BaoCao", "note.txt"), "bao cao moi");
    const destDb = path.join(destDir, "thidua.db");
    writeFileSync(destDb, "old-db");
    writeFileSync(destDb + "-wal", "old-wal");
    writeFileSync(destDb + "-shm", "old-shm");
    mkdirSync(path.join(dir, "BaoCao"), { recursive: true });
    writeFileSync(path.join(dir, "BaoCao", "old.txt"), "cu");
    const intent = intentPath(destDir);
    writeRestoreIntent(intent, {
      sourceDb,
      destDb,
      sourceBaoCao: path.join(srcDir, "BaoCao"),
      destBaoCao: path.join(dir, "BaoCao"),
    });
    assert.equal(applyRestoreIntent(intent), true);
    assert.equal(existsSync(intent), false);
    assert.equal(existsSync(destDb + "-wal"), false);
    assert.equal(existsSync(destDb + "-shm"), false);
    const live = new DatabaseSync(destDb, { readOnly: true });
    try {
      assert.equal(get(live, "SELECT ten FROM nam_hoc")?.ten, "restored");
    } finally { live.close(); }
    assert.equal(readFileSync(path.join(dir, "BaoCao", "note.txt"), "utf8"), "bao cao moi");
    assert.equal(existsSync(path.join(dir, "BaoCao", "old.txt")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("BaoCao copy skips when source and dest are the same path (case-insensitive)", () => {
  const dir = tempDir();
  try {
    const bao = path.join(dir, "BaoCao");
    mkdirSync(bao, { recursive: true });
    writeFileSync(path.join(bao, "keep.txt"), "live");
    const sourceDb = writeCandidate(dir, "thidua.db", `
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT);
      INSERT INTO nam_hoc(ten) VALUES ('same-bao');
    `);
    const destDb = path.join(dir, "live.db");
    const intent = intentPath(dir);
    writeRestoreIntent(intent, {
      sourceDb,
      destDb,
      sourceBaoCao: bao,
      destBaoCao: path.join(dir, "baocao"),
    });
    assert.equal(sameFsPath(bao, path.join(dir, "baocao")), true);
    assert.equal(applyRestoreIntent(intent), true);
    assert.equal(readFileSync(path.join(bao, "keep.txt"), "utf8"), "live");
    assert.equal(existsSync(path.join(dir, "BaoCao.restoring")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("BaoCao copy skips when dest is inside source and does not rmSync live reports", () => {
  const dir = tempDir();
  try {
    const sourceBao = path.join(dir, "usb");
    const destBao = path.join(sourceBao, "BaoCao");
    mkdirSync(destBao, { recursive: true });
    writeFileSync(path.join(sourceBao, "root.txt"), "usb");
    writeFileSync(path.join(destBao, "keep.txt"), "live");
    const sourceDb = writeCandidate(dir, "thidua.db", `
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT);
      INSERT INTO nam_hoc(ten) VALUES ('nested-bao');
    `);
    const destDb = path.join(dir, "live.db");
    const intent = intentPath(dir);
    writeRestoreIntent(intent, {
      sourceDb,
      destDb,
      sourceBaoCao: sourceBao,
      destBaoCao: destBao,
    });
    assert.equal(applyRestoreIntent(intent), true);
    assert.equal(readFileSync(path.join(destBao, "keep.txt"), "utf8"), "live");
    assert.equal(readFileSync(path.join(sourceBao, "root.txt"), "utf8"), "usb");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup applyRestoreIntent is a no-op without intent and finishes a leftover intent", () => {
  const dir = tempDir();
  try {
    assert.equal(applyRestoreIntent(intentPath(dir)), false);
    const sourceDb = writeCandidate(dir, "src.db", `
      CREATE TABLE nam_hoc (id INTEGER PRIMARY KEY, ten TEXT);
      INSERT INTO nam_hoc(ten) VALUES ('crash-mid-copy');
    `);
    const destDb = path.join(dir, "live.db");
    writeFileSync(destDb, "partial");
    const intent = intentPath(dir);
    writeRestoreIntent(intent, { sourceDb, destDb, sourceBaoCao: null, destBaoCao: null });
    assert.equal(applyRestoreIntent(intent), true);
    const live = new DatabaseSync(destDb, { readOnly: true });
    try {
      assert.equal(get(live, "SELECT ten FROM nam_hoc")?.ten, "crash-mid-copy");
    } finally { live.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
