const { db, sign, verify, maintain, phase5, label5, resolveGroup5, ipKey, ipTouch, rlBlocked, rlFail, secLog, IP_MSG } = require('./_lib');
const D6 = require('./_d6');

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
// During these days a new login from a different network is refused while the ID was active in the last 3 minutes
// (stops someone from taking over an account in the middle of a critical day).
const LOCK_DAYS = [3, 4], LOCK_MS = 3 * 60000;
const flagIds = (text, uid) => { if (/t9-[a-z0-9-]{3,}/i.test(String(text))) return secLog('id_shared_in_chat', uid); };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, token, uid: rawUid, choice, code } = req.body || {};
  try {
    let uid, sid;
    const ipk = ipKey(req), t0 = Date.now();
    if (action === 'login') {
      if (ipk && await rlBlocked(ipk, t0)) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
      uid = String(rawUid || '').trim().toUpperCase();
      if (!ID.test(uid) || !(await db.ref('players/' + uid).get()).exists()) {
        if (ipk) await rlFail(ipk, t0);
        return res.status(404).json({ error: 'ID not found. Check it and try again.' });
      }
    } else {
      const s = verify(token);
      if (!s || !s.sid) return res.status(401).json({ error: 'Session expired. Log in again.', kicked: true });
      uid = s.uid; sid = s.sid;
    }
    const ref = db.ref('players/' + uid);
    const load = async () => (await ref.get()).val();
    const st = await maintain();
    const day = st.day;
    let p = await load();
    const now = Date.now();
    const live = () => p.status === 'active' && p.current_day === day && !st.closed;

    // ---- Session rules: one live session per ID, max 3 active players per network ----
    if (!p) return res.status(401).json({ error: 'Session expired. Log in again.', kicked: true });
    if (action === 'login') {
      if (LOCK_DAYS.includes(day) && p.sid && p.seen && now - p.seen < LOCK_MS && p.ipk && ipk && p.ipk !== ipk) {
        await secLog('login_refused_locked_day', uid);
        return res.status(423).json({ error: 'This ID is being used from another network right now. Try again in a few minutes.' });
      }
      if (ipk && !(await ipTouch(ipk, uid, now))) {
        await secLog('ip_limit', uid);
        return res.status(429).json({ error: IP_MSG, ipblock: true });
      }
      sid = require('crypto').randomBytes(12).toString('hex');
      const upd = { sid, seen: now };
      if (ipk) upd.ipk = ipk;
      if (p.sid && p.seen && now - p.seen < 10 * 60000) await secLog('previous_session_closed', uid);   // the old tab/device is signed out
      const cc = String((req.headers || {})['x-vercel-ip-country'] || '').slice(0, 2).toUpperCase();   // country only, never the IP
      if (cc) { if (!p.c0) upd.c0 = cc; else if (p.c0 !== cc) { upd.flag = 'new_country'; await secLog('new_country', uid); } }
      await ref.update(upd); p = await load();
    } else {
      if (p.sid !== sid) return res.status(401).json({ error: 'You were signed out: this ID was opened on another device.', kicked: true });
      if (ipk && !(await ipTouch(ipk, uid, now))) return res.status(403).json({ error: IP_MSG, ipblock: true });
      if (!p.seen || now - p.seen > 20000) await ref.update({ seen: now });
    }

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
        await flagIds(text, uid);
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
      if (left >= 7 && left < 8) await ref.update({ current_day: 1.5 });
      else await ref.update({ status: 'eliminated', eliminated_day: 1 });
      p = await load();
    }
    if (action === 'pick' && day === 2 && live() && p.pair && p.pair !== 'bye' && (choice === 'share' || choice === 'steal')) {
      const slot = (await db.ref(`pairs/day2/${p.pair}/a`).get()).val() === uid ? 'a' : 'b';
      const cref = db.ref(`pairs/day2/${p.pair}/choice_${slot}`);
      if (!(await cref.get()).exists()) await cref.set(choice);
    }
    if (action === 'vote15' && day === 1.5 && live() && (choice === 'continue' || choice === 'cancel')) {
      const vref = db.ref('d15/votes/' + uid);   // one vote per survivor, locked once cast
      if (!(await vref.get()).exists()) await vref.set(choice);
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

    // Day 5 (The Traitor): groups, a secret traitor per group, rounds of chat + vote.
    // Rounds are resolved from the clock by the first request after they end (see _lib.js).
    let cfg5 = null;
    if (day === 5 && p.g5 && p.status === 'active' && p.current_day === 5) {
      cfg5 = (await db.ref('config/day5').get()).val();
      if (cfg5 && cfg5.start) { await resolveGroup5(p.g5, cfg5, now); p = await load(); }
    }
    if ((action === 'say5' || action === 'vote5') && day === 5 && live() && p.g5 && cfg5 && cfg5.start) {
      const ph = phase5(cfg5, now);
      const g = (await db.ref('groups/day5/' + p.g5).get()).val();
      const mine = g && g.members ? g.members[uid] : undefined;
      if (g && !g.result && mine !== undefined && !(g.out && uid in g.out)) {
        if (action === 'say5' && (ph.state === 'discuss' || ph.state === 'vote')) {
          const text = clean(req.body.text);
          if (!text) return res.status(400).json({ error: 'Write something first.' });
          if (now - (p.chat_last || 0) < 700) return res.status(429).json({ error: 'Slow down.' });
          await ref.update({ chat_last: now });
          await flagIds(text, uid);
          await db.ref('chats/day5/' + p.g5).push({ s: mine, t: censor(text), ts: now });
        }
        if (action === 'vote5' && ph.state === 'vote') {
          const t = req.body.target;
          const ok = t === -1 || (Number.isInteger(t) && t !== mine && Object.keys(g.members).some(u => g.members[u] === t && !(g.out && u in g.out)));
          if (ok) await db.ref(`groups/day5/${p.g5}/votes/r${ph.round}/${uid}`).set(t);
        }
      }
    }

    // Day 6 (Sacrifices): a solo game. The script is in _d6.js; each player's progress is in d6/<uid>.
    // The player can name an acquaintance (their ID). If that person is playing, they are asked a question
    // about it later, and if they admit they might betray, the first player gets a secret whisper.
    let d6 = null, cfg6 = {};
    if (day === 6 && live()) {
      cfg6 = (await db.ref('config/day6').get()).val() || {};
      d6 = (await db.ref('d6/' + uid).get()).val();
      if (d6) { d6.ans = d6.ans || {}; d6.sac = d6.sac || []; d6.kept = d6.kept || []; d6.cold = d6.cold || 0; }
      const cap = (Number(cfg6.minutes) || 40) * 60000;
      if (d6 && d6.start && !d6.done && now > d6.start + cap + GRACE) {   // ran out of time
        await ref.update({ status: 'eliminated', eliminated_day: 6 });
        p = await load(); d6 = null;
      }
    }
    if (action === 'd6start' && day === 6 && live() && !d6) {
      d6 = { start: now, idx: 0, shown: now, ans: {}, sac: [], kept: D6.ITEMS.map(i => i.id), cold: 0 };
      await db.ref('d6/' + uid).set(d6);
    }
    if ((action === 'd6next' || action === 'd6ans') && day === 6 && live() && d6 && d6.start && !d6.done && req.body.idx === d6.idx) {
      const step = D6.STEPS[d6.idx], value = req.body.value;
      if (now < d6.shown + step.min * 1000 - 1500) return res.status(400).json({ error: 'Take a moment before you answer.' });
      let ok = true;
      if (step.type === 'text') ok = action === 'd6next';
      else if (action !== 'd6ans') ok = false;
      else if (step.type === 'choice') {
        const o = step.opts.find(x => x[0] === value);
        if (!o) ok = false;
        else {
          d6.ans[step.id] = o[0]; d6.cold += o[2] || 0;
          if (step.id === 'betray' && d6.linkId) await db.ref(`d6links/${uid}/${d6.linkId}/betray`).set(o[0]);
        }
      } else if (step.type === 'input') {
        // The answer is never confirmed or denied to the player, so this can't be used to find valid IDs.
        const id = String(value || '').trim().toUpperCase().slice(0, 40);
        d6.ans[step.id] = 'given';
        if (ID.test(id) && id !== uid) {
          d6.friendId = id;
          if ((await db.ref('players/' + id).get()).exists()) await db.ref(`d6links/${id}/${uid}`).set({ at: now });
        }
      } else if (step.type === 'sacrifice') {
        const it = D6.ITEMS.find(i => i.id === value);
        if (it && d6.kept.includes(it.id)) { d6.kept = d6.kept.filter(x => x !== it.id); d6.sac.push(it.id); d6.cold += it.cold; }
        else ok = false;
      }
      if (!ok) return res.status(400).json({ error: 'Choose one of the options.' });
      const links = (await db.ref('d6links/' + uid).get()).val() || {};   // people who named this player
      const ctx = { linkId: d6.linkId || Object.keys(links).sort()[0] || null };
      if (ctx.linkId) d6.linkId = ctx.linkId;
      const ni = D6.nextIdx(d6, d6.idx + 1, ctx);
      if (ni < 0) { d6.done = true; d6.finished = now; } else { d6.idx = ni; d6.shown = now; }
      await db.ref('d6/' + uid).set(d6);
    }
    if (day === 6 && d6 && d6.friendId && !d6.whisper) {   // the person they named admitted they might betray
      const b = (await db.ref(`d6links/${d6.friendId}/${uid}/betray`).get()).val();
      if (b === 'yes' || b === 'ifneeded') { d6.whisper = true; await db.ref('d6/' + uid + '/whisper').set(true); }
    }

    if (action === 'ack') { await ref.child('reveal').remove(); p = await load(); }

    const day15view = async () => {
      const mine = (await db.ref('d15/votes/' + uid).get()).val();
      const all = (await db.ref('players').get()).val() || {};
      const ids = Object.keys(all);
      const survivors = ids.filter(i => all[i].status !== 'eliminated' && all[i].current_day >= 1.5).length;
      return { screen: mine ? 'wait15' : 'pick15', survivors, initial: ids.length, value: 1,
        pool: +(survivors * 0.95).toFixed(2), max: +(ids.length * 0.95).toFixed(2), myVote: mine || null };
    };

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

    const day5view = async () => {
      if (!p.g5) return { screen: 'none', msg: 'Groups not assigned yet. Come back later.' };
      if (!cfg5 || !cfg5.start) return { screen: 'none', msg: 'The game has not started yet. Come back later.' };
      const g = (await db.ref('groups/day5/' + p.g5).get()).val();
      if (!g || !g.members || g.members[uid] === undefined) return { screen: 'none', msg: 'Groups not assigned yet. Come back later.' };
      const ph = phase5(cfg5, now), out = g.out || {};
      const players = Object.keys(g.members).map(u => ({ idx: g.members[u], label: label5(g.members[u]), alive: !(u in out), me: u === uid })).sort((x, y) => x.idx - y.idx);
      const messages = [];
      (await db.ref('chats/day5/' + p.g5).orderByKey().limitToLast(80).get()).forEach(c => {
        const v = c.val();
        messages.push({ who: v.s >= 0 ? label5(v.s) : null, me: v.s === g.members[uid], sys: v.s < 0, text: v.t });
      });
      const myVote = ph.state === 'vote' && g.votes && g.votes['r' + ph.round] ? g.votes['r' + ph.round][uid] : undefined;
      return {
        screen: 'day5', state: ph.state, round: ph.round + 1, rounds: cfg5.rounds, endsAt: ph.endsAt, now: Date.now(),
        role: uid === g.traitor ? 'traitor' : 'crew', me: label5(g.members[uid]), players,
        myVote: typeof myVote === 'number' ? myVote : null, messages
      };
    };

    const day6view = () => {
      const cap = (Number(cfg6.minutes) || 40) * 60000;
      if (!d6 || !d6.start) return { screen: 'day6intro', minutes: cap / 60000 };
      const whisper = d6.whisper ? 'pss, your friend may betray you' : null;
      if (d6.done) return { screen: 'day6wait', whisper };
      const step = D6.STEPS[d6.idx];
      return { screen: 'day6', step: D6.present(d6), readyAt: d6.shown + step.min * 1000, endsAt: d6.start + cap, now: Date.now(), whisper };
    };

    let view;
    if (p.reveal) view = { screen: 'reveal', ...p.reveal };
    else if (p.status === 'eliminated') view = { screen: 'eliminated', day: p.eliminated_day || p.current_day };
    else if (st.ended && p.status === 'active') view = { screen: 'ended', pct: st.ended.pct };
    else if (p.status === 'winner' || p.current_day > day) view = { screen: 'passed' };
    else if (st.closed) view = { screen: 'none', msg: 'This day is closed.' };
    else if (day === 1.5) view = await day15view();
    else if (day === 1) view = { screen: 'day1', startAt: p.d1_start || null, now: Date.now() };
    else if (day === 2) view = await day2view();
    else if (day === 3) view = await day3view();
    else if (day === 4) view = await day4view();
    else if (day === 5) view = await day5view();
    else if (day === 6) view = day6view();
    else view = { screen: 'none', msg: 'Game not available yet.' };

    res.json({ token: action === 'login' ? sign(uid, sid) : undefined, view, now: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
};
