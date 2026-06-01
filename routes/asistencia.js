const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');

router.get('/', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = db.collection('empresas').doc(req.tenantId).collection('asistencia');
    if (fecha) query = query.where('fecha', '==', fecha);
    const snap = await query.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch(e) { console.error('[ERROR]', req.path, e.message); res.status(500).json({ error: e.message, path: req.path }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const ref = await db.collection('empresas').doc(req.tenantId).collection('asistencia').add({ ...req.body, creadoEn: new Date() });
    res.json({ id: ref.id });
  } catch(e) { console.error('[ERROR]', req.path, e.message); res.status(500).json({ error: e.message, path: req.path }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    await db.collection('empresas').doc(req.tenantId).collection('asistencia').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch(e) { console.error('[ERROR]', req.path, e.message); res.status(500).json({ error: e.message, path: req.path }); }
});

module.exports = router;
