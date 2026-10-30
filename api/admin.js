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
      return res.json({ players: pl.val() || {}, day4: d4, activeDay: st.day, endsAt: st.endsAt, closed: st.closed, now: Date.now() });
    }
    if (action === 'setDay') {
      const mins = Number(req.body.minutes) > 0 ? Number(req.body.minutes) : 1200;
      await db.ref('config').update({ active_day: Number(value), ends_at: Date.now() + mins * 60000, closed_day: null, duration_min: mins });
      await db.ref('day' + Number(value)).remove(); // old test data for that day
    } else if (action === 'close') {
      return res.json({ closed: await closeNow() });
    } else if (action === 'status' && ['active', 'eliminated', 'winner'].includes(value)) {
      const p = (await pref.get()).val(); if (!p) return res.status(404).json({ error: 'not found' });
      await pref.update({ status: value, reveal: null, d1_start: null, d1_done: null, d4_tries: null, eliminated_day: value === 'eliminated' ? p.current_day : null });
    } else if (action === 'playerDay' && value >= 1 && value <= 9) await pref.update({ current_day: Number(value), reveal: null, d1_start: null, d1_done: null, pair: null, d4_tries: null });
    else if (action === 'setDay4') {
      const c = String(req.body.code || '');
      if (!/^\d{4}$/.test(c)) return res.status(400).json({ error: 'code must be 4 digits' });
      const clues = (Array.isArray(req.body.clues) ? req.body.clues : []).map(x => String(x).slice(0, 200)).filter(Boolean).slice(0, 12);
      await db.ref('secret/day4').set({ code: c, clues });
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
