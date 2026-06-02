const router = require('express').Router();
const { db, admin } = require('../firebase');
const { verifyToken } = require('../middleware/auth');
const { esSuperadmin, randomUUID } = require('../utils');
const https = require('https');

const errHandler = (res, req, e) => {
  console.error('[SUPERADMIN]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

function mpFetch(path, params) {
  return new Promise((resolve, reject) => {
    const token = process.env.MP_ACCESS_TOKEN || '';
    const url = new URL('https://api.mercadopago.com' + path + (params || ''));
    https.get({ hostname: url.hostname, path: url.pathname + url.search, headers: { Authorization: 'Bearer ' + token } }, r => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

router.use(verifyToken, (req, res, next) => {
  if (!esSuperadmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Acceso restringido a superadmin.' });
  next();
});

// ── EMPRESAS ──────────────────────────────────────────────────────────────────

router.get('/empresas', async (req, res) => {
  try {
    const snap = await db.collection('empresas').get();
    const empresas = snap.docs.map(d => ({ tenantId: d.id, ...d.data() }))
      .filter(e => !e.eliminada);

    const resultado = await Promise.all(empresas.map(async emp => {
      const tenantId = emp.tenantId || emp.nombre || '';
      let susc = {}, choferesActivos = 0;
      try {
        const suscDoc = await db.collection('empresas').doc(tenantId).collection('suscripcion').doc('actual').get();
        if (suscDoc.exists) susc = suscDoc.data();
      } catch (e) {}
      try {
        const uSnap = await db.collection('empresas').doc(tenantId).collection('usuarios').get();
        choferesActivos = uSnap.docs.map(d => d.data()).filter(u => u.rol === 'chofer' && u.activo !== false).length;
      } catch (e) {}
      return {
        tenantId, nombre: emp.nombre || tenantId, tipo: emp.tipo || '',
        email: emp.email || '', telefono: emp.telefono || '',
        fechaRegistro: emp.creadoEn || emp._createdAt || '',
        plan: susc.plan || 'prueba', estadoSusc: susc.estado || 'prueba',
        fechaProximoCobro: susc.fechaProximoCobro || '',
        choferesActivos, maxChoferes: susc.choferesIncluidos || 2,
        activo: emp.activo !== false, suspendida: emp.suspendida === true
      };
    }));

    resultado.sort((a, b) => String(b.fechaRegistro).localeCompare(String(a.fechaRegistro)));
    res.json({ ok: true, empresas: resultado });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/empresas/:id', async (req, res) => {
  try {
    const tenantId = req.params.id;
    const base = db.collection('empresas').doc(tenantId);
    const [empDoc, suscDoc, featDoc, limDoc] = await Promise.all([
      base.get(),
      base.collection('suscripcion').doc('actual').get(),
      base.collection('config').doc('features').get(),
      base.collection('config').doc('limites').get()
    ]);
    res.json({
      ok: true,
      empresa:     empDoc.exists  ? { tenantId, ...empDoc.data() }  : {},
      suscripcion: suscDoc.exists ? suscDoc.data() : {},
      features:    featDoc.exists ? featDoc.data() : {},
      limites:     limDoc.exists  ? limDoc.data()  : {}
    });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/empresas/:id/features', async (req, res) => {
  try {
    await db.collection('empresas').doc(req.params.id).collection('config').doc('features').set({ ...req.body, _updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/empresas/:id/limites', async (req, res) => {
  try {
    await db.collection('empresas').doc(req.params.id).collection('config').doc('limites').set({ ...req.body, _updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/empresas/:id/suscripcion/extender', async (req, res) => {
  try {
    const { dias } = req.body;
    const ref = db.collection('empresas').doc(req.params.id).collection('suscripcion').doc('actual');
    const snap = await ref.get();
    const susc = snap.exists ? snap.data() : {};
    let base = susc.fechaProximoCobro ? new Date(susc.fechaProximoCobro) : new Date();
    if (base < new Date()) base = new Date();
    base.setDate(base.getDate() + Number(dias || 7));
    susc.fechaProximoCobro = base.toISOString();
    if (!susc.estado || susc.estado === 'vencida' || susc.estado === 'prueba') susc.estado = 'activa';
    susc._updatedAt = new Date().toISOString();
    await ref.set(susc);
    res.json({ ok: true, nuevaFecha: susc.fechaProximoCobro });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/empresas/:id/suspender', async (req, res) => {
  try {
    const { motivo } = req.body;
    const base = db.collection('empresas').doc(req.params.id);
    await Promise.all([
      base.update({ activo: false, suspendida: true, motivoSuspension: motivo || '', fechaSuspension: new Date().toISOString() }),
      base.collection('suscripcion').doc('actual').set({ estado: 'suspendida', _updatedAt: new Date().toISOString() }, { merge: true })
    ]);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/empresas/:id/reactivar', async (req, res) => {
  try {
    const base = db.collection('empresas').doc(req.params.id);
    await Promise.all([
      base.update({ activo: true, suspendida: false }),
      base.collection('suscripcion').doc('actual').set({ estado: 'activa', _updatedAt: new Date().toISOString() }, { merge: true })
    ]);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/empresas/:id', async (req, res) => {
  try {
    await db.collection('empresas').doc(req.params.id).update({ activo: false, eliminada: true, fechaEliminacion: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── USUARIOS DE EMPRESA ───────────────────────────────────────────────────────

router.get('/empresas/:id/usuarios', async (req, res) => {
  try {
    const snap = await db.collection('empresas').doc(req.params.id).collection('usuarios').get();
    res.json({ ok: true, usuarios: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/empresas/:id/admin', async (req, res) => {
  try {
    const { email, password, nombre } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, mensaje: 'Faltan datos.' });
    const tenantId = req.params.id;
    const userRecord = await admin.auth().createUser({ email, password, displayName: nombre || 'Admin' });
    await admin.auth().setCustomUserClaims(userRecord.uid, { rol: 'admin', tenantId });
    await db.collection('empresas').doc(tenantId).collection('usuarios').doc(userRecord.uid).set({
      uid: userRecord.uid, email, nombre: nombre || 'Admin', rol: 'admin', activo: true, tenantId,
      creadoEn: new Date().toISOString()
    });
    res.json({ ok: true, uid: userRecord.uid, mensaje: 'Admin creado.' });
  } catch (e) { errHandler(res, req, e); }
});

// ── MÉTRICAS ──────────────────────────────────────────────────────────────────

router.get('/metricas', async (req, res) => {
  try {
    const m = Number(req.query.mes) || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const inicioMes = new Date(y, m - 1, 1).toISOString();
    const finMes    = new Date(y, m, 0, 23, 59, 59).toISOString();

    const snap = await db.collection('empresas').get();
    const empresas = snap.docs.map(d => ({ tenantId: d.id, ...d.data() })).filter(e => !e.eliminada);

    let activas = 0, nuevasMes = 0, canceladas = 0, vencidas = 0, mrr = 0;
    const distPlan = { basico: 0, pro: 0, prueba: 0 };
    const distTipo = { transporte_especial: 0, traslado_pasajeros: 0, transporte_paqueteria: 0, otro: 0 };

    for (const emp of empresas) {
      const tenantId = emp.tenantId || '';
      const tipo = emp.tipo || 'otro';
      if (distTipo[tipo] !== undefined) distTipo[tipo]++; else distTipo.otro++;

      let susc = {};
      try {
        const suscDoc = await db.collection('empresas').doc(tenantId).collection('suscripcion').doc('actual').get();
        if (suscDoc.exists) susc = suscDoc.data();
      } catch (e) {}

      const estado = susc.estado || 'prueba';
      if (estado === 'activa') {
        activas++; mrr += (Number(susc.precio || 0) + Number(susc.precioExtraTotal || 0));
        const plan = susc.plan || 'prueba';
        if (distPlan[plan] !== undefined) distPlan[plan]++; else distPlan.prueba++;
      } else if (estado === 'vencida')   { vencidas++;   distPlan.prueba++; }
        else if (estado === 'cancelada') { canceladas++; }
        else                             { distPlan.prueba++; }

      const fr = emp.creadoEn || emp._createdAt || '';
      if (fr >= inicioMes && fr <= finMes) nuevasMes++;
    }

    res.json({
      ok: true, totalEmpresas: empresas.length, totalActivas: activas,
      nuevasMes, canceladas, vencidas, mrr, arr: mrr * 12,
      churnRate: empresas.length > 0 ? Math.round((canceladas / empresas.length) * 100) : 0,
      distribucionPlan: distPlan, distribucionTipo: distTipo, mes: m, anio: y
    });
  } catch (e) { errHandler(res, req, e); }
});

// ── PAGOS MERCADOPAGO ─────────────────────────────────────────────────────────

router.get('/pagos-mp', async (req, res) => {
  try {
    const { estado, fechaDesde, fechaHasta, tenantId } = req.query;
    let params = '?sort=date_created&criteria=desc&limit=50';
    if (estado) params += '&status=' + estado;
    if (fechaDesde) params += '&begin_date=' + fechaDesde + 'T00:00:00.000-03:00';
    if (fechaHasta) params += '&end_date=' + fechaHasta + 'T23:59:59.000-03:00';

    const data = await mpFetch('/v1/payments/search', params);
    let pagos = (data.results || []).map(p => ({
      id: String(p.id), tenantId: p.external_reference || '',
      monto: p.transaction_amount || 0, montoNeto: p.net_received_amount || 0,
      estado: p.status || '', fecha: p.date_created || '',
      metodoPago: p.payment_method_id || '',
      descripcion: p.additional_info?.items?.[0]?.title || ''
    }));
    if (tenantId) pagos = pagos.filter(p => p.tenantId === tenantId);
    const totalCobrado = pagos.filter(p => p.estado === 'approved').reduce((acc, p) => acc + p.monto, 0);
    res.json({ ok: true, pagos, totalCobrado });
  } catch (e) { errHandler(res, req, e); }
});

// ── USUARIOS GLOBAL ───────────────────────────────────────────────────────────

router.get('/usuarios', async (req, res) => {
  try {
    const { busqueda } = req.query;
    const snap = await db.collectionGroup('usuarios').limit(300).get();
    let usuarios = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (busqueda) {
      const q = String(busqueda).toLowerCase();
      usuarios = usuarios.filter(u =>
        String(u.email || '').toLowerCase().includes(q) ||
        String(u.nombre || '').toLowerCase().includes(q)
      );
    }
    res.json({ ok: true, usuarios });
  } catch (e) { errHandler(res, req, e); }
});

// ── LOGS ──────────────────────────────────────────────────────────────────────

router.get('/empresas/:id/logs', async (req, res) => {
  try {
    const dias = Number(req.query.dias) || 7;
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);
    const snap = await db.collection('empresas').doc(req.params.id).collection('logs').orderBy('fecha', 'desc').limit(100).get();
    const logs = snap.docs.map(d => d.data()).filter(l => !l.fecha || new Date(l.fecha) >= desde);
    res.json({ ok: true, logs });
  } catch (e) { errHandler(res, req, e); }
});

// ── MENSAJES MASIVOS ──────────────────────────────────────────────────────────

router.post('/mensajes', async (req, res) => {
  try {
    const { plan, mensaje } = req.body;
    if (!mensaje || !mensaje.trim()) return res.status(400).json({ ok: false, mensaje: 'El mensaje no puede estar vacío.' });
    const id = 'msg_' + Date.now();
    await db.collection('sa_mensajes').doc(id).set({
      id, plan: plan || 'todos', mensaje: mensaje.trim(),
      creadoEn: new Date().toISOString(), activo: true
    });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

// ── STATS RÁPIDAS ─────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const snap = await db.collection('empresas').get();
    const empresas = snap.docs.length;
    res.json({ ok: true, empresas });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
