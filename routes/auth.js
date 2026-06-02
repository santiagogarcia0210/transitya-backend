const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { col } = require('../utils');

router.get('/me', verifyToken, async (req, res) => {
  try {
    const { tenantId, uid } = req.user;
    const doc = await col(tenantId, 'usuarios').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado.' });
    res.json({ ok: true, uid, tenantId, ...doc.data() });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
