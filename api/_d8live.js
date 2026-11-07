// Day 8 live room. Everything that changes the game lives in one record, rooms8/st, and every change is a transaction on it,
// so two requests can never apply the same event twice. The clock is the server's.
const { db } = require('./_lib');
const D8 = require('./_d8');

const clone = o => JSON.parse(JSON.stringify(o));
const rnd = (a, b) => a + Math.random() * (b - a);
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10007) / 10007; };
const lab = (ctx, u) => 'P' + ctx.code[u];

// ---------------------------------------------------------------------------------------------
// The state machine. Returns the next state, or null when nothing changed.
// ctx: { cfg, alive: [uids still in the final], code: {uid: n}, pos: {uid: {x, y}}, bots: Set, room }
// ---------------------------------------------------------------------------------------------
function step(st0, now, ctx) {
  const st = clone(st0), C = ctx.cfg; let ch = false;
  st.dead = st.dead || {}; st.feed = st.feed || {};
  const aliveNow = () => ctx.alive.filter(u => !st.dead[u]);
  const feed = text => {
    st.seq = (st.seq || 0) + 1; st.feed['f' + st.seq] = { t: text, at: now };
    const ks = Object.keys(st.feed).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    ks.slice(0, Math.max(0, ks.length - 8)).forEach(k => delete st.feed[k]);
    ch = true;
  };
  const sudden = now > ctx.suddenAt;
  const wheelGap = () => (sudden ? rnd(15, 25) : rnd(C.wheelMin, C.wheelMax)) * 1000;
  const knifeGap = () => rnd(C.knifeMin, C.knifeMax) * 1000;
  if (st.over) return null;
  if (!st.wheelAt) { st.wheelAt = now + wheelGap(); st.knifeAt = now + knifeGap(); ch = true; }

  // ---- the duel ----
  const d = st.duel;
  if (d) {
    d.shots = d.shots || {};
    if (!d.res) {
      // bots answer on their own: a reaction time, and sometimes they jump the gun
      for (const k of ['a', 'b']) {
        const u = d[k]; if (!ctx.bots.has(u) || d.shots[k]) continue;
        const h = hash(u + ':' + (st.seq || 0)), early = h < 0.07, ms = Math.round(210 + hash(u + 'x' + d.greenAt) * 520);
        if (early && now >= d.greenAt - 350) { d.shots[k] = { early: true, at: now }; ch = true; }
        else if (!early && now >= d.greenAt + ms) { d.shots[k] = { ms, at: now }; ch = true; }
      }
      const sh = d.shots, A = sh.a, B = sh.b, tmo = d.greenAt + C.shootMs + 700;
      let win = null, lose = null, why = null;
      const early = ['a', 'b'].filter(k => sh[k] && sh[k].early).sort((x, y) => sh[x].at - sh[y].at)[0];
      if (early) { lose = early; win = early === 'a' ? 'b' : 'a'; why = 'early'; }
      else if (A && B) { const aw = A.ms < B.ms || (A.ms === B.ms && A.at <= B.at); win = aw ? 'a' : 'b'; lose = aw ? 'b' : 'a'; why = 'late'; }
      else if ((A || B) && now >= Math.min(tmo, d.greenAt + (A || B).ms + 600)) { win = A ? 'a' : 'b'; lose = A ? 'b' : 'a'; why = 'late'; }
      else if (!A && !B && now >= tmo) why = 'none';
      if (why) {
        d.res = { win: win ? d[win] : null, lose: lose ? d[lose] : null, why, ms: { a: A && A.ms || null, b: B && B.ms || null }, at: now, until: now + D8.RESULT_MS };
        if (lose) { st.dead[d[lose]] = now; feed(lab(ctx, d[lose]) + " Couldn't make it longer"); }
        else feed('Nobody fired. Both survive.');
        st.duels = (st.duels || 0) + 1;
        ch = true;
      }
    } else if (now >= d.res.until) { st.duel = null; st.wheelAt = now + wheelGap(); ch = true; }
  }

  const alive = aliveNow();
  const dueling = st.duel ? new Set([st.duel.a, st.duel.b]) : new Set();
  // ---- the knife ----
  if (st.knife) {
    const k = st.knife;
    if (!k.holder) {
      let best = null, bd = D8.PICK_RANGE;
      for (const u of alive) { if (dueling.has(u) || !ctx.pos[u]) continue; const dd = Math.hypot(ctx.pos[u].x - k.x, ctx.pos[u].y - k.y); if (dd <= bd) { bd = dd; best = u; } }
      if (best) { k.holder = best; k.until = now + C.knifeSec * 1000; feed(lab(ctx, best) + ' picked up the knife'); }
    } else if (st.dead[k.holder]) { st.knife = null; st.knifeAt = now + knifeGap(); ch = true; }
    else if (now > k.until) { feed(lab(ctx, k.holder) + ' let the knife go'); st.knife = null; st.knifeAt = now + knifeGap(); }
    else if (ctx.bots.has(k.holder) && !dueling.has(k.holder) && ctx.pos[k.holder]) {   // a bot with a knife uses it on whoever is close
      const me = ctx.pos[k.holder], tg = alive.filter(u => u !== k.holder && !dueling.has(u) && ctx.pos[u] && Math.hypot(ctx.pos[u].x - me.x, ctx.pos[u].y - me.y) <= D8.STAB_RANGE)[0];
      if (tg && hash(k.holder + now) < 0.7) { st.dead[tg] = now; st.stabs = (st.stabs || 0) + 1; feed(lab(ctx, tg) + ' was stabbed'); st.knife = null; st.knifeAt = now + knifeGap(); }
    }
  } else if (!st.duel && !sudden && now >= st.knifeAt && alive.length >= 3) {
    const spots = ctx.room.open.filter(c => { const p = D8.cellXY(ctx.room.n, c); return alive.every(u => !ctx.pos[u] || Math.hypot(ctx.pos[u].x - p.x, ctx.pos[u].y - p.y) > 3); });
    const c = (spots.length ? spots : ctx.room.open)[Math.floor(Math.random() * (spots.length || ctx.room.open.length))], p = D8.cellXY(ctx.room.n, c);
    st.knife = { x: p.x, y: p.y, holder: null }; feed('A knife appeared in the room'); ch = true;
  }
  // ---- the wheel ----
  const a2 = aliveNow();
  if (!st.duel && !(st.knife && st.knife.holder) && now >= st.wheelAt && a2.length >= 2) {
    const o = a2.slice().sort(() => Math.random() - 0.5);
    st.duel = { a: o[0], b: o[1], spinEnd: now + D8.WHEEL_SPIN, greenAt: now + D8.WHEEL_SPIN + D8.LIGHTS_FADE + Math.round(rnd(C.drawMin, C.drawMax) * 1000), shots: {} };
    feed('The wheel is spinning');
  }
  // ---- the end ----
  if (!st.duel && aliveNow().length <= 1 && !st.over) { st.over = now; st.winner = aliveNow()[0] || null; ch = true; }
  return ch ? st : null;
}

