// Day 7: "The Dark Maze" + "The Tightrope". One continuous hour of action.
// The server builds the mazes from a seed (the same for every player), checks that nobody finishes faster
// than is physically possible, and keeps the only clock that counts. The browser only draws and moves.
//
// ===== EDIT: defaults. The admin panel can change them without touching this file =====
const DEFAULTS = { minutes: 60, levels: 3, size: 71, segs: 5, cut: 40, seed: 'terminal9' };
// ======================================================================================
const MAX_CELLS_PER_S = 7;     // players walk at 4 cells/s; this is the generous upper bound the server accepts
const MAX_ROPE_UNITS_PER_S = 90;   // the game moves at most 60 units/s

const num = (x, d, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(x)) || d));
function cfg(raw) {
  const r = raw || {};
  return {
    minutes: num(r.minutes, DEFAULTS.minutes, 5, 180), levels: num(r.levels, DEFAULTS.levels, 1, 6),
    size: num(r.size, DEFAULTS.size, 21, 121) | 1, segs: num(r.segs, DEFAULTS.segs, 1, 10),
    cut: Math.min(90, Math.max(0, Number(r.cut == null ? DEFAULTS.cut : r.cut))), seed: String(r.seed || DEFAULTS.seed),
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
    const c = q[h];
    for (const nb of [c - 1, c + 1, c - n, c + n]) if (nb >= 0 && nb < n * n && !grid[nb] && d[nb] < 0 && Math.abs((nb % n) - (c % n)) <= 1) { d[nb] = d[c] + 1; q.push(nb); }
  }
  return d;
}

const cache = new Map();
function maze(seed, level, size) {
  const key = seed + '|' + level + '|' + size;
  if (cache.has(key)) return cache.get(key);
  const n = size, R = rng(seed + '#' + level), grid = new Uint8Array(n * n).fill(1);   // 1 = wall
  const stack = [[1, 1]]; grid[n + 1] = 0;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const opts = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([dx, dy]) => x + dx > 0 && x + dx < n - 1 && y + dy > 0 && y + dy < n - 1 && grid[(y + dy) * n + x + dx]);
    if (!opts.length) { stack.pop(); continue; }
    const [dx, dy] = opts[Math.floor(R() * opts.length)];
    grid[(y + dy / 2) * n + x + dx / 2] = 0; grid[(y + dy) * n + x + dx] = 0; stack.push([x + dx, y + dy]);
  }
  // A few extra openings so there is more than one route (and footprints can mislead)
  for (let k = 0, want = Math.floor(n * n / 90); k < want * 6 && want > 0; k++) {
    const x = 1 + Math.floor(R() * (n - 2)), y = 1 + Math.floor(R() * (n - 2)), i = y * n + x;
    if (!grid[i]) continue;
    const h = !grid[i - 1] && !grid[i + 1] && grid[i - n] && grid[i + n], v = !grid[i - n] && !grid[i + n] && grid[i - 1] && grid[i + 1];
    if (h || v) { grid[i] = 0; want--; }
  }
  const start = n + 1, dist = bfs(grid, n, start);
  let exit = start; for (let i = 0; i < n * n; i++) if (dist[i] > dist[exit]) exit = i;
  // the solution path (walking back from the exit) gives two checkpoints
  const path = [exit]; let c = exit;
  while (c !== start) { c = [c - 1, c + 1, c - n, c + n].find(nb => nb >= 0 && nb < n * n && dist[nb] === dist[c] - 1 && dist[nb] >= 0); path.push(c); }
  path.reverse();
  const m = { n, grid, start, exit, cps: [path[Math.floor(path.length / 3)], path[Math.floor(path.length * 2 / 3)]], pathLen: path.length - 1,
    minMs: Math.ceil((path.length - 1) / MAX_CELLS_PER_S * 1000 * 0.85) };
  cache.set(key, m); if (cache.size > 60) cache.delete(cache.keys().next().value);
  return m;
}
const level = (c, l) => maze(c.seed, l, c.size);
const wire = m => ({ n: m.n, grid: Array.from(m.grid).join(''), start: m.start, exit: m.exit, cps: m.cps });

// Tightrope: segment s is longer and windier than the one before
const rope = (c, s) => ({ seg: s, len: 2400 + 600 * s, amp: +(0.8 + 0.2 * s).toFixed(2), seed: c.seed + '~' + s, minMs: Math.ceil((2400 + 600 * s) / MAX_ROPE_UNITS_PER_S * 1000) });

const units = c => c.levels + c.segs;

// Ranking used when the day closes: finishers by total time, then the rest by progress. Never started = out.
function rank(players, d7, ids) {
  const fin = ids.filter(i => d7[i] && d7[i].done).sort((a, b) => d7[a].total - d7[b].total);
  const rest = ids.filter(i => !(d7[i] && d7[i].done)).sort((a, b) => ((d7[b] && d7[b].prog) || 0) - ((d7[a] && d7[a].prog) || 0));
  return fin.concat(rest);
}
module.exports = { DEFAULTS, cfg, maze, level, wire, rope, units, rank, bfs, rng };
