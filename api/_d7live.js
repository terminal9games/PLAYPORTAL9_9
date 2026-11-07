// Day 7 live maze: every request is "here is where I am" and the answer is "here is who is near you".
// The server is the referee: it limits speed, blocks walls and the safe zone, decides kills and escapes,
// and teleports hunters. Nobody ever receives another player's ID, only a role and a number.
const { db } = require('./_lib');
const D7 = require('./_d7');

const cellOf = (m, x, y) => Math.floor(y) * m.n + Math.floor(x);
const survivorsIn = (mem) => Object.keys(mem).filter(u => mem[u].role === 'survivor');

function pickTeleport(m, c, P, mem) {
  const cells = D7.tpCells(m, c), alive = survivorsIn(mem).filter(u => P[u] && !P[u].gone);
  let best = null;
  for (let t = 0; t < 30 && cells.length; t++) {
    const p = D7.cellXY(m.n, cells[Math.floor(Math.random() * cells.length)]); best = p;
    if (alive.every(u => Math.hypot(P[u].x - p.x, P[u].y - p.y) > 14)) return p;   // not right next to a survivor
  }
  return best || D7.cellXY(m.n, m.start);
}

// ---- The catch duel: when a hunter presses CATCH next to a survivor, both are frozen and each gets 5 quick buttons ----
const QTE = { n: 5, win: 1300, first: 1500, lead: 1500, grace: 6000, keys: 'ASDFGHJKLQWERTYUIOPZXCVBNM', near: 2.6, press: 3.4 };
function makePrompts() {
  let at = QTE.first; const out = [];
  for (let i = 0; i < QTE.n; i++) {
    out.push({ k: QTE.keys[Math.floor(Math.random() * QTE.keys.length)], at, x: 22 + Math.floor(Math.random() * 56), y: 28 + Math.floor(Math.random() * 44) });
    at += QTE.win + 450 + Math.floor(Math.random() * 450);   // a short random pause between buttons
  }
  return out;
}
// perfect = every button pressed (the right key, or a tap) while its circle was still open
const perfect = (prompts, hits) => Array.isArray(hits) && hits.length === prompts.length && prompts.every((p, i) => {
  const h = hits[i]; return h && String(h.k).toUpperCase() === p.k && Number(h.ms) >= 120 && Number(h.ms) <= QTE.win;
});
const inRange = (a, b, r) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

// Applies the result of a duel once. Survivor perfect: survivor goes on. Otherwise hunter perfect: the survivor goes back
// to the start and the hunter is teleported. Neither perfect: nothing happens.
async function resolveDuel(rid, id, now, snap, c, m) {
  const tx = await db.ref(`rooms7/${rid}/duels/${id}/done`).transaction(v => (v ? undefined : now));
  if (!tx.committed) return;
  const d = (snap.duels || {})[id], P = snap.p || {}, mem = snap.m || {};
  if (!d) return;
  const sp = d.res && d.res.s && d.res.s.perfect, hp = d.res && d.res.h && d.res.h.perfect, outc = sp ? 'escape' : hp ? 'caught' : 'draw';
  const up = { [`rooms7/${rid}/duels/${id}/out`]: outc }, pp = (u, k, v) => { up[`rooms7/${rid}/p/${u}/${k}`] = v; };
  const start = D7.cellXY(m.n, m.start);
  pp(d.h, 'duel', null); pp(d.s, 'duel', null); pp(d.h, 'at', now); pp(d.s, 'at', now);
  pp(d.s, 'inv', now + D7.SPAWN_SHIELD); pp(d.h, 'cd', now + 3000);
  pp(d.s, 'dres', { id, out: outc, at: now }); pp(d.h, 'dres', { id, out: outc, at: now });
  if (outc === 'caught') {
    const tp = pickTeleport(m, c, P, mem);
    pp(d.s, 'x', start.x); pp(d.s, 'y', start.y); pp(d.s, 'deaths', ((P[d.s] || {}).deaths || 0) + 1);
    pp(d.h, 'x', tp.x); pp(d.h, 'y', tp.y); pp(d.h, 'kills', ((P[d.h] || {}).kills || 0) + 1); pp(d.h, 'ringAt', null);
    pp(d.h, 'dres', { id, out: 'caught', at: now, tp: true });
  }
  await db.ref().update(up);
}

