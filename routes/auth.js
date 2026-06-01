const router = require('express').Router();
const { db } = require('../firebase');
const authMiddleware = require('../middleware/authMiddleware');

// GET /api/auth/me — obtener perfil del usuario autenticado
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { tenantId, uid } = req.user;
    const doc = await db.collection('empresas').doc(tenantId).collection('usuarios').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ uid, tenantId, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
