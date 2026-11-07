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
  hi: 75,            // % of a room's survivors that escaped: at or above this, the hunters are eliminated too
  lo: 25,            // at or below this, only the survivors still in the maze are eliminated and every hunter goes on
  minKills: 0,       // hunters go on at the "lo" outcome only with at least this many catches
  exitKills: 3,      // a hunter can use the exit (and pass) only with at least this many catches
  safe: 0,           // safe zone around the start AND the exit, in steps. 0 = automatic: it adapts to every maze.
  seed: 'terminal9',
};
// ======================================================================================
const MAX_CELLS_PER_S = 7;          // players walk at 4 cells/s; this is the generous bound the server accepts
const MAX_ROPE_UNITS_PER_S = 90;    // the rope game moves at most 60 units/s
const HIT = 2.4, SPAWN_SHIELD = 4000, ATK_COOLDOWN = 600, SEE = 11;   // cells / ms / cells

const num = (x, d, lo, hi) => { const v = Math.floor(Number(x)); return Math.min(hi, Math.max(lo, Number.isFinite(v) && x !== '' && x != null ? v : d)); };
function cfg(raw) {
  const r = raw || {}, D = DEFAULTS;
  return {
    mazeMin: num(r.mazeMin, D.mazeMin, 1, 120), ropeMin: num(r.ropeMin, D.ropeMin, 3, 120), roomSize: num(r.roomSize, D.roomSize, 2, 40) & ~1 || 2,
    lobby: num(r.lobby, D.lobby, 10, 1800), size: num(r.size, D.size, 21, 121) | 1, segs: num(r.segs, D.segs, 1, 10),
    cut: num(r.cut, D.cut, 0, 90), hi: num(r.hi, D.hi, 51, 100), lo: num(r.lo, D.lo, 0, 49), minKills: num(r.minKills, D.minKills, 0, 20),
    exitKills: num(r.exitKills, D.exitKills, 0, 50), safe: num(r.safe, D.safe, 0, 40), seed: String(r.seed || D.seed),
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
  const m = { n, grid, start, exit, dist, distE: bfs(grid, n, exit), pathLen: dist[exit] };
  cache.set(k, m); if (cache.size > 80) cache.delete(cache.keys().next().value);
  return m;
}
const roomMaze = (c, seedKey) => maze(c.seed, 'room' + seedKey, c.size);
const center = i => i; // (kept for readability)
const cellXY = (n, i) => ({ x: (i % n) + 0.5, y: Math.floor(i / n) + 0.5 });
// Safe zone radius (in steps) around the start and around the exit. 0 in the settings = automatic: the largest radius
// that keeps each zone under 8% of the maze, so it adapts to every size and every newly generated maze.
function zoneR(m, c) {
  if (c.safe > 0) return c.safe;
  if (m.autoZone) return m.autoZone;
  let open = 0; for (let i = 0; i < m.n * m.n; i++) if (!m.grid[i]) open++;
  const count = (d, r) => { let k = 0; for (let i = 0; i < d.length; i++) if (d[i] >= 0 && d[i] <= r) k++; return k; };
  let r = 5; for (let t = 6; t <= 30; t++) { if (count(m.dist, t) <= open * 0.08 && count(m.distE, t) <= open * 0.08) r = t; else break; }
  return (m.autoZone = Math.max(5, Math.min(r, Math.round(m.pathLen * 0.06))));   // and never more than ~6% of the way to the exit
}
// 'S' = inside the start zone, 'E' = inside the exit zone, null = outside both
const zoneOf = (m, c, cell) => { const r = zoneR(m, c); return m.dist[cell] >= 0 && m.dist[cell] <= r ? 'S' : (m.distE[cell] >= 0 && m.distE[cell] <= r ? 'E' : null); };
// The ring just outside a zone, where hunters may not hang around either
const nearZone = (m, c, cell) => { const r = zoneR(m, c) + 6; return (m.dist[cell] >= 0 && m.dist[cell] <= r) || (m.distE[cell] >= 0 && m.distE[cell] <= r); };
// Cells where a hunter may spawn or be teleported: open, outside both zones and their rings
const tpCells = (m, c) => { const out = []; for (let i = 0; i < m.n * m.n; i++) if (!m.grid[i] && !nearZone(m, c, i)) out.push(i); return out; };
const wire = (m, c) => ({ n: m.n, grid: Array.from(m.grid).join(''), start: m.start, exit: m.exit, zone: zoneR(m, c) });

// What happens at the end of the maze in one room. Survivors still inside are always out. For hunters:
//  'hi'  : at least `hi`% of the survivors escaped -> hunters still inside are eliminated too
//  'lo'  : at most `lo`% escaped -> hunters still inside go on (with at least minKills catches)
//  'only': fewer than 5 players, or a result between the two limits -> only those who found the exit pass
function mazeMode(roomPlayers, survivors, escaped, c) {
  if (roomPlayers < 5 || survivors < 1) return 'only';
  const pct = 100 * escaped / survivors;
  return pct >= c.hi ? 'hi' : pct <= c.lo ? 'lo' : 'only';
}

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
module.exports = { DEFAULTS, cfg, maze, roomMaze, cellXY, zoneR, zoneOf, nearZone, mazeMode, tpCells, wire, rope, buildRooms, rank, units, bfs, rng, HIT, SPAWN_SHIELD, ATK_COOLDOWN, SEE, MAX_CELLS_PER_S };
