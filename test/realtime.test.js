// test/realtime.test.js — Socket.IO integration tests for the live board.
//
// Boots server.js on a random port (fresh SQLite DB), then verifies over real
// socket connections that:
//   - a board observer receives the full state on connect
//   - join_queue shows up in the broadcast (coalesced broadcasts still land
//     within ~100ms)
//   - a non-admin cannot remove someone else's queue entry
//
// Note: broadcasts are coalesced (50ms), so listeners must also check the
// latest cached state instead of only waiting for future events — that is
// what observe()/waitForState() do.
//
// Run with: npm test   (node --test)

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { io } = require('socket.io-client');

let child = null;
let base = '';
let dbFile = '';

before(async () => {
  dbFile = path.join(os.tmpdir(), `n1-rt-test-${process.pid}-${Date.now()}.db`);
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbFile,
      // Isolate the live-board state file — without this the server would
      // load (and write) the project root's state.json.
      STATE_FILE: dbFile + '.state.json',
      SESSION_SECRET: 'test-secret',
    },
    stdio: 'ignore',
  });
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
  setTimeout(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      fs.rmSync(dbFile + suffix, { force: true });
    }
  }, 300).unref?.();
});

function connect() {
  return io(base, { transports: ['websocket'] });
}

// Track the latest broadcast state on a socket. Because broadcasts are
// coalesced, an update may land BEFORE a caller starts waiting — so checks
// poll the cache instead of relying purely on new events.
function observe(socket) {
  const latest = { state: null };
  socket.on('state_update', s => { latest.state = s; });
  return latest;
}

function waitForState(latest, cond, ms = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (latest.state && cond(latest.state)) return resolve(latest.state);
      if (Date.now() - start > ms) return reject(new Error('state condition not met in time'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms)),
  ]);
}

test('observer receives initial board state on connect', async () => {
  const socket = connect();
  const state = await withTimeout(new Promise((resolve, reject) => {
    socket.once('state_update', resolve);
    socket.once('connect_error', reject);
  }), 3000, 'initial state_update');
  assert.ok(Array.isArray(state.courtIds), 'courtIds is an array');
  assert.ok(Array.isArray(state.queue), 'queue is an array');
  socket.disconnect();
});

test('join_queue reaches the board via broadcast', async () => {
  const board = connect();
  const boardLatest = observe(board);
  await withTimeout(new Promise((resolve, reject) => {
    board.once('state_update', resolve);
    board.once('connect_error', reject);
  }), 3000, 'board initial state');

  const player = connect();
  const joinOk = withTimeout(new Promise((resolve) => player.once('join_success', resolve)),
    3000, 'join_success');
  player.emit('join_queue', { name: 'RTPlayer', level: 'novice' });
  await joinOk;

  const s = await waitForState(boardLatest, (st) => st.queue.includes('RTPlayer'));
  assert.ok(s.queue.includes('RTPlayer'), 'board sees the queued player');
  assert.ok(s.players['RTPlayer'], 'level recorded');

  player.disconnect();
  board.disconnect();
});

test('non-admin cannot remove someone else from the queue', async () => {
  const board = connect();
  const boardLatest = observe(board);
  await waitForState(boardLatest, (st) => st.queue.includes('RTPlayer'), 3000);

  // RTPlayer was joined by another socket; this new socket owns nothing.
  const outsider = connect();
  outsider.emit('remove_from_queue', 'RTPlayer');
  // Wait past the coalescing window; the queue must be untouched.
  await new Promise((r) => setTimeout(r, 300));
  const s = await waitForState(boardLatest, () => !!boardLatest.state, 1000);
  assert.ok(s.queue.includes('RTPlayer'), 'unauthorised removal is ignored');

  outsider.disconnect();
  board.disconnect();
});

// ── Auto-record: end_game writes to every player's account history ──

