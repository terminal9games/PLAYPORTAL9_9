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

async function sync(uid, d7, run, now, body) {
  if (now < run.start) return { wait: true, startsAt: run.start };
  if (now >= run.mazeEnd) return { ended: true };
  const c = run.cfg, rid = d7.room, room = run.rooms && run.rooms[rid];
  if (!room) return { ended: true };
  const m = D7.roomMaze(c, room.k);
  const snap = (await db.ref('rooms7/' + rid).get()).val() || {}, mem = snap.m || {}, P = snap.p || {};
  const me = mem[uid], prev = P[uid];
  if (!me || !prev) return { ended: true };
  if (prev.gone) return { ended: true };
  const role = me.role;
  // ---- where am I? (speed, walls and the safe zone are checked here) ----
  let x = Number(body.x), y = Number(body.y), fix = false;
  const dt = Math.min(2.5, Math.max(0, (now - (prev.at || now)) / 1000)), lim = D7.MAX_CELLS_PER_S * dt + 1.2;
  const unlocked = role === 'hunter' && (prev.kills || 0) >= c.exitKills;   // enough catches: the exit area is open to this hunter
  const blockedFor = cell => { const z = D7.zoneOf(m, c, cell); return role === 'hunter' && (z === 'S' || (z === 'E' && !unlocked)); };
  const bad = !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= m.n || y >= m.n || m.grid[cellOf(m, x, y)] === 1
    || Math.hypot(x - prev.x, y - prev.y) > lim || blockedFor(cellOf(m, x, y));
  if (bad) { x = prev.x; y = prev.y; fix = true; }
  const out = { fix, role, left: run.mazeEnd - now };
  // ---- survivors: the exit ----
  if (role === 'survivor' && !fix && cellOf(m, x, y) === m.exit) {
    await db.ref().update({ [`rooms7/${rid}/p/${uid}/gone`]: true, [`d7/${uid}/state`]: 'rope', [`d7/${uid}/escAt`]: now });
    await db.ref('d7meta/esc').transaction(v => (v || 0) + 1);
    return { escaped: true };
  }
  // ---- hunters with enough catches may leave through the exit ----
  if (role === 'hunter' && !fix && unlocked && cellOf(m, x, y) === m.exit) {
    await db.ref().update({ [`rooms7/${rid}/p/${uid}/gone`]: true, [`d7/${uid}/state`]: 'rope', [`d7/${uid}/escAt`]: now });
    return { escaped: true };
  }
  const up = {}; let kills = prev.kills || 0, tp = null, killed = [];
  // ---- hunters: no camping in or near the start or the exit, then attacks ----
  if (role === 'hunter') {
    const cell = cellOf(m, x, y), ring = D7.nearZone(m, c, cell) || D7.zoneOf(m, c, cell);
    if (ring) { if (!prev.ringAt) up.ringAt = now; else if (now - prev.ringAt > 8000) { tp = pickTeleport(m, c, P, mem); up.ringAt = null; } }
    else if (prev.ringAt) up.ringAt = null;
    const claims = [...new Set((Array.isArray(body.atk) ? body.atk : []).map(Number).filter(Number.isInteger))].slice(0, 3);
    if (claims.length && now - (prev.atk || 0) >= D7.ATK_COOLDOWN) {
      for (const idx of claims) {
        const tuid = survivorsIn(mem).find(u => mem[u].i === idx), t = tuid && P[tuid];
        // survivors in the start or exit zone cannot be hunted; a hunted survivor goes back to the start (a 4 s shield stops a second hit)
        if (!t || t.gone || (t.inv || 0) > now || Math.hypot(x - t.x, y - t.y) > D7.HIT || D7.zoneOf(m, c, cellOf(m, t.x, t.y))) continue;
        const tx = await db.ref(`rooms7/${rid}/p/${tuid}`).transaction(cur => (!cur || cur.gone || (cur.inv || 0) > now) ? undefined : { ...cur, x: D7.cellXY(m.n, m.start).x, y: D7.cellXY(m.n, m.start).y, at: now, inv: now + D7.SPAWN_SHIELD, deaths: (cur.deaths || 0) + 1 });
        if (!tx.committed) continue;
        kills++; killed.push(idx); up.atk = now; t.inv = now + D7.SPAWN_SHIELD;
        tp = pickTeleport(m, c, P, mem); up.ringAt = null;   // every catch sends the hunter somewhere else
      }
    }
  }
  if (tp) { x = tp.x; y = tp.y; out.tp = true; }
  Object.assign(up, { x, y, at: now, kills });
  await db.ref(`rooms7/${rid}/p/${uid}`).update(up);
  const mine = P[uid];
  out.me = { x, y, inv: mine.inv || 0, deaths: mine.deaths || 0, kills };
  out.killed = killed;
  out.others = Object.keys(mem).filter(u => u !== uid && P[u] && !P[u].gone && Math.hypot(P[u].x - x, P[u].y - y) <= D7.SEE)
    .map(u => ({ i: mem[u].i, r: mem[u].role === 'hunter' ? 'h' : 's', x: P[u].x, y: P[u].y, s: (P[u].inv || 0) > now ? 1 : 0 }));
  const surv = survivorsIn(mem);
  out.esc = surv.filter(u => P[u] && P[u].gone).length; out.total = surv.length;
  return out;
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
module.exports = { sync, spec };
