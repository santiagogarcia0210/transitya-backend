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

// ── DASHBOARD COMPLETO ────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const snap = await db.collection('empresas').get();
    const empresas = snap.docs.map(d => ({ tenantId: d.id, ...d.data() })).filter(e => !e.eliminada);
    const ahora = new Date();
    const en7Dias = new Date(); en7Dias.setDate(ahora.getDate() + 7);
    let activas = 0, suspendidas = 0, ingresosMes = 0;
    const distribucionPlan = {};
    const porVencer = [];
    const ultimosPagos = [];
    const mesHoy = ahora.toISOString().slice(0, 7);
    const nuevasPorMes = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
      nuevasPorMes[`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`] = 0;
    }
    empresas.forEach(e => {
      const k = (e.creadoEn || e._createdAt || '').slice(0, 7);
      if (nuevasPorMes[k] !== undefined) nuevasPorMes[k]++;
    });
    const withSusc = await Promise.all(empresas.map(async emp => {
      let susc = {};
      try {
        const s = await db.collection('empresas').doc(emp.tenantId).collection('suscripcion').doc('actual').get();
        if (s.exists) susc = s.data();
      } catch(e) {}
      return { ...emp, susc };
    }));
    for (const emp of withSusc) {
      if (emp.suspendida === true || emp.activo === false) { suspendidas++; continue; }
      activas++;
      const plan = emp.susc.plan || 'prueba';
      distribucionPlan[plan] = (distribucionPlan[plan] || 0) + 1;
      if (emp.susc.fechaProximoCobro) {
        const fv = new Date(emp.susc.fechaProximoCobro);
        const dias = Math.ceil((fv - ahora) / 86400000);
        if (fv <= en7Dias && dias >= 0)
          porVencer.push({ tenantId: emp.tenantId, nombre: emp.nombre || emp.tenantId, plan, diasRestantes: dias, fechaVencimiento: emp.susc.fechaProximoCobro });
      }
    }
    for (const emp of withSusc.slice(0, 20)) {
      try {
        const pSnap = await db.collection('empresas').doc(emp.tenantId).collection('pagos')
          .orderBy('fecha', 'desc').limit(2).get();
        pSnap.docs.forEach(d => {
          const p = d.data();
          ultimosPagos.push({ id: d.id, tenantId: emp.tenantId, empresa: emp.nombre || emp.tenantId, ...p });
          if (p.estado === 'pagado' && String(p.fecha || '').slice(0, 7) === mesHoy) ingresosMes += Number(p.monto || 0);
        });
      } catch(e) {}
    }
    ultimosPagos.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    let totalUsuarios = 0;
    try { const us = await db.collectionGroup('usuarios').limit(1000).get(); totalUsuarios = us.size; } catch(e) {}
    res.json({
      ok: true,
      totalEmpresas: empresas.length, activas, suspendidas, totalUsuarios, ingresosMes,
      distribucionPlan, porVencer,
      ultimosPagos: ultimosPagos.slice(0, 8),
      nuevasPorMes
    });
  } catch (e) { errHandler(res, req, e); }
});

// ── PAGOS FIRESTORE ───────────────────────────────────────────────────────────

