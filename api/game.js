const { db, sign, verify, maintain } = require('./_lib');

// Chat filter for Day 2. Runs on the server only, so it can't be bypassed from the browser.
// The raw text is never stored: only the censored version reaches the database.

// ===== EDIT: words to censor =====
// Matched even inside longer words ("fucking", "shitty"). Keep these long and unambiguous.
const STEMS = ['fuck', 'shit', 'suicid', 'taiwan', 'porn', 'hentai', 'blowjob', 'handjob', 'nsfw', 'pussy'];
// Matched only as whole words (so "cp" doesn't censor "cpu", "cum" doesn't censor "document").
const WORDS = ['cp', 'sex', 'sexy', 'sexual', 'nude', 'nudes', 'dick', 'cum', 'kys', 'fck'];
// =================================

const SEP = '[^a-z0-9\\s]*';   // punctuation allowed between letters: f.u.c.k, f*u*c*k
const spread = w => w.split('').map(c => c + '+').join(SEP);   // also catches repeated letters: fuuuck
const WORD = '[a-z0-9]*';
const RULES = [
  ...STEMS.map(w => new RegExp('(?<![a-z0-9])' + WORD + spread(w) + WORD, 'g')),   // masks the whole word
  ...WORDS.map(w => new RegExp('(?<![a-z0-9])' + spread(w) + '(?![a-z0-9])', 'g')),
  // Player IDs: the T9-XXXX format itself, and any "your id / unique id / my id / id" request
  /t9-[a-z0-9-]{3,20}/g,
  /(?<![a-z0-9])(?:(?:your|ur|ure|my|unique|player|t9)[\s._-]*)*id(?![a-z0-9])/g,
];
const FORBIDDEN = [...STEMS, ...WORDS];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '@': 'a', '$': 's', '!': 'i' };
// Always returns exactly one character so indexes in the normalized text match the original.
const norm1 = c => {
  const base = (c.normalize('NFD')[0] || c);
  const l = base.toLowerCase();
  const x = l.length === 1 ? l : base;
  return LEET[x] || x;
};

function censor(text) {
  const orig = String(text).split('');
  const norm = orig.map(norm1).join('');
  const hit = new Array(orig.length).fill(false);
  const mark = (s, e) => { for (let i = s; i < e; i++) hit[i] = true; };

  for (const re of RULES) for (const m of norm.matchAll(re)) mark(m.index, m.index + m[0].length);

  // Spaced-out letters: "f u c k", "s - h - i - t"
  for (const m of norm.matchAll(/(?<![a-z0-9])(?:[a-z][\s._-]+){2,9}[a-z](?![a-z0-9])/g)) {
    const joined = m[0].replace(/[^a-z]/g, '');
    if (FORBIDDEN.some(w => joined.includes(w))) mark(m.index, m.index + m[0].length);
  }
  return orig.map((c, i) => (hit[i] ? '#' : c)).join('');
}

// Trim, collapse whitespace, cap length.
const clean = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 200);


