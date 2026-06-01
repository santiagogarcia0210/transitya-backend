const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');

router.get('/', auth, async (req, res) => {
  try {
    const snap = await db.collection('empresas').doc(req.tenantId).collection('ubicaciones').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:usuario', auth, async (req, res) => {
  try {
    await db.collection('empresas').doc(req.tenantId).collection('ubicaciones').doc(req.params.usuario).set({ ...req.body, actualizadoEn: new Date() }, { merge: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