async function sync(uid, d7, run, now, body) {
  if (now < run.start) return { wait: true, startsAt: run.start };
  if (now >= run.mazeEnd) return { ended: true };
  const c = run.cfg, rid = d7.room, room = run.rooms && run.rooms[rid];
  if (!room) return { ended: true };
  const m = D7.roomMaze(c, room.k);
  let snap = (await db.ref('rooms7/' + rid).get()).val() || {}, mem = snap.m || {}, P = snap.p || {};
  let me = mem[uid], prev = P[uid];
  if (!me || !prev) return { ended: true };
  if (prev.gone) return { ended: true };
  const role = me.role;
  // a duel nobody finished in time is settled here (a missing result counts as a failure)
  if (prev.duel) {
    const d = (snap.duels || {})[prev.duel];
    if (!d || d.done) await db.ref(`rooms7/${rid}/p/${uid}/duel`).remove();
    else if (now > d.deadline) await resolveDuel(rid, prev.duel, now, snap, c, m);
    if (!d || d.done || now > d.deadline) { snap = (await db.ref('rooms7/' + rid).get()).val() || {}; mem = snap.m || {}; P = snap.p || {}; prev = P[uid]; }
  }
  const common = () => {
    const surv = survivorsIn(mem), mine = P[uid] || prev;
    return { role, left: run.mazeEnd - now, esc: surv.filter(u => P[u] && P[u].gone).length, total: surv.length, dres: mine.dres || null,
      me: { x: mine.x, y: mine.y, inv: mine.inv || 0, deaths: mine.deaths || 0, kills: mine.kills || 0 },
      others: Object.keys(mem).filter(u => u !== uid && P[u] && !P[u].gone && Math.hypot(P[u].x - mine.x, P[u].y - mine.y) <= D7.SEE)
        .map(u => ({ i: mem[u].i, r: mem[u].role === 'hunter' ? 'h' : 's', x: P[u].x, y: P[u].y, s: (P[u].inv || 0) > now ? 1 : 0 })) };
  };
  // ---- frozen in a duel: no movement at all until it is settled ----
  if (prev.duel) {
    const d = snap.duels[prev.duel], mine = role === 'hunter' ? 'h' : 's';
    await db.ref(`rooms7/${rid}/p/${uid}/at`).set(now);
    return { ...common(), fix: true, duel: { id: prev.duel, start: d.start, win: QTE.win, role: mine, prompts: d.p[mine], submitted: !!(d.res && d.res[mine]) } };
  }
  // ---- where am I? (speed, walls and the safe zones are checked here) ----
  let x = Number(body.x), y = Number(body.y), fix = false;
  const dt = Math.min(2.5, Math.max(0, (now - (prev.at || now)) / 1000)), lim = D7.MAX_CELLS_PER_S * dt + 1.2;
  const unlocked = role === 'hunter' && (prev.kills || 0) >= c.exitKills;   // enough catches: the exit area is open to this hunter
  const blockedFor = cell => { const z = D7.zoneOf(m, c, cell); return role === 'hunter' && (z === 'S' || (z === 'E' && !unlocked)); };
  const bad = !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= m.n || y >= m.n || m.grid[cellOf(m, x, y)] === 1
    || Math.hypot(x - prev.x, y - prev.y) > lim || blockedFor(cellOf(m, x, y));
  if (bad) { x = prev.x; y = prev.y; fix = true; }
  // ---- the exit ----
  if (!fix && cellOf(m, x, y) === m.exit && (role === 'survivor' || unlocked)) {
    await db.ref().update({ [`rooms7/${rid}/p/${uid}/gone`]: true, [`d7/${uid}/state`]: 'rope', [`d7/${uid}/escAt`]: now });
    if (role === 'survivor') await db.ref('d7meta/esc').transaction(v => (v || 0) + 1);
    return { escaped: true };
  }
  const up = {}; let tp = null;
  // ---- hunters: no camping in or near the start or the exit ----
  if (role === 'hunter') {
    const cell = cellOf(m, x, y), ring = D7.nearZone(m, c, cell) || D7.zoneOf(m, c, cell);
    if (ring) { if (!prev.ringAt) up.ringAt = now; else if (now - prev.ringAt > 8000) { tp = pickTeleport(m, c, P, mem); up.ringAt = null; } }
    else if (prev.ringAt) up.ringAt = null;
  }
  if (tp) { x = tp.x; y = tp.y; }
  Object.assign(up, { x, y, at: now });
  await db.ref(`rooms7/${rid}/p/${uid}`).update(up);
  P[uid] = { ...prev, ...up };
  const out = { ...common(), fix, tp: !!tp };
  // ---- hunters: who can be caught right now? (the CATCH button shows only while this list is not empty) ----
  if (role === 'hunter' && (prev.cd || 0) <= now) out.near = survivorsIn(mem).filter(u => P[u] && !P[u].gone && !P[u].duel && (P[u].inv || 0) <= now
    && Math.hypot(P[u].x - x, P[u].y - y) <= QTE.near && !D7.zoneOf(m, c, cellOf(m, P[u].x, P[u].y))).map(u => mem[u].i);
  return out;
}

