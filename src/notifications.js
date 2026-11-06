// notifications.js — in-app notifications + best-effort email delivery.
//
// In-app notifications always work (stored in the `notifications` table and
// pushed over Socket.IO when the user is online). Email is optional: it uses
// Resend's HTTPS API so it works on Render's free plan, where SMTP ports are
// blocked. Without a Resend key the in-app copy is still created.

const express = require('express');
const { db } = require('./db');

const router = express.Router();

// Socket.IO instance, injected by server.js so we can push notifications
// without importing realtime.js (which would create a circular dependency).
let io = null;
function setIo(_io) { io = _io; }

// ── Email (optional, via Resend HTTPS API) ──────────────
const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Must be an address on a domain verified in the Resend account.
const RESEND_FROM = process.env.RESEND_FROM;

// A failed email must never undo the in-app notification or its triggering action.
async function sendEmail(userId, subject, text) {
  try {
    if (!RESEND_API_KEY || !RESEND_FROM) {
      console.warn('Email notification skipped: RESEND_API_KEY and RESEND_FROM must both be configured');
      return false;
    }
    const user = await db.prepare('SELECT email, display_name FROM users WHERE id = ?').get(userId);
    if (!user?.email) {
      console.warn(`Email notification skipped: user ${userId} has no email address`);
      return false;
    }
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to: [user.email], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(`Email API rejected notification for user ${userId}:`, response.status, result.message || 'Unknown error');
      return false;
    }
    console.info(`Email notification queued by Resend for user ${userId} (email ${result.id || 'unknown'})`);
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
