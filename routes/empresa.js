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

router.put('/tipo', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tipo } = req.body;
    const tipos = ['transporte_escolar', 'transporte_especial', 'paqueteria', 'traslado'];
    if (!tipos.includes(tipo)) return res.status(400).json({ ok: false, error: `Tipo inválido. Valores permitidos: ${tipos.join(', ')}` });
    await empresaRef(req.tenantId).set({ tipo }, { merge: true });
    res.json({ ok: true, tipo });
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

router.put('/config', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { nombre, tipo, logo } = req.body;
    const tipos = ['transporte_escolar', 'transporte_especial', 'paqueteria', 'traslado'];
    if (tipo !== undefined && !tipos.includes(tipo))
      return res.status(400).json({ ok: false, error: `Tipo inválido` });
    const updates = { actualizadoEn: new Date().toISOString() };
    if (nombre !== undefined) updates.nombre = nombre;
    if (tipo   !== undefined) updates.tipo   = tipo;
    if (logo   !== undefined) updates.logo   = logo;
    await empresaRef(req.tenantId).set(updates, { merge: true });
    res.json({ ok: true, mensaje: 'Configuración guardada' });
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

router.get('/suscripcion', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [empDoc, suscDoc] = await Promise.all([
      empresaRef(req.tenantId).get(),
      empresaRef(req.tenantId).collection('suscripcion').doc('actual').get(),
    ]);
    const emp  = empDoc.exists  ? empDoc.data()  : {};
    const susc = suscDoc.exists ? suscDoc.data() : {};
    const ahora = new Date();
    let estado = 'trial';
    if (susc.estado) {
      estado = susc.estado;
    } else if (susc.fechaProximoCobro) {
      estado = new Date(susc.fechaProximoCobro) >= ahora ? 'activa' : 'vencida';
    }
    res.json({
      ok: true,
      plan:             susc.plan || emp.plan || 'prueba',
      estado,
      fechaVencimiento: susc.fechaProximoCobro || '',
      limites: {
        choferes: susc.choferesIncluidos || emp.limites?.choferes || 2,
        ...(susc.limites || emp.limites || {}),
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
