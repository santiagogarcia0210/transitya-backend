const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');

const err = (res, req, e) => {
  console.error('[ERROR]', req.path, e.message);
  res.status(500).json({ error: e.message, path: req.path });
};

const superadminMiddleware = async (req, res, next) => {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Acceso restringido a superadmin' });
  }
  next();
};

router.use(auth, superadminMiddleware);

// --- Empresas ---
router.get('/empresas', async (req, res) => {
  try {
    const snap = await db.collection('empresas').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.get('/empresas/:id', async (req, res) => {
  try {
    const doc = await db.collection('empresas').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) { err(res, req, e); }
});

router.post('/empresas', async (req, res) => {
  try {
    const ref = await db.collection('empresas').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/empresas/:id', async (req, res) => {
  try {
    await db.collection('empresas').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/empresas/:id', async (req, res) => {
  try {
    await db.collection('empresas').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Features por empresa ---
router.put('/empresas/:id/features', async (req, res) => {
  try {
    await db.collection('empresas').doc(req.params.id).update({ features: req.body });
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// --- Estadísticas globales ---
router.get('/stats', async (req, res) => {
  try {
    const snap = await db.collection('empresas').get();
    const empresas = snap.docs.length;
    res.json({ empresas });
  } catch (e) { err(res, req, e); }
});

// --- Usuarios de cualquier empresa ---
router.get('/empresas/:id/usuarios', async (req, res) => {
  try {
    const snap = await db.collection('empresas').doc(req.params.id).collection('usuarios').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

module.exports = router;
