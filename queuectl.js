#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { fork } = require("child_process");
const Database = require("better-sqlite3");

// ---------- Paths / DB ----------
const DEFAULT_DB_PATH =
  process.env.QUEUECTL_DB || path.join(os.homedir(), ".queuectl", "queue.db");

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ensureDb(dbPath = DEFAULT_DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id           TEXT PRIMARY KEY,
      command      TEXT NOT NULL,
      state        TEXT NOT NULL CHECK(state IN ('pending','processing','completed','failed','dead')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      max_retries  INTEGER NOT NULL DEFAULT 3,
      priority     INTEGER NOT NULL DEFAULT 0,
      run_at       TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      last_error   TEXT,
      last_rc      INTEGER,
      stdout       TEXT,
      stderr       TEXT,
      worker_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_state_runat ON jobs(state, run_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority DESC, created_at);

    CREATE TABLE IF NOT EXISTS workers (
      id          TEXT PRIMARY KEY,
      pid         INTEGER NOT NULL,
      status      TEXT NOT NULL CHECK(status IN ('starting','running','stopping','stopped')),
      started_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const defaults = {
    max_retries: "3",
    backoff_base: "2",
    poll_interval_sec: "1",
    graceful_stop: "0",
  };
  const get = db.prepare("SELECT value FROM config WHERE key=?");
  const set = db.prepare(
    "INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING"
  );
  for (const [k, v] of Object.entries(defaults)) {
    const row = get.get(k);
    if (!row) set.run(k, v);
  }
  return db;
}

function getCfg(db, key, def) {
  const row = db.prepare("SELECT value FROM config WHERE key=?").get(key);
  return row ? row.value : def;
}
function setCfg(db, key, value) {
  db.prepare(
    "INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, value);
}

// ---------- Job ops ----------
function enqueueJob(db, payload) {
  const job = {
    id: payload.id || cryptoRandomId(),
    command: payload.command,
    state: payload.state || "pending",
    attempts: payload.attempts ?? 0,
    max_retries:
      payload.max_retries ?? parseInt(getCfg(db, "max_retries", "3"), 10),
    priority: payload.priority ?? 0,
    run_at: payload.run_at || null,
    created_at: payload.created_at || nowISO(),
    updated_at: nowISO(),
    last_error: null,
    last_rc: null,
    stdout: null,
    stderr: null,
    worker_id: null,
  };
  db.prepare(
    `
    INSERT INTO jobs(id,command,state,attempts,max_retries,priority,run_at,created_at,updated_at,last_error,last_rc,stdout,stderr,worker_id)
    VALUES (@id,@command,@state,@attempts,@max_retries,@priority,@run_at,@created_at,@updated_at,@last_error,@last_rc,@stdout,@stderr,@worker_id)
  `
  ).run(job);
  return job.id;
}

function listJobs(db, state, limit) {
  let stmt;
  if (state) {
    stmt = db.prepare(`
      SELECT id,command,state,attempts,max_retries,priority,run_at,created_at,updated_at,last_rc
      FROM jobs WHERE state=? ORDER BY priority DESC, created_at LIMIT ?
    `);
    return stmt.all(state, limit);
  }
  stmt = db.prepare(`
    SELECT id,command,state,attempts,max_retries,priority,run_at,created_at,updated_at,last_rc
    FROM jobs ORDER BY created_at DESC LIMIT ?
  `);
  return stmt.all(limit);
}

function status(db) {
  const counts = {};
  for (const s of ["pending", "processing", "completed", "failed", "dead"]) {
    counts[s] = db
      .prepare("SELECT COUNT(*) c FROM jobs WHERE state=?")
      .get(s).c;
  }
  const workers = db.prepare("SELECT * FROM workers").all();
  return { counts, workers };
}

function cryptoRandomId() {
  // simple unique id
  return `job_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

// Claim one job atomically using an IMMEDIATE transaction.
// Strategy: pick candidate id, then update with state check; if changes === 1, we claimed it.
function claimOneJob(db, workerId) {
  const tx = db.transaction(() => {
    const now = nowISO();
    const pick = db
      .prepare(
        `
      SELECT id FROM jobs
      WHERE state='pending' AND (run_at IS NULL OR run_at <= ?)
      ORDER BY priority DESC, created_at
      LIMIT 1
    `
      )
      .get(now);
    if (!pick) return null;
    const upd = db
      .prepare(
        `
      UPDATE jobs
      SET state='processing', worker_id=?, updated_at=?
      WHERE id=? AND state='pending'
    `
      )
      .run(workerId, now, pick.id);
    if (upd.changes !== 1) return null;
    return db.prepare("SELECT * FROM jobs WHERE id=?").get(pick.id);
  });
  return tx();
}

function completeJob(db, jobId, rc, stdout, stderr) {
  if (rc === 0) {
    db.prepare(
      `
      UPDATE jobs SET state='completed', last_rc=?, stdout=?, stderr=?, updated_at=?
      WHERE id=?
    `
    ).run(rc, stdout, stderr, nowISO(), jobId);
    return;
  }
  const row = db
    .prepare("SELECT attempts, max_retries FROM jobs WHERE id=?")
    .get(jobId);
  if (!row) return;
  const attempts = Number(row.attempts) + 1;
  const max = Number(row.max_retries);
  const base = Number(getCfg(db, "backoff_base", "2"));
  if (attempts < max) {
    const delay = Math.pow(base, attempts);
    const runAt = new Date(Date.now() + delay * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    db.prepare(
      `
      UPDATE jobs SET state='pending', attempts=?, run_at=?, last_rc=?, last_error=?, stdout=?, stderr=?, updated_at=?
      WHERE id=?
    `
    ).run(
      attempts,
      runAt,
      rc,
      `nonzero exit ${rc}`,
      stdout,
      stderr,
      nowISO(),
      jobId
    );
  } else {
    db.prepare(
      `
      UPDATE jobs SET state='dead', attempts=?, last_rc=?, last_error=?, stdout=?, stderr=?, updated_at=?
      WHERE id=?
    `
    ).run(
      attempts,
      rc,
      `retries_exhausted (rc=${rc})`,
      stdout,
      stderr,
      nowISO(),
      jobId
    );
  }
}

function failJobImmediate(db, jobId, message) {
  const row = db
    .prepare("SELECT attempts, max_retries FROM jobs WHERE id=?")
    .get(jobId);
  if (!row) return;
  const attempts = Number(row.attempts) + 1;
  const max = Number(row.max_retries);
  const base = Number(getCfg(db, "backoff_base", "2"));
  if (attempts < max) {
    const delay = Math.pow(base, attempts);
    const runAt = new Date(Date.now() + delay * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    db.prepare(
      `
      UPDATE jobs SET state='pending', attempts=?, run_at=?, last_error=?, updated_at=?
      WHERE id=?
    `
    ).run(attempts, runAt, message.slice(0, 500), nowISO(), jobId);
  } else {
    db.prepare(
      `
      UPDATE jobs SET state='dead', attempts=?, last_error=?, updated_at=?
      WHERE id=?
    `
    ).run(
      attempts,
      `retries_exhausted (${message.slice(0, 500)})`,
      nowISO(),
      jobId
    );
  }
}

// ---------- Worker loop ----------
async function execCommand(cmd) {
  // Promise wrapper around child_process.exec to capture stdout/stderr
  const { exec } = require("child_process");
  return new Promise((resolve) => {
    const child = exec(
      cmd,
      { shell: true, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // error.code is exit code if process started, else null
          const rc = typeof error.code === "number" ? error.code : 1;
          return resolve({
            rc,
            stdout: stdout || "",
            stderr: stderr || error.message || "",
          });
        }
        resolve({ rc: 0, stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

function workerLoop(dbPath, workerId) {
  const db = ensureDb(dbPath);
  const poll = Number(getCfg(db, "poll_interval_sec", "1"));
  let stop = false;

  process.on("SIGTERM", () => {
    stop = true;
  });
  process.on("SIGINT", () => {
    stop = true;
  });

  db.prepare(
    "INSERT OR REPLACE INTO workers(id,pid,status,started_at,updated_at) VALUES(?,?,?,?,?)"
  ).run(workerId, process.pid, "running", nowISO(), nowISO());

  (async () => {
    while (true) {
      if (stop || getCfg(db, "graceful_stop", "0") === "1") break;

      const job = claimOneJob(db, workerId);
      if (!job) {
        await new Promise((r) => setTimeout(r, poll * 1000));
        continue;
      }

      try {
        const { rc, stdout, stderr } = await execCommand(job.command);
        const cap = (s) => (s ? s.slice(-100000) : null);
        completeJob(db, job.id, rc, cap(stdout), cap(stderr));
      } catch (e) {
        failJobImmediate(
          db,
          job.id,
          `exec error: ${e && e.message ? e.message : String(e)}`
        );
      }
    }
    db.prepare("UPDATE workers SET status=?, updated_at=? WHERE id=?").run(
      "stopped",
      nowISO(),
      workerId
    );
    db.close();
    process.exit(0);
  })();
}

// ---------- CLI ----------
function parseArgs(argv) {
  // Tiny arg parser (keeps deps minimal)
  const [cmd, subcmdOrArg, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(t);
    }
  }
  return { cmd, sub: subcmdOrArg, flags, positional };
}

function printHelp() {
  console.log(`queuectl (Node.js)

Usage:
  queuectl enqueue '<job-json>' | --file job.json
  queuectl worker start --count N
  queuectl worker stop
  queuectl status
  queuectl list [--state pending|processing|completed|failed|dead] [--limit 50]
  queuectl dlq list [--limit 50]
  queuectl dlq retry <jobId>
  queuectl config set <key> <value>
  queuectl config get [key]
`);
}

function cmd_enqueue(args) {
  const db = ensureDb();
  try {
    let payload;
    if (args.flags.file) {
      payload = JSON.parse(fs.readFileSync(args.flags.file, "utf-8"));
    } else if (args.sub) {
      payload = JSON.parse(args.sub);
    } else {
      throw new Error("provide inline JSON or --file");
    }
    if (!payload.command) throw new Error('job requires "command"');
    const id = enqueueJob(db, payload);
    console.log(`enqueued: ${id}`);
  } catch (e) {
    console.error(`enqueue error: ${e.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

function cmd_list(args) {
  const db = ensureDb();
  const limit = Number(args.flags.limit || 50);
  const rows = listJobs(db, args.flags.state, limit);
  if (!rows.length) {
    console.log("(no jobs)");
  } else {
    for (const r of rows) {
      const cmd =
        r.command.length > 60 ? r.command.slice(0, 57) + "…" : r.command;
      console.log(
        `${r.id.padEnd(28)} ${String(r.state).padEnd(10)} att=${r.attempts}/${
          r.max_retries
        } rc=${String(r.last_rc ?? "").padEnd(3)} run_at=${
          r.run_at || "-"
        } prio=${r.priority}  ${cmd}`
      );
    }
  }
  db.close();
}

function cmd_status() {
  const db = ensureDb();
  const { counts, workers } = status(db);
  console.log("Jobs:");
  for (const k of ["pending", "processing", "completed", "failed", "dead"]) {
    console.log(`  ${k.padEnd(10)} ${counts[k]}`);
  }
  console.log("Workers:");
  if (!workers.length) console.log("  (none)");
  else {
    for (const w of workers) {
      console.log(
        `  ${w.id} pid=${w.pid} status=${w.status} updated=${w.updated_at}`
      );
    }
  }
  db.close();
}

function cmd_dlq(args) {
  const db = ensureDb();
  const action = args.sub;
  if (action === "list") {
    const limit = Number(args.flags.limit || 50);
    const rows = listJobs(db, "dead", limit);
    if (!rows.length) console.log("(DLQ empty)");
    else {
      for (const r of rows) {
        const err = (r.last_error || "").slice(0, 80);
        console.log(`${r.id} attempts=${r.attempts} err=${err}`);
      }
    }
  } else if (action === "retry") {
    const jobId = args.positional[0];
    if (!jobId) {
      console.error("dlq retry <jobId>");
      process.exit(2);
    }
    const row = db.prepare("SELECT state FROM jobs WHERE id=?").get(jobId);
    if (!row) {
      console.error(`no such job: ${jobId}`);
      process.exit(1);
    }
    if (row.state !== "dead") {
      console.error(`job not in DLQ (state=${row.state})`);
      process.exit(1);
    }
    db.prepare(
      `
      UPDATE jobs
      SET state='pending', attempts=0, run_at=NULL, last_error=NULL, last_rc=NULL, stdout=NULL, stderr=NULL, updated_at=?
      WHERE id=?
    `
    ).run(nowISO(), jobId);
    console.log(`requeued: ${jobId}`);
  } else {
    console.error("dlq [list|retry]");
    process.exit(2);
  }
  db.close();
}

function cmd_config(args) {
  const db = ensureDb();
  const action = args.sub;
  if (action === "set") {
    const key = args.flags._key || args.positional[0];
    const value = args.flags._val || args.positional[1];
    if (!key || typeof value === "undefined") {
      console.error("config set <key> <value>");
      process.exit(2);
    }
    setCfg(db, key, String(value));
    // sanity: if someone sets graceful_stop to weird value, reset
    if (key === "graceful_stop" && !["0", "1"].includes(String(value)))
      setCfg(db, "graceful_stop", "0");
    console.log(`set ${key}=${value}`);
  } else if (action === "get") {
    const key = args.flags._key || args.positional[0];
    if (key) {
      console.log(getCfg(db, key, ""));
    } else {
      const rows = db
        .prepare("SELECT key,value FROM config ORDER BY key")
        .all();
      for (const r of rows) console.log(`${r.key}=${r.value}`);
    }
  } else {
    console.error("config [get|set]");
    process.exit(2);
  }
  db.close();
}

function randomUUID() {
  // lightweight uuid v4-ish
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function startWorkers(args) {
  const count = Number(args.flags.count || 1);
  const db = ensureDb();
  const procs = [];
  for (let i = 0; i < count; i++) {
    const wid = randomUUID();
    db.prepare(
      "INSERT OR REPLACE INTO workers(id,pid,status,started_at,updated_at) VALUES(?,?,?,?,?)"
    ).run(wid, 0, "starting", nowISO(), nowISO());

    // fork this same file with hidden _worker mode
    const child = fork(
      __filename,
      ["_worker", "--id", wid, "--db", DEFAULT_DB_PATH],
      {
        detached: true,
        stdio: "ignore",
      }
    );
    db.prepare(
      "UPDATE workers SET pid=?, status=?, updated_at=? WHERE id=?"
    ).run(child.pid, "running", nowISO(), wid);
    child.unref();
    procs.push({ wid, pid: child.pid });
  }
  db.close();
  console.log(`started ${procs.length} worker(s):`);
  for (const p of procs) console.log(`  worker ${p.wid} pid=${p.pid}`);
}

function stopWorkers() {
  const db = ensureDb();
  setCfg(db, "graceful_stop", "1");
  const rows = db
    .prepare(
      "SELECT id,pid,status FROM workers WHERE status IN ('starting','running')"
    )
    .all();
  for (const r of rows) {
    try {
      process.kill(Number(r.pid), "SIGTERM");
    } catch (_) {
      /* already dead */
    }
  }
  db.close();
  console.log(
    `stop requested for ${rows.length} worker(s). They will exit after finishing current job.`
  );
}

// ---------- Entrypoint ----------
(async function main() {
  const argv = process.argv.slice(2);

  // Hidden worker mode
  if (argv[0] === "_worker") {
    const idIdx = argv.indexOf("--id");
    const dbIdx = argv.indexOf("--db");
    const wid = idIdx >= 0 ? argv[idIdx + 1] : randomUUID();
    const dbPath = dbIdx >= 0 ? argv[dbIdx + 1] : DEFAULT_DB_PATH;
    return workerLoop(dbPath, wid);
  }

  if (argv.length === 0) return printHelp();
  const args = parseArgs(argv);
  switch (args.cmd) {
    case "enqueue":
      return cmd_enqueue(args);
    case "list":
      return cmd_list(args);
    case "status":
      return cmd_status(args);
    case "worker":
      if (args.sub === "start") return startWorkers(args);
      if (args.sub === "stop") return stopWorkers();
      console.error("worker [start|stop]");
      process.exit(2);
      break;
    case "dlq":
      return cmd_dlq(args);
    case "config":
      return cmd_config(args);
    case "help":
    default:
      return printHelp();
  }
})();
