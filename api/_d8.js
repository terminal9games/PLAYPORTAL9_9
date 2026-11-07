// Day 8: "The Elimination Wheel" - the final. Every finalist is in one room with a long table of food.
// Once in a while a wheel picks two players for a quick-draw duel in front of everybody, and once in a while a knife
// appears on the floor. The last player standing wins. The server holds the only clock and decides everything.
// Players are known only by a code (P1, P2...) that is drawn at random when the final is opened. IDs are never sent.
//
// ===== EDIT: defaults. The admin panel can change them without touching this file =====
const DEFAULTS = {
  chatMin: 10,     // minutes of briefing + chat before the lobby (the chat disappears when the lobby starts)
  lobby: 60,       // seconds of lobby before the room opens
  wheelMin: 5,     // the wheel appears at random, between wheelMin and wheelMax minutes after the last duel
  wheelMax: 10,
  knifeMin: 2,     // a knife appears at random between knifeMin and knifeMax minutes
  knifeMax: 4,
  knifeSec: 5,     // seconds a player has to use the knife once they pick it up
  drawMin: 2,      // after the lights come on, the button turns green after a random delay (seconds)
  drawMax: 6,
  shootMs: 2500,   // after it turns green, how long the other player has to answer
  maxMin: 60,      // after this many minutes of play the wheel speeds up (sudden death) until one player is left
  size: 21,        // the room is size x size cells
  prize: 'The grand prize',
};
// ======================================================================================
const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
function cfg(raw) {
  const r = raw || {}, o = {};
  o.chatMin = clamp(r.chatMin, 0, 120, DEFAULTS.chatMin); o.lobby = clamp(r.lobby, 5, 900, DEFAULTS.lobby);
  o.wheelMin = clamp(r.wheelMin, 0.1, 60, DEFAULTS.wheelMin); o.wheelMax = Math.max(o.wheelMin, clamp(r.wheelMax, 0.1, 90, DEFAULTS.wheelMax));
  o.knifeMin = clamp(r.knifeMin, 0.1, 60, DEFAULTS.knifeMin); o.knifeMax = Math.max(o.knifeMin, clamp(r.knifeMax, 0.1, 90, DEFAULTS.knifeMax));
  o.knifeSec = clamp(r.knifeSec, 2, 20, DEFAULTS.knifeSec);
  o.drawMin = clamp(r.drawMin, 1, 15, DEFAULTS.drawMin); o.drawMax = Math.max(o.drawMin, clamp(r.drawMax, 1, 30, DEFAULTS.drawMax));
  o.shootMs = clamp(r.shootMs, 800, 8000, DEFAULTS.shootMs); o.maxMin = clamp(r.maxMin, 1, 600, DEFAULTS.maxMin);
  o.size = Math.round(clamp(r.size, 15, 41, DEFAULTS.size)); o.prize = String(r.prize == null ? DEFAULTS.prize : r.prize).slice(0, 120);
  return o;
}

// The room: walls around, and a long table in the middle (the food). Everything else is open floor.
function room(n) {
  const g = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) { g[i] = 1; g[(n - 1) * n + i] = 1; g[i * n] = 1; g[i * n + n - 1] = 1; }
  const mid = Math.floor(n / 2), t = { x0: 4, x1: n - 5, y0: mid - 1, y1: mid + 1 };
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) g[y * n + x] = 1;
  const open = []; for (let i = 0; i < n * n; i++) if (!g[i]) open.push(i);
  return { n, g, table: t, open };
}
const wire = r => ({ n: r.n, grid: Array.from(r.g).join(''), table: r.table });
const cellXY = (n, c) => ({ x: (c % n) + 0.5, y: Math.floor(c / n) + 0.5 });
const blocked = (r, x, y) => x < 0 || y < 0 || x >= r.n || y >= r.n || r.g[Math.floor(y) * r.n + Math.floor(x)] === 1;
// start positions: spread around the walls so nobody starts on top of another player
function spawns(r, count) {
  const ring = r.open.filter(c => { const p = cellXY(r.n, c); return Math.min(p.x, p.y, r.n - p.x, r.n - p.y) < 3; });
  const out = [], pool = ring.slice().sort(() => Math.random() - 0.5);
  for (const c of pool) { const p = cellXY(r.n, c); if (out.every(q => Math.hypot(q.x - p.x, q.y - p.y) > 2.2)) out.push(p); if (out.length >= count) break; }
  for (const c of pool) { if (out.length >= count) break; out.push(cellXY(r.n, c)); }
  return out;
}
// The wheel and the knife are announced to everybody, so only these numbers are fixed here
const WHEEL_SPIN = 5500, LIGHTS_FADE = 1500, RESULT_MS = 5000, SPEED = 7, STAB_RANGE = 1.9, PICK_RANGE = 1.1;
module.exports = { DEFAULTS, cfg, room, wire, cellXY, blocked, spawns, WHEEL_SPIN, LIGHTS_FADE, RESULT_MS, SPEED, STAB_RANGE, PICK_RANGE };
