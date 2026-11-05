const { db } = require('./db');
const express = require('express');
const router = express.Router();
// Registrations live at /api/registrations, so they need a router mounted at
// that prefix (a "/../registrations/:id" path on the events router silently
// stopped matching under Express 5 / path-to-regexp v8).
const registrationsRouter = express.Router();
const { requireAdmin } = require('./auth');
const { createNotification } = require('./notifications');

const SLOT_LABELS = ['7:00 – 7:30', '7:30 – 8:00', '8:00 – 8:30', '8:30 – 9:00'];
const MAX_PER_SLOT = 4;
const EVENT_CAPACITY = 33;          // players per event; admins may go over
const DEFAULT_FEE_SOCIAL = 1900;    // $19.00
const DEFAULT_FEE_TRAINING = 4500;  // $45.00

// Event times are stored as Sydney local date + time, so convert them to an
// absolute instant no matter which timezone the server runs in (UTC on Render).
const EVENT_TZ = 'Australia/Sydney';
const CANCEL_CUTOFF_MS = 24 * 60 * 60 * 1000; // no cancellations inside this window

function sydneyOffsetMinutes(date) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TZ, timeZoneName: 'longOffset',
  }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'GMT+10:00';
  const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name);
  if (!m || !m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function eventStartMs(ev) {
  if (!ev || !ev.event_date) return null;
  const time = String(ev.start_time || '19:00').slice(0, 5);
  const naive = Date.parse(`${ev.event_date}T${time}:00Z`);
  if (Number.isNaN(naive)) return null;
  let ms = naive;
  // Two passes so DST transitions resolve to the right offset.
  for (let i = 0; i < 2; i++) ms = naive - sydneyOffsetMinutes(new Date(ms)) * 60000;
  return ms;
}

function cancelDeadlineMs(ev) {
  const start = eventStartMs(ev);
  return start == null ? null : start - CANCEL_CUTOFF_MS;
}

// Adds starts_at_ms / cancel_deadline_ms / cancel_open to an event payload.
function attachWindow(ev, now = Date.now()) {
  const start = eventStartMs(ev);
  const deadline = start == null ? null : start - CANCEL_CUTOFF_MS;
  ev.starts_at_ms = start;
  ev.cancel_deadline_ms = deadline;
  ev.cancel_open = deadline == null ? null : now < deadline;
  return ev;
}

// Amount owed for a registration type, falling back to the event defaults.
function feeFor(ev, regType) {
  if (regType === 'training_and_activity') {
    return ev.fee_training_cents != null ? ev.fee_training_cents : DEFAULT_FEE_TRAINING;
  }
  return ev.fee_social_cents != null ? ev.fee_social_cents : DEFAULT_FEE_SOCIAL;
}

// Parse a cents amount from the request body, clamped to a sane range.
function parseCents(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1000000, Math.round(n)));
}

// ── Waitlist auto-promotion ────────────────────────────
// When a spot frees up, the earliest waitlisted player is moved into a real
// registration (fee snapshot taken from the event) and notified in-app + email.
// Returns null when there is nobody waiting or the event is somehow still full.
async function promoteNextWaitlist(eventId) {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev) return null;

  const taken = (await db.prepare(
    "SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status = 'registered'"
  ).get(eventId)).c;
  if (Number(taken) >= Number(ev.capacity || EVENT_CAPACITY)) return null;

  const entry = await db.prepare(
    'SELECT * FROM waitlist WHERE event_id = ? ORDER BY created_at ASC, id ASC LIMIT 1'
  ).get(eventId);
  if (!entry) return null;

  const now = Date.now();
  const fee = feeFor(ev, entry.reg_type);
  const inserted = await db.prepare(
    `INSERT INTO registrations
       (event_id, user_id, reg_type, training_slot, fee_cents, payment_status,
        status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 'unpaid', 'registered', ?, ?)`
  ).run(eventId, entry.user_id, entry.reg_type, fee, now, now);
  await db.prepare('DELETE FROM waitlist WHERE id = ?').run(entry.id);

  const when = `${ev.event_date} · ${ev.start_time}-${ev.end_time}`;
  const place = ev.location ? ` · ${ev.location}` : '';
  const title = `Waitlist promoted: ${ev.title}`;
  const body = `You have been automatically moved from the waitlist to a confirmed spot.\nWhen: ${when}${place}\nFee: AUD$${(fee / 100).toFixed(2)} (please pay before the event)\nIf you can no longer attend, please cancel at least 24 hours before the event starts.`;

  createNotification({
    userId: entry.user_id,
    type: 'waitlist_promoted',
    title,
    body,
    eventId,
    email: { subject: `[N1 Badminton] ${title}`, text: body },
  }).catch(e => console.warn('Waitlist notification failed:', e.message));

  return { userId: entry.user_id, registrationId: inserted.lastInsertRowid };
}

