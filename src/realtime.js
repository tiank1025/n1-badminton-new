const fs = require('fs');
const path = require('path');

// ── Constants ───────────────────────────────────────────
const INITIAL_COURT_IDS = [6, 7, 8, 9, 10];
const EXTRA_COURT_IDS   = [1, 2, 3, 4, 5]; // venue courts available as extras
const LEVELS = ['advanced', 'intermediate', 'novice', 'beginner'];
const TRAINING_SLOT_COUNT = 4;
const TRAINING_MAX_PER_SLOT = 4;
// One training slot lasts 30 minutes. Override with TRAINING_DURATION_MS
// (ms) for tests / environments with different schedules.
const TRAINING_DURATION_MS = Number(process.env.TRAINING_DURATION_MS) > 0
  ? Number(process.env.TRAINING_DURATION_MS)
  : 30 * 60 * 1000;
// How often the server checks for expired training slots and auto-returns
// players to the front of the queue (server-side guarantee; the client timer
// only controls display and provides a snappy early trigger).
const TRAINING_CHECK_INTERVAL_MS = 10 * 1000;

// ── State ───────────────────────────────────────────────
const state = {
  courtIds: [...INITIAL_COURT_IDS],
  courts: Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [], playing: false }])),
  next:    Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [] }])),
  queue:   [],
  players: {},
  pairs:   {},
  // Canonical pair key (JSON of sorted [a,b]) -> true means "LOCK pair":
  // the pair survives games and is never auto-dissolved. Absent = casual pair,
  // which auto-unbinds after the two players finish one game together.
  stickyPairs: {},
  history: [],
  // Training module: 4 half-hour slots, each holds up to 4 player names.
  // `slots[i]` is a flat array of names; `startedAt[i]` is the timestamp the
  // slot first became occupied (drives the countdown + server-side expiry).
  training: {
    slots: Array.from({ length: TRAINING_SLOT_COUNT }, () => []),
    startedAt: Array.from({ length: TRAINING_SLOT_COUNT }, () => null),
  },
  // Currently active event context (set when admin activates an event from
  // the dashboard). Used by board.html to display the event title and by
  // auto_join_event to know which event's registrations to pull in.
  activeEventId: null,
  activeEventTitle: null,
};

let connectedCount = 0;
const courtUndoSnapshots = {}; // courtId -> { type: 'end_game'|'promote', players, wasPlaying }
const queuedSince = {};        // name -> timestamp they (continuously) entered the queue

// ── Persistence ─────────────────────────────────────────
// Set STATE_FILE to a path on a persistent disk (e.g. /var/data/state.json on
// Render with a disk attached) so the board survives deploys/restarts. With no
// disk, it falls back to a local file (best-effort; ephemeral on free tiers).
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'state.json');

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.courtIds))               state.courtIds = saved.courtIds;
      if (saved.courts  && typeof saved.courts  === 'object') state.courts  = saved.courts;
      if (saved.next    && typeof saved.next    === 'object') state.next    = saved.next;
      if (Array.isArray(saved.queue))                  state.queue   = saved.queue;
      if (saved.players && typeof saved.players === 'object') state.players = saved.players;
      if (saved.pairs   && typeof saved.pairs   === 'object') state.pairs   = saved.pairs;
      if (saved.stickyPairs && typeof saved.stickyPairs === 'object') state.stickyPairs = saved.stickyPairs;
      if (Array.isArray(saved.history))                state.history = saved.history;
      if (saved.training && Array.isArray(saved.training.slots)
          && saved.training.slots.length === TRAINING_SLOT_COUNT) {
        const slots = saved.training.slots.map(s => Array.isArray(s) ? [...s] : []);
        // startedAt may be missing in state.json written by older versions.
        // An occupied slot without a saved stamp gets stamped on load; an
        // empty slot always starts with null.
        const loadedStarts = Array.isArray(saved.training.startedAt)
          ? saved.training.startedAt
          : [];
        const now = Date.now();
        const startedAt = slots.map((players, i) => {
          if (!players.length) return null;
          const v = loadedStarts[i];
          return Number.isFinite(v) ? v : now;
        });
        state.training = { slots, startedAt };
      }
      // Restore active event context (may be null on first run).
      if (saved.activeEventId !== undefined) state.activeEventId = saved.activeEventId;
      if (saved.activeEventTitle !== undefined) state.activeEventTitle = saved.activeEventTitle;
      // Heal any missing court/on-deck entries so the rest of the code is safe.
      INITIAL_COURT_IDS.forEach(id => { if (!state.next[id]) state.next[id] = { players: [] }; });
      state.courtIds.forEach(id => { if (!state.courts[id]) state.courts[id] = { players: [], playing: false }; });
      console.log(`   状态已从 ${STATE_FILE} 恢复`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('   加载状态失败:', e.message);
  }
}

function saveNow() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE); // atomic replace
  } catch (e) {
    console.warn('   保存状态失败:', e.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;            // debounce: batch rapid mutations into ~1 write/sec
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1000);
}

