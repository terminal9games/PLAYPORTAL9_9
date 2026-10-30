const { db, sign, verify } = require('./_lib');
const ID = /^T9-[A-Z0-9-]{3,20}$/;
const D1_MS = 60000, LEAD = 2000, GRACE = 3000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, token, uid: rawUid, choice } = req.body || {};
  try {
    let uid;
    if (action === 'login') {
      uid = String(rawUid || '').trim().toUpperCase();
      if (!ID.test(uid) || !(await db.ref('players/' + uid).get()).exists())
        return res.status(404).json({ error: 'ID not found. Check it and try again.' });
    } else {
      const s = verify(token);
      if (!s) return res.status(401).json({ error: 'Session expired. Log in again.' });
      uid = s.uid;
    }
    const ref = db.ref('players/' + uid);
    const load = async () => (await ref.get()).val();
    let p = await load();
    const day = (await db.ref('config/active_day').get()).val() || 1;
    const now = Date.now();
    const live = () => p.status === 'active' && p.current_day === day;

    // Day 1: a game that was started and never finished is a timeout
    if (day === 1 && live() && p.d1_start && !p.d1_done && now > p.d1_start + D1_MS + GRACE) {
      await ref.update({ d1_done: true, status: 'eliminated', eliminated_day: 1 });
      p = await load();
    }

    if (action === 'ready' && day === 1 && live() && !p.d1_start) {
      await ref.update({ d1_start: now + LEAD });
      p = await load();
    }
    if (action === 'press' && day === 1 && live() && p.d1_start && !p.d1_done) {
      const left = 60 - (now - p.d1_start) / 1000;
      await ref.update({ d1_done: true });
      if (left >= 7 && left < 8) await ref.update({ current_day: 2 });
      else await ref.update({ status: 'eliminated', eliminated_day: 1 });
      p = await load();
    }
    if (action === 'pick' && day === 2 && live() && p.pair && p.pair !== 'bye' && (choice === 'share' || choice === 'steal')) {
      const slot = (await db.ref(`pairs/day2/${p.pair}/a`).get()).val() === uid ? 'a' : 'b';
      await db.ref(`pairs/day2/${p.pair}/choice_${slot}`).transaction(v => (v === null ? choice : undefined));
    }
    if (action === 'ack') { await ref.child('reveal').remove(); p = await load(); }

    const day2view = async () => {
      if (!p.pair) return { screen: 'none', msg: 'Rivals not assigned yet. Come back later.' };
      if (p.pair === 'bye') { await ref.update({ current_day: 3 }); return { screen: 'passed' }; }
      const pr = (await db.ref(`pairs/day2/${p.pair}`).get()).val() || {};
      const slot = pr.a === uid ? 'a' : 'b', other = slot === 'a' ? 'b' : 'a';
      const mine = pr['choice_' + slot], theirs = pr['choice_' + other];
      if (!mine) return { screen: 'pick' };
      if (!theirs) return { screen: 'wait' };
      const reveal = { mine, theirs, ok: theirs === 'share', day: 2 };
      await ref.transaction(cur => {
        if (!cur || cur.reveal) return;
        cur.reveal = reveal;
        if (reveal.ok) cur.current_day = 3; else { cur.status = 'eliminated'; cur.eliminated_day = 2; }
        return cur;
      });
      p = await load();
      return { screen: 'reveal', ...p.reveal };
    };

    let view;
    if (p.reveal) view = { screen: 'reveal', ...p.reveal };
    else if (p.status === 'eliminated') view = { screen: 'eliminated', day: p.eliminated_day || p.current_day };
    else if (p.status === 'winner' || p.current_day > day) view = { screen: 'passed' };
    else if (day === 1) view = { screen: 'day1', startAt: p.d1_start || null, now: Date.now() };
    else if (day === 2) view = await day2view();
    else view = { screen: 'none', msg: 'Game not available yet.' };

    res.json({ token: action === 'login' ? sign(uid) : undefined, view, now: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
};