// GET /api/events?status=open
// Publicly visible, but admins get full stats (reg_count/capacity) while
// regular visitors see only the boolean flags (is_full, has_waitlist) so
// we don't leak exact seat counts to competitors.
router.get('/', async (req, res) => {
  const { status } = req.query;
  const base = `SELECT e.*,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.event_id = e.id AND r.status = 'registered') AS reg_count,
      (SELECT COUNT(*) FROM waitlist w
        WHERE w.event_id = e.id) AS waitlist_count
      FROM events e`;
  const rows = status
    ? await db.prepare(`${base} WHERE e.status = ? ORDER BY e.event_date ASC`).all(status)
    : await db.prepare(`${base} ORDER BY e.event_date DESC`).all();

  // Figure out if the caller is an admin — never gate the endpoint itself,
  // just trim the payload for non-admins.
  let meAdmin = false;
  if (req.session?.userId) {
    const u = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
    meAdmin = !!u?.is_admin;
  }

  rows.forEach(r => {
    const cap = Number(r.capacity) || EVENT_CAPACITY;
    const regCount = Number(r.reg_count) || 0;
    const waitlistCount = Number(r.waitlist_count) || 0;
    r.capacity = cap;
    r.reg_count = regCount;
    r.waitlist_count = waitlistCount;
    r.is_full = regCount >= cap;
    r.has_waitlist = waitlistCount > 0;
    attachWindow(r);

    if (!meAdmin) {
      // Strip the exact numbers — admins can still see them.
      delete r.reg_count;
      delete r.waitlist_count;
      delete r.capacity;
    }
  });
  res.json(rows);
});

// GET /api/events/:id
router.get('/:id', async (req, res) => {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json(ev);
});