// The hunter presses CATCH. Both players freeze and the 5 buttons start 1.5 s later.
async function duelStart(uid, d7, run, now, body) {
  if (now < run.start || now >= run.mazeEnd || d7.role !== 'hunter') return { err: 'no' };
  const c = run.cfg, rid = d7.room, room = run.rooms && run.rooms[rid]; if (!room) return { err: 'no' };
  const m = D7.roomMaze(c, room.k), snap = (await db.ref('rooms7/' + rid).get()).val() || {}, mem = snap.m || {}, P = snap.p || {}, h = P[uid];
  if (!h || h.gone || h.duel || (h.cd || 0) > now) return { err: 'busy' };
  const tuid = survivorsIn(mem).find(u => mem[u].i === Number(body.target)), t = tuid && P[tuid];
  if (!t || t.gone || t.duel || (t.inv || 0) > now || !inRange(h, t, QTE.press) || D7.zoneOf(m, c, cellOf(m, t.x, t.y))) return { err: 'far' };
  const id = 'd' + now.toString(36) + Math.random().toString(36).slice(2, 5);
  // the survivor is claimed first, so two hunters cannot catch the same survivor
  const tx = await db.ref(`rooms7/${rid}/p/${tuid}/duel`).transaction(cur => (cur ? undefined : id));
  if (!tx.committed) return { err: 'busy' };
  const prompts = { h: makePrompts(), s: makePrompts() }, start = now + QTE.lead, last = prompts.h[QTE.n - 1].at > prompts.s[QTE.n - 1].at ? prompts.h[QTE.n - 1].at : prompts.s[QTE.n - 1].at;
  await db.ref().update({ [`rooms7/${rid}/duels/${id}`]: { h: uid, s: tuid, start, p: prompts, deadline: start + last + QTE.win + QTE.grace }, [`rooms7/${rid}/p/${uid}/duel`]: id });
  return { ok: true };
}

// A player reports how they did on their 5 buttons. When both have reported, the duel is settled.
async function duelResult(uid, d7, run, now, body) {
  const c = run.cfg, rid = d7.room, room = run.rooms && run.rooms[rid]; if (!room || now >= run.mazeEnd) return { err: 'no' };
  const m = D7.roomMaze(c, room.k), snap = (await db.ref('rooms7/' + rid).get()).val() || {}, d = (snap.duels || {})[body.id];
  if (!d || d.done || (d.h !== uid && d.s !== uid)) return { err: 'no' };
  const mine = d.h === uid ? 'h' : 's';
  if (d.res && d.res[mine]) return { ok: true };
  const prompts = d.p[mine], ok = now >= d.start + prompts[prompts.length - 1].at + 120 && perfect(prompts, body.hits);   // cannot be reported before the last button even appeared
  await db.ref(`rooms7/${rid}/duels/${body.id}/res/${mine}`).set({ perfect: !!ok, at: now });
  const res = { ...(d.res || {}), [mine]: { perfect: !!ok } };
  if (res.h && res.s) { d.res = res; snap.duels[body.id] = d; await resolveDuel(rid, body.id, now, snap, c, m); }
  return { ok: true };
}

// The player who had no team (an odd count) watches every room: roles and numbers only.
async function spec(uid, d7, run, now, body) {
  if (now < run.start) return { wait: true, startsAt: run.start };
  if (now >= run.mazeEnd) return { ended: true };
  const ids = Object.keys(run.rooms || {});
  if (!ids.length) return { ended: true };
  const rid = ids.includes(body.room) ? body.room : ids[0], room = run.rooms[rid], c = run.cfg;
  const snap = (await db.ref('rooms7/' + rid).get()).val() || {}, mem = snap.m || {}, P = snap.p || {};
  const out = { room: rid, rooms: ids.map((r, k) => ({ id: r, label: 'Room ' + (k + 1) })), left: run.mazeEnd - now };
  if (body.wantMaze) out.maze = D7.wire(D7.roomMaze(c, room.k), c);
  out.players = Object.keys(mem).filter(u => P[u] && !P[u].gone).map(u => ({ i: mem[u].i, r: mem[u].role === 'hunter' ? 'h' : 's', x: P[u].x, y: P[u].y, s: (P[u].inv || 0) > now ? 1 : 0, k: P[u].kills || 0, d: P[u].deaths || 0 }));
  const surv = survivorsIn(mem); out.esc = surv.filter(u => P[u] && P[u].gone).length; out.total = surv.length;
  return out;
}
module.exports = { sync, spec, duelStart, duelResult, QTE };