// ---------------------------------------------------------------------------------------------
async function load(run) {
  const snap = (await db.ref('rooms8').get()).val() || {};
  const m = snap.m || {}, P = snap.p || {}, st = snap.st || null;
  const code = {}; Object.keys(m).forEach(u => { code[u] = m[u].c; });
  const room = D8.room(run.cfg.size);
  return { m, P, st, code, room };
}
const mkCtx = (run, L) => ({ cfg: run.cfg, alive: Object.keys(L.m), code: L.code, pos: L.P, room: L.room, bots: new Set(Object.keys(L.m).filter(u => L.m[u].bot)), suddenAt: run.start + run.cfg.maxMin * 60000 });

// When a player is out of the final their account is marked eliminated; when the last one is left, the winner is set.
async function reconcile(run, st, L) {
  const up = {};
  Object.keys(st.dead || {}).forEach(u => { up[`players/${u}/status`] = 'eliminated'; up[`players/${u}/eliminated_day`] = 8; });
  if (st.over && st.winner) {
    up[`players/${st.winner}/status`] = 'winner';
    const isTest = (await db.ref(`players/${st.winner}/test`).get()).val();
    if (!isTest) up['config/winner_uid'] = st.winner;   // from now on nobody can log in (see winnerLocked)
  }
  if (Object.keys(up).length) await db.ref().update(up);
}

