// Day 6: "Sacrifices". A solo, text-only game. Everything here runs on the server: the browser only
// receives the text of the current step, never the hidden numbers (the "cold" values) or the rules.
//
// ===== EDIT: all the texts and the hidden values live in this file =====

// If true, the other player's exact ID is shown in the "Do you know ...?" question.
// Keep it false: the ID is also the login password, so showing it would let that player log in as them.
const SHOW_FULL_ID = false;
const mask = id => {
  if (SHOW_FULL_ID) return id;
  const r = String(id).slice(3);
  return r.length <= 2 ? 'T9-**' : 'T9-' + r[0] + '*'.repeat(r.length - 2) + r[r.length - 1];
};

// The six things the player must give up, one per round. `cold` is hidden:
// positive = giving it up looks cold / selfish, negative = giving it up looks selfless.
const ITEMS = [
  { id: 'promise',    name: 'A promise',              desc: 'one you made to someone who trusted you',            cold: 2 },
  { id: 'person',     name: 'The one who stays',      desc: 'the person who would never leave you',               cold: 3 },
  { id: 'conscience', name: 'A clear conscience',     desc: 'sleeping without a single doubt',                    cold: 2 },
  { id: 'home',       name: 'A place to return to',   desc: 'a door that is always open for you',                 cold: 1 },
  { id: 'name',       name: 'Your name',              desc: 'remembered by everyone after you are gone',          cold: -2 },
  { id: 'dream',      name: 'Your dream',             desc: 'the thing you always wanted to become',              cold: -3 },
];
const itemName = id => (ITEMS.find(i => i.id === id) || {}).name || null;

const GONE = {
  promise:    'The promise is broken. Somewhere, someone is still waiting for you to keep it.',
  person:     'They are gone. They would have stayed.',
  conscience: 'Your conscience goes quiet. It will not come back.',
  home:       'The place is empty now. The light was left on for you.',
  name:       'Your name fades. Nobody says it anymore.',
  dream:      'You stop wanting it. That is lighter, and emptier.',
};

// Lines that use what the player said before ("the mirror"). The first rule that matches is used.
function echo(st) {
  const last = st.sac[st.sac.length - 1], a = st.ans;
  if (last === 'person' && a.fear === 'love') return 'You said you feared losing someone you love. That fear lasted a few minutes.';
  if (last === 'person' && a.alone === 'alone') return 'You said you would rather win alone. At least you are consistent.';
  if (last === 'dream' && a.regret === 'chance') return 'You said a chance never taken is the worst regret. You just did it on purpose.';
  if (last === 'conscience' && a.sleep === 'forever') return 'You told us it stays with you forever. Not anymore.';
  if (last === 'name' && a.power === 'feared') return 'You wanted to be feared. It is hard to be feared when nobody says your name.';
  if (last === 'promise' && a.lie === 'never') return 'You said you never lie. A broken promise is the loudest lie there is.';
  if (last === 'home' && a.alone === 'together') return 'You said you would lose together. And yet you closed the door they were waiting behind.';
  if (last === 'promise' && a.forgive === 'never') return 'You said you could never forgive a betrayal. Remember that when someone forgives yours.';
  return 'Terminal 9 noticed that.';
}
function ending(st) {
  const kept = st.kept[0], a = st.ans;
  const lines = ['You kept: ' + itemName(kept) + '.', 'Everything else is gone.'];
  if (kept === 'person' && a.alone === 'alone') lines.push('You said you would rather win alone. You kept someone anyway.');
  else if (kept === 'dream' && a.alone === 'together') lines.push('You said you would lose together. You kept only yourself.');
  else if (kept === 'name') lines.push('You will be remembered. By whom, we cannot say.');
  else if (kept === 'conscience') lines.push('You will sleep well. That is all you will have.');
  return lines;
}

// ----- the script -----
// type: 'text' (Continue), 'choice' (opts: [id, label, hiddenCold]), 'input', 'sacrifice'
// min: seconds the step stays on screen before the server accepts an answer (prevents skipping)
// when(st, ctx): the step is skipped when it returns false
const c = (id, label, cold) => [id, label, cold || 0];
const hasFriend = st => st.ans.friend === 'yes' || st.ans.friend === 'maybe';
const hasLink = (st, ctx) => !!ctx.linkId;

