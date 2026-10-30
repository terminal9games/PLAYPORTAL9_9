const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL
  });
}
const db = admin.database();

const mac = s => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(s).digest('base64url');
const sign = uid => {
  const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 2 * 864e5 })).toString('base64url');
  return p + '.' + mac(p);
};
const verify = t => {
  try {
    const [p, m] = String(t).split('.');
    const a = Buffer.from(mac(p)), b = Buffer.from(m);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const s = JSON.parse(Buffer.from(p, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
};

// Closes a day: everyone who did not complete it is eliminated; days with a ranking resolve it here.
async function closeDay(day) {
  const players = (await db.ref('players').get()).val() || {};
  const up = {};
  const pending = Object.keys(players).filter(id => players[id].status === 'active' && players[id].current_day === day);
  const elim = (id, reveal) => {
    up[`players/${id}/status`] = 'eliminated'; up[`players/${id}/eliminated_day`] = day;
    if (reveal) up[`players/${id}/reveal`] = reveal;
  };
  const pass = (id, reveal) => {
    up[`players/${id}/current_day`] = day + 1;
    if (reveal) up[`players/${id}/reveal`] = reveal;
  };
  if (day === 2) {
    const pairs = (await db.ref('pairs/day2').get()).val() || {};
    for (const id of pending) {
      const p = players[id];
      if (p.pair === 'bye') { pass(id); continue; }
      const pr = pairs[p.pair];
      if (!pr) { elim(id); continue; }
      const slot = pr.a === id ? 'a' : 'b', other = slot === 'a' ? 'b' : 'a';
      const mine = pr['choice_' + slot], theirs = pr['choice_' + other];
      if (!mine) elim(id);
      else if (!theirs) pass(id, { day: 2, mine, theirs: null, ok: true });
      else if (theirs === 'share') pass(id, { day: 2, mine, theirs, ok: true });
      else elim(id, { day: 2, mine, theirs, ok: false });
    }
  } else if (day === 3) {
    const ch = (await db.ref('day3/choices').get()).val() || {};
    const voters = pending.filter(id => typeof ch[id] === 'number');
    pending.filter(id => !voters.includes(id)).forEach(id => elim(id));
    if (voters.length) {
      const avg = voters.reduce((s, id) => s + ch[id], 0) / voters.length;
      const target = 0.8 * avg;
      const ranked = voters.map(id => ({ id, d: Math.abs(ch[id] - target) })).sort((a, b) => a.d - b.d);
      const cutoff = ranked[Math.max(1, Math.ceil(0.6 * ranked.length)) - 1].d; // 60% closest, ties included
      for (const r of ranked) {
        const ok = r.d <= cutoff;
        const reveal = { day: 3, mine: ch[r.id], avg: +avg.toFixed(2), target: +target.toFixed(2), ok };
        if (ok) pass(r.id, reveal); else elim(r.id, reveal);
      }
    }
  } else pending.forEach(id => elim(id));
  if (Object.keys(up).length) await db.ref().update(up);
}

// Marks the day as closed exactly once; returns true only for the request that closed it.
async function closeOnce(day) {
  const r = await db.ref('config/closed_day').transaction(cur => (cur === day ? undefined : day));
  if (!r.committed) return false;
  await closeDay(day);
  return true;
}
// Runs on every request: if the deadline passed and the day is still open, close it.
async function maintain() {
  const c = (await db.ref('config').get()).val() || {};
  const day = c.active_day || 1;
  let closed = c.closed_day === day;
  if (!closed && c.ends_at && Date.now() > c.ends_at) closed = await closeOnce(day) || true;
  return { day, endsAt: c.ends_at || null, closed };
}
async function closeNow() {
  const day = ((await db.ref('config/active_day').get()).val()) || 1;
  return closeOnce(day);
}
module.exports = { admin, db, sign, verify, maintain, closeNow };
