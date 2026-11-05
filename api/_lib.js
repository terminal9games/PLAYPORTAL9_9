const admin = require('firebase-admin');
const crypto = require('crypto');
const D6 = require('./_d6');
const D7 = require('./_d7');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL
  });
}
const db = admin.database();

const mac = s => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(s).digest('base64url');
const sign = (uid, sid, adm) => {
  // adm = a token minted by the admin panel to play a test tab (6 hours); players can never get one
  const p = Buffer.from(JSON.stringify(adm ? { uid, sid, adm: true, exp: Date.now() + 6 * 36e5 } : { uid, sid, exp: Date.now() + 2 * 864e5 })).toString('base64url');
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


// ---- Security helpers ----
// IPs are never stored or shown: they are turned into a keyed hash that is only used for counting.
const ACTIVE_MS = 5 * 60000, MAX_PER_IP = 3;
const IP_MSG = 'Too many active players are currently playing from your IP address. Please ensure no more than 3 devices are connected from this network.';
const newId = () => 'T9-' + Array.from(crypto.randomBytes(8), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const ipKey = req => {
  const h = (req && req.headers) || {};
  const raw = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
  return raw ? crypto.createHmac('sha256', process.env.SESSION_SECRET).update('ip:' + raw).digest('base64url').slice(0, 20) : null;
};
// Registers "this player is active from this network" and says whether they fit (max 3 at once).
// The ones who connected first keep their place; the extra player is the one who is blocked.
async function ipTouch(ipk, uid, now) {
  const ref = db.ref('ips/' + ipk);
  const cur = (await ref.get()).val() || {};
  const me = cur[uid], alive = me && now - me.seen < ACTIVE_MS;
  const mine = { seen: now, since: alive ? me.since : now };
  const next = { ...cur, [uid]: mine };
  const act = Object.keys(next).filter(u => now - next[u].seen < ACTIVE_MS).sort((a, b) => next[a].since - next[b].since || (a < b ? -1 : 1));
  if (act.indexOf(uid) >= MAX_PER_IP) return false;
  if (!alive || now - me.seen > 20000) {
    const up = { [uid]: mine };
    for (const u of Object.keys(cur)) if (now - cur[u].seen > 3600000) up[u] = null;   // tidy old entries
    await ref.update(up);
  }
  return true;
}
// Failed logins: max 5 per minute per network.
async function rlBlocked(ipk, now) {
  const v = (await db.ref('rl/' + ipk).get()).val();
  return !!(v && now - v.t0 < 60000 && v.n >= 5);
}
async function rlFail(ipk, now) {
  await db.ref('rl/' + ipk).transaction(v => (v && now - v.t0 < 60000 ? { t0: v.t0, n: v.n + 1 } : { t0: now, n: 1 }));
}
// Security events for the admin panel. They hold an ID and a type, never an IP.
async function secLog(type, uid) {
  try { await db.ref('seclog').push({ t: Date.now(), type, uid: uid || null }); } catch (e) { console.error(e); }
}

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
  const testMode = !!(await db.ref('config/test_mode').get()).val();   // test mode: only test players take part
  const players = (await db.ref('players').get()).val() || {};
  const up = {};
  const pending = Object.keys(players).filter(id => players[id].status === 'active' && players[id].current_day === day && !!players[id].test === testMode);
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
  } else if (day === 1.5) {
    // Squid Game vote: more than 50% of the votes cast for CANCEL ends the tournament. Nobody is eliminated.
    // Players who did not vote do not count and move on with the rest.
    const votes = (await db.ref('d15/votes').get()).val() || {};
    let cont = 0, canc = 0;
    pending.forEach(id => { if (votes[id] === 'continue') cont++; else if (votes[id] === 'cancel') canc++; });
    const total = cont + canc, cancel = canc > cont;
    const pctC = total ? Math.round(100 * cont / total) : 100, pctX = total ? 100 - pctC : 0;
    for (const id of pending) {
      if (cancel) up[`players/${id}/reveal`] = { day: 1.5, result: 'cancel', pct: pctX };
      else { up[`players/${id}/current_day`] = 2; up[`players/${id}/reveal`] = { day: 1.5, result: 'continue', pct: pctC }; }
    }
    if (cancel) up['config/ended'] = { at: Date.now(), pct: pctX };
  } else if (day === 6) {
    // Ranking by the hidden "cold" score. config/day6: { cut: % of finishers to eliminate, side: 'cold' | 'warm' }
    const cfg = (await db.ref('config/day6').get()).val() || {};
    const all = (await db.ref('d6').get()).val() || {};
    const fin = pending.filter(id => all[id] && all[id].done);
    pending.filter(id => !fin.includes(id)).forEach(id => elim(id));   // never finished: eliminated
    const dir = cfg.side === 'warm' ? -1 : 1;                           // default: the coldest are eliminated
    const cut = Math.min(90, Math.max(0, Number(cfg.cut) || 40));
    const ranked = fin.map(id => ({ id, v: dir * (all[id].cold || 0) })).sort((a, b) => b.v - a.v);
    const nOut = Math.floor(ranked.length * cut / 100);
    const boundary = nOut < ranked.length ? ranked[nOut].v : -Infinity;   // ties at the boundary all stay
    ranked.forEach((r, i) => {
      const kept = D6.itemName((all[r.id].kept || [])[0]);
      const out = i < nOut && r.v > boundary;
      const reveal = { day: 6, ok: !out, kept };
      if (out) elim(r.id, reveal); else pass(r.id, reveal);
    });
  } else if (day === 7) {
    // Finishers are ranked by total time, everyone else by progress. The slowest cut% are eliminated;
    // nobody who never moved can pass.
    const cfg = D7.cfg((await db.ref('config/day7').get()).val());
    const all = (await db.ref('d7').get()).val() || {};
    const order = D7.rank(players, all, pending);
    const started = order.filter(id => all[id] && (all[id].done || all[id].prog > 0));
    const nOut = Math.floor(started.length * cfg.cut / 100);
    const keep = new Set(started.slice(0, started.length - nOut));
    order.forEach(id => { const ok = keep.has(id), reveal = { day: 7, ok, finished: !!(all[id] && all[id].done) }; if (ok) pass(id, reveal); else elim(id, reveal); });
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
  return { day, endsAt: c.ends_at || null, closed, ended: c.ended || null };
}
async function closeNow() {
  const day = ((await db.ref('config/active_day').get()).val()) || 1;
  return closeOnce(day);
}
module.exports = { admin, db, sign, verify, maintain, closeNow, phase5, label5, resolveGroup5, ipKey, ipTouch, rlBlocked, rlFail, secLog, newId, IP_MSG };
