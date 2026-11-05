// matches.js — doubles match records + head-to-head statistics.
//
// Design notes:
//   - Only doubles (2v2). Each match creates 4 opponent pairs for stats:
//     A1–B1, A1–B2, A2–B1, A2–B2.
//   - Winner can be null ("未记录"). Matches with no winner still count
//     towards "交手次数" but not win/loss columns.
//   - Soft delete: status = 'cancelled' excludes the match from stats.
//
// Route order matters! Express matches top-to-bottom, so static paths
// (/search-user, /events, /stats/*) MUST come before the dynamic /:id.

const { db } = require('./db');
const express = require('express');
const router = express.Router();

// ── Helpers ──────────────────────────────────────────────

function requireLogin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

async function isAdmin(userId) {
  const u = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
  return !!u?.is_admin;
}

// Attach player + event names to a list of match rows.
async function hydrateMatches(rows) {
  if (!rows.length) return [];
  const userIds = new Set();
  rows.forEach(r => {
    [r.team_a_p1_id, r.team_a_p2_id, r.team_b_p1_id, r.team_b_p2_id, r.recorded_by]
      .forEach(id => { if (id) userIds.add(id); });
  });
  const users = await db.prepare(
    `SELECT id, display_name FROM users WHERE id IN (${Array.from(userIds).join(',')})`
  ).all();
  const uMap = Object.fromEntries(users.map(u => [u.id, u.display_name]));

  const eventIds = [...new Set(rows.map(r => r.event_id))];
  const events = await db.prepare(
    `SELECT id, title FROM events WHERE id IN (${eventIds.join(',')})`
  ).all();
  const eMap = Object.fromEntries(events.map(e => [e.id, e.title]));

  return rows.map(r => ({
    ...r,
    team_a_p1_name: uMap[r.team_a_p1_id] || '?',
    team_a_p2_name: uMap[r.team_a_p2_id] || '?',
    team_b_p1_name: uMap[r.team_b_p1_id] || '?',
    team_b_p2_name: uMap[r.team_b_p2_id] || '?',
    recorded_by_name: uMap[r.recorded_by] || '?',
    event_title: eMap[r.event_id] || '?',
  }));
}

// ── Stats SQL: expand 1 match → 4 opponent pairs ─────────
// Each pair row: me_id, opp_id, did_win (null if no winner).
// Only includes active ('recorded') matches.
const PAIRS_SQL = `
  SELECT me.p_id AS me_id, opp.p_id AS opp_id,
         m.id AS match_id, m.match_date, m.match_time, m.event_id,
         m.team_a_p1_id, m.team_a_p2_id, m.team_b_p1_id, m.team_b_p2_id,
         m.score_a, m.score_b, m.winner, m.status,
         CASE
           WHEN m.winner = 'A' AND me.team = 'A' THEN 1
           WHEN m.winner = 'B' AND me.team = 'B' THEN 1
           WHEN m.winner = 'A' AND me.team = 'B' THEN 0
           WHEN m.winner = 'B' AND me.team = 'A' THEN 0
           ELSE NULL
         END AS did_win
    FROM matches m
    JOIN (
      SELECT id, team_a_p1_id AS p_id, 'A' AS team FROM matches
      UNION ALL SELECT id, team_a_p2_id, 'A' FROM matches
      UNION ALL SELECT id, team_b_p1_id, 'B' FROM matches
      UNION ALL SELECT id, team_b_p2_id, 'B' FROM matches
    ) me ON me.id = m.id
    JOIN (
      SELECT id, team_b_p1_id AS p_id, 'B' AS team FROM matches
      UNION ALL SELECT id, team_b_p2_id, 'B' FROM matches
      UNION ALL SELECT id, team_a_p1_id, 'A' FROM matches
      UNION ALL SELECT id, team_a_p2_id, 'A' FROM matches
    ) opp ON opp.id = m.id AND opp.team != me.team
   WHERE m.status = 'recorded'
`;

// ── Routes ───────────────────────────────────────────────
// ⚠️ Static routes first, then dynamic /:id.

// GET /api/matches/search-user?q= — find users for match entry
router.get('/search-user', requireLogin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const rows = await db.prepare(`
    SELECT id, username, display_name, level
      FROM users u
     WHERE u.username LIKE ? OR u.display_name LIKE ?
     ORDER BY u.display_name ASC
     LIMIT 15
  `).all(like, like);
  res.json(rows);
});