async function http(path, opts = {}, cookie = null) {
  const r = await fetch(base + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

test('end_game auto-records the match for all players; undo voids it', async () => {
  // 1) Register four players over HTTP.
  const users = [];
  for (let i = 1; i <= 4; i++) {
    const reg = await http('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: `autop${i}`, password: `password${i}`,
        display_name: `AutoP${i}`, email: `autop${i}@test.com`,
      }),
    });
    assert.equal(reg.status, 200, `register player ${i}`);
    users.push({ name: `AutoP${i}`, cookie: reg.cookie });
  }

  // 2) Admin login + create event + register the four players to it.
  const adm = await http('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'admin1234' }),
  });
  assert.equal(adm.status, 200, 'admin login');
  const ev = await http('/api/events', {
    method: 'POST',
    body: JSON.stringify({ title: 'AutoRecord Event', event_date: '2099-01-01', capacity: 20 }),
  }, adm.cookie);
  assert.equal(ev.status, 200, 'create event');
  const eventId = ev.data.id;
  for (const u of users) {
    const reg = await http(`/api/events/${eventId}/registrations`, {
      method: 'POST',
      body: JSON.stringify({ reg_type: 'activity' }),
    }, u.cookie);
    assert.ok(reg.status === 200 || reg.status === 409, `register player to event`);
  }

  // 3) Admin socket (session cookie in the websocket handshake) activates
  //    the event — registrants land in the queue.
  const adminSock = io(base, { transports: ['websocket'], extraHeaders: { Cookie: adm.cookie } });
  const adminLatest = observe(adminSock);
  await withTimeout(new Promise((res, rej) => {
    adminSock.once('connect', res);
    adminSock.once('connect_error', rej);
  }), 3000, 'admin socket connect');
  adminSock.emit('activate_event', { eventId });
  await withTimeout(new Promise((res) => adminSock.once('activate_success', res)),
    3000, 'activate_success');
  await waitForState(adminLatest, (s) => s.activeEventId === eventId
    && users.every(u => s.queue.includes(u.name)), 3000);

  // 4) Seat the four on court 6, start, then end with a score.
  adminSock.emit('manual_assign', { courtId: 6, names: users.map(u => u.name) });
  await waitForState(adminLatest, (s) => s.courts[6].players.length === 4, 3000);
  adminSock.emit('start_game', 6);
  adminSock.emit('end_game', {
    courtId: 6, toQueue: true,
    teams: [['AutoP1', 'AutoP2'], ['AutoP3', 'AutoP4']],
    score: { a: 21, b: 15 },
  });
  await new Promise(r => setTimeout(r, 500)); // allow the insert + broadcast

  // 5) Every player's account history shows the match with correct perspective.
  for (let i = 0; i < 4; i++) {
    const mine = await http('/api/matches/mine', {}, users[i].cookie);
    assert.equal(mine.status, 200, `/mine for player ${i + 1}`);
    assert.equal(mine.data.matches.length, 1, `player ${i + 1} sees exactly one match`);
    const m = mine.data.matches[0];
    assert.equal(m.event_title, 'AutoRecord Event');
    assert.equal(m.score_a, 21);
    assert.equal(m.score_b, 15);
    // Teammates: AutoP1+AutoP2 are team A, AutoP3+AutoP4 are team B.
    const expectedTeammate = { AutoP1: 'AutoP2', AutoP2: 'AutoP1', AutoP3: 'AutoP4', AutoP4: 'AutoP3' }[users[i].name];
    assert.equal(m.teammate_name, expectedTeammate);
    if (i < 2) {
      assert.equal(m.my_team, 'A');
      assert.equal(m.did_win, true);
    } else {
      assert.equal(m.my_team, 'B');
      assert.equal(m.did_win, false);
    }
  }

  // 6) Undo also voids the auto-recorded match.
  adminSock.emit('undo_court_action', 6);
  await new Promise(r => setTimeout(r, 500));
  const mineAfterUndo = await http('/api/matches/mine', {}, users[0].cookie);
  assert.equal(mineAfterUndo.data.matches.length, 0, 'match voided after undo');

  adminSock.disconnect();
});
