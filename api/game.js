const { db, sign, verify, maintain } = require('./_lib');
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
    const st = await maintain();
    const day = st.day;
    let p = await load();
    const now = Date.now();
    const live = () => p.status === 'active' && p.current_day === day && !st.closed;

    // Admin reset the player to Day 1: clear leftovers from the previous attempt
    if (day === 1 && live() && p.d1_done) { await ref.update({ d1_start: null, d1_done: null }); p = await load(); }

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
      const cref = db.ref(`pairs/day2/${p.pair}/choice_${slot}`);
      if (!(await cref.get()).exists()) await cref.set(choice);
    }
    if (action === 'pick' && day === 3 && live() && Number.isInteger(choice) && choice >= 0 && choice <= 100) {
      const cref = db.ref('day3/choices/' + uid);
      if (!(await cref.get()).exists()) await cref.set(choice);
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
      if (!p.reveal) {
        const upd = { reveal };
        if (reveal.ok) upd.current_day = 3; else { upd.status = 'eliminated'; upd.eliminated_day = 2; }
        await ref.update(upd);
      }
      p = await load();
      return { screen: 'reveal', ...p.reveal };
    };

    const day3view = async () => {
      const c = (await db.ref('day3/choices/' + uid).get()).val();
      return typeof c === 'number' ? { screen: 'wait3' } : { screen: 'pick3' };
    };

    let view;
    if (p.reveal) view = { screen: 'reveal', ...p.reveal };
    else if (p.status === 'eliminated') view = { screen: 'eliminated', day: p.eliminated_day || p.current_day };
    else if (p.status === 'winner' || p.current_day > day) view = { screen: 'passed' };
    else if (st.closed) view = { screen: 'none', msg: 'This day is closed.' };
    else if (day === 1) view = { screen: 'day1', startAt: p.d1_start || null, now: Date.now() };
    else if (day === 2) view = await day2view();
    else if (day === 3) view = await day3view();
    else view = { screen: 'none', msg: 'Game not available yet.' };

    res.json({ token: action === 'login' ? sign(uid) : undefined, view, now: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
};
