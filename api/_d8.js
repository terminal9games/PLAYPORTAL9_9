// Day 8: "The Elimination Wheel" - the final. Every finalist is in one room with a long table of food.
// Once in a while a wheel picks two players for a quick-draw duel in front of everybody, and once in a while a knife
// appears on the floor. The last player standing wins. The server holds the only clock and decides everything.
// Players are known only by a code (P1, P2...) that is drawn at random when the final is opened. IDs are never sent.
//
// ===== EDIT: defaults. The admin panel can change them without touching this file =====
const DEFAULTS = {
  chatMin: 10,     // minutes of briefing + chat before the lobby (the chat disappears when the lobby starts)
  lobby: 60,       // seconds of lobby before the room opens
  wheelMin: 300,   // the wheel appears at random, between wheelMin and wheelMax SECONDS after the last duel
  wheelMax: 600,
  knifeMin: 120,   // a knife appears at random between knifeMin and knifeMax SECONDS
  knifeMax: 240,
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
  o.wheelMin = clamp(r.wheelMin, 5, 3600, DEFAULTS.wheelMin); o.wheelMax = Math.max(o.wheelMin, clamp(r.wheelMax, 5, 5400, DEFAULTS.wheelMax));
  o.knifeMin = clamp(r.knifeMin, 5, 3600, DEFAULTS.knifeMin); o.knifeMax = Math.max(o.knifeMin, clamp(r.knifeMax, 5, 5400, DEFAULTS.knifeMax));
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
// start positions: spread evenly around the long table, like guests sitting down to eat
function spawns(r, count) {
  const t = r.table, cx = (t.x0 + t.x1 + 1) / 2, cy = (t.y0 + t.y1 + 1) / 2, rx = (t.x1 - t.x0 + 1) / 2 + 1.6, ry = (t.y1 - t.y0 + 1) / 2 + 1.6;
  const out = [], total = Math.max(count, 1), off = Math.random() * Math.PI * 2;
  for (let i = 0; i < total; i++) {
    const a = off + i * Math.PI * 2 / total; let x = cx + Math.cos(a) * rx * 1.05, y = cy + Math.sin(a) * ry * 1.05;
    x = Math.min(r.n - 1.6, Math.max(1.6, x)); y = Math.min(r.n - 1.6, Math.max(1.6, y));
    if (blocked(r, x, y)) { const c = r.open[Math.floor(Math.random() * r.open.length)]; out.push(cellXY(r.n, c)); } else out.push({ x, y });
  }
  return out;
}
// The wheel and the knife are announced to everybody, so only these numbers are fixed here
const WHEEL_SPIN = 10000, LIGHTS_FADE = 1500, RESULT_MS = 5000, SPEED = 7, STAB_RANGE = 1.9, PICK_RANGE = 1.1;
module.exports = { DEFAULTS, cfg, room, wire, cellXY, blocked, spawns, WHEEL_SPIN, LIGHTS_FADE, RESULT_MS, SPEED, STAB_RANGE, PICK_RANGE };
