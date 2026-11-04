const { admin, db, maintain, closeNow, newId, secLog, sign, phase5, label5 } = require('./_lib');
const D6 = require('./_d6');
const { simulate } = require('./_sim');
const rnd = arr => arr[Math.floor(Math.random() * arr.length)];

// A test player plays the whole Day 6 script at random (skips the minimum reading time)
async function botPlay6(db, u, now) {
  const st = (await db.ref('d6/' + u).get()).val() || { start: now, idx: 0, shown: now, cold: 0 };
  st.ans = st.ans || {}; st.sac = st.sac || []; st.kept = st.kept || D6.ITEMS.map(i => i.id); st.cold = st.cold || 0;
  if (st.done) return;
  const links = (await db.ref('d6links/' + u).get()).val() || {};
  for (let g = 0; !st.done && g < 80; g++) {
    const step = D6.STEPS[st.idx], ctx = { linkId: st.linkId || Object.keys(links).sort()[0] || null };
    if (ctx.linkId) st.linkId = ctx.linkId;
    if (step.type === 'choice') { const o = rnd(step.opts); st.ans[step.id] = o[0]; st.cold += o[2] || 0; if (step.id === 'betray' && st.linkId) await db.ref(`d6links/${u}/${st.linkId}/betray`).set(o[0]); }
    else if (step.type === 'sacrifice') { const id = rnd(st.kept), it = D6.ITEMS.find(i => i.id === id); st.kept = st.kept.filter(x => x !== id); st.sac.push(id); st.cold += it.cold; }
    else if (step.type === 'input') st.ans[step.id] = 'skipped';
    const ni = D6.nextIdx(st, st.idx + 1, ctx);
    if (ni < 0) { st.done = true; st.finished = now; } else { st.idx = ni; st.shown = now; }
  }
  await db.ref('d6/' + u).set(st);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const u = await admin.auth().verifyIdToken((req.headers.authorization || '').replace('Bearer ', ''));
    if (u.uid !== process.env.ADMIN_UID) return res.status(403).json({ error: 'forbidden' });
  } catch { return res.status(401).json({ error: 'unauthorized' }); }

  const { action, id, value } = req.body || {};
  try {
    const pref = id && db.ref('players/' + String(id).toUpperCase());
    if (action === 'list') {
      const st = await maintain();
      const pl = await db.ref('players').get();
      const d4 = (await db.ref('secret/day4').get()).val();
      const d5cfg = (await db.ref('config/day5').get()).val();
      const d5groups = (await db.ref('groups/day5').get()).val() || {};
      const d6 = (await db.ref('d6').get()).val() || {};
      const d6cfg = (await db.ref('config/day6').get()).val() || {};
      const d6links = (await db.ref('d6links').get()).val() || {};
      const testMode = !!(await db.ref('config/test_mode').get()).val();
      const players = pl.val() || {};
      Object.keys(players).forEach(k => { delete players[k].sid; delete players[k].ipk; });   // session internals never leave the server
      const sec = [];
      (await db.ref('seclog').orderByKey().limitToLast(40).get()).forEach(c => { sec.push(c.val()); });
      return res.json({ testMode, seclog: sec.reverse(), players, day4: d4, day5: { cfg: d5cfg, groups: d5groups }, day6: { cfg: d6cfg, data: d6, links: d6links }, activeDay: st.day, endsAt: st.endsAt, closed: st.closed, now: Date.now() });
    }
    if (action === 'setDay') {
      const mins = Number(req.body.minutes) > 0 ? Number(req.body.minutes) : 1200;
      await db.ref('config').update({ active_day: Number(value), ends_at: Date.now() + mins * 60000, closed_day: null, ended: null, duration_min: mins });
      await db.ref('day' + String(Number(value)).replace('.', '_')).remove(); // old test data for that day
      if (Number(value) === 1.5) await db.ref('d15').remove();
      if (Number(value) === 6) await Promise.all([db.ref('d6').remove(), db.ref('d6links').remove()]);
      if (Number(value) === 5) await Promise.all([db.ref('groups/day5').remove(), db.ref('chats/day5').remove(), db.ref('config/day5').remove()]);
    } else if (action === 'close') {
      return res.json({ closed: await closeNow() });
    } else if (action === 'status' && ['active', 'eliminated', 'winner'].includes(value)) {
      const p = (await pref.get()).val(); if (!p) return res.status(404).json({ error: 'not found' });
      await db.ref('d6/' + String(id).toUpperCase()).remove();
      await pref.update({ status: value, reveal: null, d1_start: null, d1_done: null, d4_tries: null, g5: null, eliminated_day: value === 'eliminated' ? p.current_day : null });
    } else if (action === 'playerDay' && value >= 1 && value <= 9) { await db.ref('d6/' + String(id).toUpperCase()).remove(); await pref.update({ current_day: Number(value), reveal: null, d1_start: null, d1_done: null, pair: null, d4_tries: null, g5: null }); }
    else if (action === 'setDay4') {
      const c = String(req.body.code || '');
      if (!/^\d{4}$/.test(c)) return res.status(400).json({ error: 'code must be 4 digits' });
      const clues = (Array.isArray(req.body.clues) ? req.body.clues : []).map(x => String(x).slice(0, 200)).filter(Boolean).slice(0, 12);
      await db.ref('secret/day4').set({ code: c, clues });
    }
    else if (action === 'setDay6') {
      const minutes = Math.min(120, Math.max(10, Math.floor(Number(req.body.minutes)) || 40));
      const cut = Math.min(90, Math.max(0, Math.floor(Number(req.body.cut)) || 0));
      const side = req.body.side === 'warm' ? 'warm' : 'cold';
      await db.ref('config/day6').set({ minutes, cut, side });
    }
    else if (action === 'start5') {
      // Forms groups of about 4 from the active Day 5 players, picks one secret traitor per group,
      // and starts the game after a short lobby. Players who show up late still see the chat history.
      const num = (x, d, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(x)) || d));
      const discuss = num(req.body.discuss, 8, 1, 30), vote = num(req.body.vote, 2, 1, 10);
      const rounds = num(req.body.rounds, 3, 1, 6), lobby = num(req.body.lobby, 120, 10, 900);
      const s = (await db.ref('players').get()).val() || {};
      const tm = !!(await db.ref('config/test_mode').get()).val();
      const ids = Object.keys(s).filter(i => s[i].status === 'active' && s[i].current_day === 5 && !!s[i].test === tm);
      if (ids.length < 3) return res.status(400).json({ error: 'Need at least 3 active players on Day 5 (there are ' + ids.length + ').' });
      const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      shuffle(ids);
      const g = Math.max(1, Math.floor(ids.length / 4));
      const buckets = Array.from({ length: g }, () => []);
      ids.forEach((id, i) => buckets[i % g].push(id));
      await Promise.all([db.ref('groups/day5').remove(), db.ref('chats/day5').remove()]);
      const up = {};
      for (const b of buckets) {
        const gid = 'g' + Math.random().toString(36).slice(2, 10);
        const members = {};
        b.forEach((u, i) => { members[u] = i; up[`players/${u}/g5`] = gid; });
        up['groups/day5/' + gid] = { members, traitor: b[Math.floor(Math.random() * b.length)], resolved: 0 };
      }
      up['config/day5'] = { start: Date.now() + lobby * 1000, discuss, vote, rounds };
      await db.ref().update(up);
      return res.json({ groups: g, players: ids.length });
    }
    else if (action === 'simulate') {
      // Pure simulation with imaginary bots; reads nothing and writes nothing.
      const b = req.body, days = (Array.isArray(b.days) ? b.days : []).map(Number).filter(d => d >= 1 && d <= 9);
      if (!days.length) return res.status(400).json({ error: 'Pick at least one day.' });
      const P = b.params || {}, o = {};
      ['p1', 'p4', 'p7', 'cancel'].forEach(k => { if (P[k] !== '' && P[k] != null) o[k] = Math.min(1, Math.max(0, Number(P[k]) / 100)); });
      if (P.cut6 !== '' && P.cut6 != null) o.cut6 = Number(P.cut6);
      if (P.side6 === 'warm' || P.side6 === 'cold') o.side6 = P.side6;
      return res.json(simulate(Number(b.bots), days, Number(b.runs), o));
    }
    else if (action === 'setTestMode') {
      await db.ref('config/test_mode').set(!!req.body.on);
    }
    else if (action === 'createTest') {
      const n = Math.min(40, Math.max(1, Math.floor(Number(req.body.count)) || 1));
      const day = Math.min(9, Math.max(1, Number(req.body.day) || 1));
      const cur = (await db.ref('players').get()).val() || {};
      let k = Object.keys(cur).filter(i => cur[i].test).length;
      const up = {}; let made = 0;
      while (made < n) { k++; const nid = 'T9-TEST' + String(k).padStart(4, '0'); if (cur[nid] || up['players/' + nid]) continue; up['players/' + nid] = { status: 'active', current_day: day, test: true }; made++; }
      await db.ref().update(up);
      return res.json({ created: made });
    }
    else if (action === 'deleteTest') {
      // Removes every test player and everything they left behind. Real players are never touched.
      const cur = (await db.ref('players').get()).val() || {};
      const tests = Object.keys(cur).filter(i => cur[i].test), set = new Set(tests);
      const up = {};
      for (const u of tests) { up['players/' + u] = null; up['d6/' + u] = null; up['d15/votes/' + u] = null; up['day3/choices/' + u] = null; up['d6links/' + u] = null; }
      const links = (await db.ref('d6links').get()).val() || {};
      Object.keys(links).forEach(b => Object.keys(links[b] || {}).forEach(x => { if (set.has(x)) up['d6links/' + b + '/' + x] = null; }));
      const groups = (await db.ref('groups/day5').get()).val() || {};
      Object.keys(groups).forEach(g => { if (set.has(groups[g].traitor)) { up['groups/day5/' + g] = null; up['chats/day5/' + g] = null; } });
      const pairs = (await db.ref('pairs/day2').get()).val() || {};
      Object.keys(pairs).forEach(p => { if (set.has(pairs[p].a)) up['pairs/day2/' + p] = null; });
      if (tests.length) await db.ref().update(up);
      return res.json({ deleted: tests.length });
    }
    else if (action === 'impersonate') {
      // A 6-hour token for one tab. It skips sessions and network limits, so you can keep many tabs open.
      const who = String(id || '').toUpperCase();
      if (!(await db.ref('players/' + who).get()).exists()) return res.status(404).json({ error: 'not found' });
      await secLog('admin_play_as', who);
      return res.json({ token: sign(who, 'adm', true) });
    }
    else if (action === 'simBots') {
      // Test players answer for you in the current day, so you can see a full round with many players
      const st = await maintain(), day = st.day, now = Date.now();
      const all = (await db.ref('players').get()).val() || {};
      const bots = Object.keys(all).filter(i => all[i].test && all[i].status === 'active' && all[i].current_day === day);
      if (!bots.length) return res.status(400).json({ error: 'There are no active test players on Day ' + day + '.' });
      const up = {}; let n = 0;
      if (day === 1.5) {
        const v = (await db.ref('d15/votes').get()).val() || {};
        bots.filter(b => !v[b]).forEach(b => { up['d15/votes/' + b] = Math.random() < 0.7 ? 'continue' : 'cancel'; n++; });
      } else if (day === 2) {
        const pr = (await db.ref('pairs/day2').get()).val() || {};
        bots.forEach(b => { const p = pr[all[b].pair]; if (!p) return; const slot = p.a === b ? 'a' : 'b'; if (!p['choice_' + slot]) { up[`pairs/day2/${all[b].pair}/choice_${slot}`] = rnd(['share', 'steal']); n++; } });
      } else if (day === 3) {
        const c = (await db.ref('day3/choices').get()).val() || {};
        bots.filter(b => typeof c[b] !== 'number').forEach(b => { up['day3/choices/' + b] = Math.floor(Math.random() * 101); n++; });
      } else if (day === 5) {
        const cfg = (await db.ref('config/day5').get()).val();
        if (!cfg || !cfg.start) return res.status(400).json({ error: 'Press "Create groups and start" first.' });
        const ph = phase5(cfg, now);
        if (ph.state !== 'discuss' && ph.state !== 'vote') return res.status(400).json({ error: 'Day 5 is in the lobby or finished. Bots play during discussion and voting.' });
        const groups = (await db.ref('groups/day5').get()).val() || {};
        const talk = ['I am not the traitor.', 'Who has been quiet?', 'Something feels off about one of you.', 'Let us not vote the wrong person.', 'I vote with the majority.'];
        for (const gid of Object.keys(groups)) {
          const g = groups[gid]; if (g.result) continue;
          const alive = Object.keys(g.members).filter(u => !(g.out && u in g.out));
          for (const b of alive.filter(u => all[u] && all[u].test)) {
            await db.ref('chats/day5/' + gid).push({ s: g.members[b], t: rnd(talk), ts: now }); n++;
            if (ph.state === 'vote') { const others = alive.filter(u => u !== b); if (others.length) up[`groups/day5/${gid}/votes/r${ph.round}/${b}`] = g.members[rnd(others)]; }
          }
        }
      } else if (day === 6) {
        for (const b of bots) { await botPlay6(db, b, now); n++; }
      } else return res.status(400).json({ error: 'Bots do not play Day ' + day + '. Play it yourself in a test tab.' });
      if (Object.keys(up).length) await db.ref().update(up);
      return res.json({ bots: n, day });
    }
    else if (action === 'kill') {
      // Signs out every device of this ID right away (lost or stolen device, leaked ID)
      if (!(await pref.get()).exists()) return res.status(404).json({ error: 'not found' });
      await pref.update({ sid: null }); await secLog('sessions_killed', String(id).toUpperCase());
    }
    else if (action === 'genIds') {
      const n = Math.min(200, Math.max(1, Math.floor(Number(req.body.count)) || 1));
      const day = Math.min(9, Math.max(1, Number(req.body.day) || 1));
      const cur = (await db.ref('players').get()).val() || {}, made = [], up = {};
      while (made.length < n) { const k = newId(); if (!cur[k] && !up['players/' + k]) { made.push(k); up['players/' + k] = { status: 'active', current_day: day }; } }
      await db.ref().update(up);
      return res.json({ ids: made });
    }
    else if (action === 'migrate') {
      // Moves a player's whole progress from an exposed ID to a brand new random ID. The old ID stops working.
      const old = String(id || '').toUpperCase();
      const p = (await db.ref('players/' + old).get()).val();
      if (!p) return res.status(404).json({ error: 'not found' });
      let nid; do { nid = newId(); } while ((await db.ref('players/' + nid).get()).exists());
      const clean = { ...p }; ['sid', 'ipk', 'seen', 'flag', 'c0'].forEach(k => delete clean[k]);
      const up = { ['players/' + nid]: clean, ['players/' + old]: null };
      for (const base of ['d6/', 'day3/choices/']) { const v = (await db.ref(base + old).get()).val(); if (v != null) { up[base + nid] = v; up[base + old] = null; } }
      if (p.pair && p.pair !== 'bye') {
        const pr = (await db.ref('pairs/day2/' + p.pair).get()).val() || {};
        if (pr.a === old) up['pairs/day2/' + p.pair + '/a'] = nid; if (pr.b === old) up['pairs/day2/' + p.pair + '/b'] = nid;
      }
      if (p.g5) {
        const g = (await db.ref('groups/day5/' + p.g5).get()).val();
        if (g) {
          const gp = 'groups/day5/' + p.g5 + '/';
          if (g.members && old in g.members) { up[gp + 'members/' + nid] = g.members[old]; up[gp + 'members/' + old] = null; }
          if (g.traitor === old) up[gp + 'traitor'] = nid;
          if (g.out && old in g.out) { up[gp + 'out/' + nid] = g.out[old]; up[gp + 'out/' + old] = null; }
          Object.keys(g.votes || {}).forEach(r => { if (g.votes[r] && old in g.votes[r]) { up[gp + 'votes/' + r + '/' + nid] = g.votes[r][old]; up[gp + 'votes/' + r + '/' + old] = null; } });
        }
      }
      const links = (await db.ref('d6links').get()).val() || {};
      Object.keys(links).forEach(b => { if (links[b] && old in links[b]) { up['d6links/' + b + '/' + nid] = links[b][old]; up['d6links/' + b + '/' + old] = null; } });
      if (links[old]) { up['d6links/' + nid] = links[old]; up['d6links/' + old] = null; }
      const vote = (await db.ref('d15/votes/' + old).get()).val(); if (vote) { up['d15/votes/' + nid] = vote; up['d15/votes/' + old] = null; }
      await db.ref().update(up);
      await secLog('migrated', nid);
      return res.json({ ok: true, newId: nid });
    }
    else if (action === 'addMany') {
      // Adds many players at once. Existing IDs are left untouched.
      const day = Math.min(9, Math.max(1, Math.floor(Number(req.body.day)) || 1));
      const raw = (Array.isArray(req.body.ids) ? req.body.ids : []).map(x => String(x).trim().toUpperCase()).filter(Boolean);
      const ids = [...new Set(raw)].slice(0, 500);
      const bad = ids.filter(k => !/^T9-[A-Z0-9-]{3,20}$/.test(k));
      const good = ids.filter(k => !bad.includes(k));
      const cur = (await db.ref('players').get()).val() || {};
      const fresh = good.filter(k => !cur[k]);
      const up = {};
      fresh.forEach(k => { up['players/' + k] = { status: 'active', current_day: day }; });
      if (fresh.length) await db.ref().update(up);
      return res.json({ added: fresh.length, existing: good.length - fresh.length, bad });
    }
    else if (action === 'add') {
      const k = String(id || '').toUpperCase();
      if (!/^T9-[A-Z0-9-]{3,20}$/.test(k)) return res.status(400).json({ error: 'bad id' });
      if (!(await pref.get()).exists()) await pref.set({ status: 'active', current_day: 1 });
    } else if (action === 'pair') {
      const d = Number(value);
      const s = (await db.ref('players').get()).val() || {};
      const tm = !!(await db.ref('config/test_mode').get()).val();
      const ids = Object.keys(s).filter(i => s[i].status === 'active' && s[i].current_day === d && !!s[i].test === tm);
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      await db.ref('pairs/day' + d).remove();
      const up = {};
      for (let i = 0; i < ids.length; i += 2) {
        if (i + 1 >= ids.length) { up[`players/${ids[i]}/pair`] = 'bye'; break; }
        const pid = 'p' + Math.random().toString(36).slice(2, 10);
        up[`pairs/day${d}/${pid}/a`] = ids[i]; up[`pairs/day${d}/${pid}/b`] = ids[i + 1];
        up[`players/${ids[i]}/pair`] = pid; up[`players/${ids[i + 1]}/pair`] = pid;
      }
      if (ids.length) await db.ref().update(up);
      return res.json({ paired: ids.length });
    } else return res.status(400).json({ error: 'bad action' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
};