router.get('/pagos', async (req, res) => {
  try {
    const { tenantId: filtroTenant, mes, estado: filtroEstado } = req.query;
    const empSnap = await db.collection('empresas').get();
    const empresasIds = empSnap.docs.map(d => ({ id: d.id, nombre: d.data().nombre || d.id }));
    const todos = [];
    for (const emp of empresasIds) {
      if (filtroTenant && emp.id !== filtroTenant) continue;
      try {
        let q = db.collection('empresas').doc(emp.id).collection('pagos').orderBy('fecha', 'desc').limit(30);
        const pSnap = await q.get();
        pSnap.docs.forEach(d => {
          const p = { id: d.id, tenantId: emp.id, empresa: emp.nombre, ...d.data() };
          if (mes && String(p.fecha || '').slice(0, 7) !== mes) return;
          if (filtroEstado && p.estado !== filtroEstado) return;
          todos.push(p);
        });
      } catch(e) {}
    }
    todos.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    const totalCobrado = todos.filter(p => p.estado === 'pagado').reduce((s, p) => s + Number(p.monto || 0), 0);
    res.json({ ok: true, pagos: todos, totalCobrado });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/pagos/:tenantId/registrar', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { monto, plan, dias, observaciones, metodo } = req.body;
    const pagoId = 'pago_' + Date.now();
    const fecha = new Date().toISOString();
    await db.collection('empresas').doc(tenantId).collection('pagos').doc(pagoId).set({
      id: pagoId, monto: Number(monto || 0), plan: plan || 'pro',
      dias: Number(dias || 30), metodo: metodo || 'manual',
      observaciones: observaciones || '', estado: 'pagado',
      fecha, creadoEn: fecha, registradoPor: req.user.email
    });
    // Extend subscription
    const suscRef = db.collection('empresas').doc(tenantId).collection('suscripcion').doc('actual');
    const suscSnap = await suscRef.get();
    const susc = suscSnap.exists ? suscSnap.data() : {};
    let base = susc.fechaProximoCobro ? new Date(susc.fechaProximoCobro) : new Date();
    if (base < new Date()) base = new Date();
    base.setDate(base.getDate() + Number(dias || 30));
    await suscRef.set({ ...susc, plan: plan || susc.plan || 'pro', estado: 'activa', fechaProximoCobro: base.toISOString(), _updatedAt: fecha }, { merge: true });
    // Reactivate if suspended
    await db.collection('empresas').doc(tenantId).update({ activo: true, suspendida: false });
    // Log
    try {
      await db.collection('LOGS_AUDITORIA').add({ accion: 'PAGO', tenantId, email: req.user.email, monto: Number(monto || 0), plan, dias: Number(dias || 30), fecha, ip: req.ip || '' });
    } catch(e) {}
    res.json({ ok: true, pagoId, nuevaFecha: base.toISOString() });
  } catch (e) { errHandler(res, req, e); }
});

// ── FEATURES ──────────────────────────────────────────────────────────────────

