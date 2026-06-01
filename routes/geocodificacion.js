const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const https = require('https');

const CACHE_COL = 'geoCache';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

const err = (res, req, e) => {
  console.error('[ERROR]', req.path, e.message);
  res.status(500).json({ error: e.message, path: req.path });
};

function nominatimFetch(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get(
      { hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'TransitYa/1.0' } },
      (r) => {
        let data = '';
        r.on('data', c => (data += c));
        r.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }
    ).on('error', reject);
  });
}

// --- Geocodificación directa: dirección → coordenadas ---
router.get('/geocode', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Falta parámetro q' });

    const cacheKey = `geocode_${q.toLowerCase().trim()}`;
    const cacheDoc = await db.collection(CACHE_COL).doc(Buffer.from(cacheKey).toString('base64')).get();
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      if (Date.now() - cached.ts < CACHE_TTL_MS) return res.json(cached.result);
    }

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`;
    const result = await nominatimFetch(url);

    await db.collection(CACHE_COL).doc(Buffer.from(cacheKey).toString('base64')).set({ result, ts: Date.now() });
    res.json(result);
  } catch (e) { err(res, req, e); }
});

// --- Geocodificación inversa: coordenadas → dirección ---
router.get('/reverse', auth, async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Faltan parámetros lat y lon' });

    const cacheKey = `reverse_${lat}_${lon}`;
    const cacheDoc = await db.collection(CACHE_COL).doc(Buffer.from(cacheKey).toString('base64')).get();
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      if (Date.now() - cached.ts < CACHE_TTL_MS) return res.json(cached.result);
    }

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
    const result = await nominatimFetch(url);

    await db.collection(CACHE_COL).doc(Buffer.from(cacheKey).toString('base64')).set({ result, ts: Date.now() });
    res.json(result);
  } catch (e) { err(res, req, e); }
});

// --- Limpiar cache (admin) ---
router.delete('/cache', auth, async (req, res) => {
  try {
    const snap = await db.collection(CACHE_COL).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.json({ ok: true, eliminados: snap.size });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