// Moves the bots (test players the admin marked as bots) a little and applies whatever is due.
async function advance(now, run) {
  const L = await load(run); if (!L.st) return L;
  const ctx = mkCtx(run, L);
  const dueling = L.st.duel ? new Set([L.st.duel.a, L.st.duel.b]) : new Set();
  const up = {};
  for (const u of ctx.alive) {
    if (!ctx.bots.has(u) || (L.st.dead || {})[u] || dueling.has(u)) continue;
    const p = L.P[u]; if (!p) continue;
    const dt = Math.min(1.2, Math.max(0, (now - (p.at || now)) / 1000));
    if (dt < 0.15) continue;
    let g = p.g;
    const hold = L.st.knife && L.st.knife.holder === u;
    const others = ctx.alive.filter(o => o !== u && !(L.st.dead || {})[o] && L.P[o]);
    if (hold && others.length) { const t = others.sort((a, b) => Math.hypot(L.P[a].x - p.x, L.P[a].y - p.y) - Math.hypot(L.P[b].x - p.x, L.P[b].y - p.y))[0]; g = { x: L.P[t].x, y: L.P[t].y }; }
    else if (L.st.knife && !L.st.knife.holder && hash(u + 'k') < 0.5) g = { x: L.st.knife.x, y: L.st.knife.y };
    else if (!g || Math.hypot(g.x - p.x, g.y - p.y) < 0.6 || hash(u + Math.floor(now / 5000)) < 0.1) { const c = L.room.open[Math.floor(Math.random() * L.room.open.length)]; g = D8.cellXY(L.room.n, c); }
    let x = p.x, y = p.y; const dx = g.x - x, dy = g.y - y, l = Math.hypot(dx, dy) || 1, sp = 3.2 * dt;
    const nx = x + dx / l * sp, ny = y + dy / l * sp;
    if (!D8.blocked(L.room, nx, y)) x = nx; if (!D8.blocked(L.room, x, ny)) y = ny;
    if (x === p.x && y === p.y) g = null;   // stuck behind the table: pick another goal next time
    L.P[u] = { ...p, x, y, at: now, g }; up[`rooms8/p/${u}`] = L.P[u];
  }
  if (Object.keys(up).length) await db.ref().update(up);
  const before = L.st;
  let nxt = null;
  const tx = await db.ref('rooms8/st').transaction(cur => { if (!cur) return cur; nxt = step(cur, now, ctx); return nxt || undefined; });
  if (tx.committed && nxt) { L.st = nxt; await reconcile(run, nxt, L); }
  else L.st = before;
  return L;
}

const view = (uid, L, now, run) => {
  const st = L.st, code = L.code, dead = !!(st.dead && st.dead[uid]);
  const d = st.duel, me = L.P[uid] || {};
  const shown = u => !(st.dead || {})[u] || !!(st.duel && st.duel.res && st.duel.res.lose === u);   // the player who just lost stays visible while the result is shown
  const players = Object.keys(L.m).filter(u => u !== uid && shown(u) && L.P[u]).map(u => ({ c: code[u], x: L.P[u].x, y: L.P[u].y }));
  const k = st.knife ? { x: st.knife.x, y: st.knife.y, h: st.knife.holder ? code[st.knife.holder] : null, until: st.knife.until || 0, mine: st.knife.holder === uid } : null;
  let duel = null;
  if (d) {
    const slot = d.a === uid ? 'a' : d.b === uid ? 'b' : null;
    duel = { a: code[d.a], b: code[d.b], spinEnd: d.spinEnd, greenAt: d.greenAt, slot, shot: !!(slot && d.shots && d.shots[slot]) };
    if (d.res) duel.res = { win: d.res.win ? code[d.res.win] : null, lose: d.res.lose ? code[d.res.lose] : null, why: d.res.why, ms: d.res.ms, until: d.res.until };
  }
  const feed = Object.keys(st.feed || {}).map(key => ({ id: Number(key.slice(1)), t: st.feed[key].t })).sort((a, b) => a.id - b.id);
  const aliveN = Object.keys(L.m).filter(u => !(st.dead || {})[u]).length;
  return { me: { c: code[uid], x: me.x, y: me.y, dead }, players, knife: k, duel, feed, alive: aliveN, total: Object.keys(L.m).length, over: !!st.over, winner: st.winner ? code[st.winner] : null, left: Math.max(0, run.cfg.maxMin * 60000 - (now - run.start)) };
};

