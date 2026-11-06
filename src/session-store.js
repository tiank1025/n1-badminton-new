const session = require('express-session');

// A small store backed by the same SQLite/Postgres adapter as the application.
// This keeps login sessions available after a process restart and across app
// instances without adding another service or dependency.
class DatabaseSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.cleanupTimer = setInterval(() => {
      this.db.prepare('DELETE FROM app_sessions WHERE expire <= ?').run(Date.now())
        .catch(err => console.warn('Session cleanup failed:', err.message));
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  get(sid, callback) {
    this.db.prepare('SELECT sess, expire FROM app_sessions WHERE sid = ?').get(sid)
      .then(row => {
        if (!row) return callback(null, null);
        if (Number(row.expire) <= Date.now()) {
          this.destroy(sid, err => callback(err, null));
          return;
        }
        callback(null, JSON.parse(row.sess));
      })
      .catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    const cookieExpiry = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    const expire = Number.isFinite(cookieExpiry) ? cookieExpiry : Date.now() + Number(sess.cookie?.maxAge || 0);
    this.db.prepare(`
      INSERT INTO app_sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `).run(sid, JSON.stringify(sess), expire)
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    const cookieExpiry = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    const expire = Number.isFinite(cookieExpiry) ? cookieExpiry : Date.now() + Number(sess.cookie?.maxAge || 0);
    this.db.prepare('UPDATE app_sessions SET expire = ? WHERE sid = ?').run(expire, sid)
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.db.prepare('DELETE FROM app_sessions WHERE sid = ?').run(sid)
      .then(() => callback(null))
      .catch(callback);
  }
}

module.exports = { DatabaseSessionStore };
