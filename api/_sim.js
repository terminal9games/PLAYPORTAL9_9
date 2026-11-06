// Tournament simulator. Pure maths: it never touches the database, so it is safe to run at any time.
// It applies the same rules as closeDay() and the Day 5 engine to imaginary bots with random traits,
// many times over, and reports how many pass, how many are eliminated and who tends to win.
const rnd = Math.random;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7071; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Default knobs. Days 1, 4 and 7+ depend on player skill, so the admin sets the base pass rate.
const DEFAULTS = { p1: 0.75, p4: 0.5, p7: 0.5, cancel: 0.25, cut6: 40, cut7: 30, need7: 50, side6: 'cold', group5: 4, rounds5: 3 };

function runOnce(n, days, k) {
  const bots = Array.from({ length: n }, (_, i) => ({
    id: i, skill: rnd(), greed: rnd(), sus: rnd(), cold: clamp(gauss() * 3, -9, 9),
  }));
  let alive = bots.slice(); const log = []; let ended = false;
  for (const day of days) {
    if (!alive.length) break;
    const inn = alive.length; let pass = [];
    if (day === 1) pass = alive.filter(b => rnd() < clamp(k.p1 * (0.55 + 0.9 * b.skill), 0, 1));
    else if (day === 1.5) {
      const c = alive.filter(() => rnd() < k.cancel).length;
      if (c > alive.length - c) { ended = true; pass = alive; } else pass = alive;   // cancel: games end, nobody eliminated
    } else if (day === 2) {
      const o = shuffle(alive.slice()), ch = new Map(o.map(b => [b, rnd() < 0.1 + 0.8 * b.greed ? 'steal' : 'share']));
      for (let i = 0; i < o.length; i += 2) {
        if (i + 1 >= o.length) { pass.push(o[i]); break; }
        const a = o[i], b = o[i + 1];
        if (ch.get(b) === 'share') pass.push(a);
        if (ch.get(a) === 'share') pass.push(b);
      }
    } else if (day === 3) {
      const x = new Map(alive.map(b => [b, clamp(Math.round(35 + 25 * b.greed + 15 * gauss()), 0, 100)]));
      const avg = alive.reduce((s, b) => s + x.get(b), 0) / alive.length, target = 0.8 * avg;
      const rk = alive.map(b => ({ b, d: Math.abs(x.get(b) - target) })).sort((p, q) => p.d - q.d);
      const cut = rk[Math.max(1, Math.ceil(0.6 * rk.length)) - 1].d;
      pass = rk.filter(r => r.d <= cut).map(r => r.b);
    } else if (day === 4) pass = alive.filter(b => rnd() < clamp(k.p4 * (0.55 + 0.9 * b.skill), 0, 1));
    else if (day === 5) {
      if (alive.length < 3) pass = alive;
      else {
        const o = shuffle(alive.slice()), g = Math.max(1, Math.floor(o.length / k.group5));
        const bk = Array.from({ length: g }, () => []); o.forEach((b, i) => bk[i % g].push(b));
        for (const grp of bk) {
          const traitor = grp[Math.floor(rnd() * grp.length)], out = new Set(); let result = null;
          for (let r = 0; r < k.rounds5 && !result; r++) {
            const left = grp.filter(b => !out.has(b)), tally = new Map();
            for (const v of left) {
              const others = left.filter(b => b !== v);
              if (!others.length) continue;
              const t = v === traitor ? others[Math.floor(rnd() * others.length)]
                : (rnd() < 0.2 + 0.4 * v.sus ? traitor : others[Math.floor(rnd() * others.length)]);
              tally.set(t, (tally.get(t) || 0) + 1);
            }
            let best = 0, top = []; for (const [t, c] of tally) { if (c > best) { best = c; top = [t]; } else if (c === best) top.push(t); }
            const ex = top.length === 1 ? top[0] : null;
            if (ex) { out.add(ex); if (ex === traitor) result = 'crew'; }
            const rest = left.filter(b => b !== ex);
            if (!result && rest.length <= 2) result = 'traitor';
            if (!result && r === k.rounds5 - 1) result = 'traitor';
            if (result === 'crew') { pass.push(...rest.filter(b => b !== traitor)); }
            else if (result === 'traitor') pass.push(traitor);   // innocents still in the group are eliminated
          }
          // innocents who were not expelled and the group ended 'traitor': eliminated; expelled innocents: eliminated
        }
      }
    } else if (day === 6) {
      const dir = k.side6 === 'warm' ? -1 : 1, cut = clamp(k.cut6, 0, 90);
      const rk = alive.map(b => ({ b, v: dir * (b.cold + gauss()) })).sort((p, q) => q.v - p.v);
      const nOut = Math.floor(rk.length * cut / 100), boundary = nOut < rk.length ? rk[nOut].v : -Infinity;
      pass = rk.filter((r, i) => !(i < nOut && r.v > boundary)).map(r => r.b);
    } else if (day === 7) {
      // Maze: rooms of 8, half hunters and half survivors (odd one out watches). Survivors escape by skill and luck.
      // Hunters pass when enough of their room's survivors failed. Then the rope cuts the slowest cut7 %.
      const o = shuffle(alive.slice()), spec = o.length % 2 ? o.pop() : null, rooms = [];
      for (let i = 0; i < o.length; i += 8) rooms.push(o.slice(i, i + 8));
      const inRope = spec ? [spec] : [];
      for (const rm of rooms) {
        if (rm.length % 2) inRope.push(rm.pop());
        if (!rm.length) continue;
        const half = rm.length / 2, hunters = rm.slice(0, half), surv = rm.slice(half);
        const hSkill = hunters.reduce((s, b) => s + b.skill, 0) / half;
        const esc = surv.filter(b => rnd() < clamp(0.25 + 0.5 * b.skill - 0.3 * (hSkill - 0.5), 0.05, 0.9));
        inRope.push(...esc);
        const failed = surv.length - esc.length;
        if (failed >= Math.ceil(surv.length * k.need7 / 100)) inRope.push(...hunters.filter(() => rnd() < 0.9));   // 10% fail the kill minimum
      }
      const rk = inRope.map(b => ({ b, v: 0.6 * b.skill + 0.25 * (1 - b.sus) + 0.15 * (1 - b.greed) + 0.35 * gauss() * 0.5 })).sort((p, q) => q.v - p.v);
      const nOut = Math.floor(rk.length * clamp(k.cut7, 0, 90) / 100);
      pass = rk.slice(0, rk.length - nOut).map(r => r.b);
    } else pass = alive.filter(b => rnd() < clamp(k.p7 * (0.55 + 0.9 * b.skill), 0, 1));   // Day 8 and later
    log.push({ day, inn, pass: pass.length });
    alive = pass;
    if (ended) break;
  }
  return { log, alive, ended };
}

