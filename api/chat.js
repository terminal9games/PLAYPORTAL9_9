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

module.exports = { censor, clean };
