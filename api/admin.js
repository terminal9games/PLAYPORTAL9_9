const { admin, db, maintain, closeNow } = require('./_lib');

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
      return res.json({ players: pl.val() || {}, day4: d4, day5: { cfg: d5cfg, groups: d5groups }, activeDay: st.day, endsAt: st.endsAt, closed: st.closed, now: Date.now() });
    }
    if (action === 'setDay') {
      const mins = Number(req.body.minutes) > 0 ? Number(req.body.minutes) : 1200;
      await db.ref('config').update({ active_day: Number(value), ends_at: Date.now() + mins * 60000, closed_day: null, duration_min: mins });
      await db.ref('day' + Number(value)).remove(); // old test data for that day
      if (Number(value) === 5) await Promise.all([db.ref('groups/day5').remove(), db.ref('chats/day5').remove(), db.ref('config/day5').remove()]);
    } else if (action === 'close') {
      return res.json({ closed: await closeNow() });
    } else if (action === 'status' && ['active', 'eliminated', 'winner'].includes(value)) {
      const p = (await pref.get()).val(); if (!p) return res.status(404).json({ error: 'not found' });
      await pref.update({ status: value, reveal: null, d1_start: null, d1_done: null, d4_tries: null, g5: null, eliminated_day: value === 'eliminated' ? p.current_day : null });
    } else if (action === 'playerDay' && value >= 1 && value <= 9) await pref.update({ current_day: Number(value), reveal: null, d1_start: null, d1_done: null, pair: null, d4_tries: null, g5: null });
    else if (action === 'setDay4') {
      const c = String(req.body.code || '');
      if (!/^\d{4}$/.test(c)) return res.status(400).json({ error: 'code must be 4 digits' });
      const clues = (Array.isArray(req.body.clues) ? req.body.clues : []).map(x => String(x).slice(0, 200)).filter(Boolean).slice(0, 12);
      await db.ref('secret/day4').set({ code: c, clues });
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
