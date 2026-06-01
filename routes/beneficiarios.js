const router = require('express').Router();
const { db } = require('../firebase');
const authMiddleware = require('../middleware/authMiddleware');

// GET /api/beneficiarios — listar todos
router.get('/', authMiddleware, async (req, res) => {
  try {
    const snap = await db.collection('empresas').doc(req.tenantId).collection('registro').get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/beneficiarios/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const doc = await db.collection('empresas').doc(req.tenantId).collection('registro').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/beneficiarios
router.post('/', authMiddleware, async (req, res) => {
  try {
    const ref = await db.collection('empresas').doc(req.tenantId).collection('registro').add({
      ...req.body,
      creadoEn: new Date()
    });
    res.json({ id: ref.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/beneficiarios/:id
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('empresas').doc(req.tenantId).collection('registro').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
