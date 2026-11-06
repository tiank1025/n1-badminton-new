// notifications.js — in-app notifications + best-effort email delivery.
//
// In-app notifications always work (stored in the `notifications` table and
// pushed over Socket.IO when the user is online). Email is optional: it only
// sends when SMTP_HOST / SMTP_USER / SMTP_PASS are configured AND the user has
// an email address on file. Without that setup the in-app copy is still created.

const express = require('express');
const { db } = require('./db');

const router = express.Router();

// Socket.IO instance, injected by server.js so we can push notifications
// without importing realtime.js (which would create a circular dependency).
let io = null;
function setIo(_io) { io = _io; }

// ── Email (optional) ────────────────────────────────────
let transporter = null;
// Pre-resolve the SMTP host with the system resolver. nodemailer's own
// c-ares DNS (resolve4/6) can bypass VPN TUN DNS hijacking and time out on
// hosts like smtp.gmail.com, while dns.lookup follows the OS routing and
// works. Passing an IP also skips nodemailer's internal resolution entirely;
// tls.servername keeps certificate validation against the real hostname.
async function getTransporter() {
  if (transporter !== null) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('Email notification skipped: SMTP_HOST, SMTP_USER and SMTP_PASS must all be configured');
    transporter = false;
    return false;
  }
  let host = SMTP_HOST;
  try {
    const { address } = await require('node:dns').promises.lookup(SMTP_HOST, { family: 4 });
    host = address;
  } catch { /* fall back to the hostname */ }
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { servername: SMTP_HOST },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transporter;
}

const MAIL_FROM = process.env.SMTP_FROM || 'N1 Badminton <no-reply@n1badminton.org>';

// A failed email must never undo the in-app notification or its triggering action.
async function sendEmail(userId, subject, text) {
  try {
    const t = await getTransporter();
    if (!t) return false;
    const user = await db.prepare('SELECT email, display_name FROM users WHERE id = ?').get(userId);
    if (!user?.email) {
      console.warn(`Email notification skipped: user ${userId} has no email address`);
      return false;
    }
    const info = await t.sendMail({ from: MAIL_FROM, to: user.email, subject, text });
    console.info(`Email notification accepted by SMTP for user ${userId} (message ${info.messageId})`);
    return true;
  } catch (e) {
    console.warn(`Email notification failed for user ${userId}:`, e.code || '', e.message);
    return false;
  }
}

// ── Create ──────────────────────────────────────────────
// `email` is opt-in per call site — waitlist promotion is the only place that
// sends one today, because it is the only notification that needs to reach a
// player who may not be looking at the site.
async function createNotification({ userId, type, title, body, eventId = null, email = null }) {
  const now = Date.now();
  const r = await db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, type, title, body || null, eventId, now);

  const payload = { id: r.lastInsertRowid, type, title, body, event_id: eventId, created_at: now };
  const deliveries = [];
  if (io) {
    deliveries.push(Promise.resolve().then(() => {
      io.to(`u:${userId}`).emit('notification', payload);
      return true;
    }).catch(e => {
      console.warn(`In-app notification push failed for user ${userId}:`, e.message);
      return false;
    }));
  }
  if (email) {
    const subject = email.subject || title;
    const text = email.text || `${title}\n\n${body || ''}`;
    deliveries.push(sendEmail(userId, subject, text));
  }
  const results = await Promise.all(deliveries);
  if (email) payload.emailSent = results[deliveries.length - 1] === true;
  return payload;
}

// ── Routes ──────────────────────────────────────────────

router.get('/my', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Login required' });
  const rows = await db.prepare(
    `SELECT id, type, title, body, event_id, read_at, created_at
       FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 30`
  ).all(req.session.userId);
  res.json({ notifications: rows, unread: rows.filter(r => !r.read_at).length });
});

router.post('/:id/read', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Login required' });
  await db.prepare(
    'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL'
  ).run(Date.now(), req.params.id, req.session.userId);
  res.json({ ok: true });
});

router.post('/read-all', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Login required' });
  await db.prepare(
    'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'
  ).run(Date.now(), req.session.userId);
  res.json({ ok: true });
});

module.exports = { router, setIo, createNotification, sendEmail };
