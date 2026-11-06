// Day 7: "The Dark Maze" (hunters against survivors, live) + "The Tightrope" (solo).
// The server builds the mazes from a seed, validates every move, decides every kill and every escape, and
// keeps the only clock that counts. Browsers only draw and send "where I am". Players are never shown IDs:
// inside a room everyone is just a role and a number.
//
// ===== EDIT: defaults. The admin panel can change them without touching this file =====
const DEFAULTS = {
  mazeMin: 25,       // minutes of live maze
  ropeMin: 25,       // minutes each player has for the rope, counted from the moment they press Start
  roomSize: 8,       // players per room (half hunters, half survivors)
  lobby: 180,        // seconds between pressing "start" in the admin and the maze opening
  size: 61,          // maze size in grid cells (odd)
  segs: 5,           // rope segments
  cut: 30,           // % of the rope ranking that is eliminated
  need: 50,          // % of its room's survivors that must fail to escape for the hunters to pass
  minKills: 1,       // a hunter with fewer kills is eliminated
  zone: 12,          // spawn safe zone: cells within this many steps of the survivors' start. Hunters cannot enter.
  lives: 0,          // deaths before a survivor is eliminated. 0 = unlimited (they just go back to the start)
  seed: 'terminal9',
};
// ======================================================================================
const MAX_CELLS_PER_S = 7;          // players walk at 4 cells/s; this is the generous bound the server accepts
const MAX_ROPE_UNITS_PER_S = 90;    // the rope game moves at most 60 units/s
const HIT = 2.4, SPAWN_SHIELD = 3500, ATK_COOLDOWN = 600, SEE = 11;   // cells / ms / cells

const num = (x, d, lo, hi) => { const v = Math.floor(Number(x)); return Math.min(hi, Math.max(lo, Number.isFinite(v) && x !== '' && x != null ? v : d)); };
function cfg(raw) {
  const r = raw || {}, D = DEFAULTS;
  return {
    mazeMin: num(r.mazeMin, D.mazeMin, 1, 120), ropeMin: num(r.ropeMin, D.ropeMin, 3, 120), roomSize: num(r.roomSize, D.roomSize, 2, 40) & ~1 || 2,
    lobby: num(r.lobby, D.lobby, 10, 1800), size: num(r.size, D.size, 21, 121) | 1, segs: num(r.segs, D.segs, 1, 10),
    cut: num(r.cut, D.cut, 0, 90), need: num(r.need, D.need, 1, 100), minKills: num(r.minKills, D.minKills, 0, 20),
    zone: num(r.zone, D.zone, 3, 30), lives: num(r.lives, D.lives, 0, 50), seed: String(r.seed || D.seed),
  };
}

function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function bfs(grid, n, from) {
  const d = new Int32Array(n * n).fill(-1), q = [from]; d[from] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = c % n;
    for (const nb of [x > 0 ? c - 1 : -1, x < n - 1 ? c + 1 : -1, c - n, c + n]) if (nb >= 0 && nb < n * n && !grid[nb] && d[nb] < 0) { d[nb] = d[c] + 1; q.push(nb); }
  }
  return d;
}

const cache = new Map();
function maze(seed, key, size) {
  const k = seed + '|' + key + '|' + size;
  if (cache.has(k)) return cache.get(k);
  const n = size, R = rng(seed + '#' + key), grid = new Uint8Array(n * n).fill(1);   // 1 = wall
  const stack = [[1, 1]]; grid[n + 1] = 0;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const opts = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([dx, dy]) => x + dx > 0 && x + dx < n - 1 && y + dy > 0 && y + dy < n - 1 && grid[(y + dy) * n + x + dx]);
    if (!opts.length) { stack.pop(); continue; }
    const [dx, dy] = opts[Math.floor(R() * opts.length)];
    grid[(y + dy / 2) * n + x + dx / 2] = 0; grid[(y + dy) * n + x + dx] = 0; stack.push([x + dx, y + dy]);
  }
  // extra openings: more than one route, so hunters cannot simply wait in one corridor
  for (let t = 0, want = Math.floor(n * n / 60); t < want * 8 && want > 0; t++) {
    const x = 1 + Math.floor(R() * (n - 2)), y = 1 + Math.floor(R() * (n - 2)), i = y * n + x;
    if (!grid[i]) continue;
    const h = !grid[i - 1] && !grid[i + 1] && grid[i - n] && grid[i + n], v = !grid[i - n] && !grid[i + n] && grid[i - 1] && grid[i + 1];
    if (h || v) { grid[i] = 0; want--; }
  }
  const start = n + 1, dist = bfs(grid, n, start);
  let exit = start; for (let i = 0; i < n * n; i++) if (dist[i] > dist[exit]) exit = i;
  const m = { n, grid, start, exit, dist, pathLen: dist[exit] };
  cache.set(k, m); if (cache.size > 80) cache.delete(cache.keys().next().value);
  return m;
}
const roomMaze = (c, seedKey) => maze(c.seed, 'room' + seedKey, c.size);
const center = i => i; // (kept for readability)
const cellXY = (n, i) => ({ x: (i % n) + 0.5, y: Math.floor(i / n) + 0.5 });
const inZone = (m, c, cell) => m.dist[cell] >= 0 && m.dist[cell] <= c.zone;
// Cells where a hunter may spawn or be teleported: open, outside the safe zone and not close to it
const tpCells = (m, c) => { const out = []; for (let i = 0; i < m.n * m.n; i++) if (!m.grid[i] && m.dist[i] > c.zone + 6) out.push(i); return out; };
const wire = m => ({ n: m.n, grid: Array.from(m.grid).join(''), start: m.start, exit: m.exit });

// Tightrope: segment s is longer and windier than the one before
const rope = (c, s) => ({ seg: s, len: 2400 + 600 * s, amp: +(0.8 + 0.2 * s).toFixed(2), seed: c.seed + '~' + s, minMs: Math.ceil((2400 + 600 * s) / MAX_ROPE_UNITS_PER_S * 1000) });

// Rooms: even teams. An odd player out becomes a spectator, then goes to the rope when the maze ends.
function buildRooms(ids, c) {
  const a = ids.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const spec = a.length % 2 ? a.pop() : null, pairs = a.length / 2;
  if (!pairs) return { rooms: [], spec };
  const nRooms = Math.max(1, Math.round(pairs / (c.roomSize / 2))), rooms = Array.from({ length: nRooms }, () => []);
  for (let p = 0; p < pairs; p++) rooms[p % nRooms].push(a[2 * p], a[2 * p + 1]);
  return { rooms: rooms.filter(r => r.length), spec };
}

const rank = (d7, ids) => {
  const fin = ids.filter(i => d7[i] && d7[i].done).sort((a, b) => d7[a].total - d7[b].total);
  const rest = ids.filter(i => !(d7[i] && d7[i].done)).sort((a, b) => ((d7[b] && d7[b].prog) || 0) - ((d7[a] && d7[a].prog) || 0));
  return fin.concat(rest);
};
const units = c => c.segs;
module.exports = { DEFAULTS, cfg, maze, roomMaze, cellXY, inZone, tpCells, wire, rope, buildRooms, rank, units, bfs, rng, HIT, SPAWN_SHIELD, ATK_COOLDOWN, SEE, MAX_CELLS_PER_S };