// GET /api/matches/events — list finished/active events that can have matches
router.get('/events', requireLogin, async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, title, event_date, status
      FROM events
     WHERE status IN ('active', 'finished')
     ORDER BY event_date DESC
     LIMIT 30
  `).all();
  res.json(rows);
});

// GET /api/matches/my-events — events where I actually played a match
router.get('/my-events', requireLogin, async (req, res) => {
  const me = req.session.userId;
  const rows = await db.prepare(`
    SELECT DISTINCT e.id, e.title, e.event_date, e.start_time, e.end_time, e.status
      FROM matches m
      JOIN events e ON e.id = m.event_id
     WHERE m.status = 'recorded'
       AND (m.team_a_p1_id = ? OR m.team_a_p2_id = ?
            OR m.team_b_p1_id = ? OR m.team_b_p2_id = ?)
     ORDER BY e.event_date DESC
  `).all(me, me, me, me);
  res.json(rows);
});

// GET /api/matches/stats/me — current user's total record
router.get('/stats/me', requireLogin, async (req, res) => {
  const me = req.session.userId;
  const { event_id, from_date, to_date } = req.query;

  const pairClauses = [`me_id = ?`];
  const pairParams = [me];
  if (event_id) { pairClauses.push(`event_id = ?`); pairParams.push(Number(event_id)); }
  if (from_date) { pairClauses.push(`match_date >= ?`); pairParams.push(from_date); }
  if (to_date) { pairClauses.push(`match_date <= ?`); pairParams.push(to_date); }
  const pairWhere = 'WHERE ' + pairClauses.join(' AND ');

  const stats = await db.prepare(
    `SELECT
        COUNT(*) AS total_pairs,
        SUM(CASE WHEN did_win = 1 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN did_win = 0 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN did_win IS NULL THEN 1 ELSE 0 END) AS pending
      FROM (${PAIRS_SQL}) pairs
      ${pairWhere}`
  ).all(...pairParams);

  // Distinct matches where I participated
  const matchClauses = [];
  const matchParams = [me, me, me, me];
  if (event_id) { matchClauses.push('event_id = ?'); matchParams.push(Number(event_id)); }
  if (from_date) { matchClauses.push('match_date >= ?'); matchParams.push(from_date); }
  if (to_date) { matchClauses.push('match_date <= ?'); matchParams.push(to_date); }
  const matchWhere = `WHERE m.status = 'recorded'
    AND (m.team_a_p1_id = ? OR m.team_a_p2_id = ? OR m.team_b_p1_id = ? OR m.team_b_p2_id = ?)`
    + (matchClauses.length ? ' AND ' + matchClauses.join(' AND ') : '');

  const matchCountRow = await db.prepare(
    `SELECT COUNT(*) AS c FROM matches m ${matchWhere}`
  ).all(...matchParams);

  // Opponent list
  const oppClauses = [...pairClauses];
  const oppWhere = 'WHERE ' + oppClauses.join(' AND ');
  const opponents = await db.prepare(
    `SELECT opp_id,
        COUNT(*) AS encounters,
        SUM(CASE WHEN did_win = 1 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN did_win = 0 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN did_win IS NULL THEN 1 ELSE 0 END) AS pending,
        MAX(match_date) AS last_date
      FROM (${PAIRS_SQL}) pairs
      ${oppWhere}
      GROUP BY opp_id
      ORDER BY encounters DESC, last_date DESC`
  ).all(...pairParams);

  // Hydrate opponent names
  let oppNames = [];
  if (opponents.length) {
    const ids = opponents.map(o => o.opp_id);
    oppNames = await db.prepare(
      `SELECT id, display_name, level FROM users WHERE id IN (${ids.join(',')})`
    ).all();
  }
  const nameMap = Object.fromEntries(oppNames.map(u => [u.id, u]));

  res.json({
    total_matches: Number(matchCountRow[0].c),
    total_encounters: Number(stats[0].total_pairs || 0),
    wins: Number(stats[0].wins || 0),
    losses: Number(stats[0].losses || 0),
    pending: Number(stats[0].pending || 0),
    opponents: opponents.map(o => ({
      opponent_id: o.opp_id,
      display_name: nameMap[o.opp_id]?.display_name || '?',
      level: nameMap[o.opp_id]?.level || null,
      encounters: Number(o.encounters),
      wins: Number(o.wins || 0),
      losses: Number(o.losses || 0),
      pending: Number(o.pending || 0),
      last_date: o.last_date,
    })),
    filters: { event_id, from_date, to_date },
  });
});

// GET /api/matches/stats/me/opponents/:opponentId — detailed history vs one opponent
router.get('/stats/me/opponents/:opponentId', requireLogin, async (req, res) => {
  const me = req.session.userId;
  const oppId = Number(req.params.opponentId);
  const { event_id, from_date, to_date } = req.query;

  // Get distinct match IDs where I faced this opponent
  const pairClauses = [`me_id = ?`, `opp_id = ?`];
  const pairParams = [me, oppId];
  if (event_id) { pairClauses.push(`event_id = ?`); pairParams.push(Number(event_id)); }
  if (from_date) { pairClauses.push(`match_date >= ?`); pairParams.push(from_date); }
  if (to_date) { pairClauses.push(`match_date <= ?`); pairParams.push(to_date); }
  const pairWhere = 'WHERE ' + pairClauses.join(' AND ');

  const pairRows = await db.prepare(
    `SELECT DISTINCT match_id FROM (${PAIRS_SQL}) pairs ${pairWhere} ORDER BY match_id DESC`
  ).all(...pairParams);

  if (!pairRows.length) {
    const oppInfo = await db.prepare(
      'SELECT id, display_name, level FROM users WHERE id = ?'
    ).get(oppId);
    return res.json({ matches: [], opponent: oppInfo });
  }

  const matchIds = pairRows.map(p => p.match_id);
  const placeholders = matchIds.map(() => '?').join(',');
  const extraParams = [];

  let sql = `SELECT * FROM matches WHERE id IN (${placeholders}) AND status = 'recorded'`;
  if (event_id) { sql += ' AND event_id = ?'; extraParams.push(Number(event_id)); }
  if (from_date) { sql += ' AND match_date >= ?'; extraParams.push(from_date); }
  if (to_date) { sql += ' AND match_date <= ?'; extraParams.push(to_date); }
  sql += ' ORDER BY match_date DESC';

  const rows = await db.prepare(sql).all(...matchIds, ...extraParams);
  const hydrated = await hydrateMatches(rows);

  // Mark did_win for the current user + perspective info
  hydrated.forEach(m => {
    const myTeam = [m.team_a_p1_id, m.team_a_p2_id].includes(me) ? 'A' : 'B';
    if (m.winner === myTeam) m.did_win = true;
    else if (m.winner) m.did_win = false;
    else m.did_win = null;
    m.my_team = myTeam;
    m.opponent_team_mates = myTeam === 'A'
      ? [{id: m.team_b_p1_id, name: m.team_b_p1_name}, {id: m.team_b_p2_id, name: m.team_b_p2_name}]
      : [{id: m.team_a_p1_id, name: m.team_a_p1_name}, {id: m.team_a_p2_id, name: m.team_a_p2_name}];
    m.teammate_name = myTeam === 'A' ? m.team_a_p2_name : m.team_a_p1_name;
  });

  const oppInfo = await db.prepare(
    'SELECT id, display_name, level FROM users WHERE id = ?'
  ).get(oppId);

  res.json({ matches: hydrated, opponent: oppInfo });
});

// ── Standard CRUD (/:id comes AFTER all static routes) ──────

// GET /api/matches?event_id=X&status=cancelled — list matches
router.get('/', requireLogin, async (req, res) => {
  const { event_id, status } = req.query;
  const clauses = [];
  const params = [];
  if (event_id) { clauses.push('m.event_id = ?'); params.push(Number(event_id)); }
  if (status) { clauses.push('m.status = ?'); params.push(status); }
  else { clauses.push("m.status = 'recorded'"); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = await db.prepare(
    `SELECT m.* FROM matches m ${where} ORDER BY m.match_date DESC, m.match_time DESC`
  ).all(...params);
  res.json({ matches: await hydrateMatches(rows) });
});

// POST /api/matches — record a doubles match
router.post('/', requireLogin, async (req, res) => {
  const { event_id, match_date, match_time,
          team_a_p1_id, team_a_p2_id, team_b_p1_id, team_b_p2_id,
          score_a, score_b, winner, notes } = req.body || {};

  if (!event_id || !match_date) return res.status(400).json({ error: 'event_id and match_date required' });
  const a1 = Number(team_a_p1_id), a2 = Number(team_a_p2_id);
  const b1 = Number(team_b_p1_id), b2 = Number(team_b_p2_id);
  if (![a1, a2, b1, b2].every(Number.isInteger)) {
    return res.status(400).json({ error: 'All 4 player IDs required' });
  }
  const all = [a1, a2, b1, b2];
  if (new Set(all).size !== 4) {
    return res.status(400).json({ error: 'All 4 players must be distinct' });
  }
  if (winner && !['A', 'B'].includes(winner)) {
    return res.status(400).json({ error: 'winner must be A or B (or null)' });
  }

  // Verify users exist
  const userRows = await db.prepare(
    `SELECT id FROM users WHERE id IN (?,?,?,?,?)`
  ).all(a1, a2, b1, b2, req.session.userId);
  const foundIds = new Set(userRows.map(u => u.id));
  if (!all.every(id => foundIds.has(id))) {
    return res.status(400).json({ error: 'One or more players not found' });
  }
  if (!foundIds.has(req.session.userId)) {
    return res.status(400).json({ error: 'Recorder not found' });
  }

  const ev = await db.prepare('SELECT id FROM events WHERE id = ?').get(event_id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const now = Date.now();
  const result = await db.prepare(
    `INSERT INTO matches (event_id, match_date, match_time,
        team_a_p1_id, team_a_p2_id, team_b_p1_id, team_b_p2_id,
        score_a, score_b, winner, notes, status,
        recorded_by, recorded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?)`
  ).run(
    event_id, match_date, match_time || null,
    a1, a2, b1, b2,
    score_a != null ? Number(score_a) : null,
    score_b != null ? Number(score_b) : null,
    winner || null,
    notes ? String(notes).slice(0, 500) : null,
    req.session.userId, now, now,
  );
  res.json({ id: result.lastInsertRowid });
});

// GET /api/matches/:id
router.get('/:id', requireLogin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Match not found' });
  const hydrated = await hydrateMatches([row]);
  res.json(hydrated[0]);
});

// PATCH /api/matches/:id — update match (admin or original recorder)
router.patch('/:id', requireLogin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Match not found' });

  const admin = await isAdmin(req.session.userId);
  if (!admin && row.recorded_by !== req.session.userId) {
    return res.status(403).json({ error: 'Not allowed — admin or recorder only' });
  }

  const { match_date, match_time,
          team_a_p1_id, team_a_p2_id, team_b_p1_id, team_b_p2_id,
          score_a, score_b, winner, notes, status } = req.body || {};

  const a1 = team_a_p1_id != null ? Number(team_a_p1_id) : row.team_a_p1_id;
  const a2 = team_a_p2_id != null ? Number(team_a_p2_id) : row.team_a_p2_id;
  const b1 = team_b_p1_id != null ? Number(team_b_p1_id) : row.team_b_p1_id;
  const b2 = team_b_p2_id != null ? Number(team_b_p2_id) : row.team_b_p2_id;
  const all = [a1, a2, b1, b2];
  if (new Set(all).size !== 4) {
    return res.status(400).json({ error: 'All 4 players must be distinct' });
  }
  if (winner !== undefined && winner !== null && !['A', 'B'].includes(winner)) {
    return res.status(400).json({ error: 'winner must be A or B' });
  }
  if (status && !['recorded', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const now = Date.now();
  await db.prepare(
    `UPDATE matches SET
        match_date = COALESCE(?, match_date),
        match_time = COALESCE(?, match_time),
        team_a_p1_id = COALESCE(?, team_a_p1_id),
        team_a_p2_id = COALESCE(?, team_a_p2_id),
        team_b_p1_id = COALESCE(?, team_b_p1_id),
        team_b_p2_id = COALESCE(?, team_b_p2_id),
        score_a = ?,
        score_b = ?,
        winner = ?,
        notes = ?,
        status = COALESCE(?, status),
        updated_by = ?,
        updated_at = ?
      WHERE id = ?`
  ).run(
    match_date || null,
    match_time !== undefined ? match_time || null : null,
    team_a_p1_id != null ? a1 : null,
    team_a_p2_id != null ? a2 : null,
    team_b_p1_id != null ? b1 : null,
    team_b_p2_id != null ? b2 : null,
    score_a !== undefined ? (score_a != null ? Number(score_a) : null) : null,
    score_b !== undefined ? (score_b != null ? Number(score_b) : null) : null,
    winner !== undefined ? winner || null : null,
    notes !== undefined ? (notes ? String(notes).slice(0, 500) : null) : null,
    status || null,
    req.session.userId,
    now,
    req.params.id,
  );
  res.json({ ok: true });
});

// DELETE /api/matches/:id — soft-delete (cancelled status)
router.delete('/:id', requireLogin, async (req, res) => {
  const row = await db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Match not found' });
  const admin = await isAdmin(req.session.userId);
  if (!admin && row.recorded_by !== req.session.userId) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const now = Date.now();
  await db.prepare(
    `UPDATE matches SET status = 'cancelled', updated_by = ?, updated_at = ? WHERE id = ?`
  ).run(req.session.userId, now, req.params.id);
  res.json({ ok: true });
});

module.exports = { router };
