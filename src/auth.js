const { db, hashPassword, verifyPassword } = require('./db');
const express = require('express');
const router = express.Router();

const LEVELS = ['advanced', 'intermediate', 'novice', 'beginner'];

// ── Middleware: require login ───────────────────────────
function requireLogin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ── Middleware: require admin ────────────────────────────
async function requireAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Routes ──────────────────────────────────────────────

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, password, display_name, email, level } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!username || !password || !display_name || !normalizedEmail) {
    return res.status(400).json({ error: 'username, password, display_name and email are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });
  if (!LEVELS.includes(level || 'novice')) return res.status(400).json({ error: 'Invalid level' });

  const existing = await db.prepare('SELECT id FROM users WHERE username = ? OR display_name = ?').get(username, display_name);
  if (existing) return res.status(409).json({ error: 'Username or display name already taken' });

  const { hash, salt } = hashPassword(password);
  const now = Date.now();
  const result = await db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, display_name, email, level, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(username, hash, salt, display_name, normalizedEmail, level || 'novice', now, now);

  req.session.userId = result.lastInsertRowid;
  res.json({ id: result.lastInsertRowid, username, display_name, email: normalizedEmail, level: level || 'novice', is_admin: 0 });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username, display_name: user.display_name, level: user.level, is_admin: user.is_admin });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  if (!req.session?.userId) return res.json(null);
  const user = await db.prepare(
    'SELECT id, username, display_name, email, level, is_admin FROM users WHERE id = ?'
  ).get(req.session.userId);
  res.json(user || null);
});

// GET /api/auth/users (admin) — every registered account, newest first.
router.get('/users', requireAdmin, async (req, res) => {
  const rows = await db.prepare(
    `SELECT u.id, u.username, u.display_name, u.email, u.level, u.is_admin, u.created_at,
            (SELECT COUNT(*) FROM registrations r
              WHERE r.user_id = u.id AND r.status = 'registered') AS active_events,
            (SELECT COUNT(*) FROM registrations r2
              WHERE r2.user_id = u.id) AS total_signups
     FROM users u
     ORDER BY u.created_at DESC`
  ).all();
  res.json(rows);
});

// PATCH /api/auth/email — players opt in to email notifications themselves
// (used when a waitlist spot opens). Empty string clears the address.
router.patch('/email', requireLogin, async (req, res) => {
  const raw = String(req.body?.email || '').trim();
  if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  await db.prepare('UPDATE users SET email = ? WHERE id = ?')
    .run(raw || null, req.session.userId);
  res.json({ ok: true, email: raw || null });
});

// PATCH /api/auth/profile — update the signed-in user's public profile.
router.patch('/profile', requireLogin, async (req, res) => {
  const displayName = String(req.body?.display_name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const level = String(req.body?.level || '');
  if (!displayName) return res.status(400).json({ error: 'Display name is required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!LEVELS.includes(level)) return res.status(400).json({ error: 'Invalid level' });
  const duplicate = await db.prepare('SELECT id FROM users WHERE display_name = ? AND id <> ?').get(displayName, req.session.userId);
  if (duplicate) return res.status(409).json({ error: 'Display name already taken' });
  await db.prepare('UPDATE users SET display_name = ?, email = ?, level = ?, updated_at = ? WHERE id = ?')
    .run(displayName, email, level, Date.now(), req.session.userId);
  const user = await db.prepare('SELECT id, username, display_name, email, level, is_admin FROM users WHERE id = ?').get(req.session.userId);
  res.json({ ok: true, user });
});

module.exports = { router, requireLogin, requireAdmin };