function stateWithUndo() {
  const canUndoCourt = Object.fromEntries(state.courtIds.map(id => [id, !!courtUndoSnapshots[id]]));
  // Clients receive training slots as {players, startedAt} objects; internally
  // the server keeps a flat name array plus a parallel startedAt array.
  const training = {
    durationMs: TRAINING_DURATION_MS,
    slots: state.training.slots.map((players, i) => ({
      players: [...players],
      startedAt: state.training.startedAt[i],
    })),
  };
  return { ...state, training, canUndoCourt, queuedSince };
}

// Stamp a start time when a court fills (game begins); clear it when it empties.
function syncCourtTimers() {
  state.courtIds.forEach(id => {
    const c = state.courts[id];
    if (!c) return;
    if (c.players.length === 4) { if (!c.startedAt) c.startedAt = Date.now(); }
    else if (c.startedAt) { delete c.startedAt; }
  });
}

// Track how long each player has been continuously waiting in the queue.
function syncQueueTimers() {
  const now = Date.now();
  const inQueue = new Set(state.queue);
  state.queue.forEach(n => { if (!queuedSince[n]) queuedSince[n] = now; });
  Object.keys(queuedSince).forEach(n => { if (!inQueue.has(n)) delete queuedSince[n]; });
}

function broadcast() {
  syncCourtTimers();
  syncQueueTimers();
  io.emit('state_update', stateWithUndo());
  scheduleSave();
}

// ── Training slot timer helpers ─────────────────────────
// Call AFTER a player has been added: the countdown starts the moment a slot
// goes from empty to occupied (first entrant stamps it).
function stampTrainingStart(slot) {
  if (state.training.slots[slot]?.length && state.training.startedAt[slot] === null) {
    state.training.startedAt[slot] = Date.now();
  }
}
// Call AFTER a player has been removed: when the slot empties out its
// countdown resets, so the next entrant gets a fresh 30 minutes.
function clearTrainingStartIfEmpty(slot) {
  if (state.training.slots[slot] && state.training.slots[slot].length === 0) {
    state.training.startedAt[slot] = null;
  }
}

// Server-authoritative expiry sweep: any slot whose countdown has elapsed
// sends its players back to the FRONT of the queue (they were pulled out of
// rotation for training, like end_training does manually). Runs even with no
// browser open; the client countdown is display-only + an early trigger.
function expireTrainingSlots() {
  if (!io) return; // server not initialised yet
  const now = Date.now();
  let changed = false;
  for (let slot = 0; slot < TRAINING_SLOT_COUNT; slot++) {
    const startedAt = state.training.startedAt[slot];
    const players = state.training.slots[slot];
    if (startedAt === null || !players.length) continue;
    if (now - startedAt < TRAINING_DURATION_MS) continue;
    players.forEach(name => { state.queue = [name, ...state.queue]; });
    state.training.slots[slot] = [];
    state.training.startedAt[slot] = null;
    changed = true;
  }
  if (changed) broadcast();
}

