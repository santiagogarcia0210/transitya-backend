const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');

const col = (tenantId, sub) =>
  db.collection('empresas').doc(tenantId).collection(sub);

const err = (res, req, e) => {
  console.error('[ERROR]', req.path, e.message);
  res.status(500).json({ error: e.message, path: req.path });
};

// --- Repartidores ---
router.get('/repartidores', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'repartidores').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/repartidores', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'repartidores').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/repartidores/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'repartidores').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/repartidores/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'repartidores').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Clientes de paquetería ---
router.get('/clientes', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'clientesPaqueteria').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/clientes', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'clientesPaqueteria').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/clientes/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'clientesPaqueteria').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/clientes/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'clientesPaqueteria').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Envíos ---
router.get('/envios', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'envios').orderBy('creadoEn', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.get('/envios/:id', auth, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'envios').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Envío no encontrado' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) { err(res, req, e); }
});

router.post('/envios', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'envios').add({ ...req.body, estado: 'pendiente', creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/envios/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'envios').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/envios/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'envios').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Rutas de reparto ---
router.get('/rutas', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'rutasReparto').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/rutas', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'rutasReparto').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/rutas/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'rutasReparto').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/rutas/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'rutasReparto').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Seguimiento público (sin auth) ---
router.get('/seguimiento/:codigo', async (req, res) => {
  try {
    const snap = await db.collectionGroup('envios')
      .where('codigoSeguimiento', '==', req.params.codigo)
      .limit(1)
      .get();
    if (snap.empty) return res.status(404).json({ error: 'Envío no encontrado' });
    const doc = snap.docs[0];
    const { estado, historial, origen, destino, estimadoEntrega } = doc.data();
    res.json({ id: doc.id, estado, historial, origen, destino, estimadoEntrega });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
