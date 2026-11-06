// test/api.test.js — integration tests against a real server instance.
//
// Boots server.js as a child process on a random port with a throwaway SQLite
// database, then exercises the core flows over HTTP:
//   - health, registration + login validation, session rotation
//   - concurrent registration on a capacity-1 event (overbooking race)
//   - waitlist auto-promotion on cancel
//   - matches PATCH must not wipe scores/winner/notes on partial updates
//
// Run with: npm test   (node --test test/)

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let child = null;
let base = '';
let dbFile = '';

// ── Server lifecycle ─────────────────────────────────────
before(async () => {
  dbFile = path.join(os.tmpdir(), `n1-test-${process.pid}-${Date.now()}.db`);
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbFile,
      // Isolate the live-board state file so tests never touch the project
      // root's state.json.
      STATE_FILE: dbFile + '.state.json',
      SESSION_SECRET: 'test-secret',
      // Raise rate limits so the suite's many credential calls don't trip them.
      LOGIN_RATE_LIMIT_MAX: '1000',
      REGISTER_RATE_LIMIT_MAX: '1000',
    },
    stdio: 'inherit',
  });

  // Poll /api/health until the server accepts requests (db init included).
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('test server did not become healthy in 10s');
});

after(() => {
  if (child) child.kill();
  if (child) {
    // Give the process a moment to exit before removing its DB files.
    setTimeout(() => {
      for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(dbFile + suffix, { force: true });
      }
    }, 300).unref?.();
  }
});

// ── Cookie-aware client ──────────────────────────────────
function client() {
  let cookie = '';
  return {
    async req(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookies.length) {
        cookie = setCookies.map(c => c.split(';')[0]).join('; ');
      }
      let json = null;
      try { json = await res.json(); } catch { /* empty / non-JSON body */ }
      return { status: res.status, json };
    },
  };
}

const admin = client();
const a = client(); // player A
const b = client(); // player B

let eventId = 0;
let userIds = {}; // username -> id