function simulate(n, days, runs, over) {
  n = clamp(Math.floor(n) || 100, 2, 5000); runs = clamp(Math.floor(runs) || 100, 1, 500);
  const k = { ...DEFAULTS, ...(over || {}) };
  days = [...new Set(days)].sort((a, b) => a - b);
  const per = days.map(d => ({ day: d, inn: 0, pass: 0, min: Infinity, max: 0 }));
  let sole = 0, none = 0, cancelled = 0, finalists = 0;
  const wins = new Map(), traitsSum = { skill: 0, greed: 0, sus: 0, cold: 0 };
  for (let r = 0; r < runs; r++) {
    const res = runOnce(n, days, k);
    res.log.forEach(l => { const p = per.find(x => x.day === l.day); p.inn += l.inn; p.pass += l.pass; p.min = Math.min(p.min, l.pass); p.max = Math.max(p.max, l.pass); });
    if (res.ended) cancelled++;
    const a = res.alive; finalists += a.length;
    if (!a.length) none++; else if (a.length === 1) sole++;
    a.forEach(b => {
      const key = (b.skill > .66 ? 'Skilled' : b.skill < .33 ? 'Clumsy' : 'Average') + ' / ' + (b.greed > .66 ? 'greedy' : b.greed < .33 ? 'generous' : 'balanced') + ' / ' + (b.sus > .66 ? 'suspicious' : b.sus < .33 ? 'trusting' : 'alert') + ' / ' + (b.cold > 2 ? 'cold' : b.cold < -2 ? 'warm' : 'neutral');
      wins.set(key, (wins.get(key) || 0) + 1 / a.length);
    });
  }
  const profile = [...wins].map(([name, w]) => ({ name, share: +(100 * w / runs).toFixed(1) })).sort((a, b) => b.share - a.share).slice(0, 6);
  return {
    bots: n, runs, params: k,
    days: per.map(x => ({ day: x.day, in: Math.round(x.inn / runs), passed: Math.round(x.pass / runs), eliminated: Math.round((x.inn - x.pass) / runs), min: x.min === Infinity ? 0 : x.min, max: x.max })),
    avgFinalists: +(finalists / runs).toFixed(1),
    pctSole: Math.round(100 * sole / runs), pctNone: Math.round(100 * none / runs), pctCancelled: Math.round(100 * cancelled / runs),
    profiles: profile,
  };
}
module.exports = { simulate, DEFAULTS };