const STEPS = [
  { id: 'intro', type: 'text', min: 6, lines: ['TERMINAL 9 // PERSONAL FILE', 'There are no right answers here.', 'Answer quickly. Answer honestly. Everything you say is remembered.'] },

  // ---- Part I: the mirror ----
  { id: 'fear', type: 'choice', min: 8, q: 'What do you fear losing the most?',
    opts: [c('love', 'Someone I love'), c('freedom', 'My freedom'), c('pride', 'My pride'), c('work', 'Everything I have built')] },
  { id: 'lie', type: 'choice', min: 8, q: 'When did you last lie to protect someone?',
    opts: [c('today', 'Today'), c('week', 'This week'), c('longago', 'A long time ago'), c('never', 'I never lie')] },
  { id: 'secret', type: 'choice', min: 8, q: 'Have you ever kept a secret that would have hurt someone to hear?',
    opts: [c('yes', 'Yes'), c('no', 'No')] },
  { id: 'alone', type: 'choice', min: 8, q: 'Would you rather win alone, or lose together with the people you care about?',
    opts: [c('alone', 'Win alone', 1), c('together', 'Lose together', -1)] },
  { id: 'friend', type: 'choice', min: 8, q: 'Do you know anyone else who is playing this tournament?',
    opts: [c('yes', 'Yes'), c('maybe', 'I think so'), c('no', 'No')] },
  { id: 'friendId', type: 'input', min: 6, when: hasFriend, q: 'Write their exact ID.', ph: 'T9-...' },
  { id: 'noted', type: 'text', min: 5, when: hasFriend, lines: ['Noted.', 'We will remember that name.'] },
  { id: 'power', type: 'choice', min: 8, q: 'Would you rather be feared, or loved?',
    opts: [c('feared', 'Feared', 1), c('loved', 'Loved', -1)] },
  { id: 'regret', type: 'choice', min: 8, q: 'Which is worse?',
    opts: [c('mistake', 'A mistake I made'), c('chance', 'A chance I never took')] },
  { id: 'mirror1', type: 'text', min: 8, lines: st => {
      const f = { love: 'someone you love', freedom: 'your freedom', pride: 'your pride', work: 'everything you have built' }[st.ans.fear] || 'something';
      return ['You said you fear losing ' + f + '.', 'Keep that in mind.'];
    } },

  // ---- Part II: the sacrifices ----
  { id: 'rules', type: 'text', min: 10, lines: ['Terminal 9 has given you six things.', 'You can keep only one.', 'Each round you must give one up.', 'There is no way back.'] },
  { id: 's1', type: 'sacrifice', min: 15 },
  { id: 'e1', type: 'text', min: 8, lines: st => [GONE[st.sac[0]], echo(st)] },
  { id: 's2', type: 'sacrifice', min: 15 },
  { id: 'e2', type: 'text', min: 8, lines: st => [GONE[st.sac[1]], echo(st)] },

  // ---- A person who named you (only shown if another player named this player) ----
  { id: 'know', type: 'choice', min: 8, secret: true, when: hasLink, q: (st) => 'Do you know ' + mask(st.linkId) + '?',
    opts: [c('yes', 'Yes'), c('no', 'No'), c('unsure', 'I am not sure')] },
  { id: 'linkinfo', type: 'text', min: 8, secret: true, when: hasLink, lines: st => [mask(st.linkId) + ' is an acquaintance of yours.', 'They are also in the tournament.'] },
  { id: 'betray', type: 'choice', min: 12, when: hasLink, q: 'Would you betray them to win the grand prize?',
    opts: [c('yes', 'Yes. The prize is the prize.', 2), c('ifneeded', 'Only if I had no other choice.', 1), c('no', 'No. Never.', -1)] },

  { id: 'forgive', type: 'choice', min: 8, q: 'Could you forgive someone who betrayed you for money?',
    opts: [c('easily', 'Yes, easily', -1), c('ifasked', 'Only if they asked', 0), c('never', 'Never', 1)] },
  { id: 's3', type: 'sacrifice', min: 15 },
  { id: 'e3', type: 'text', min: 8, lines: st => [GONE[st.sac[2]], echo(st)] },
  { id: 'sleep', type: 'choice', min: 8, q: 'After doing something wrong, how long does it stay with you?',
    opts: [c('sleep', 'Until I sleep', 1), c('weeks', 'For weeks'), c('forever', 'Forever', -1)] },
  { id: 'forgot', type: 'choice', min: 8, q: 'Which would hurt more?',
    opts: [c('forgotten', 'Being forgotten'), c('hated', 'Being hated')] },
  { id: 's4', type: 'sacrifice', min: 15 },
  { id: 'e4', type: 'text', min: 8, lines: st => [GONE[st.sac[3]], echo(st)] },
  { id: 'prize', type: 'choice', min: 10, q: 'If the grand prize were yours tomorrow, what would you feel?',
    opts: [c('relief', 'Relief'), c('guilt', 'Guilt', -1), c('hunger', 'Hunger for more', 1), c('nothing', 'Nothing', 1)] },
  { id: 's5', type: 'sacrifice', min: 15, last: true },
  { id: 'e5', type: 'text', min: 8, lines: st => [GONE[st.sac[4]], echo(st)] },
  { id: 'end', type: 'text', min: 10, lines: st => ending(st).concat(['', 'Terminal 9 will decide.', 'Come back later.']) },
];

// First step at or after `from` that applies to this player; -1 when the script is over.
function nextIdx(st, from, ctx) {
  for (let i = from; i < STEPS.length; i++) if (!STEPS[i].when || STEPS[i].when(st, ctx)) return i;
  return -1;
}
const val = (x, st) => (typeof x === 'function' ? x(st) : x);

// What the browser receives for the current step.
function present(st) {
  const s = STEPS[st.idx];
  const out = { type: s.type, idx: st.idx, secret: !!s.secret };
  if (s.type === 'text') out.lines = val(s.lines, st);
  if (s.type === 'choice') { out.q = val(s.q, st); out.opts = s.opts.map(o => ({ id: o[0], label: o[1] })); }
  if (s.type === 'input') { out.q = val(s.q, st); out.ph = s.ph || ''; }
  if (s.type === 'sacrifice') {
    out.q = s.last ? 'Two things are left. Give one up.' : 'Give one up.';
    out.round = st.sac.length + 1;
    out.items = ITEMS.filter(i => st.kept.includes(i.id)).map(i => ({ id: i.id, name: i.name, desc: i.desc }));
  }
  return out;
}

module.exports = { STEPS, ITEMS, itemName, mask, nextIdx, present };
