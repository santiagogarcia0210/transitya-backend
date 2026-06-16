const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken, requireAdmin, requireSuperadmin } = require('../middleware/auth');
const { mpPost } = require('../helpers/mp');
const { enviarConfirmacionPago } = require('../helpers/mailer');

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

// ── MP CHECKOUT — genera preferencia de pago ──────────────────────────────────
router.post('/checkout', verifyToken, requireAdmin, async (req, res) => {
  try {
    const empDoc = await empresaRef(req.tenantId).get();
    const emp = empDoc.exists ? empDoc.data() : {};
    const frontUrl = process.env.FRONTEND_URL || 'https://transitya-frontend.vercel.app';

    const preference = await mpPost('/checkout/preferences', {
      items: [{
        title: 'Transit·Ya — Plan Pro (mensual)',
        description: 'Suscripción mensual al plan Pro de Transit·Ya',
        quantity: 1,
        unit_price: 89000,
        currency_id: 'ARS',
      }],
      payer: { email: emp.email || req.user.email },
      external_reference: req.tenantId,
      back_urls: {
        success: `${frontUrl}/dashboard?pago=ok`,
        failure: `${frontUrl}/dashboard?pago=error`,
        pending: `${frontUrl}/dashboard?pago=pendiente`,
      },
      auto_return: 'approved',
      statement_descriptor: 'TransitYa',
      metadata: { tenantId: req.tenantId },
    });

    if (!preference.init_point) {
      return res.status(502).json({ ok: false, error: 'mp_error', mensaje: preference.message || 'Error al crear preferencia MP' });
    }

    res.json({ ok: true, init_point: preference.init_point, id: preference.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── SUPERADMIN: empresas pendientes de confirmar pago ─────────────────────────

router.get('/pendientes-confirmacion', verifyToken, requireSuperadmin, async (req, res) => {
  try {
    const snap = await db.collection('empresas')
      .where('planActivo', '==', false)
      .get();
    const ahora = new Date();
    const pendientes = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => !e.eliminada && e.trialFin && new Date(e.trialFin) >= ahora)
      .map(e => ({
        id:            e.id,
        nombre:        e.nombre || e.id,
        adminEmail:    e.email || '',
        fechaRegistro: e.creadoEn || '',
        diasRestantes: Math.max(0, Math.ceil((new Date(e.trialFin) - ahora) / 86400000)),
      }));
    pendientes.sort((a, b) => a.diasRestantes - b.diasRestantes);
    res.json({ ok: true, pendientes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── SUPERADMIN: confirmar pago manual ────────────────────────────────────────

router.post('/:id/confirmar-pago', verifyToken, requireSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const empRef = db.collection('empresas').doc(id);
    const empDoc = await empRef.get();
    if (!empDoc.exists) return res.status(404).json({ ok: false, mensaje: 'Empresa no encontrada.' });

    const { nombre, email } = empDoc.data();
    const ahora = new Date().toISOString();

    await empRef.update({
      planActivo:           true,
      fechaPagoConfirmado:  ahora,
      trialFin:             new Date(Date.now() + 365 * 86400000).toISOString(),
    });

    res.json({ ok: true, mensaje: 'Plan activado.' });

    enviarConfirmacionPago({ email, nombreEmpresa: nombre })
      .catch(err => console.error('[MAILER] fallo envío', { template: 'confirmacion-pago', to: email, error: err.message }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