// The player says where they are. The server checks speed and walls, and freezes duelists.
async function sync(uid, run, now, body) {
  if (now < run.start) return { wait: true, startsAt: run.start };
  const L = await advance(now, run); if (!L.st) return { wait: true, startsAt: run.start };
  const st = L.st, p = L.P[uid]; if (!L.m[uid] || !p) return { ended: true };
  const dead = !!(st.dead && st.dead[uid]), inDuel = !!(st.duel && (st.duel.a === uid || st.duel.b === uid));
  let fix = false;
  if (!dead && !inDuel && !st.over) {
    let x = Number(body.x), y = Number(body.y);
    const dt = Math.min(2.5, Math.max(0, (now - (p.at || now)) / 1000)), lim = D8.SPEED * dt + 1.2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || D8.blocked(L.room, x, y) || Math.hypot(x - p.x, y - p.y) > lim) { x = p.x; y = p.y; fix = true; }
    L.P[uid] = { x, y, at: now }; await db.ref(`rooms8/p/${uid}`).set(L.P[uid]);
  } else if (inDuel) fix = true;
  return { ...view(uid, L, now, run), fix, frozen: inDuel };
}

// A duelist presses the button.
async function shoot(uid, run, now, body) {
  const C = run.cfg; let out = { ok: false };
  await db.ref('rooms8/st').transaction(cur => {
    if (!cur || !cur.duel || cur.duel.res) return cur ? undefined : cur;
    const d = cur.duel, k = d.a === uid ? 'a' : d.b === uid ? 'b' : null;
    if (!k) return undefined;
    d.shots = d.shots || {}; if (d.shots[k]) return undefined;
    let sh;
    if (body.early || now < d.greenAt - 450) sh = { early: true, at: now };
    else { const ms = Math.round(Number(body.ms)); if (!Number.isFinite(ms) || ms < 100 || ms > C.shootMs + 2000) return undefined; sh = { ms: Math.min(ms, Math.max(100, now - d.greenAt + 150)), at: now }; }
    d.shots[k] = sh; out = { ok: true }; return cur;
  });
  await advance(now, run);
  return out;
}

// The knife: the holder has a few seconds to use it on someone close by (not on the duelists).
async function stab(uid, run, now, body) {
  const L = await load(run); if (!L.st) return { ok: false };
  const tuid = Object.keys(L.m).find(u => L.code[u] === Number(body.target)), me = L.P[uid], t = tuid && L.P[tuid];
  if (!t || !me || (L.st.dead || {})[tuid] || (L.st.dead || {})[uid]) return { ok: false };
  if (L.st.duel && (L.st.duel.a === tuid || L.st.duel.b === tuid || L.st.duel.a === uid || L.st.duel.b === uid)) return { ok: false };
  if (Math.hypot(t.x - me.x, t.y - me.y) > D8.STAB_RANGE) return { ok: false, far: true };
  let done = false;
  const ctx = mkCtx(run, L); let nxt = null;
  const tx = await db.ref('rooms8/st').transaction(cur => {
    done = false; if (!cur || !cur.knife || cur.knife.holder !== uid || now > cur.knife.until || (cur.dead || {})[tuid]) return cur ? undefined : cur;
    cur.dead = cur.dead || {}; cur.dead[tuid] = now; cur.stabs = (cur.stabs || 0) + 1; cur.knife = null; cur.knifeAt = now + rnd(run.cfg.knifeMin, run.cfg.knifeMax) * 1000;
    cur.feed = cur.feed || {}; cur.seq = (cur.seq || 0) + 1; cur.feed['f' + cur.seq] = { t: 'P' + L.code[tuid] + ' was stabbed', at: now };
    done = true; nxt = cur; return cur;
  });
  if (tx.committed && done) { await reconcile(run, nxt, L); await advance(now, run); }
  return { ok: done };
}

// The admin starts the final: codes are drawn at random, everybody goes to the briefing and chat.
function assign(ids) {
  const o = ids.slice().sort(() => Math.random() - 0.5), out = {};
  o.forEach((u, i) => { out[u] = i + 1; });
  return out;
}
// Finishes the final right now: the last alive player (or a random one) wins, everybody else is out.
async function force(run, now) {
  const L = await load(run); if (!L.st) return;
  const alive = Object.keys(L.m).filter(u => !(L.st.dead || {})[u]);
  if (!alive.length) return;
  const w = alive[Math.floor(Math.random() * alive.length)];
  let nxt = null;
  await db.ref('rooms8/st').transaction(cur => {
    if (!cur || cur.over) return cur ? undefined : cur;
    cur.dead = cur.dead || {}; alive.filter(u => u !== w).forEach(u => { cur.dead[u] = now; });
    cur.duel = null; cur.over = now; cur.winner = w; nxt = cur; return cur;
  });
  if (nxt) await reconcile(run, nxt, L);
}
module.exports = { step, advance, sync, shoot, stab, assign, force, reconcile, load, view };
