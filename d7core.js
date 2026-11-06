// Day 7 game rules shared by the browser and the tests: movement, the chaser, and the tightrope physics.
// Nothing here is secret. The server decides what counts (time, progress); this only makes it playable.
(function (root) {
  const SPEED = 4, CHASER_SPEED = 2.7, RADIUS = 0.28, CHASER_DELAY = 14;   // cells per second

  const wall = (g, n, x, y) => { const cx = Math.floor(x), cy = Math.floor(y); return cx < 0 || cy < 0 || cx >= n || cy >= n || g[cy * n + cx] === 1; };
  const blocked = (g, n, x, y) => wall(g, n, x - RADIUS, y - RADIUS) || wall(g, n, x + RADIUS, y - RADIUS) || wall(g, n, x - RADIUS, y + RADIUS) || wall(g, n, x + RADIUS, y + RADIUS);
  // One step with sliding along walls. pos = {x, y} in cell units (a cell spans [i, i+1)).
  function move(g, n, pos, dx, dy, dt) {
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    const sx = pos.x + dx * SPEED * dt, sy = pos.y + dy * SPEED * dt;
    if (!blocked(g, n, sx, pos.y)) pos.x = sx;
    if (!blocked(g, n, pos.x, sy)) pos.y = sy;
    return pos;
  }
  const cellOf = (n, pos) => Math.floor(pos.y) * n + Math.floor(pos.x);

  function dists(g, n, from) {
    const d = new Int32Array(n * n).fill(-1), q = [from]; d[from] = 0;
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % n;
      const nb = [x > 0 ? c - 1 : -1, x < n - 1 ? c + 1 : -1, c - n, c + n];
      for (const b of nb) if (b >= 0 && b < n * n && g[b] !== 1 && d[b] < 0) { d[b] = d[c] + 1; q.push(b); }
    }
    return d;
  }
  // The chaser always takes the shortest way to you, so wandering into dead ends lets it cut the distance.
  function chase(ch, g, n, dist, dt, speed) {
    let left = (speed || CHASER_SPEED) * dt;
    while (left > 1e-6) {
      const c = Math.floor(ch.y) * n + Math.floor(ch.x);
      if (dist[c] <= 0) return;
      const x = c % n; let best = -1;
      for (const b of [x > 0 ? c - 1 : -1, x < n - 1 ? c + 1 : -1, c - n, c + n]) if (b >= 0 && b < n * n && dist[b] >= 0 && dist[b] < dist[c]) { best = b; break; }
      if (best < 0) return;
      const tx = (best % n) + 0.5, ty = Math.floor(best / n) + 0.5, d = Math.hypot(tx - ch.x, ty - ch.y);
      if (d <= left) { ch.x = tx; ch.y = ty; left -= d; } else { ch.x += (tx - ch.x) / d * left; ch.y += (ty - ch.y) / d * left; left = 0; }
    }
  }

  // ---- Tightrope ----
  // th: lean (|th| >= 1 means you fell), w: how fast you are leaning. u: your correction (-1..1).
  const ROPE = { k: 1.15, c: 4.2, damp: 0.9, vmax: 60 };
  function windAt(t, amp, seed) {
    const R = (i) => { let h = 2166136261 ^ i; for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
    let w = amp * (0.6 * Math.sin(t * (0.5 + R(1)) + R(2) * 6.28) + 0.4 * Math.sin(t * (1.3 + R(3)) + R(4) * 6.28));
    const g = t / 7 + R(5); const gf = g - Math.floor(g);
    if (gf < 0.17) w += amp * 1.1 * Math.sin(gf / 0.17 * Math.PI) * (Math.floor(g) % 2 ? 1 : -1);   // a gust every ~7 s
    return w;
  }
  function ropeStep(s, u, wind, dt) {
    const sub = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / sub;
    for (let i = 0; i < sub; i++) { const a = ROPE.k * s.th + wind + ROPE.c * u - ROPE.damp * s.w; s.w += a * h; s.th += s.w * h; }
    return s;
  }
  const ropeSpeed = th => ROPE.vmax * Math.max(0.15, 1 - 0.85 * Math.abs(th));   // you slow down when you wobble

  const api = { SPEED, CHASER_SPEED, CHASER_DELAY, RADIUS, move, cellOf, dists, chase, ROPE, windAt, ropeStep, ropeSpeed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.D7 = api;
})(typeof window !== 'undefined' ? window : this);