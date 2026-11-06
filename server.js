// Load secrets from a .env file at project root (if present).
// Variables set in the environment (e.g. shell) always win over the file.
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const { DatabaseSessionStore } = require('./src/session-store');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { db, dbReady } = require('./src/db');
const { router: authRouter, requireAdmin } = require('./src/auth');
const { router: eventsRouter, registrationsRouter } = require('./src/events');
const { router: matchesRouter } = require('./src/matches');
const { initRealtime } = require('./src/realtime');
const { router: notificationsRouter, setIo } = require('./src/notifications');

const app = express();
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
// Render terminates HTTPS at its proxy and forwards the request to Node over
// HTTP. Trust the proxy so express-session can issue secure cookies correctly.
app.set('trust proxy', 1);

// Security headers. The frontend pages rely heavily on inline <script> and
// <style>, so a strict CSP is disabled for now; frameguard / nosniff / HSTS
// (behind HTTPS) and the other defaults still apply.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ── Session middleware (shared with Socket.IO) ───────────
const sessionMiddleware = session({
  name: 'n1.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  store: new DatabaseSessionStore(db),
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
// JSON bodies are small (logins, registrations, scores). The one exception is
// the payment-proof upload — its 6 MiB image cap gets its own generous limit
// via express.json on that route (see events.js), so every other endpoint
// rejects oversized bodies early instead of buffering 9 MB of JSON.
app.use(express.json({ limit: '300kb' }));
app.use(express.urlencoded({ extended: true, limit: '300kb' }));
app.use(compression());
app.use(cookieParser());
app.use(sessionMiddleware);

// Serve static files. Hash-free assets (i18n.js, common.css, images) get a
// week of caching; HTML pages stay no-cache so deploys reach users instantly.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ── REST API ────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/events', eventsRouter);
app.use('/api/registrations', registrationsRouter);
app.use('/api/matches', matchesRouter);
app.use('/api/notifications', notificationsRouter);

// ── Page routes ─────────────────────────────────────────
// "/" (index.html, served by express.static) is the public bilingual event
// info / landing page. /info.html was the old separate URL — keep old links
// and bookmarks alive with a permanent redirect.
app.get('/info.html', (req, res) => res.redirect(301, '/'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/events', (req, res) => res.sendFile(path.join(__dirname, 'public', 'events.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/matches', (req, res) => res.sendFile(path.join(__dirname, 'public', 'matches.html')));
// Mobile-first on-site page: check-in, queue position, quick registration.
app.get('/m', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile.html')));
// The QR code points here; /checkin is kept as a friendly alias.
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile.html')));

// ── Health check ────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Socket.IO real-time ─────────────────────────────────
const io = new Server(server);
initRealtime(io, sessionMiddleware, db);
// Let notifications push to the player's room without a circular import.
setIo(io);

// ── Global error handler ────────────────────────────────
// Must be registered last. Catches errors thrown in async route handlers
// (Express 5 forwards rejected promises here) and returns structured JSON so
// the frontend never receives an HTML error page from an API call.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.expose ? err.message : 'Internal server error',
  });
});

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