// POST /api/events (admin)
router.post('/', requireAdmin, async (req, res) => {
  const { title, event_date, start_time, end_time, location, registration_open_at, registration_close_at,
          fee_social_cents, fee_training_cents, payment_link, capacity } = req.body || {};
  if (!title || !event_date) return res.status(400).json({ error: 'title and event_date required' });
  const now = Date.now();
  const cap = Number(capacity);
  if (capacity !== undefined && (!Number.isFinite(cap) || cap < 1 || cap > 500)) {
    return res.status(400).json({ error: 'capacity must be between 1 and 500' });
  }
  const result = await db.prepare(
    `INSERT INTO events (title, event_date, start_time, end_time, location, capacity,
                         fee_social_cents, fee_training_cents,
                         payment_link, registration_open_at, registration_close_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(title, event_date, start_time || '19:00', end_time || '21:00',
        location || null,
        cap || EVENT_CAPACITY,
        parseCents(fee_social_cents, DEFAULT_FEE_SOCIAL),
        parseCents(fee_training_cents, DEFAULT_FEE_TRAINING),
        payment_link || null,
        registration_open_at || null, registration_close_at || null, now, now);
  res.json({ id: result.lastInsertRowid });
});

// DELETE /api/events/:id (admin) — cascade deletes registrations
router.delete('/:id', requireAdmin, async (req, res) => {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  await db.prepare('DELETE FROM registrations WHERE event_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/events/:id/activate (admin) — load registrations into real-time queue
router.post('/:id/activate', requireAdmin, async (req, res) => {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const regs = await db.prepare(`
    SELECT r.*, u.display_name, u.level
    FROM registrations r JOIN users u ON r.user_id = u.id
    WHERE r.event_id = ? AND r.status = 'registered'
    ORDER BY r.created_at ASC
  `).all(req.params.id);
  const now = Date.now();
  await db.prepare('UPDATE events SET status = ?, synced_at = ?, updated_at = ? WHERE id = ?')
    .run('active', now, now, req.params.id);
  // Return registrations for the caller to inject into the real-time queue
  const social = regs.filter(r => r.reg_type === 'activity').map(r => ({
    name: r.display_name, level: r.level,
    partner: r.partner_user_id ? null : null, // partner resolution done by caller
    training_slot: null,
  }));
  const training = regs.filter(r => r.reg_type === 'training_and_activity').map(r => ({
    name: r.display_name, level: r.level,
    training_slot: r.training_slot,
  }));
  // Resolve partner names
  const allRegs = regs;
  const partnerMap = {};
  allRegs.forEach(r => {
    if (r.partner_user_id) {
      const partner = allRegs.find(p => p.user_id === r.partner_user_id);
      if (partner) partnerMap[r.display_name] = partner.display_name;
    }
  });
  social.forEach(s => { if (partnerMap[s.name]) s.partner = partnerMap[s.name]; });
  training.forEach(s => { if (partnerMap[s.name]) s.partner = partnerMap[s.name]; });
  res.json({ social, training, eventTitle: ev.title });
});

// PATCH /api/events/:id (admin)
router.patch('/:id', requireAdmin, async (req, res) => {
  const { status, registration_open_at, registration_close_at, title, event_date, location,
          fee_social_cents, fee_training_cents, payment_link, capacity } = req.body || {};
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const now = Date.now();
  let capacitySql = `COALESCE(?, capacity)`;
  let capacityVal = null;
  if (capacity !== undefined && capacity !== null && capacity !== '') {
    const cap = Number(capacity);
    if (!Number.isFinite(cap) || cap < 1 || cap > 500) {
      return res.status(400).json({ error: 'capacity must be between 1 and 500' });
    }
    capacityVal = Math.round(cap);
  }
  await db.prepare(
    `UPDATE events SET
      status = COALESCE(?, status),
      registration_open_at = COALESCE(?, registration_open_at),
      registration_close_at = COALESCE(?, registration_close_at),
      title = COALESCE(?, title),
      event_date = COALESCE(?, event_date),
      location = COALESCE(?, location),
      fee_social_cents = COALESCE(?, fee_social_cents),
      fee_training_cents = COALESCE(?, fee_training_cents),
      payment_link = COALESCE(?, payment_link),
      capacity = ${capacitySql},
      updated_at = ?
     WHERE id = ?`
  ).run(status || null, registration_open_at || null, registration_close_at || null,
        title || null, event_date || null, location || null,
        fee_social_cents != null ? parseCents(fee_social_cents, ev.fee_social_cents) : null,
        fee_training_cents != null ? parseCents(fee_training_cents, ev.fee_training_cents) : null,
        payment_link !== undefined ? payment_link : null,
        capacityVal, now, req.params.id);
  // If capacity increased (or was just set), promote waitlisted players into
  // the newly freed spot(s). We run it in a loop because a single PATCH may
  // open up several spots at once.
  if (capacityVal !== null && capacityVal > (ev.capacity || EVENT_CAPACITY)) {
    let promoted = null;
    do { promoted = await promoteNextWaitlist(req.params.id); } while (promoted);
  }
  res.json({ ok: true });
});

// GET /api/events/:id/qrcode — SVG QR code pointing at the mobile check-in page.
// Printed/pinned at the venue so players scan once and self check in.
router.get('/:id/qrcode', async (req, res) => {
  const ev = await db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${base.replace(/\/$/, '')}/m?event=${ev.id}`;
  try {
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(url, {
      type: 'svg', margin: 2, width: 320,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// POST /api/events/:id/checkin — player taps "I'm here".
// Admins may pass { user_id } to check someone in on their behalf.
router.post('/:id/checkin', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  let targetId = req.session.userId;
  const requested = req.body?.user_id;
  if (requested && Number(requested) !== Number(targetId)) {
    const me = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(targetId);
    if (!me?.is_admin) return res.status(403).json({ error: 'Only admins can check in others' });
    targetId = Number(requested);
  }

  const reg = await db.prepare(
    "SELECT * FROM registrations WHERE event_id = ? AND user_id = ? AND status = 'registered'"
  ).get(req.params.id, targetId);
  if (!reg) return res.status(404).json({ error: 'No active registration for this event' });
  if (reg.checked_in_at) {
    return res.json({ ok: true, alreadyCheckedIn: true, checked_in_at: reg.checked_in_at });
  }

  const now = Date.now();
  await db.prepare('UPDATE registrations SET checked_in_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, reg.id);
  res.json({ ok: true, checked_in_at: now });
});

// GET /api/events/:id/registrations
router.get('/:id/registrations', async (req, res) => {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  attachWindow(ev);

  const adminRow = req.session.userId
    ? await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId)
    : null;
  const isAdmin = adminRow?.is_admin;
  if (isAdmin) {
    const regs = await db.prepare(`
      SELECT r.*, u.display_name, u.level,
             p.display_name AS partner_name
      FROM registrations r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN users p ON r.partner_user_id = p.id
      WHERE r.event_id = ? AND r.status = 'registered'
      ORDER BY r.created_at ASC
    `).all(req.params.id);
    // Legacy rows created before the fee snapshot existed fall back to the
    // event's current fee so the payment summary is always complete.
    regs.forEach(r => { if (r.fee_cents == null) r.fee_cents = feeFor(ev, r.reg_type); });

    const paymentSummary = {
      total: regs.length,
      paid: regs.filter(r => r.payment_status === 'paid').length,
      submitted: regs.filter(r => r.payment_status === 'submitted').length,
      unpaid: regs.filter(r => r.payment_status === 'unpaid').length,
      waived: regs.filter(r => r.payment_status === 'waived').length,
      expectedCents: regs.reduce((s, r) => s + (r.fee_cents || 0), 0),
      collectedCents: regs.filter(r => r.payment_status === 'paid')
        .reduce((s, r) => s + (r.fee_cents || 0), 0),
      waivedCents: regs.filter(r => r.payment_status === 'waived')
        .reduce((s, r) => s + (r.fee_cents || 0), 0),
      outstandingCents: regs.filter(r => ['unpaid', 'submitted'].includes(r.payment_status))
        .reduce((s, r) => s + (r.fee_cents || 0), 0),
    };
    // Count per slot
    const slotCounts = [0,1,2,3].map(i =>
      regs.filter(r => r.training_slot === i).length
    );
    // Everyone queued for a spot once the event hit its capacity.
    const waitlist = await db.prepare(`
      SELECT w.*, u.display_name, u.level, u.username
      FROM waitlist w JOIN users u ON w.user_id = u.id
      WHERE w.event_id = ?
      ORDER BY w.created_at ASC
    `).all(req.params.id);
    // Honour the per-event capacity an admin configured, falling back only when
    // migrating a database that predates the capacity column.
    const cap = Number(ev.capacity) || EVENT_CAPACITY;
    res.json({
      registrations: regs, waitlist, capacity: cap, regCount: regs.length,
      checkedInCount: regs.filter(r => r.checked_in_at).length,
      cancelOpen: ev.cancel_open, cancelDeadline: ev.cancel_deadline_ms,
      slotCounts, slotLabels: SLOT_LABELS, maxPerSlot: MAX_PER_SLOT,
      event: ev, event_title: ev.title, paymentSummary,
    });
  } else {
    // Regular user: only see own
    if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
    const reg = await db.prepare(`
      SELECT r.*, u.display_name, u.level,
             p.display_name AS partner_name
      FROM registrations r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN users p ON r.partner_user_id = p.id
      WHERE r.event_id = ? AND r.user_id = ? AND r.status = 'registered'
    `).get(req.params.id, req.session.userId);
    if (reg && reg.fee_cents == null) reg.fee_cents = feeFor(ev, reg.reg_type);
    const slotCounts = [0,1,2,3].map(async i =>
      (await db.prepare('SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND training_slot = ? AND status = \'registered\'')
        .get(req.params.id, i)).c
    );
    const regCount = (await db.prepare(
      "SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status = 'registered'"
    ).get(req.params.id)).c;
    const cap = Number(ev.capacity) || EVENT_CAPACITY;
    const regCountNum = Number(regCount);
    // The user's own waitlist entry (if the event was full when they signed up).
    const entry = await db.prepare(
      'SELECT * FROM waitlist WHERE event_id = ? AND user_id = ?'
    ).get(req.params.id, req.session.userId);
    let waitlistPosition = null;
    if (entry) {
      const ahead = (await db.prepare(
        'SELECT COUNT(*) AS c FROM waitlist WHERE event_id = ? AND created_at < ?'
      ).get(req.params.id, entry.created_at)).c;
      waitlistPosition = Number(ahead) + 1;
    }
    // Regular users only get boolean seat-availability flags, never the exact numbers.
    res.json({
      registration: reg, waitlistEntry: entry ? { ...entry, position: waitlistPosition } : null,
      is_full: regCountNum >= cap,
      cancelOpen: ev.cancel_open, cancelDeadline: ev.cancel_deadline_ms,
      slotCounts: await Promise.all(slotCounts), slotLabels: SLOT_LABELS,
      maxPerSlot: MAX_PER_SLOT, event: ev, event_title: ev.title,
    });
  }
});

// GET /api/events/:id/user-search?q= (admin) — find people to add manually.
router.get('/:id/user-search', requireAdmin, async (req, res) => {
  const ev = await db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const rows = await db.prepare(`
    SELECT u.id, u.username, u.display_name, u.level
      FROM users u
     WHERE (u.username LIKE ? OR u.display_name LIKE ?)
       AND NOT EXISTS (SELECT 1 FROM registrations r
                        WHERE r.event_id = ? AND r.user_id = u.id AND r.status = 'registered')
       AND NOT EXISTS (SELECT 1 FROM waitlist w
                        WHERE w.event_id = ? AND w.user_id = u.id)
     ORDER BY u.display_name ASC
     LIMIT 10
  `).all(like, like, req.params.id, req.params.id);
  res.json(rows);
});

// POST /api/events/:id/participants (admin) — add someone directly.
// Admins are not bound by the 33-player cap.
router.post('/:id/participants', requireAdmin, async (req, res) => {
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const userId = Number(req.body?.user_id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'user_id required' });
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const regType = req.body?.reg_type === 'training_and_activity' ? 'training_and_activity' : 'activity';
  let trainingSlot = null;
  if (regType === 'training_and_activity') {
    const slot = Number(req.body?.training_slot);
    trainingSlot = [0,1,2,3].includes(slot) ? slot : 0;
  }
  const existing = await db.prepare(
    "SELECT id FROM registrations WHERE event_id = ? AND user_id = ? AND status = 'registered'"
  ).get(ev.id, userId);
  if (existing) return res.status(409).json({ error: 'Already registered' });

  const now = Date.now();
  const feeCents = feeFor(ev, regType);
  const id = await db.transaction(async (tx) => {
    const r = await tx.prepare(
      `INSERT INTO registrations (event_id, user_id, reg_type, training_slot, status,
                                  fee_cents, payment_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'registered', ?, 'unpaid', ?, ?)`
    ).run(ev.id, userId, regType, trainingSlot, feeCents, now, now);
    // Adding someone who was queued should clear their waitlist entry.
    await tx.prepare('DELETE FROM waitlist WHERE event_id = ? AND user_id = ?').run(ev.id, userId);
    return r.lastInsertRowid;
  });
  res.json({ id });
});

// POST /api/events/:id/registrations
router.post('/:id/registrations', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (ev.status !== 'open') return res.status(400).json({ error: 'Registration closed' });

  // Players no longer choose a training time — the organiser assigns one
  // later, so training_slot starts empty for Training + Social registrations.
  const { reg_type, partner_user_id, sticky_pair } = req.body || {};
  if (!['activity', 'training_and_activity'].includes(reg_type)) {
    return res.status(400).json({ error: 'Invalid registration type' });
  }

  // Check existing registration
  const existing = await db.prepare('SELECT id FROM registrations WHERE event_id = ? AND user_id = ? AND status = \'registered\'').get(req.params.id, req.session.userId);
  if (existing) return res.status(409).json({ error: 'Already registered' });

  const now = Date.now();

  // Event full (per-event capacity)? Queue the user instead of turning them away.
  const regCount = (await db.prepare(
    "SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status = 'registered'"
  ).get(req.params.id)).c;
  const cap = Number(ev.capacity) || EVENT_CAPACITY;
  if (Number(regCount) >= cap) {
    const queued = await db.prepare('SELECT id FROM waitlist WHERE event_id = ? AND user_id = ?')
      .get(req.params.id, req.session.userId);
    if (queued) return res.status(409).json({ error: 'Already on the waitlist' });
    await db.prepare(
      'INSERT INTO waitlist (event_id, user_id, reg_type, created_at) VALUES (?, ?, ?, ?)'
    ).run(req.params.id, req.session.userId, reg_type, now);
    return res.json({ waitlisted: true });
  }

  // Partner validation
  if (partner_user_id) {
    const partner = await db.prepare('SELECT id FROM registrations WHERE event_id = ? AND user_id = ? AND status = \'registered\'').get(req.params.id, partner_user_id);
    if (!partner) return res.status(400).json({ error: 'Partner not registered' });
    const partnerHasPair = await db.prepare('SELECT id FROM registrations WHERE event_id = ? AND partner_user_id = ? AND status = \'registered\'').get(req.params.id, partner_user_id);
    if (partnerHasPair) return res.status(400).json({ error: 'Partner already paired' });
  }

  const feeCents = feeFor(ev, reg_type);
  let newId;
  try {
    newId = await db.transaction(async (tx) => {
      const result = await tx.prepare(
        `INSERT INTO registrations (event_id, user_id, reg_type, training_slot, partner_user_id, sticky_pair,
                                    status, fee_cents, payment_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, 'unpaid', ?, ?)`
      ).run(req.params.id, req.session.userId, reg_type, null,
            partner_user_id || null, sticky_pair ? 1 : 0, feeCents, now, now);

      // If partner specified, set their partner_user_id too
      if (partner_user_id) {
        await tx.prepare("UPDATE registrations SET partner_user_id = ?, sticky_pair = ?, updated_at = ? WHERE event_id = ? AND user_id = ? AND status = 'registered'")
          .run(req.session.userId, sticky_pair ? 1 : 0, now, req.params.id, partner_user_id);
      }
      return result.lastInsertRowid;
    });
  } catch (e) {
    // UNIQUE / CHECK races (e.g. double-submit) — surface as clean JSON, not a 500 page.
    if (e && /constraint/i.test(e.message)) return res.status(409).json({ error: 'Already registered' });
    throw e;
  }
  res.json({ id: newId });
});

// DELETE /api/registrations/:id — cancel my own registration
registrationsRouter.delete('/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  // Only a currently-active registration can be cancelled; a missing row or
  // one already cancelled/otherwise non-active is 404 (idempotent guard).
  const reg = await db.prepare("SELECT * FROM registrations WHERE id = ? AND status = 'registered'").get(req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found' });

  let isAdmin = false;
  if (reg.user_id !== req.session.userId) {
    // Admins may remove anyone from an event ("reduce participants").
    const me = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
    isAdmin = !!me?.is_admin;
    if (!isAdmin) return res.status(403).json({ error: 'Can only cancel your own registration' });
  }

  // Players can cancel up to 24 hours before the start; inside that window the
  // spot is locked and the fee stays payable (admins are not restricted).
  if (!isAdmin) {
    const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(reg.event_id);
    const deadline = cancelDeadlineMs(ev);
    if (deadline != null && Date.now() >= deadline) {
      return res.status(409).json({
        error: 'Cancellation closed — less than 24 hours before the event. The fee is still payable even if you cannot attend.',
      });
    }
  }

  const now = Date.now();
  await db.prepare("UPDATE registrations SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, req.params.id);
  // Clear partner's back-reference
  if (reg.partner_user_id) {
    await db.prepare("UPDATE registrations SET partner_user_id = NULL, updated_at = ? WHERE event_id = ? AND user_id = ? AND status = 'registered'")
      .run(now, reg.event_id, reg.partner_user_id);
  }
  // A freed spot immediately goes to the first person on the waitlist.
  const promoted = await promoteNextWaitlist(reg.event_id);
  res.json({ ok: true, promoted: promoted || null });
});

// PATCH /api/registrations/:id/training-slot (admin) — the organiser assigns
// training times, since players no longer pick a slot when registering.
registrationsRouter.patch('/:id/training-slot', requireAdmin, async (req, res) => {
  const reg = await db.prepare(
    "SELECT * FROM registrations WHERE id = ? AND status = 'registered'"
  ).get(req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found' });
  if (reg.reg_type !== 'training_and_activity') {
    return res.status(400).json({ error: 'Only Training + Social registrations have a training time' });
  }

  const raw = req.body?.training_slot;
  let slot = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (![0, 1, 2, 3].includes(n)) return res.status(400).json({ error: 'Invalid training slot' });
    slot = n;
  }

  await db.prepare('UPDATE registrations SET training_slot = ?, updated_at = ? WHERE id = ?')
    .run(slot, Date.now(), req.params.id);
  res.json({ ok: true, training_slot: slot });
});

// GET /api/registrations/my — the signed-in user's active registrations,
// used by the events page to show a global payment reminder on login.
registrationsRouter.get('/my', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  // include_finished=1 keeps history in the "My Events" list; the default
  // (upcoming only) is what the payment reminder wants.
  const includeFinished = String(req.query.include_finished || '') === '1';
  const regs = await db.prepare(`
    SELECT r.id, r.event_id, r.reg_type, r.training_slot, r.fee_cents, r.payment_status,
           r.payment_submitted_at, r.checked_in_at, e.title AS event_title, e.event_date, e.start_time,
           e.end_time, e.status AS event_status, e.payment_link
      FROM registrations r
      JOIN events e ON r.event_id = e.id
     WHERE r.user_id = ? AND r.status = 'registered'
       ${includeFinished ? '' : "AND e.status IN ('open', 'closed', 'active')"}
     ORDER BY e.event_date DESC
  `).all(req.session.userId);
  res.json({ registrations: regs });
});

// POST /api/registrations/:id/payment-proof — upload a screenshot / receipt.
// The image arrives as a data URL (already downscaled client-side) and is
// stored in the DB so it survives restarts on hosts with ephemeral disks.
registrationsRouter.post('/:id/payment-proof', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const reg = await db.prepare("SELECT * FROM registrations WHERE id = ? AND status = 'registered'").get(req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found' });
  if (reg.user_id !== req.session.userId) return res.status(403).json({ error: 'Not your registration' });
  if (reg.payment_status === 'paid') return res.status(400).json({ error: 'Payment already confirmed' });

  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(reg.event_id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (ev.status === 'finished') return res.status(400).json({ error: 'Event already finished' });

  const { proof, note } = req.body || {};
  const m = /^data:(image\/png|image\/jpeg|image\/jpg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(proof || ''));
  if (!m) return res.status(400).json({ error: 'Please upload a PNG / JPG / WEBP image' });
  const approxBytes = Math.floor(m[2].length * 3 / 4);
  if (approxBytes > 6 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 6MB)' });

  const now = Date.now();
  await db.prepare(
    `UPDATE registrations
        SET payment_status = 'submitted', payment_proof = ?, payment_note = ?,
            payment_submitted_at = ?, updated_at = ?
      WHERE id = ?`
  ).run(proof, String(note || '').slice(0, 300) || null, now, now, req.params.id);
  res.json({ ok: true, status: 'submitted' });
});

// GET /api/registrations/:id/proof — owner or admin can view the receipt.
registrationsRouter.get('/:id/proof', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const reg = await db.prepare('SELECT * FROM registrations WHERE id = ?').get(req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found' });
  const me = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (reg.user_id !== req.session.userId && !me?.is_admin) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  if (!reg.payment_proof) return res.status(404).json({ error: 'No payment proof uploaded' });
  res.json({
    proof: reg.payment_proof,
    status: reg.payment_status,
    note: reg.payment_note,
    submittedAt: reg.payment_submitted_at,
  });
});

// PATCH /api/registrations/:id/payment (admin) — confirm / undo / waive.
registrationsRouter.patch('/:id/payment', requireAdmin, async (req, res) => {
  const { status, note } = req.body || {};
  if (!['paid', 'unpaid', 'waived'].includes(status)) {
    return res.status(400).json({ error: 'Invalid payment status' });
  }
  const reg = await db.prepare('SELECT * FROM registrations WHERE id = ?').get(req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found' });

  const now = Date.now();
  await db.prepare(
    `UPDATE registrations
        SET payment_status = ?, payment_note = COALESCE(?, payment_note),
            payment_confirmed_at = ?, updated_at = ?
      WHERE id = ?`
  ).run(status, note !== undefined ? String(note).slice(0, 300) : null,
        status === 'paid' ? now : null, now, req.params.id);
  res.json({ ok: true, status });
});

// POST /api/registrations/waitlist/:id/promote (admin) — give a waitlisted
// player a spot. Capacity and slot limits do not apply to admin actions.
registrationsRouter.post('/waitlist/:id/promote', requireAdmin, async (req, res) => {
  const entry = await db.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').get(entry.event_id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const existing = await db.prepare(
    "SELECT id FROM registrations WHERE event_id = ? AND user_id = ? AND status = 'registered'"
  ).get(entry.event_id, entry.user_id);
  if (existing) {
    await db.prepare('DELETE FROM waitlist WHERE id = ?').run(entry.id);
    return res.status(409).json({ error: 'Already registered' });
  }

  // Training + social needs a slot: take the first one with room.
  let trainingSlot = null;
  if (entry.reg_type === 'training_and_activity') {
    for (const i of [0, 1, 2, 3]) {
      const c = (await db.prepare(
        "SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND training_slot = ? AND status = 'registered'"
      ).get(entry.event_id, i)).c;
      if (Number(c) < MAX_PER_SLOT) { trainingSlot = i; break; }
    }
  }

  const now = Date.now();
  const feeCents = feeFor(ev, entry.reg_type);
  const id = await db.transaction(async (tx) => {
    const r = await tx.prepare(
      `INSERT INTO registrations (event_id, user_id, reg_type, training_slot, status,
                                  fee_cents, payment_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'registered', ?, 'unpaid', ?, ?)`
    ).run(entry.event_id, entry.user_id, entry.reg_type, trainingSlot, feeCents, now, now);
    await tx.prepare('DELETE FROM waitlist WHERE id = ?').run(entry.id);
    return r.lastInsertRowid;
  });

  // Manual promotion deserves the same notification as the automatic one.
  const when = `${ev.event_date} · ${ev.start_time}-${ev.end_time}`;
  const place = ev.location ? ` · ${ev.location}` : '';
  const title = `Waitlist promoted: ${ev.title}`;
  const body = `An organiser has given you a confirmed spot.\nWhen: ${when}${place}\nFee: AUD$${(feeCents / 100).toFixed(2)} (please pay before the event)`;
  createNotification({
    userId: entry.user_id, type: 'waitlist_promoted', title, body, eventId: entry.event_id,
    email: { subject: `[N1 Badminton] ${title}`, text: body },
  }).catch(e => console.warn('Waitlist notification failed:', e.message));

  res.json({ id, training_slot: trainingSlot });
});

// DELETE /api/registrations/waitlist/:id — leave the waitlist (owner or admin).
registrationsRouter.delete('/waitlist/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const entry = await db.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (entry.user_id !== req.session.userId) {
    const me = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
    if (!me?.is_admin) return res.status(403).json({ error: 'Not allowed' });
  }
  await db.prepare('DELETE FROM waitlist WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, registrationsRouter, SLOT_LABELS, MAX_PER_SLOT, EVENT_CAPACITY };
