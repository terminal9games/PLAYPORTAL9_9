const { admin, db, maintain, closeNow, newId, secLog } = require('./_lib');

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
      const players = pl.val() || {};
      Object.keys(players).forEach(k => { delete players[k].sid; delete players[k].ipk; });   // session internals never leave the server
      const sec = [];
      (await db.ref('seclog').orderByKey().limitToLast(40).get()).forEach(c => { sec.push(c.val()); });
      return res.json({ seclog: sec.reverse(), players, day4: d4, day5: { cfg: d5cfg, groups: d5groups }, day6: { cfg: d6cfg, data: d6, links: d6links }, activeDay: st.day, endsAt: st.endsAt, closed: st.closed, now: Date.now() });
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
      const ids = Object.keys(s).filter(i => s[i].status === 'active' && s[i].current_day === 5);
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
      const ids = Object.keys(s).filter(i => s[i].status === 'active' && s[i].current_day === d);
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