function sanitize(name) {
  return String(name || '').trim().replace(/[<>"'&]/g, '').slice(0, 20);
}

function isNameUsed(name) {
  if (state.queue.includes(name)) return true;
  if (state.courtIds.some(id => state.courts[id].players.includes(name))) return true;
  if (INITIAL_COURT_IDS.some(id => state.next[id].players.includes(name))) return true;
  if (state.training.slots.some(slot => slot.includes(name))) return true;
  return false;
}

function lvlIdx(name) {
  const i = LEVELS.indexOf(state.players[name]);
  return i >= 0 ? i : 2;
}

function shiftNextSlots() {
  const filled = INITIAL_COURT_IDS.map(id => state.next[id].players).filter(p => p.length > 0);
  INITIAL_COURT_IDS.forEach((id, i) => {
    state.next[id].players = filled[i] ? [...filled[i]] : [];
  });
}

// Canonical, collision-free key for an unordered pair of names.
function pairKey(a, b) { return JSON.stringify([a, b].sort()); }
function isStickyPair(a, b) { return !!state.stickyPairs[pairKey(a, b)]; }
function setPairSticky(a, b, sticky) {
  const k = pairKey(a, b);
  if (sticky) state.stickyPairs[k] = true;
  else delete state.stickyPairs[k];
}

// Write a bidirectional pair edge (replacing any existing pair on either side)
// and record whether it is a force-paired (sticky) pair.
function linkPair(a, b, sticky) {
  cleanupPair(a);
  cleanupPair(b);
  state.pairs[a] = b;
  state.pairs[b] = a;
  setPairSticky(a, b, !!sticky);
}

function cleanupPair(name) {
  const partner = state.pairs[name];
  if (partner) {
    delete state.stickyPairs[pairKey(name, partner)];
    delete state.pairs[name];
    if (state.pairs[partner] === name) delete state.pairs[partner];
  }
}

// Locate a player across queue / courts / on-deck / training. Returns null if not found.
function findPlayer(name) {
  if (state.queue.includes(name)) return { type: 'queue' };
  for (const id of state.courtIds) {
    if (state.courts[id] && state.courts[id].players.includes(name)) return { type: 'court', id };
  }
  for (const id of INITIAL_COURT_IDS) {
    if (state.next[id] && state.next[id].players.includes(name)) return { type: 'next', id };
  }
  for (let i = 0; i < state.training.slots.length; i++) {
    if (state.training.slots[i].includes(name)) return { type: 'training', id: i };
  }
  return null;
}

// Get the backing players array for a located player.
function arrForLoc(loc) {
  if (loc.type === 'queue') return state.queue;
  if (loc.type === 'court') return state.courts[loc.id].players;
  if (loc.type === 'next')  return state.next[loc.id].players;
  if (loc.type === 'training') return state.training.slots[loc.id];
  return null;
}

// Expand a base selection to also include each player's waiting partner.
// Returns null if the resulting group can't fit in `spots` (would split a pair).
function expandWithPartners(base, spots, occupied) {
  const toAdd = new Set();
  for (const n of base) {
    toAdd.add(n);
    const p = state.pairs[n];
    if (p && state.queue.includes(p) && !occupied.has(p)) toAdd.add(p);
  }
  return toAdd.size > spots ? null : [...toAdd];
}

// Unordered key for a pair of player names (co-play history memory).
function edgeKey(a, b) { return [a, b].sort().join(' '); }

// Set of player-pairs that have already shared a court in recorded history.
function buildCoPlayedSet() {
  const s = new Set();
  state.history.forEach(h => {
    const p = h.players || [];
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++)
        s.add(edgeKey(p[i], p[j]));
  });
  return s;
}

// Auto-fill by choosing from the ENTIRE waitlist — queue position is only a
// final tie-break. Selection priorities (lexicographic):
//   1) fill as many open spots as possible; bound pairs are atomic 2-player units
//   2) prefer groups whose level spread is within one tier (relaxed if impossible)
//   3) maximise fresh matchups — players who have NEVER shared a court before
//   4) then tighter level spread, then longest-waiting players on ties
function smartFillInto(targetPlayers) {
  const needed = 4 - targetPlayers.length;
  if (needed <= 0 || state.queue.length === 0) return;

  const queuePos = new Map(state.queue.map((n, i) => [n, i]));

  // Build scheduling units from the whole queue: a pair whose partner is also
  // waiting forms one indivisible unit; everyone else is a single.
  const units = [];
  const consumed = new Set();
  state.queue.forEach(name => {
    if (consumed.has(name)) return;
    const partner = state.pairs[name];
    if (partner && partner !== name && queuePos.has(partner) && !consumed.has(partner)) {
      units.push({
        players: [name, partner],
        size: 2,
        order: Math.min(queuePos.get(name), queuePos.get(partner)),
      });
      consumed.add(name); consumed.add(partner);
    } else {
      units.push({ players: [name], size: 1, order: queuePos.get(name) });
      consumed.add(name);
    }
  });
  // Units larger than the open spots can never be picked; the rest are explored
  // in queue order so equal-score combinations favour longer-waiting players.
  const fitting = units.filter(u => u.size <= needed)
                       .sort((a, b) => a.order - b.order);

  const coPlayed = buildCoPlayedSet();
  const fixed = [...targetPlayers];

  function score(extra) {
    const group = fixed.concat(extra);
    const lvls = group.map(lvlIdx);
    const spread = group.length ? Math.max(...lvls) - Math.min(...lvls) : Infinity;
    // Repeated matchups are counted on cross-unit edges only. Edges inside a
    // currently bound pair are mandatory, so they don't count against freshness.
    let edges = 0, repeats = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (state.pairs[group[i]] === group[j]) continue;
        edges++;
        if (coPlayed.has(edgeKey(group[i], group[j]))) repeats++;
      }
    }
    return {
      unfilled: needed - extra.length,
      spreadBucket: spread <= 1 ? 0 : 1, // strong preference, relaxed via ranking
      repeatRate: edges ? repeats / edges : 0,
      spread,
    };
  }

  function better(c, b) {
    return c.unfilled < b.unfilled
      || (c.unfilled === b.unfilled && c.spreadBucket < b.spreadBucket)
      || (c.unfilled === b.unfilled && c.spreadBucket === b.spreadBucket && c.repeatRate < b.repeatRate)
      || (c.unfilled === b.unfilled && c.spreadBucket === b.spreadBucket
          && c.repeatRate === b.repeatRate && c.spread < b.spread);
  }

  let best = null;
  // Enumerate every feasible unit combination (total unit size <= needed).
  // A group contains at most `needed` (<=4) singles, so the search stays small.
  (function dfs(start, acc, size) {
    const s = score(acc);
    if (!best || better(s, best.s)) best = { s, players: [...acc] };
    for (let i = start; i < fitting.length; i++) {
      const u = fitting[i];
      if (size + u.size <= needed) {
        acc.push(...u.players);
        dfs(i + 1, acc, size + u.size);
        acc.length -= u.size;
      }
    }
  })(0, [], 0);

  if (best && best.players.length) {
    const chosenSet = new Set(best.players);
    state.queue = state.queue.filter(n => !chosenSet.has(n));
    targetPlayers.push(...best.players);
  }
}

// ── Module-level io reference (set in initRealtime) ────
let io = null;

