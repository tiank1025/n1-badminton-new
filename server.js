const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { db, dbReady } = require('./src/db');
const { router: authRouter, requireAdmin } = require('./src/auth');
const { router: eventsRouter, registrationsRouter } = require('./src/events');
const { initRealtime } = require('./src/realtime');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ── Session middleware (shared with Socket.IO) ───────────
const sessionMiddleware = session({
  name: 'n1.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

// ── Middleware ──────────────────────────────────────────
app.use(express.json({ limit: '8mb' })); // payment-proof screenshots arrive as data URLs
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionMiddleware);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/events', eventsRouter);
app.use('/api/registrations', registrationsRouter);

// ── Page routes ─────────────────────────────────────────
// "/" (index.html, served by express.static) is the public bilingual event
// info / landing page. /info.html was the old separate URL — keep old links
// and bookmarks alive with a permanent redirect.
app.get('/info.html', (req, res) => res.redirect(301, '/'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/events', (req, res) => res.sendFile(path.join(__dirname, 'public', 'events.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));

// ── Health check ────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Socket.IO real-time ─────────────────────────────────
const io = new Server(server);
initRealtime(io, sessionMiddleware, db);

// ── Start ───────────────────────────────────────────────
// Wait for the DB schema + seed to finish before accepting requests.
dbReady.then(() => {
  server.listen(PORT, () => {
    console.log(`🏸  N1 Badminton Registration System`);
    console.log(`   Local:  http://localhost:${PORT}`);
    console.log(`   Login:  http://localhost:${PORT}/login`);
    console.log(`   Board:  http://localhost:${PORT}/board`);
  });
});
