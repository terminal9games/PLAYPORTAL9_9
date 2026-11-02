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

// ---- Day 5: The Traitor ----
// Groups of players, one secret traitor per group. Each round has a discussion (chat) and a vote.
// The player with the most votes is expelled (a tie expels nobody). Rounds are resolved from the clock,
// by whichever request arrives first after a round ends, so no scheduled task is needed.
const label5 = i => 'Agent ' + String.fromCharCode(65 + i);

function phase5(cfg, now) {
  const D = cfg.discuss * 60000, V = cfg.vote * 60000, L = D + V;
  if (now < cfg.start) return { state: 'lobby', round: 0, endsAt: cfg.start };
  const t = now - cfg.start, r = Math.floor(t / L);
  if (r >= cfg.rounds) return { state: 'over', round: cfg.rounds - 1, endsAt: cfg.start + cfg.rounds * L };
  return t - r * L < D
    ? { state: 'discuss', round: r, endsAt: cfg.start + r * L + D }
    : { state: 'vote', round: r, endsAt: cfg.start + (r + 1) * L };
}

async function applyRound5(gid, g, k, cfg) {
  const members = g.members, out = g.out || {}, traitor = g.traitor;
  const byIdx = {};
  for (const u of Object.keys(members)) byIdx[members[u]] = u;
  const alive = Object.keys(members).filter(u => !(u in out));
  const votes = (g.votes && g.votes['r' + k]) || {};
  const tally = {};
  for (const v of Object.keys(votes)) {
    const t = byIdx[votes[v]];
    if (alive.includes(v) && t && alive.includes(t) && t !== v) tally[t] = (tally[t] || 0) + 1;
  }
  let best = 0, top = [];
  for (const u of Object.keys(tally)) {
    if (tally[u] > best) { best = tally[u]; top = [u]; } else if (tally[u] === best) top.push(u);
  }
  const expelled = top.length === 1 ? top[0] : null;
  const up = {}, msgs = [];
  let result = null;
  if (expelled) {
    const l = label5(members[expelled]);
    up[`groups/day5/${gid}/out/${expelled}`] = k;
    if (expelled === traitor) { msgs.push(`${l} was expelled, and ${l} WAS the traitor!`); result = 'crew'; }
    else {
      msgs.push(`${l} was expelled, but ${l} was NOT the traitor.`);
      up[`players/${expelled}/status`] = 'eliminated'; up[`players/${expelled}/eliminated_day`] = 5;
      up[`players/${expelled}/reveal`] = { day: 5, ok: false, expelled: true, mine: l };
    }
  } else msgs.push(top.length > 1 ? 'Tie: nobody was expelled.' : 'Nobody got enough votes: nobody was expelled.');
  const left = alive.filter(u => u !== expelled);
  if (!result && left.length <= 2) { result = 'traitor'; msgs.push('Only two players are left: the traitor wins.'); }
  if (!result && k >= cfg.rounds - 1) { result = 'traitor'; msgs.push('Time is up and the traitor is still among you.'); }
  if (result) {
    const tl = label5(members[traitor]);
    const finals = result === 'crew' ? [...left, traitor] : left;   // the expelled traitor is judged too
    for (const u of finals) {
      const isT = u === traitor, ok = result === 'traitor' ? isT : !isT;
      up[`players/${u}/reveal`] = { day: 5, ok, role: isT ? 'traitor' : 'crew', traitor: tl, mine: label5(members[u]) };
      if (ok) up[`players/${u}/current_day`] = 6;
      else { up[`players/${u}/status`] = 'eliminated'; up[`players/${u}/eliminated_day`] = 5; }
    }
    up[`groups/day5/${gid}/result`] = result;
  }
  await db.ref().update(up);
  for (const t of msgs) await db.ref('chats/day5/' + gid).push({ s: -1, t, ts: Date.now() });
}

// Resolves every round of this group that has already ended. Safe to call from many requests at once.
async function resolveGroup5(gid, cfg, now) {
  if (!cfg || !cfg.start || !gid) return;
  const L = (cfg.discuss + cfg.vote) * 60000;
  const done = now < cfg.start ? 0 : Math.min(cfg.rounds, Math.floor((now - cfg.start) / L));
  for (;;) {
    const gref = db.ref('groups/day5/' + gid);
    const g = (await gref.get()).val();
    if (!g || g.result) return;
    const k = g.resolved || 0;
    if (k >= done) return;
    // Only the request that moves "resolved" from k to k+1 applies round k
    const tx = await gref.child('resolved').transaction(cur => (cur == null || cur === k ? k + 1 : undefined));
    if (!tx.committed) return;
    await applyRound5(gid, g, k, cfg);
  }
}
async function resolveAll5(now) {
  const cfg = (await db.ref('config/day5').get()).val();
  if (!cfg) return;
  const groups = (await db.ref('groups/day5').get()).val() || {};
  for (const gid of Object.keys(groups)) await resolveGroup5(gid, cfg, now);
}

// Closes a day: everyone who did not complete it is eliminated; days with a ranking resolve it here.
async function closeDay(day) {
  if (day === 5) await resolveAll5(Date.now());
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
module.exports = { admin, db, sign, verify, maintain, closeNow, phase5, label5, resolveGroup5 };
