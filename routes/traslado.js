const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');

const col = (tenantId, sub) =>
  db.collection('empresas').doc(tenantId).collection(sub);

const err = (res, req, e) => {
  console.error('[ERROR]', req.path, e.message);
  res.status(500).json({ error: e.message, path: req.path });
};

// --- Choferes ---
router.get('/choferes', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'choferes').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/choferes', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'choferes').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/choferes/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'choferes').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/choferes/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'choferes').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Pasajeros ---
router.get('/pasajeros', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'pasajeros').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/pasajeros', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'pasajeros').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/pasajeros/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'pasajeros').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/pasajeros/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'pasajeros').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Viajes ---
router.get('/viajes', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'viajes').orderBy('creadoEn', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.get('/viajes/:id', auth, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'viajes').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Viaje no encontrado' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) { err(res, req, e); }
});

router.post('/viajes', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'viajes').add({ ...req.body, estado: 'pendiente', creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/viajes/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'viajes').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/viajes/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'viajes').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Reservas ---
router.get('/reservas', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'reservas').orderBy('creadoEn', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/reservas', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'reservas').add({ ...req.body, estado: 'pendiente', creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/reservas/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'reservas').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/reservas/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'reservas').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Seguimiento público de viaje (sin auth) ---
router.get('/seguimiento/:codigo', async (req, res) => {
  try {
    const snap = await db.collectionGroup('viajes')
      .where('codigoSeguimiento', '==', req.params.codigo)
      .limit(1)
      .get();
    if (snap.empty) return res.status(404).json({ error: 'Viaje no encontrado' });
    const doc = snap.docs[0];
    const { estado, origen, destino, chofer, estimadoLlegada, ubicacionActual } = doc.data();
    res.json({ id: doc.id, estado, origen, destino, chofer, estimadoLlegada, ubicacionActual });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