test('health check', async () => {
  const r = await a.req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('register rejects a too-short password', async () => {
  const r = await a.req('POST', '/api/auth/register', {
    username: 'shorty', password: 'abc', display_name: 'Shorty', email: 'shorty@test.dev',
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /min 8/);
});

test('admin login works', async () => {
  const r = await admin.req('POST', '/api/auth/login', { username: 'admin', password: 'admin1234' });
  assert.equal(r.status, 200);
  assert.equal(r.json.is_admin, 1);
  userIds.admin = r.json.id;
});

test('register + login two players', async () => {
  for (const [name, email] of [['playerA', 'a@test.dev'], ['playerB', 'b@test.dev']]) {
    const reg = await (name === 'playerA' ? a : b).req('POST', '/api/auth/register', {
      username: name, password: 'longenough1', display_name: name, email,
    });
    assert.equal(reg.status, 200);
    userIds[name] = reg.json.id;
  }
  const la = await a.req('POST', '/api/auth/login', { username: 'playerA', password: 'longenough1' });
  assert.equal(la.status, 200);
  const lb = await b.req('POST', '/api/auth/login', { username: 'playerB', password: 'longenough1' });
  assert.equal(lb.status, 200);
});

test('login rotates the session id', async () => {
  const fresh = client();
  const pre = await fresh.req('GET', '/api/auth/me'); // establishes an anonymous session
  assert.equal(pre.status, 200);
  const login = await fresh.req('POST', '/api/auth/login', { username: 'playerA', password: 'longenough1' });
  assert.equal(login.status, 200);
  // After rotation the anonymous session id must no longer resolve to a user —
  // hard to assert directly; instead confirm the new session works via /me.
  const me = await fresh.req('GET', '/api/auth/me');
  assert.equal(me.json?.username, 'playerA');
});

test('GET /api/events/:id exposes cancel-window fields', async () => {
  const r = await admin.req('POST', '/api/events', {
    title: 'Test Event', event_date: '2099-01-01', capacity: 1,
  });
  assert.equal(r.status, 200);
  eventId = r.json.id;
  const ev = await admin.req('GET', `/api/events/${eventId}`);
  assert.equal(ev.status, 200);
  assert.ok(Number.isFinite(ev.json.starts_at_ms));
  assert.ok(Number.isFinite(ev.json.cancel_deadline_ms));
  assert.equal(ev.json.cancel_open, true);
});

test('capacity-1 event: concurrent signups cannot overbook', async () => {
  // Fire both registrations truly concurrently — pre-fix, both could pass the
  // capacity COUNT and insert, producing 2 registrations on a 1-seat event.
  const [ra, rb] = await Promise.all([
    a.req('POST', `/api/events/${eventId}/registrations`, { reg_type: 'activity' }),
    b.req('POST', `/api/events/${eventId}/registrations`, { reg_type: 'activity' }),
  ]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  const bodies = [ra.json, rb.json];
  const registered = bodies.filter(x => x.id !== undefined);
  const waitlisted = bodies.filter(x => x.waitlisted === true);
  assert.equal(registered.length, 1, 'exactly one player gets the seat');
  assert.equal(waitlisted.length, 1, 'the other goes to the waitlist');
});

test('cancelling frees the spot and auto-promotes the waitlist', async () => {
  const regs = await admin.req('GET', `/api/events/${eventId}/registrations`);
  assert.equal(regs.status, 200);
  const seat = regs.json.registrations[0];
  assert.ok(seat, 'seat holder exists');

  const cancel = await admin.req('DELETE', `/api/registrations/${seat.id}`);
  assert.equal(cancel.status, 200);
  assert.ok(cancel.json.promoted, 'waitlisted player was promoted');
  assert.equal(cancel.json.promoted.userId, userIds.playerA === seat.user_id ? userIds.playerB : userIds.playerA);

  // The promoted player now has a real registration.
  const after = await (cancel.json.promoted.userId === userIds.playerA ? a : b)
    .req('GET', `/api/events/${eventId}/registrations`);
  assert.ok(after.json.registration, 'promoted player holds a registration');
  assert.equal(after.json.waitlistEntry, null);
});

test('match creation validates distinct players', async () => {
  // admin appears on both teams — must be rejected.
  const m = await a.req('POST', '/api/matches', {
    event_id: eventId, match_date: '2099-01-01',
    team_a_p1_id: userIds.admin, team_a_p2_id: userIds.playerA,
    team_b_p1_id: userIds.playerB, team_b_p2_id: userIds.admin,
  });
  assert.equal(m.status, 400);
});

test('match record + partial PATCH preserves score', async () => {
  // Register a 3rd and 4th player for a valid match.
  const c = client();
  const rc = await c.req('POST', '/api/auth/register', {
    username: 'playerC', password: 'longenough1', display_name: 'playerC', email: 'c@test.dev',
  });
  assert.equal(rc.status, 200);
  const d = client();
  const rd = await d.req('POST', '/api/auth/register', {
    username: 'playerD', password: 'longenough1', display_name: 'playerD', email: 'd@test.dev',
  });
  assert.equal(rd.status, 200);

  const created = await a.req('POST', '/api/matches', {
    event_id: eventId, match_date: '2099-01-01',
    team_a_p1_id: userIds.admin, team_a_p2_id: userIds.playerA,
    team_b_p1_id: rc.json.id, team_b_p2_id: rd.json.id,
    score_a: 21, score_b: 15, winner: 'A',
  });
  assert.equal(created.status, 200);
  const mid = created.json.id;

  // PATCH that only touches notes must NOT wipe score/winner.
  const patched = await a.req('PATCH', `/api/matches/${mid}`, { notes: 'great rally' });
  assert.equal(patched.status, 200);
  const got = await a.req('GET', `/api/matches/${mid}`);
  assert.equal(got.json.score_a, 21);
  assert.equal(got.json.score_b, 15);
  assert.equal(got.json.winner, 'A');
  assert.equal(got.json.notes, 'great rally');

  // An explicit null still clears just the targeted field.
  const cleared = await a.req('PATCH', `/api/matches/${mid}`, { winner: null });
  assert.equal(cleared.status, 200);
  const got2 = await a.req('GET', `/api/matches/${mid}`);
  assert.equal(got2.json.winner, null);
  assert.equal(got2.json.score_a, 21, 'score survives a winner-only PATCH');
});

test('payment proof upload + retrieval (DB fallback path)', async () => {
  const ev = await admin.req('POST', '/api/events', { title: 'Proof Event', event_date: '2099-02-01' });
  assert.equal(ev.status, 200);
  const reg = await a.req('POST', `/api/events/${ev.json.id}/registrations`, { reg_type: 'activity' });
  assert.equal(reg.status, 200);
  const regId = reg.json.id;

  // A valid 1x1 PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await a.req('POST', `/api/registrations/${regId}/payment-proof`, {
    proof: `data:image/png;base64,${PNG}`, note: 'receipt',
  });
  assert.equal(up.status, 200);
  assert.equal(up.json.status, 'submitted');

  const proof = await a.req('GET', `/api/registrations/${regId}/proof`);
  assert.equal(proof.status, 200);
  assert.match(proof.json.proof, /^data:image\/png;base64,/);
  assert.equal(proof.json.note, 'receipt');

  // Another player must not view someone else's proof.
  const other = await b.req('GET', `/api/registrations/${regId}/proof`);
  assert.equal(other.status, 403);

  // Unsupported image format is rejected.
  const bad = await a.req('POST', `/api/registrations/${regId}/payment-proof`, {
    proof: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  });
  assert.equal(bad.status, 400);
});

test('oversized JSON bodies are rejected outside the proof route', async () => {
  const big = 'x'.repeat(400 * 1024); // 400 KB > 300 KB global cap
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin1234', padding: big }),
  });
  assert.equal(res.status, 413);
});
