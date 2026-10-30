const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL
  });
}
const db = admin.database();

const mac = s => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(s).digest('base64url');
const sign = uid => {
  const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 2 * 864e5 })).toString('base64url');
  return p + '.' + mac(p);
};
const verify = t => {
  try {
    const [p, m] = String(t).split('.');
    const a = Buffer.from(mac(p)), b = Buffer.from(m);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const s = JSON.parse(Buffer.from(p, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
};
module.exports = { admin, db, sign, verify };
