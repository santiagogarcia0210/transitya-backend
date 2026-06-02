const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken } = require('../middleware/auth');

router.get('/', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = db.collection('empresas').doc(req.tenantId).collection('asistencia');
    if (fecha) query = query.where('fecha', '==', fecha);
    const snap = await query.get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
