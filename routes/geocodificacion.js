const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { normalizarText_, col } = require('../utils');
const https = require('https');

const CACHE_COL = 'geoCache';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOMINATIM_DELAY_MS = 1150;

const err = (res, req, e) => {
  console.error('[ERROR geo]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

function cacheKey(domicilio, localidad) {
  return normalizarText_((domicilio || '').trim() + '|' + (localidad || '').trim());
}

function cacheDocId(key) {
  return Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
}

function nominatimFetch(query) {
  return new Promise((resolve, reject) => {
    const path = '/search?q=' + encodeURIComponent(query) + '&format=json&limit=1&countrycodes=ar&addressdetails=0';
    https.get(
      { hostname: 'nominatim.openstreetmap.org', path, headers: { 'User-Agent': 'TransitYa/1.0 (gestion transporte)' } },
      r => {
        let data = '';
        r.on('data', c => (data += c));
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }
    ).on('error', reject);
  });
}

function nominatimReverseFetch(lat, lon) {
  return new Promise((resolve, reject) => {
    const path = '/reverse?lat=' + lat + '&lon=' + lon + '&format=json&addressdetails=1';
    https.get(
      { hostname: 'nominatim.openstreetmap.org', path, headers: { 'User-Agent': 'TransitYa/1.0 (gestion transporte)' } },
      r => {
        let data = '';
        r.on('data', c => (data += c));
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }
    ).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── GEOCODIFICACIÓN DIRECTA ───────────────────────────────────────────────────

router.get('/geocode', auth, async (req, res) => {
  try {
    const { q, domicilio, localidad } = req.query;
    const query = q || [domicilio, localidad, 'Tucumán', 'Argentina'].filter(Boolean).join(', ');
    if (!query) return res.status(400).json({ ok: false, mensaje: 'Falta parámetro q o domicilio.' });

    const key    = cacheKey(domicilio || q || '', localidad || '');
    const docId  = cacheDocId(key);
    const cacheRef = db.collection(CACHE_COL).doc(docId);
    const cached = await cacheRef.get();

    if (cached.exists) {
      const d = cached.data();
      if (Date.now() - d.ts < CACHE_TTL_MS) {
        return res.json({ ok: true, lat: d.lat, lng: d.lng, display: d.display || '', fuente: 'cache' });
      }
    }

    await sleep(NOMINATIM_DELAY_MS);
    const data = await nominatimFetch(query);
    if (!data || !data.length) return res.status(404).json({ ok: false, mensaje: 'No se encontró: ' + query });

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    const display = data[0].display_name || '';

    await cacheRef.set({ lat, lng, display, query, ts: Date.now() });
    res.json({ ok: true, lat, lng, display, fuente: 'nominatim', resultados: data });
  } catch (e) { err(res, req, e); }
});

// ── GEOCODIFICACIÓN DOMICILIO (compatible con GAS geocodificarDomicilio) ──────

router.post('/geocodificar', auth, async (req, res) => {
  try {
    const { domicilio, localidad } = req.body;
    if (!domicilio || !domicilio.trim()) return res.status(400).json({ ok: false, mensaje: 'Domicilio vacío.' });

    const key   = cacheKey(domicilio, localidad || 'Tucumán');
    const docId = cacheDocId(key);
    const cacheRef = db.collection(CACHE_COL).doc(docId);
    const cached = await cacheRef.get();

    if (cached.exists) {
      const d = cached.data();
      if (Date.now() - d.ts < CACHE_TTL_MS) {
        return res.json({ ok: true, lat: d.lat, lng: d.lng, fuente: 'cache' });
      }
    }

    const partes = [domicilio, localidad || 'Tucumán', 'Argentina'].filter(Boolean);
    await sleep(NOMINATIM_DELAY_MS);
    const data = await nominatimFetch(partes.join(', '));
    if (!data || !data.length) return res.status(404).json({ ok: false, mensaje: 'No se encontró: ' + domicilio });

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    const display = data[0].display_name || '';

    await cacheRef.set({ lat, lng, display, key, ts: Date.now() });
    res.json({ ok: true, lat, lng, display, fuente: 'nominatim' });
  } catch (e) { err(res, req, e); }
});

// ── GEOCODIFICACIÓN INVERSA ───────────────────────────────────────────────────

router.get('/reverse', auth, async (req, res) => {
  try {
    const { lat, lon, lng } = req.query;
    const lonFinal = lon || lng;
    if (!lat || !lonFinal) return res.status(400).json({ ok: false, mensaje: 'Faltan parámetros lat y lon.' });

    const key    = `rev_${lat}_${lonFinal}`;
    const docId  = cacheDocId(key);
    const cacheRef = db.collection(CACHE_COL).doc(docId);
    const cached = await cacheRef.get();

    if (cached.exists) {
      const d = cached.data();
      if (Date.now() - d.ts < CACHE_TTL_MS) return res.json({ ok: true, result: d.result, fuente: 'cache' });
    }

    await sleep(NOMINATIM_DELAY_MS);
    const result = await nominatimReverseFetch(lat, lonFinal);
    await cacheRef.set({ result, ts: Date.now() });
    res.json({ ok: true, result, fuente: 'nominatim' });
  } catch (e) { err(res, req, e); }
});

// ── RUTA DEL DÍA (compatible con GAS obtenerRutaDia) ─────────────────────────

router.get('/ruta-dia', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    const fechaBuscar = fecha || require('../utils').fechaHoyAR();
    const partes = String(fechaBuscar).split('/');
    if (partes.length < 3) return res.status(400).json({ ok: false, mensaje: 'Formato de fecha inválido (dd/MM/yyyy).' });

    const d  = Number(partes[0]);
    const m  = Number(partes[1]) - 1;
    const yy = partes[2].length === 2 ? 2000 + Number(partes[2]) : Number(partes[2]);
    const dt = new Date(yy, m, d);
    const jsDay = dt.getDay();
    const DIAS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

    if (jsDay === 0 || jsDay === 6) {
      return res.json({ ok: true, paradas: [], destinos: [], total: 0, sinCoords: 0, dia: DIAS[jsDay], fecha: fechaBuscar, mensaje: jsDay === 0 ? 'Domingo — sin ruta.' : 'Sábado — sin ruta.' });
    }

    const snap = await col(req.tenantId, 'registro').get();
    const beneficiarios = snap.docs.map(d => ({ _fsId: d.id, ...d.data() }));

    const paradas = [];
    const prestadoresMapa = {};

    for (const doc of beneficiarios) {
      if (!doc['APELLIDO Y NOMBRE'] && !doc['NOMBRE']) continue;
      const nombre    = doc['APELLIDO Y NOMBRE'] || doc['NOMBRE'] || '';
      const domicilio = doc['DOMICILIO'] || '';
      const localidad = doc['LOCALIDAD'] || 'Tucumán';
      const prestador = doc['PRESTADOR'] || doc['DEPENDENCIA'] || '';

      let lat = doc['LAT'] ? parseFloat(doc['LAT']) : null;
      let lng = doc['LNG'] ? parseFloat(doc['LNG']) : null;
      let geocodificado = !!(lat && lng);

      if (!geocodificado && domicilio) {
        const key   = cacheKey(domicilio, localidad);
        const docId = cacheDocId(key);
        const cacheSnap = await db.collection(CACHE_COL).doc(docId).get();
        if (cacheSnap.exists) {
          const c = cacheSnap.data();
          if (Date.now() - c.ts < CACHE_TTL_MS) { lat = c.lat; lng = c.lng; geocodificado = true; }
        }
      }

      paradas.push({ nombre, domicilio, localidad, prestador, telefono: doc['N° CONTACTO'] || '', lat, lng, geocodificado });
      if (prestador) { if (!prestadoresMapa[prestador]) prestadoresMapa[prestador] = 0; prestadoresMapa[prestador]++; }
    }

    const destinos = Object.keys(prestadoresMapa)
      .map(k => ({ nombre: k, count: prestadoresMapa[k] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);

    res.json({
      ok: true, fecha: fechaBuscar, dia: DIAS[jsDay], paradas,
      destinos, total: paradas.length, sinCoords: paradas.filter(p => !p.geocodificado).length
    });
  } catch (e) { err(res, req, e); }
});

// ── GEOCODIFICAR RUTA COMPLETA ────────────────────────────────────────────────

router.post('/geocodificar-ruta', auth, async (req, res) => {
  try {
    const { paradas } = req.body;
    if (!Array.isArray(paradas)) return res.status(400).json({ ok: false, mensaje: 'Se esperan paradas[].' });
    let geocodificadas = 0;
    const errores = [];

    for (const p of paradas) {
      if (p.geocodificado || (!p.domicilio)) continue;
      await sleep(NOMINATIM_DELAY_MS);
      const partes = [p.domicilio, p.localidad || 'Tucumán', 'Argentina'].filter(Boolean);
      const data = await nominatimFetch(partes.join(', ')).catch(() => null);
      if (data && data.length) {
        p.lat = parseFloat(data[0].lat);
        p.lng = parseFloat(data[0].lon);
        p.geocodificado = true;
        geocodificadas++;
        const key = cacheKey(p.domicilio, p.localidad || 'Tucumán');
        await db.collection(CACHE_COL).doc(cacheDocId(key)).set({ lat: p.lat, lng: p.lng, display: data[0].display_name || '', key, ts: Date.now() });
      } else {
        errores.push(p.domicilio);
      }
    }

    res.json({
      ok: true, paradas, geocodificadas, errores: errores.length,
      sinCoords: paradas.filter(p => !p.geocodificado).length,
      mensaje: `${geocodificadas} geocodificadas.${errores.length ? ' No encontradas: ' + errores.join(', ') : ''}`
    });
  } catch (e) { err(res, req, e); }
});

// ── LIMPIAR CACHE ─────────────────────────────────────────────────────────────

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
