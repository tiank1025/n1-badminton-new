// db.js — unified async database layer.
//
// Two backends, one API:
//   - DATABASE_URL set  → PostgreSQL via `pg` (Render/Supabase production)
//   - DATABASE_URL unset → local SQLite via better-sqlite3 (dev)
//
// All callers write SQL with `?` placeholders (SQLite style). The PG wrapper
// translates `?` → `$1, $2, …` automatically, so the same SQL works on both.
//
//   const row  = await db.prepare(sql).get(...params)
//   const rows = await db.prepare(sql).all(...params)
//   const info = await db.prepare(sql).run(...params)   // {lastInsertRowid, changes}
//   await db.exec(multiStatementSql)
//   const r = await db.transaction(async tx => { await tx.prepare(...).run(...); return x; })

const crypto = require('node:crypto');
const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;
const isPG = !!DATABASE_URL;

// ── Schema (identical structure, only PK type differs) ──
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            {PK} PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name  TEXT NOT NULL UNIQUE,
  email         TEXT,
  level         TEXT NOT NULL DEFAULT 'novice'
                CHECK (level IN ('advanced','intermediate','novice','beginner')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    {INT} NOT NULL,
  updated_at    {INT} NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id                   {PK} PRIMARY KEY,
  title                TEXT NOT NULL,
  event_date           TEXT NOT NULL,
  start_time           TEXT NOT NULL DEFAULT '19:00',
  end_time             TEXT NOT NULL DEFAULT '21:00',
  location             TEXT,
  training_enabled     INTEGER NOT NULL DEFAULT 1,
  capacity             INTEGER NOT NULL DEFAULT 33,
  fee_social_cents     INTEGER NOT NULL DEFAULT 1900,
  fee_training_cents   INTEGER NOT NULL DEFAULT 4500,
  payment_link         TEXT,
  registration_open_at  {INT},
  registration_close_at {INT},
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','open','closed','active','finished')),
  synced_at            {INT},
  created_at           {INT} NOT NULL,
  updated_at           {INT} NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  id              {PK} PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reg_type        TEXT NOT NULL CHECK (reg_type IN ('activity','training_and_activity')),
  training_slot   INTEGER,
  partner_user_id INTEGER REFERENCES users(id),
  sticky_pair     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'registered'
                  CHECK (status IN ('registered','checked_in','cancelled')),
  -- Fee snapshot at registration time, so changing the event fee later does
  -- not silently change what an existing participant owes.
  fee_cents       INTEGER,
  -- 'unpaid' → 'submitted' (user uploaded proof) → 'paid' (admin confirmed).
  -- 'waived' is set by an admin and counts as settled.
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',
  payment_proof   TEXT,
  payment_note    TEXT,
  payment_submitted_at {INT},
  payment_confirmed_at {INT},
  -- On-site check-in: set when the player taps "I'm here" on the mobile page
  -- (or an admin marks them present). Kept separate from the status column so
  -- the registration still counts as active for capacity / board sync.
  checked_in_at   {INT},
  created_at      {INT} NOT NULL,
  updated_at      {INT} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_event ON registrations(event_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_active
  ON registrations(event_id, user_id) WHERE status = 'registered';

-- Queue for a full event (33 registered). Kept in its own table so the
-- registrations CHECK constraint stays untouched on existing databases.
CREATE TABLE IF NOT EXISTS waitlist (
  id         {PK} PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reg_type   TEXT NOT NULL DEFAULT 'activity'
             CHECK (reg_type IN ('activity','training_and_activity')),
  created_at {INT} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_waitlist_event_user
  ON waitlist(event_id, user_id);

CREATE TABLE IF NOT EXISTS matches (
  id              {PK} PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  match_date      TEXT NOT NULL,
  match_time      TEXT,
  team_a_p1_id    INTEGER NOT NULL REFERENCES users(id),
  team_a_p2_id    INTEGER NOT NULL REFERENCES users(id),
  team_b_p1_id    INTEGER NOT NULL REFERENCES users(id),
  team_b_p2_id    INTEGER NOT NULL REFERENCES users(id),
  score_a         INTEGER,
  score_b         INTEGER,
  winner          TEXT CHECK (winner IN ('A', 'B', NULL)),
  status          TEXT NOT NULL DEFAULT 'recorded'
                  CHECK (status IN ('recorded', 'cancelled')),
  notes           TEXT,
  recorded_by     INTEGER NOT NULL REFERENCES users(id),
  recorded_at     {INT} NOT NULL,
  updated_by      INTEGER REFERENCES users(id),
  updated_at      {INT},
  created_at      {INT} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_event ON matches(event_id);
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);

-- In-app notifications. Created when a waitlisted player is promoted into a
-- freed spot (and potentially for other admin actions later).
CREATE TABLE IF NOT EXISTS notifications (
  id         {PK} PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  event_id   INTEGER REFERENCES events(id) ON DELETE CASCADE,
  read_at    {INT},
  created_at {INT} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

-- Persistent express-session storage; survives process restarts and works
-- when requests are served by more than one app instance.
CREATE TABLE IF NOT EXISTS app_sessions (
  sid    TEXT PRIMARY KEY,
  sess   TEXT NOT NULL,
  expire {INT} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expire ON app_sessions(expire);
`;

// ── Build the backend ───────────────────────────────────
let db;

if (isPG) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
  });

  // Convert SQLite-style `?` placeholders to PostgreSQL `$1, $2, …`.
  function toPgParams(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  function makePrepare(queryable) {
    return function prepare(sql) {
      let finalSql = toPgParams(sql);
      // Auto-append RETURNING id for INSERTs so .run() can expose lastInsertRowid.
      if (/^\s*INSERT\s+/i.test(sql) && !/RETURNING/i.test(sql)) {
        finalSql = finalSql + ' RETURNING id';
      }
      return {
        async get(...params) {
          const r = await queryable.query(finalSql, params);
          return r.rows[0];
        },
        async all(...params) {
          const r = await queryable.query(finalSql, params);
          return r.rows;
        },
        async run(...params) {
          const r = await queryable.query(finalSql, params);
          return { lastInsertRowid: r.rows[0]?.id, changes: r.rowCount };
        },
      };
    };
  }

  db = {
    prepare: makePrepare(pool),
    exec: async (sql) => { await pool.query(sql); },
    pool,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = { prepare: makePrepare(client) };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
} else {
  const Database = require('better-sqlite3');
  const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'n1.db');
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(DB_FILE);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  function prepare(sql) {
    const stmt = sqlite.prepare(sql);
    return {
      async get(...p) { return stmt.get(...p); },
      async all(...p) { return stmt.all(...p); },
      async run(...p) { return stmt.run(...p); },
    };
  }

  db = {
    prepare,
    exec: (sql) => sqlite.exec(sql),
    _raw: sqlite,
    async transaction(fn) {
      // better-sqlite3's native db.transaction() requires a sync callback, but
      // our callback is async (uses await). Use manual BEGIN/COMMIT/ROLLBACK
      // on the single shared connection instead — equivalent for this app.
      sqlite.exec('BEGIN');
      try {
        const tx = { prepare };
        const result = await fn(tx);
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// ── Schema init ─────────────────────────────────────────
async function initSchema() {
  const pk = isPG ? 'SERIAL' : 'INTEGER';
  const int = isPG ? 'BIGINT' : 'INTEGER';
  const sql = SCHEMA.replace(/\{PK\}/g, pk).replace(/\{INT\}/g, int);
  await db.exec(sql);
}

// Columns added after the first release. Databases created before the payment
// feature already have the tables, so CREATE TABLE IF NOT EXISTS is a no-op —
// these ALTERs bring the existing schema up to date on both backends.
const COLUMN_MIGRATIONS = [
  ['events', 'fee_social_cents', 'INTEGER NOT NULL DEFAULT 1900'],
  ['events', 'fee_training_cents', 'INTEGER NOT NULL DEFAULT 4500'],
  ['events', 'payment_link', 'TEXT'],
  ['events', 'capacity', 'INTEGER NOT NULL DEFAULT 33'],
  ['events', 'training_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['registrations', 'fee_cents', 'INTEGER'],
  ['registrations', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'"],
  ['registrations', 'payment_proof', 'TEXT'],
  ['registrations', 'payment_note', 'TEXT'],
  ['registrations', 'payment_submitted_at', '{INT}'],
  ['registrations', 'payment_confirmed_at', '{INT}'],
  ['registrations', 'checked_in_at', '{INT}'],
  ['events', 'location', 'TEXT'],
  ['users', 'email', 'TEXT'],
];

async function hasColumn(table, column) {
  if (isPG) {
    // NOTE: restrict to the current schema — Supabase ships its own
    // auth.users table (with an email column), and an unqualified
    // information_schema query would match it and wrongly skip migrations.
    const row = await db.prepare(
      'SELECT 1 AS x FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?'
    ).get(table, column);
    return !!row;
  }
  const cols = db._raw.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

async function migrate() {
  const int = isPG ? 'BIGINT' : 'INTEGER';
  for (const [table, column, def] of COLUMN_MIGRATIONS) {
    if (await hasColumn(table, column)) continue;
    await db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${def.replace('{INT}', int)}`
    );
  }
  // Backfill the fee snapshot for registrations created before this feature.
  await db.exec(`
    UPDATE registrations AS r
       SET fee_cents = CASE
         WHEN r.reg_type = 'training_and_activity' THEN e.fee_training_cents
         ELSE e.fee_social_cents
       END
      FROM events AS e
     WHERE r.event_id = e.id AND r.fee_cents IS NULL
  `);

  await translateLegacyNotifications();
}

// Notifications written before the site standardised on English are stored in
// Chinese. Rewrite them once so the in-app list is consistent in both modes.
async function translateLegacyNotifications() {
  const rows = await db.prepare(
    "SELECT id, type, title, body, event_id FROM notifications WHERE type = 'waitlist_promoted'"
  ).all();
  const CJK = /[\u4e00-\u9fff]/;
  for (const row of rows) {
    if (!CJK.test(`${row.title || ''}${row.body || ''}`)) continue;

    // Recover the event title from the Chinese prefix when possible.
    const m = /^候补转正确认：(.+)$/.exec(row.title || '');
    let eventTitle = m ? m[1] : null;
    if (!eventTitle && row.event_id) {
      const ev = await db.prepare('SELECT title FROM events WHERE id = ?').get(row.event_id);
      eventTitle = ev?.title || null;
    }

    const title = `Waitlist promoted: ${eventTitle || 'N1 Badminton event'}`;
    const ev = row.event_id
      ? await db.prepare('SELECT event_date, start_time, end_time, location FROM events WHERE id = ?').get(row.event_id)
      : null;

    const when = ev
      ? `${ev.event_date} · ${ev.start_time}-${ev.end_time}${ev.location ? ` · ${ev.location}` : ''}`
      : '';
    const body = [
      'You have been moved from the waitlist to a confirmed spot.',
      when ? `When: ${when}` : '',
      'If you can no longer attend, please cancel at least 24 hours before the event starts.',
    ].filter(Boolean).join('\n');

    await db.prepare('UPDATE notifications SET title = ?, body = ? WHERE id = ?').run(title, body, row.id);
  }
}

// ── Password hashing (node:crypto scrypt) ───────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

// ── Seed admin on first run ────────────────────────────
async function seedAdmin() {
  const count = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;
  if (count > 0) return;
  const adminUser = process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin';
  const adminPass = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin1234';
  const { hash, salt } = hashPassword(adminPass);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, display_name, level, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'intermediate', 1, ?, ?)`
  ).run(adminUser, hash, salt, adminUser, now, now);
  console.log(`  Seeded admin user: ${adminUser} (change password after first login)`);
}

// Initialise schema + seed before exporting. Export the promise so server.js
// can wait for it before listening (avoids races on first boot with PG).
const dbReady = initSchema().then(migrate).then(seedAdmin).catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});

module.exports = { db, dbReady, hashPassword, verifyPassword };
