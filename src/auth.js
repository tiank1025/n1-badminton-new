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
  const { username, password, display_name, level } = req.body || {};
  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'username, password, display_name are required' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });
  if (!LEVELS.includes(level || 'novice')) return res.status(400).json({ error: 'Invalid level' });

  const existing = await db.prepare('SELECT id FROM users WHERE username = ? OR display_name = ?').get(username, display_name);
  if (existing) return res.status(409).json({ error: 'Username or display name already taken' });

  const { hash, salt } = hashPassword(password);
  const now = Date.now();
  const result = await db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, display_name, level, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(username, hash, salt, display_name, level || 'novice', now, now);

  req.session.userId = result.lastInsertRowid;
  res.json({ id: result.lastInsertRowid, username, display_name, level: level || 'novice', is_admin: 0 });
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
    'SELECT id, username, display_name, level, is_admin FROM users WHERE id = ?'
  ).get(req.session.userId);
  res.json(user || null);
});

module.exports = { router, requireLogin, requireAdmin };
