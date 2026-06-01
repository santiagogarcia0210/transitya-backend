const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');

router.get('/tipo', auth, async (req, res) => {
  try {
    const doc = await db.collection('empresas').doc(req.tenantId).get();
    const tipo = doc.data()?.tipo || 'transporte_especial';
    res.json({ tipo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
