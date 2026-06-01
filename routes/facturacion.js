const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');

const col = (tenantId, sub) =>
  db.collection('empresas').doc(tenantId).collection(sub);

const err = (res, req, e) => {
  console.error('[ERROR]', req.path, e.message);
  res.status(500).json({ error: e.message, path: req.path });
};

// --- Datos fiscales de la empresa ---
router.get('/datos-fiscales', auth, async (req, res) => {
  try {
    const doc = await db.collection('empresas').doc(req.tenantId).get();
    res.json(doc.exists ? { id: doc.id, ...doc.data() } : {});
  } catch (e) { err(res, req, e); }
});

router.put('/datos-fiscales', auth, async (req, res) => {
  try {
    await db.collection('empresas').doc(req.tenantId).update({ datosFiscales: req.body });
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Facturas ---
router.get('/facturas', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'facturas').orderBy('creadoEn', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.get('/facturas/:id', auth, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'facturas').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) { err(res, req, e); }
});

router.post('/facturas', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'facturas').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/facturas/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'facturas').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/facturas/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'facturas').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Puntos de venta AFIP/ARCA ---
router.get('/puntos-venta', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'puntosVenta').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/puntos-venta', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'puntosVenta').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/puntos-venta/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'puntosVenta').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/puntos-venta/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'puntosVenta').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
