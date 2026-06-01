const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const empresaRef = (tenantId) => db.collection('empresas').doc(tenantId);

router.get('/tipo', verifyToken, async (req, res) => {
  try {
    const doc = await empresaRef(req.tenantId).get();
    const tipo = doc.data()?.tipo || 'transporte_escolar';
    res.json({ tipo });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/config', verifyToken, async (req, res) => {
  try {
    const doc = await empresaRef(req.tenantId).get();
    if (!doc.exists) return res.json({ ok: true, config: {} });
    const { nombre, tipo, limites, features, ...rest } = doc.data();
    res.json({ ok: true, config: { nombre, tipo, limites, features, ...rest } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/fiscal', verifyToken, async (req, res) => {
  try {
    const doc = await empresaRef(req.tenantId).collection('config').doc('fiscal').get();
    if (!doc.exists) return res.json({ ok: true, fiscal: {} });
    res.json({ ok: true, fiscal: doc.data() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.put('/fiscal', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { razonSocial, cuit, condicionIVA, domicilio, puntoVentaDefault, iibb, inicioActividades } = req.body;
    await empresaRef(req.tenantId).collection('config').doc('fiscal').set({
      razonSocial, cuit, condicionIVA, domicilio,
      puntoVentaDefault, iibb, inicioActividades,
      actualizadoEn: new Date().toISOString(),
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