const ID = /^T9-[A-Z0-9-]{3,20}$/;
const D1_MS = 60000, LEAD = 2000, GRACE = 3000;
const D5_DEFAULT_LEN = 8;   // rounds of Simon; the admin can change it (config/day5_len)
// Answers are compared ignoring case, accents and extra spaces.
const norm5 = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, token, uid: rawUid, choice, code } = req.body || {};
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

    // Day 2 chat: only between the two paired players, only while Day 2 is open.
    // Messages are censored here and only the censored text is stored.
    if (action === 'chatGet' || action === 'chatSend') {
      if (!(day === 2 && live() && p.pair && p.pair !== 'bye' && !p.reveal)) return res.json({ open: false, messages: [] });
      const cref = db.ref(`pairs/day2/${p.pair}/chat`);
      const me = (await db.ref(`pairs/day2/${p.pair}/a`).get()).val() === uid ? 'a' : 'b';
      if (action === 'chatSend') {
        const text = clean(req.body.text);
        if (!text) return res.status(400).json({ error: 'Write something first.' });
        if (now - (p.chat_last || 0) < 700) return res.status(429).json({ error: 'Slow down.' });
        await ref.update({ chat_last: now });
        await cref.push({ s: me, t: censor(text), ts: now });
      }
      const messages = [];
      (await cref.orderByKey().limitToLast(60).get()).forEach(c => { const v = c.val(); messages.push({ me: v.s === me, text: v.t }); });
      return res.json({ open: true, messages });
    }

    let wrong = false;
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
      // The browser reports how many ms had passed on its own clock when the button was clicked, so
      // network delay and server cold starts don't count against the player. The server only trusts
      // that value if it is consistent with its own clock (at most 2.5 s earlier than the request arrived).
      const srvEl = now - p.d1_start, el = Number(req.body.el);
      const useEl = Number.isFinite(el) && el >= srvEl - 2500 && el <= srvEl + 300;
      const left = 60 - (useEl ? el : srvEl) / 1000;
      await ref.update({ d1_done: true, d1_left: +left.toFixed(2), d1_srv_left: +(60 - srvEl / 1000).toFixed(2) });   // kept for debugging
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
    if (action === 'code' && day === 4 && live() && /^\d{4}$/.test(String(code))) {
      const sec = (await db.ref('secret/day4').get()).val();
      const tries = p.d4_tries || 0;
      if (sec && tries < 3) {
        wrong = String(code) !== String(sec.code);
        if (!wrong) await ref.update({ current_day: 5 });
        else if (tries + 1 >= 3) await ref.update({ d4_tries: tries + 1, status: 'eliminated', eliminated_day: 4 });
        else await ref.update({ d4_tries: tries + 1 });
        p = await load();
      }
    }

    // Day 5 (Simon): the full random sequence lives on the server. The browser only receives
    // the part for the current level, and a wrong answer eliminates the player.
    if (day === 5 && live() && !Array.isArray(p.d5_seq)) {
      const len = Number((await db.ref('config/day5_len').get()).val()) || D5_DEFAULT_LEN;
      const seq = Array.from({ length: len }, () => Math.floor(Math.random() * 4));
      await ref.update({ d5_seq: seq, d5_level: 1, d5_phase: 1 });
      p = await load();
    }
    // Day 5 has 3 phases: 1 = Simon, 2 = logic puzzle (10 min), 3 = final puzzle (15 min).
    // Puzzle text, answer and minutes are set by the admin and stay on the server (secret/day5puz).
    let sec5 = null;
    if (day === 5) sec5 = (await db.ref('secret/day5puz').get()).val();
    const ph = () => p.d5_phase || 1;
    const cfg5 = () => sec5 && sec5['p' + ph()];
    const mins5 = () => Number(cfg5() && cfg5().minutes) || (ph() === 2 ? 10 : 15);
    if (action === 'seq' && day === 5 && live() && ph() === 1 && Array.isArray(p.d5_seq)) {
      const level = p.d5_level || 1;
      const input = req.body.seq;
      const ok = Array.isArray(input) && input.length === level && input.every((v, i) => v === p.d5_seq[i]);
      if (!ok) await ref.update({ status: 'eliminated', eliminated_day: 5 });
      else if (level >= p.d5_seq.length) await ref.update({ d5_phase: 2, d5_start: null, d5_tries: 0 });
      else await ref.update({ d5_level: level + 1 });
      p = await load();
    }
    // A puzzle phase that was started and not solved in time is a timeout
    if (day === 5 && live() && ph() >= 2 && p.d5_start && now > p.d5_start + mins5() * 60000 + GRACE) {
      await ref.update({ status: 'eliminated', eliminated_day: 5 });
      p = await load();
    }
    // The player presses Start; the server records the moment, so refreshing never resets the clock
    if (action === 'p5start' && day === 5 && live() && ph() >= 2 && cfg5() && !p.d5_start) {
      await ref.update({ d5_start: now, d5_tries: 0 });
      p = await load();
    }
    if (action === 'p5ans' && day === 5 && live() && ph() >= 2 && cfg5() && p.d5_start && typeof req.body.answer === 'string') {
      const tries = p.d5_tries || 0;
      if (tries < 3) {
        const accepted = String(cfg5().answer || '').split('|').map(norm5).filter(Boolean);
        wrong = !accepted.includes(norm5(req.body.answer.slice(0, 200)));
        if (!wrong) {
          if (ph() === 2) await ref.update({ d5_phase: 3, d5_start: null, d5_tries: 0 });
          else await ref.update({ current_day: 6 });
        } else if (tries + 1 >= 3) await ref.update({ d5_tries: tries + 1, status: 'eliminated', eliminated_day: 5 });
        else await ref.update({ d5_tries: tries + 1 });
        p = await load();
      }
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

    const day4view = async () => {
      const sec = (await db.ref('secret/day4').get()).val();
      if (!sec) return { screen: 'none', msg: 'Not ready yet. Come back later.' };
      return { screen: 'day4', clues: sec.clues || [], left: 3 - (p.d4_tries || 0), wrong };
    };

    const day5view = () => {
      if (!Array.isArray(p.d5_seq)) return { screen: 'none', msg: 'Not ready yet. Come back later.' };
      const phase = ph();
      if (phase === 1) {
        const level = p.d5_level || 1;
        return { screen: 'day5', phase, level, total: p.d5_seq.length, seq: p.d5_seq.slice(0, level) };
      }
      const c = cfg5();
      if (!c || !c.text) return { screen: 'none', msg: 'Not ready yet. Come back later.' };
      const minutes = mins5();
      if (!p.d5_start) return { screen: 'day5intro', phase, minutes };
      return { screen: 'day5puz', phase, text: c.text, endsAt: p.d5_start + minutes * 60000, left: 3 - (p.d5_tries || 0), wrong, now: Date.now() };
    };

    let view;
    if (p.reveal) view = { screen: 'reveal', ...p.reveal };
    else if (p.status === 'eliminated') view = { screen: 'eliminated', day: p.eliminated_day || p.current_day };
    else if (p.status === 'winner' || p.current_day > day) view = { screen: 'passed' };
    else if (st.closed) view = { screen: 'none', msg: 'This day is closed.' };
    else if (day === 1) view = { screen: 'day1', startAt: p.d1_start || null, now: Date.now() };
    else if (day === 2) view = await day2view();
    else if (day === 3) view = await day3view();
    else if (day === 4) view = await day4view();
    else if (day === 5) view = day5view();
    else view = { screen: 'none', msg: 'Game not available yet.' };

    res.json({ token: action === 'login' ? sign(uid) : undefined, view, now: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
};