router.get('/features/:tenantId', async (req, res) => {
  try {
    const base = db.collection('empresas').doc(req.params.tenantId);
    const [featDoc, suscDoc] = await Promise.all([
      base.collection('config').doc('features').get(),
      base.collection('suscripcion').doc('actual').get()
    ]);
    res.json({
      ok: true,
      features: featDoc.exists ? featDoc.data() : {},
      plan: suscDoc.exists ? (suscDoc.data().plan || 'prueba') : 'prueba'
    });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/features/:tenantId', async (req, res) => {
  try {
    await db.collection('empresas').doc(req.params.tenantId).collection('config').doc('features')
      .set({ ...req.body, _updatedAt: new Date().toISOString() });
    try { await db.collection('LOGS_AUDITORIA').add({ accion: 'FEATURES', tenantId: req.params.tenantId, email: req.user.email, fecha: new Date().toISOString(), ip: req.ip || '' }); } catch(e) {}
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── USUARIO POR UID ───────────────────────────────────────────────────────────

router.get('/usuarios/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    let firebaseUser = {};
    try { const u = await admin.auth().getUser(uid); firebaseUser = { email: u.email, displayName: u.displayName, disabled: u.disabled, emailVerified: u.emailVerified, creationTime: u.metadata.creationTime, lastSignInTime: u.metadata.lastSignInTime, customClaims: u.customClaims || {} }; } catch(e) {}
    const snap = await db.collectionGroup('usuarios').where('uid', '==', uid).limit(1).get();
    const firestoreUser = snap.empty ? {} : { id: snap.docs[0].id, ...snap.docs[0].data() };
    res.json({ ok: true, usuario: { uid, ...firebaseUser, ...firestoreUser } });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/usuarios/:uid/estado', async (req, res) => {
  try {
    const { uid } = req.params;
    const { activo, motivo } = req.body;
    await admin.auth().updateUser(uid, { disabled: !activo });
    const snap = await db.collectionGroup('usuarios').where('uid', '==', uid).limit(1).get();
    if (!snap.empty) await snap.docs[0].ref.update({ activo: !!activo, motivoSuspension: motivo || '' });
    try { await db.collection('LOGS_AUDITORIA').add({ accion: activo ? 'ACTIVAR_USUARIO' : 'SUSPENDER_USUARIO', uid, email: req.user.email, motivo: motivo || '', fecha: new Date().toISOString(), ip: req.ip || '' }); } catch(e) {}
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── COMUNICACIONES ────────────────────────────────────────────────────────────

router.post('/comunicaciones', async (req, res) => {
  try {
    const { tenantId, asunto, mensaje, tipo } = req.body;
    if (!mensaje?.trim()) return res.status(400).json({ ok: false, mensaje: 'Mensaje vacío.' });
    const id = 'com_' + Date.now();
    const fecha = new Date().toISOString();
    const docData = { id, asunto: asunto || '', mensaje: mensaje.trim(), tipo: tipo || 'info', fecha, leido: false, de: req.user.email };
    const histRef = db.collection('sa_comunicaciones').doc(id);
    await histRef.set({ ...docData, tenantId: tenantId || 'todos' });
    if (!tenantId || tenantId === 'todos') {
      const snap = await db.collection('empresas').get();
      const batch = db.batch();
      snap.docs.forEach(d => {
        if (d.data().eliminada) return;
        batch.set(d.ref.collection('COMUNICACIONES').doc(id), docData);
      });
      await batch.commit();
    } else {
      await db.collection('empresas').doc(tenantId).collection('COMUNICACIONES').doc(id).set(docData);
    }
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/comunicaciones', async (req, res) => {
  try {
    const snap = await db.collection('sa_comunicaciones').orderBy('fecha', 'desc').limit(50).get();
    res.json({ ok: true, comunicaciones: snap.docs.map(d => d.data()) });
  } catch (e) { errHandler(res, req, e); }
});

// ── LOGS AUDITORÍA ────────────────────────────────────────────────────────────

router.get('/logs', async (req, res) => {
  try {
    const { tenantId, tipo, limite } = req.query;
    let q = db.collection('LOGS_AUDITORIA').orderBy('fecha', 'desc').limit(Number(limite) || 200);
    const snap = await q.get();
    let logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (tenantId) logs = logs.filter(l => l.tenantId === tenantId);
    if (tipo) logs = logs.filter(l => String(l.accion || '').includes(tipo));
    res.json({ ok: true, logs });
  } catch (e) { errHandler(res, req, e); }
});

// ── ESTADO EMPRESA (TOGGLE) ───────────────────────────────────────────────────

router.put('/empresas/:id/estado', async (req, res) => {
  try {
    const { activo, motivo } = req.body;
    const base = db.collection('empresas').doc(req.params.id);
    if (activo) {
      await Promise.all([
        base.update({ activo: true, suspendida: false }),
        base.collection('suscripcion').doc('actual').set({ estado: 'activa', _updatedAt: new Date().toISOString() }, { merge: true })
      ]);
    } else {
      await Promise.all([
        base.update({ activo: false, suspendida: true, motivoSuspension: motivo || '', fechaSuspension: new Date().toISOString() }),
        base.collection('suscripcion').doc('actual').set({ estado: 'suspendida', _updatedAt: new Date().toISOString() }, { merge: true })
      ]);
    }
    try { await db.collection('LOGS_AUDITORIA').add({ accion: activo ? 'REACTIVAR' : 'SUSPENDER', tenantId: req.params.id, email: req.user.email, motivo: motivo || '', fecha: new Date().toISOString(), ip: req.ip || '' }); } catch(e) {}
    res.json({ ok: true });
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
