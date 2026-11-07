const { maintain, winnerLocked } = require('./_lib');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const s = await maintain();
    res.json({ day: s.day, endsAt: s.endsAt, closed: s.closed, winner: await winnerLocked(), now: Date.now() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
};