// ── Realtime init ───────────────────────────────────────
function initRealtime(_io, sessionMiddleware, db) {
  io = _io;

  // Server-authoritative training expiry sweep (also covers overdue slots
  // left over from a restart). unref() so it never keeps the process alive.
  const trainingTimer = setInterval(expireTrainingSlots, TRAINING_CHECK_INTERVAL_MS);
  if (typeof trainingTimer.unref === 'function') trainingTimer.unref();
  // Run one sweep shortly after boot in case a slot expired while offline.
  setTimeout(expireTrainingSlots, 2000).unref?.();

  // Attach the Express session to each incoming socket so we can read
  // `socket.request.session.userId` and resolve admin status from the DB.
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, async () => {
      const userId = socket.request.session && socket.request.session.userId;
      if (userId) {
        try {
          const row = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
          socket.isAdmin = !!(row && row.is_admin);
        } catch (e) {
          socket.isAdmin = false;
        }
      } else {
        socket.isAdmin = false;
      }
      next();
    });
  });

  io.on('connection', (socket) => {
    connectedCount++;
    // Personal room so notifications.js can push to this player only.
    const uid = socket.request.session && socket.request.session.userId;
    if (uid) socket.join(`u:${uid}`);
    io.emit('connected_count', connectedCount);
    socket.emit('state_update', stateWithUndo());

    socket.on('disconnect', () => {
      connectedCount--;
      io.emit('connected_count', connectedCount);
    });

    socket.on('join_queue', ({ name, level, partner, sticky }) => {
      name = sanitize(name);
      partner = sanitize(partner || '');
      if (!name) return;
      if (isNameUsed(name)) { socket.emit('join_error', { reason: 'name_taken', name }); return; }
      if (!LEVELS.includes(level)) return;
      state.players[name] = level;
      state.queue.push(name);
      // Partner must already be waiting. `sticky` = keep the pair together for the
      // whole session; otherwise it auto-dissolves after their first game together.
      // First-pair priority: a partner who is already in an earlier pair cannot be
      // claimed away — the new player joins solo instead. (Admins can still re-pair.)
      let pairDeclined = null;
      if (partner && partner !== name && state.queue.includes(partner)) {
        if (state.pairs[partner]) {
          pairDeclined = { partner, pairedWith: state.pairs[partner] };
        } else {
          linkPair(name, partner, !!sticky);
        }
      }
      socket.emit('join_success', { pairDeclined });
      broadcast();
    });

    socket.on('remove_from_queue', (name) => {
      name = sanitize(name);
      state.queue = state.queue.filter(n => n !== name);
      cleanupPair(name); // also clears the sticky flag
      broadcast();
    });

    socket.on('unlink_pair', (name) => {
      if (!socket.isAdmin) return;
      name = sanitize(name);
      cleanupPair(name); // also clears the sticky flag
      broadcast();
    });

    // Admin pairs two waiting players into a partnership (overrides existing pairs).
    socket.on('pair_players', ({ a, b, sticky }) => {
      if (!socket.isAdmin) return;
      a = sanitize(a); b = sanitize(b);
      if (!a || !b || a === b) return;
      if (!state.queue.includes(a) || !state.queue.includes(b)) return; // both must be waiting
      linkPair(a, b, !!sticky);
      broadcast();
    });

    socket.on('add_court', () => {
      if (!socket.isAdmin) return;
      const allIds = [...EXTRA_COURT_IDS, ...INITIAL_COURT_IDS].sort((a, b) => a - b);
      const nextId = allIds.find(id => !state.courtIds.includes(id));
      if (nextId === undefined) return; // all courts already active
      state.courtIds.push(nextId);
      state.courtIds.sort((a, b) => a - b);
      state.courts[nextId] = { players: [], playing: false };
      broadcast();
    });

    socket.on('remove_court', (courtId) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      if (!state.courtIds.includes(courtId)) return;
      const court = state.courts[courtId];
      const next  = state.next[courtId];
      if (court.players.length > 0 || court.playing) return;
      if (next && next.players.length > 0) return;
      state.courtIds = state.courtIds.filter(id => id !== courtId);
      delete state.courts[courtId];
      broadcast();
    });

    socket.on('fill_court', (courtId) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const court = state.courts[courtId];
      if (court) { delete courtUndoSnapshots[courtId]; smartFillInto(court.players); broadcast(); }
    });

    socket.on('fill_next', (courtId) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const next = state.next[courtId];
      if (!next) return;
      smartFillInto(next.players);
      broadcast();
    });

    socket.on('manual_assign', ({ courtId, names }) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const court = state.courts[courtId];
      if (!court) return;
      const spots = 4 - court.players.length;
      const occupied = new Set(court.players);
      const base = [...new Set((names || []).map(n => sanitize(n))
        .filter(n => n && state.queue.includes(n) && !occupied.has(n)))];
      if (base.length === 0) return;
      const toAdd = expandWithPartners(base, spots, occupied); // brings waiting partners
      if (!toAdd) { socket.emit('assign_error', { reason: 'no_space' }); return; }
      delete courtUndoSnapshots[courtId];
      const added = new Set(toAdd);
      // Keep the pair intact — casual pairs unbind after the game, sticky pairs stay.
      state.queue = state.queue.filter(n => !added.has(n));
      court.players.push(...toAdd);
      broadcast();
    });

    socket.on('manual_assign_next', ({ courtId, names }) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const next = state.next[courtId];
      if (!next) return;
      const spots = 4 - next.players.length;
      const occupied = new Set(next.players);
      const base = [...new Set((names || []).map(n => sanitize(n))
        .filter(n => n && state.queue.includes(n) && !occupied.has(n)))];
      if (base.length === 0) return;
      const toAdd = expandWithPartners(base, spots, occupied); // brings waiting partners
      if (!toAdd) { socket.emit('assign_error', { reason: 'no_space' }); return; }
      const added = new Set(toAdd);
      state.queue = state.queue.filter(n => !added.has(n));
      next.players.push(...toAdd); // pair stays bound until the game is over
      broadcast();
    });

    socket.on('assign_player', ({ courtId, name }) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      name = sanitize(name);
      const court = state.courts[courtId];
      if (!court || court.players.length >= 4 || court.players.includes(name)) return;
      delete courtUndoSnapshots[courtId];
      state.queue = state.queue.filter(n => n !== name);
      court.players.push(name); // pair is not broken by scheduling moves
      broadcast();
    });

    // Atomically move a player between queue / court / on-deck / training (admin drag-and-drop).
    socket.on('move_player', ({ name, toType, toId }) => {
      if (!socket.isAdmin) return;
      name = sanitize(name);
      if (!name) return;
      toId = (toId === undefined || toId === null) ? null : Number(toId);

      const from = findPlayer(name);
      if (!from) return; // unknown / stale player

      // Validate destination + capacity (and ignore no-op moves to same slot)
      if (toType === 'court') {
        const dest = state.courts[toId];
        if (!dest) return;
        if (from.type === 'court' && from.id === toId) return;
        if (dest.players.length >= 4) return;
      } else if (toType === 'next') {
        const dest = state.next[toId];
        if (!dest) return;
        if (from.type === 'next' && from.id === toId) return;
        if (dest.players.length >= 4) return;
      } else if (toType === 'training') {
        if (!Number.isInteger(toId) || toId < 0 || toId >= TRAINING_SLOT_COUNT) return;
        if (from.type === 'training' && from.id === toId) return;
        if (state.training.slots[toId].length >= TRAINING_MAX_PER_SLOT) return;
      } else if (toType === 'queue') {
        if (from.type === 'queue') return;
      } else {
        return;
      }

      // Remove from source
      if (from.type === 'queue') {
        state.queue = state.queue.filter(n => n !== name);
      } else if (from.type === 'court') {
        const c = state.courts[from.id];
        c.players = c.players.filter(n => n !== name);
        if (c.players.length < 4) c.playing = false;
        delete courtUndoSnapshots[from.id];
      } else if (from.type === 'next') {
        state.next[from.id].players = state.next[from.id].players.filter(n => n !== name);
      } else if (from.type === 'training') {
        state.training.slots[from.id] = state.training.slots[from.id].filter(n => n !== name);
        // Remaining players keep the running countdown; only an emptied slot resets.
        clearTrainingStartIfEmpty(from.id);
      }

      // Add to destination (pair binding is unaffected by drag-and-drop moves)
      if (toType === 'court') {
        state.courts[toId].players.push(name);
        delete courtUndoSnapshots[toId];
      } else if (toType === 'next') {
        state.next[toId].players.push(name);
      } else if (toType === 'training') {
        state.training.slots[toId].push(name);
        stampTrainingStart(toId); // fresh countdown if the slot was empty
      } else if (toType === 'queue') {
        state.queue.push(name);
      }

      broadcast();
    });

    // Swap two players' positions (admin drag one player onto another).
    socket.on('swap_players', ({ a, b }) => {
      if (!socket.isAdmin) return;
      a = sanitize(a); b = sanitize(b);
      if (!a || !b || a === b) return;
      const la = findPlayer(a), lb = findPlayer(b);
      if (!la || !lb) return;
      const arrA = arrForLoc(la), arrB = arrForLoc(lb);
      if (!arrA || !arrB) return;
      const ia = arrA.indexOf(a), ib = arrB.indexOf(b);
      if (ia < 0 || ib < 0) return;
      arrA[ia] = b; arrB[ib] = a; // works in-place whether same array or not
      // a court that loses/keeps 4 players is unaffected; just clear stale undo snapshots
      [la, lb].forEach(loc => {
        if (loc.type === 'court') delete courtUndoSnapshots[loc.id];
      });
      broadcast();
    });

    socket.on('remove_from_court', ({ courtId, name }) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      name = sanitize(name);
      const court = state.courts[courtId];
      if (!court) return;
      delete courtUndoSnapshots[courtId];
      court.players = court.players.filter(n => n !== name);
      if (court.players.length < 4) court.playing = false;
      broadcast();
    });

    socket.on('remove_from_next', ({ courtId, name }) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      name = sanitize(name);
      const next = state.next[courtId];
      if (!next) return;
      const wasIn = next.players.includes(name);
      next.players = next.players.filter(n => n !== name);
      if (wasIn) {
        // Back to the queue without playing — keep any pair binding intact.
        state.queue = [name, ...state.queue];
      }
      broadcast();
    });

    socket.on('promote_next', ({ fromCourtId, toCourtId }) => {
      if (!socket.isAdmin) return;
      fromCourtId = Number(fromCourtId);
      toCourtId   = Number(toCourtId);
      const next  = state.next[fromCourtId];
      const court = state.courts[toCourtId];
      if (!next || !court || next.players.length === 0) return;
      if (court.players.length > 0 || court.playing) return;
      courtUndoSnapshots[toCourtId] = { type: 'promote', players: [...next.players], wasPlaying: false };
      court.players = [...next.players];
      next.players  = [];
      shiftNextSlots();
      io.emit('announce', { courtId: toCourtId, players: [...court.players] });
      broadcast();
    });

    // Clear an On-Deck slot: send everyone in it back to the front of the queue.
    // Always available while the slot has players (admin "Undo").
    socket.on('clear_next', (courtId) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const next = state.next[courtId];
      if (!next || next.players.length === 0) return;
      const players = [...next.players];
      next.players = [];
      state.queue = [...players, ...state.queue]; // sent back without playing: pairs persist
      broadcast();
    });

    socket.on('start_game', (courtId) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const court = state.courts[courtId];
      if (court && court.players.length === 4) { delete courtUndoSnapshots[courtId]; court.playing = true; broadcast(); }
    });

    socket.on('end_game', ({ courtId, toQueue, score, teams }) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const court = state.courts[courtId];
      if (!court) return;
      if (court.players.length > 0) {
        const snap = { type: 'end_game', players: [...court.players], wasPlaying: court.playing };
        courtUndoSnapshots[courtId] = snap;
        // Store players in team order (team1 first, team2 next) if a valid split is given.
        let ordered = [...court.players];
        if (Array.isArray(teams) && teams.length === 2
            && teams.every(t => Array.isArray(t) && t.length === 2)) {
          const flat = [teams[0][0], teams[0][1], teams[1][0], teams[1][1]].map(sanitize);
          const same = flat.length === court.players.length
            && [...flat].sort().join('|') === [...court.players].sort().join('|');
          if (same) ordered = flat;
        }
        const entry = { time: Date.now(), courtId, players: ordered };
        if (court.startedAt) entry.durationMs = Date.now() - court.startedAt; // how long the game ran
        // optional score: { a, b } for team1 (players 0,1) vs team2 (players 2,3)
        if (score && typeof score === 'object') {
          const a = Number(score.a), b = Number(score.b);
          if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0)
            entry.score = { a: Math.round(a), b: Math.round(b) };
        }
        state.history.unshift(entry);
        if (state.history.length > 100) state.history.pop();

        // Casual (non-sticky) pairs that just finished a game TOGETHER are
        // auto-unbound now. Sticky pairs stay paired for the whole session.
        // The unbound pairs are saved in the undo snapshot so "Undo End" restores them.
        const onCourt = new Set(court.players);
        snap.pairsToRestore = [];
        court.players.forEach(p => {
          const partner = state.pairs[p];
          if (partner && partner !== p && onCourt.has(partner) && !isStickyPair(p, partner)) {
            snap.pairsToRestore.push([p, partner]);
            cleanupPair(p); // removes both edges; the partner's iteration becomes a no-op
          }
        });
      }
      if (toQueue) state.queue.push(...court.players);
      court.players = [];
      court.playing = false;
      broadcast();
    });

    socket.on('undo_court_action', (courtId) => {
      if (!socket.isAdmin) return;
      courtId = Number(courtId);
      const snap = courtUndoSnapshots[courtId];
      if (!snap) return;
      const court = state.courts[courtId];
      if (!court) return;

      if (snap.type === 'end_game') {
        if (court.players.length > 0 || court.playing) return;
        const snapSet = new Set(snap.players);
        state.queue = state.queue.filter(n => !snapSet.has(n));
        court.players = [...snap.players];
        court.playing = snap.wasPlaying;
        // Restore casual pairs auto-dissolved at end-game, unless the players were
        // re-paired manually in the meantime.
        (snap.pairsToRestore || []).forEach(([a, b]) => {
          if (!state.pairs[a] && !state.pairs[b]) { state.pairs[a] = b; state.pairs[b] = a; }
        });
      } else if (snap.type === 'promote') {
        if (court.playing) return;
        const snapSet = new Set(snap.players);
        const sameSet = court.players.length === snap.players.length && court.players.every(p => snapSet.has(p));
        if (!sameSet) return;
        court.players = [];
        state.queue = [...snap.players, ...state.queue];
      }

      delete courtUndoSnapshots[courtId];
      broadcast();
    });

    socket.on('reset_all', () => {
      if (!socket.isAdmin) return;
      state.courtIds = [...INITIAL_COURT_IDS];
      state.courts = Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [], playing: false }]));
      state.next   = Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [] }]));
      state.queue   = [];
      state.players = {};
      state.pairs   = {};
      state.stickyPairs = {};
      state.history = [];
      state.training = {
        slots: Array.from({ length: TRAINING_SLOT_COUNT }, () => []),
        startedAt: Array.from({ length: TRAINING_SLOT_COUNT }, () => null),
      };
      state.activeEventId = null;
      state.activeEventTitle = null;
      Object.keys(courtUndoSnapshots).forEach(k => delete courtUndoSnapshots[k]);
      broadcast();
    });

    // ── Event activation & auto-join ──────────────────────
    // Admin activates an event: reset the board (if switching events), set
    // activeEventId/Title, load all registrants into queue / training slots
    // and link partner pairs. Idempotent — calling it again on the same
    // event only fills in any missing registrants.
    socket.on('activate_event', async ({ eventId }) => {
      if (!socket.isAdmin) return;
      eventId = Number(eventId);
      if (!Number.isFinite(eventId)) return;

      const ev = await db.prepare('SELECT id, title, status FROM events WHERE id = ?').get(eventId);
      if (!ev) { socket.emit('activate_error', { reason: 'not_found' }); return; }

      // Switching to a different event — wipe the board and start fresh.
      if (state.activeEventId !== null && state.activeEventId !== eventId) {
        state.courtIds = [...INITIAL_COURT_IDS];
        state.courts = Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [], playing: false }]));
        state.next   = Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [] }]));
        state.queue   = [];
        state.players = {};
        state.pairs   = {};
        state.stickyPairs = {};
        state.history = [];
        state.training = {
          slots: Array.from({ length: TRAINING_SLOT_COUNT }, () => []),
          startedAt: Array.from({ length: TRAINING_SLOT_COUNT }, () => null),
        };
        Object.keys(courtUndoSnapshots).forEach(k => delete courtUndoSnapshots[k]);
      }

      state.activeEventId   = eventId;
      state.activeEventTitle = ev.title;

      // Pull every active registration, ordered by registration time so the
      // queue reflects sign-up order. Partner name is resolved via JOIN.
      const regs = await db.prepare(`
        SELECT r.*, u.display_name, u.level,
               p.display_name AS partner_name
        FROM registrations r
        JOIN users u ON r.user_id = u.id
        LEFT JOIN users p ON r.partner_user_id = p.id
        WHERE r.event_id = ? AND r.status = 'registered'
        ORDER BY r.created_at ASC
      `).all(eventId);

      // 1) Seed each player's level + drop them into the right bucket.
      regs.forEach(r => {
        state.players[r.display_name] = r.level;
        // Skip players already seated somewhere (court / on-deck / training /
        // queue) — they were placed there by an admin and shouldn't be cloned.
        if (isNameUsed(r.display_name)) return;
        if (r.reg_type === 'training_and_activity') {
          const slot = r.training_slot;
          if (Number.isInteger(slot) && slot >= 0 && slot < TRAINING_SLOT_COUNT
              && state.training.slots[slot].length < TRAINING_MAX_PER_SLOT) {
            state.training.slots[slot].push(r.display_name);
          } else {
            // Slot full or invalid — fall back to queue.
            state.queue.push(r.display_name);
          }
        } else {
          state.queue.push(r.display_name);
        }
      });
      // Any training slot that just became occupied starts its countdown;
      // slots already running (re-activation) keep their original stamp.
      for (let s = 0; s < TRAINING_SLOT_COUNT; s++) stampTrainingStart(s);

      // 2) Link partner pairs now that everyone is seated somewhere.
      // linkPair is bidirectional and idempotent (it cleans up first).
      const byUser = new Map(regs.map(r => [r.user_id, r]));
      regs.forEach(r => {
        if (!r.partner_user_id) return;
        const partner = byUser.get(r.partner_user_id);
        if (!partner) return;
        const a = r.display_name, b = partner.display_name;
        if (findPlayer(a) && findPlayer(b)) {
          linkPair(a, b, !!r.sticky_pair);
        }
      });

      // 3) Mark this event active and retire any other "active" events —
      // only one event can be on the board at a time.
      const now = Date.now();
      await db.prepare("UPDATE events SET status = 'finished', updated_at = ? WHERE status = 'active' AND id != ?")
        .run(now, eventId);
      await db.prepare("UPDATE events SET status = 'active', synced_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, eventId);

      broadcast();
      socket.emit('activate_success', { eventId, title: ev.title });
    });

    // Admin finishes an active event: mark it finished in the DB, clear the
    // board's active-event context, and reset all court/queue/training state
    // so the board is ready for the next event. Stays on the dashboard (unlike
    // activate, there's no board navigation involved).
    socket.on('finish_event', async ({ eventId }) => {
      if (!socket.isAdmin) return;
      eventId = Number(eventId);
      if (!Number.isFinite(eventId)) return;

      const ev = await db.prepare('SELECT id, title, status FROM events WHERE id = ?').get(eventId);
      if (!ev) { socket.emit('finish_error', { reason: 'not_found' }); return; }
      if (ev.status !== 'active') {
        socket.emit('finish_error', { reason: 'not_active', current: ev.status });
        return;
      }

      const now = Date.now();
      await db.prepare("UPDATE events SET status = 'finished', updated_at = ? WHERE id = ?")
        .run(now, eventId);

      // Clear the board entirely — the event is over.
      state.courtIds = [...INITIAL_COURT_IDS];
      state.courts = Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [], playing: false }]));
      state.next   = Object.fromEntries(INITIAL_COURT_IDS.map(id => [id, { players: [] }]));
      state.queue   = [];
      state.players = {};
      state.pairs   = {};
      state.stickyPairs = {};
      state.history = [];
      state.training = {
        slots: Array.from({ length: TRAINING_SLOT_COUNT }, () => []),
        startedAt: Array.from({ length: TRAINING_SLOT_COUNT }, () => null),
      };
      state.activeEventId = null;
      state.activeEventTitle = null;
      Object.keys(courtUndoSnapshots).forEach(k => delete courtUndoSnapshots[k]);

      broadcast();
      socket.emit('finish_success', { eventId, title: ev.title });
    });

    // Regular user opening /board?eventId=X: if the event is the currently
    // active one and the user has registered, drop them (and their partner)
    // into the queue. No-op if already on the board. Errors out if the event
    // is not yet active on the board (admin must activate first).
    socket.on('auto_join_event', async ({ eventId }) => {
      eventId = Number(eventId);
      if (!Number.isFinite(eventId)) return;
      const userId = socket.request.session && socket.request.session.userId;
      if (!userId) { socket.emit('auto_join_error', { reason: 'not_logged_in' }); return; }

      const reg = await db.prepare(`
        SELECT r.*, u.display_name, u.level,
               p.display_name AS partner_name
        FROM registrations r
        JOIN users u ON r.user_id = u.id
        LEFT JOIN users p ON r.partner_user_id = p.id
        WHERE r.event_id = ? AND r.user_id = ? AND r.status = 'registered'
      `).get(eventId, userId);
      if (!reg) { socket.emit('auto_join_error', { reason: 'not_registered' }); return; }

      if (state.activeEventId !== eventId) {
        socket.emit('auto_join_error', {
          reason: 'event_not_active',
          activeTitle: state.activeEventTitle,
        });
        return;
      }

      const name = reg.display_name;
      if (isNameUsed(name)) {
        socket.emit('auto_join_noop', { reason: 'already_in_state' });
        return;
      }

      state.players[name] = reg.level;
      state.queue.push(name);

      // Pull the partner in too if they registered but aren't on the board yet.
      if (reg.partner_user_id && reg.partner_name) {
        if (!isNameUsed(reg.partner_name)) {
          const partnerReg = await db.prepare(`
            SELECT r.*, u.level
            FROM registrations r
            JOIN users u ON r.user_id = u.id
            WHERE r.event_id = ? AND r.user_id = ? AND r.status = 'registered'
          `).get(eventId, reg.partner_user_id);
          if (partnerReg) {
            state.players[reg.partner_name] = partnerReg.level;
            state.queue.push(reg.partner_name);
            linkPair(name, reg.partner_name, !!reg.sticky_pair);
          }
        } else {
          // Partner already on the board — just link them.
          linkPair(name, reg.partner_name, !!reg.sticky_pair);
        }
      }

      broadcast();
      socket.emit('auto_join_success', { name, partner: reg.partner_name || null });
    });

    socket.on('set_player_level', ({ name, level }) => {
      if (!socket.isAdmin) return;
      name = sanitize(name);
      if (!name || !LEVELS.includes(level)) return;
      if (state.players[name] === undefined) return;
      state.players[name] = level;
      broadcast();
    });

    // ── Training module ──────────────────────────────────
    // Admin moves a player from the queue into a half-hour training slot.
    // Pair binding is preserved (training is a temporary holding bucket, like on-deck).
    socket.on('start_training', ({ slot, name }) => {
      if (!socket.isAdmin) return;
      slot = Number(slot);
      name = sanitize(name);
      if (!name) return;
      if (!Number.isInteger(slot) || slot < 0 || slot >= TRAINING_SLOT_COUNT) return;
      if (!state.queue.includes(name)) return;
      if (state.training.slots[slot].length >= TRAINING_MAX_PER_SLOT) return;
      state.queue = state.queue.filter(n => n !== name);
      state.training.slots[slot].push(name);
      stampTrainingStart(slot); // countdown starts when the slot first fills
      broadcast();
    });

    // Admin manually returns a player from a training slot to the front of the queue.
    socket.on('end_training', ({ slot, name }) => {
      if (!socket.isAdmin) return;
      slot = Number(slot);
      name = sanitize(name);
      if (!name) return;
      if (!Number.isInteger(slot) || slot < 0 || slot >= TRAINING_SLOT_COUNT) return;
      const arr = state.training.slots[slot];
      if (!arr.includes(name)) return;
      state.training.slots[slot] = arr.filter(n => n !== name);
      clearTrainingStartIfEmpty(slot); // reset countdown if nobody is left
      state.queue = [name, ...state.queue]; // pair binding preserved
      broadcast();
    });

    // Client timer expiry requested the auto-return of a training player.
    // Validated server-side: only succeeds if the player is still in that slot.
    // (The server-side expiry sweep in expireTrainingSlots() is authoritative;
    // this handler just makes the return feel instant when a board is open.)
    socket.on('training_auto_return', ({ slot, name }) => {
      slot = Number(slot);
      name = sanitize(name);
      if (!name) return;
      if (!Number.isInteger(slot) || slot < 0 || slot >= TRAINING_SLOT_COUNT) return;
      const arr = state.training.slots[slot];
      if (!arr.includes(name)) return; // already returned / moved by admin — ignore
      state.training.slots[slot] = arr.filter(n => n !== name);
      clearTrainingStartIfEmpty(slot);
      state.queue = [name, ...state.queue]; // pair binding preserved
      broadcast();
    });
  });
}

// ── Module-level bootstrap ─────────────────────────────
loadState();

// Flush the latest state on shutdown (Render sends SIGTERM on deploy/restart).
let shuttingDown = false;
function gracefulExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveNow();
  process.exit(0);
}
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);

module.exports = { initRealtime, state, broadcast };
