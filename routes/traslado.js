const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const {
  normalizarText_, fechaHoyAR, nombreUsuario,
  esMesISO, generarCorrelativo, col, MESES, randomUUID
} = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[TRASLADO]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const isoToDMY = (f) => {
  if (!f || !f.includes('-')) return f;
  const [y, m, d] = f.split('-');
  return `${d}/${m}/${y}`;
};

// ── CHOFERES ──────────────────────────────────────────────────────────────────

router.get('/choferes', verifyToken, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'tras_choferes').get();
    const docs = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    res.json({ ok: true, choferes: docs, hayMas: docs.length >= 500 });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/choferes', verifyToken, async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = {
      id, nombre: data.nombre || '', telefono: data.telefono || '',
      email: data.email || '', dni: data.dni || '', licencia: data.licencia || '',
      vehiculo: data.vehiculo || '', patente: data.patente || '',
      tipoVehiculo: data.tipoVehiculo || 'auto', capacidad: data.capacidad || 4,
      activo: data.activo !== false, notas: data.notas || '',
      creadoEn: data.creadoEn || new Date().toISOString()
    };
    await col(req.tenantId, 'tras_choferes').doc(id).set(doc);
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/choferes/:id', verifyToken, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_choferes').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ ...req.body, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/choferes/:id', verifyToken, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_choferes').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ activo: false });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── PASAJEROS ─────────────────────────────────────────────────────────────────

router.get('/pasajeros', verifyToken, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'tras_pasajeros').get();
    const docs = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    res.json({ ok: true, pasajeros: docs, hayMas: docs.length >= 500 });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/pasajeros', verifyToken, async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = {
      id, nombre: data.nombre || '', telefono: data.telefono || '',
      email: data.email || '', dni: data.dni || '', domicilio: data.domicilio || '',
      notas: data.notas || '', activo: data.activo !== false,
      creadoEn: data.creadoEn || new Date().toISOString()
    };
    await col(req.tenantId, 'tras_pasajeros').doc(id).set(doc);
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/pasajeros/:id', verifyToken, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_pasajeros').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ ...req.body, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/pasajeros/:id', verifyToken, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_pasajeros').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ activo: false });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── VIAJES ────────────────────────────────────────────────────────────────────

router.get('/viajes', verifyToken, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'tras_viajes').get();
    let docs = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    docs.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ ok: true, viajes: docs });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/viajes-chofer', verifyToken, async (req, res) => {
  try {
    const snapCh = await col(req.tenantId, 'tras_choferes').get();
    const choferes = snapCh.docs.map(d => d.data());
    const usuario = nombreUsuario(req.user);
    const email   = req.user?.email || '';
    const chofer  = choferes.find(c =>
      (email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
      normalizarText_(c.nombre) === normalizarText_(usuario)
    );
    if (!chofer) return res.status(404).json({ ok: false, mensaje: 'No tenés un perfil de chofer asociado a tu usuario.' });
    const hoy  = fechaHoyAR();
    const snap = await col(req.tenantId, 'tras_viajes').get();
    const deHoy = snap.docs.map(d => d.data())
      .filter(v => v.choferId === chofer.id && (v.fecha === hoy || !v.fecha) && v.estado !== 'cancelado' && v.estado !== 'completado')
      .sort((a, b) => String(a.hora || '').localeCompare(String(b.hora || '')));
    res.json({ ok: true, viajes: deHoy, chofer });
  } catch (e) { errHandler(res, req, e); }
});

// Sub-routes before /:id
router.put('/viajes/:id/estado', verifyToken, async (req, res) => {
  try {
    const { estado, nota } = req.body;
    const ref  = col(req.tenantId, 'tras_viajes').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    const doc = snap.data();
    doc.estado = estado;
    if (!doc.historial) doc.historial = [];
    doc.historial.push({ estado, fecha: new Date().toISOString(), usuario: nombreUsuario(req.user), nota: nota || '' });
    if (estado === 'completado') doc.fechaCompletado = fechaHoyAR() + ' ' + new Date().toTimeString().slice(0, 5);
    await ref.set(doc);
    res.json({ ok: true, estado });
  } catch (e) { errHandler(res, req, e); }
});

router.patch('/viajes/:id/estado', verifyToken, async (req, res) => {
  try {
    const { estado, nota } = req.body;
    const ref  = col(req.tenantId, 'tras_viajes').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    const doc = snap.data();
    doc.estado = estado;
    if (!doc.historial) doc.historial = [];
    doc.historial.push({ estado, fecha: new Date().toISOString(), usuario: nombreUsuario(req.user), nota: nota || '' });
    if (estado === 'completado') doc.fechaCompletado = fechaHoyAR() + ' ' + new Date().toTimeString().slice(0, 5);
    await ref.set(doc);
    res.json({ ok: true, estado });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/viajes/:id/asignar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { choferId } = req.body;
    const [viajeSnap, choferSnap] = await Promise.all([
      col(req.tenantId, 'tras_viajes').doc(req.params.id).get(),
      col(req.tenantId, 'tras_choferes').doc(choferId).get()
    ]);
    if (!viajeSnap.exists)  return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    if (!choferSnap.exists) return res.status(404).json({ ok: false, mensaje: 'Chofer no encontrado.' });
    const doc    = viajeSnap.data();
    const chofer = choferSnap.data();
    doc.choferId = chofer.id; doc.choferNombre = chofer.nombre; doc.estado = 'asignado';
    if (!doc.historial) doc.historial = [];
    doc.historial.push({ estado: 'asignado', fecha: new Date().toISOString(), usuario: nombreUsuario(req.user), nota: 'Asignado a ' + chofer.nombre });
    await col(req.tenantId, 'tras_viajes').doc(req.params.id).set(doc);
    res.json({ ok: true, choferNombre: chofer.nombre });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/viajes/:id/cancelar', verifyToken, async (req, res) => {
  try {
    const { motivo } = req.body;
    const ref  = col(req.tenantId, 'tras_viajes').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    const doc = snap.data();
    doc.estado = 'cancelado';
    if (!doc.historial) doc.historial = [];
    doc.historial.push({ estado: 'cancelado', fecha: new Date().toISOString(), usuario: nombreUsuario(req.user), nota: motivo || 'Cancelado' });
    await ref.set(doc);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/viajes/:id', verifyToken, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'tras_viajes').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    res.json({ ok: true, viaje: { ...doc.data(), _fsId: doc.id } });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/viajes', verifyToken, async (req, res) => {
  try {
    const data    = req.body;
    const id      = data.id || randomUUID();
    const esNuevo = !data.id;
    const usuario = nombreUsuario(req.user);
    const nroViaje = data.nroViaje || (esNuevo ? ('VIA-' + String(await generarCorrelativo(req.tenantId, 'tras_nro_viaje')).padStart(6, '0')) : '');
    const doc = {
      id, nroViaje, pasajeroId: data.pasajeroId || '', pasajeroNombre: data.pasajeroNombre || '',
      pasajeroTel: data.pasajeroTel || '', choferId: data.choferId || '',
      choferNombre: data.choferNombre || '', origen: data.origen || '', destino: data.destino || '',
      fecha: isoToDMY(data.fecha) || data.fecha || '', hora: data.hora || '',
      precio: Number(data.precio) || 0, estado: data.estado || 'pendiente',
      notas: data.notas || '', historial: data.historial || [],
      creadoPor: data.creadoPor || usuario, creadoEn: data.creadoEn || new Date().toISOString()
    };
    if (esNuevo) doc.historial.push({ estado: 'pendiente', fecha: new Date().toISOString(), usuario, nota: 'Viaje creado' });
    await col(req.tenantId, 'tras_viajes').doc(id).set(doc);
    res.json({ ok: true, id, nroViaje: doc.nroViaje });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/viajes/:id', verifyToken, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_viajes').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    await ref.update({ ...req.body, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/viajes/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_viajes').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── RESERVAS ──────────────────────────────────────────────────────────────────

router.get('/reservas', verifyToken, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'tras_reservas').get();
    const docs = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }))
      .sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ ok: true, reservas: docs });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/reservas', verifyToken, async (req, res) => {
  try {
    const data = req.body;
    const id   = data.id || randomUUID();
    const doc  = {
      id, pasajeroId: data.pasajeroId || '', pasajeroNombre: data.pasajeroNombre || '',
      pasajeroTel: data.pasajeroTel || '', origen: data.origen || '', destino: data.destino || '',
      fecha: isoToDMY(data.fecha) || data.fecha || '', hora: data.hora || '',
      precio: Number(data.precio) || 0, estado: data.estado || 'pendiente',
      notas: data.notas || '', creadoPor: nombreUsuario(req.user),
      creadoEn: data.creadoEn || new Date().toISOString()
    };
    await col(req.tenantId, 'tras_reservas').doc(id).set(doc);
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

// Sub-routes before /:id
router.patch('/reservas/:id/confirmar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'tras_reservas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Reserva no encontrada.' });
    await ref.update({ estado: 'confirmada', confirmadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/reservas/:id/cancelar', verifyToken, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'tras_reservas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Reserva no encontrada.' });
    await ref.update({ estado: 'cancelada' });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.patch('/reservas/:id/cancelar', verifyToken, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'tras_reservas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Reserva no encontrada.' });
    await ref.update({ estado: 'cancelada' });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/reservas/:id', verifyToken, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'tras_reservas').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'Reserva no encontrada.' });
    res.json({ ok: true, reserva: { ...doc.data(), _fsId: doc.id } });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/reservas/:id', verifyToken, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_reservas').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'Reserva no encontrada.' });
    await ref.update({ ...req.body, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/reservas/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_reservas').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'Reserva no encontrada.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── FACTURAS ──────────────────────────────────────────────────────────────────

router.get('/facturas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'tras_facturas').get();
    const docs = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }))
      .sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ ok: true, facturas: docs });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/facturas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data     = req.body;
    const esNueva  = !data.id;
    const id       = data.id || randomUUID();
    const tipoFac  = String(data.tipoFactura || 'X').toUpperCase();
    const pv       = String(Number(data.puntoVenta) || 1).padStart(4, '0');

    let nroComprobante, nroFormateado;
    if (esNueva) {
      nroComprobante = await generarCorrelativo(req.tenantId, `tras_fac_${tipoFac}_${pv}`);
      nroFormateado  = pv + '-' + String(nroComprobante).padStart(8, '0');
    } else {
      nroComprobante = data.nroComprobante || 0;
      nroFormateado  = data.nroFactura || '';
    }

    const doc = {
      id, nroFactura: nroFormateado, nroComprobante, tipoFactura: tipoFac, puntoVenta: Number(data.puntoVenta) || 1,
      cuitEmisor: String(data.cuitEmisor || '').trim(), razonSocialEmisor: String(data.razonSocialEmisor || '').trim(),
      condicionIVAEmisor: String(data.condicionIVAEmisor || '').trim(), domicilioEmisor: String(data.domicilioEmisor || '').trim(),
      iibbEmisor: String(data.iibbEmisor || '').trim(), pasajeroId: data.pasajeroId || '',
      pasajeroNombre: String(data.pasajeroNombre || '').trim(), cuitReceptor: String(data.cuitReceptor || '').trim(),
      condicionIVAReceptor: String(data.condicionIVAReceptor || '').trim(),
      items: Array.isArray(data.items) ? data.items : [], viajes: data.viajes || [],
      subtotal: Number(data.subtotal) || 0, iva21: Number(data.iva21) || 0,
      total: Number(data.total) || 0, descuento: Number(data.descuento) || 0,
      condicionVenta: String(data.condicionVenta || 'Contado').trim(),
      observaciones: String(data.observaciones || '').trim(),
      estado: data.estado || 'pendiente', fecha: data.fecha || fechaHoyAR(),
      fechaPago: data.fechaPago || '', ingresoId: data.ingresoId || '',
      creadoPor: nombreUsuario(req.user),
      creadoEn: esNueva ? new Date().toISOString() : (data.creadoEn || new Date().toISOString()),
      actualizadoEn: new Date().toISOString()
    };
    await col(req.tenantId, 'tras_facturas').doc(id).set(doc);

    if (esNueva) {
      try {
        const ingresoId = randomUUID();
        await col(req.tenantId, 'ingresos').doc(ingresoId).set({
          id: ingresoId, tipo: 'FACTURA', numero: nroFormateado,
          cliente: doc.pasajeroNombre, cuit: doc.cuitReceptor, fecha: doc.fecha,
          monto: doc.total, estado: 'PRESENTADO', facturaId: id,
          concepto: 'Factura ' + tipoFac + ' ' + nroFormateado,
          _origen: 'facturacion_automatica', modulo: 'traslado',
          fechaPago: '', creadoEn: new Date().toISOString()
        });
        await col(req.tenantId, 'tras_facturas').doc(id).update({ ingresoId });
      } catch (eIng) { console.error('[tras ingreso error]', eIng.message); }
    }

    res.json({ ok: true, id, nroFactura: nroFormateado });
  } catch (e) { errHandler(res, req, e); }
});

// Sub-routes before /:id
router.put('/facturas/:id/pagar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'tras_facturas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    const doc = snap.data();
    const fechaHoy = fechaHoyAR();
    doc.estado = 'pagada'; doc.fechaPago = fechaHoy;
    await ref.set(doc);
    if (doc.ingresoId) {
      try {
        const ingRef  = col(req.tenantId, 'ingresos').doc(doc.ingresoId);
        const ingSnap = await ingRef.get();
        if (ingSnap.exists) await ingRef.update({ estado: 'PAGADO', fechaPago: fechaHoy });
      } catch (eI) {}
    }
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.patch('/facturas/:id/pagar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'tras_facturas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    const doc = snap.data();
    const fechaHoy = fechaHoyAR();
    doc.estado = 'pagada'; doc.fechaPago = fechaHoy;
    await ref.set(doc);
    if (doc.ingresoId) {
      try {
        const ingRef  = col(req.tenantId, 'ingresos').doc(doc.ingresoId);
        const ingSnap = await ingRef.get();
        if (ingSnap.exists) await ingRef.update({ estado: 'PAGADO', fechaPago: fechaHoy });
      } catch (eI) {}
    }
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/facturas/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_facturas').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    await ref.update({ ...req.body, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/facturas/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'tras_facturas').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    await ref.update({ estado: 'anulada', anuladoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── INGRESOS ──────────────────────────────────────────────────────────────────

router.get('/ingresos', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'ingresos').get();
    const todos = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }))
      .filter(i => i.modulo === 'traslado' || i.modulo === 'arca')
      .sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ ok: true, ingresos: todos });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/ingresos/:id/pagar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'ingresos').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Ingreso no encontrado.' });
    const ing      = snap.data();
    const fechaHoy = fechaHoyAR();
    ing.estado = 'PAGADO'; ing.fechaPago = fechaHoy;
    await ref.set(ing);
    if (ing.facturaId) {
      try {
        const facRef  = col(req.tenantId, 'tras_facturas').doc(ing.facturaId);
        const facSnap = await facRef.get();
        if (facSnap.exists) await facRef.update({ estado: 'pagada', fechaPago: fechaHoy });
      } catch (eF) {}
    }
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── REPORTES ──────────────────────────────────────────────────────────────────

router.get('/reportes', verifyToken, requireAdmin, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const [viajesSnap, facturasSnap] = await Promise.all([
      col(req.tenantId, 'tras_viajes').get(),
      col(req.tenantId, 'tras_facturas').get()
    ]);
    const viajes       = viajesSnap.docs.map(d => d.data());
    const facturas     = facturasSnap.docs.map(d => d.data());
    const viajesMes    = viajes.filter(v => esMesISO(v.creadoEn, m, y));
    const completados  = viajesMes.filter(v => v.estado === 'completado');
    const cancelados   = viajesMes.filter(v => v.estado === 'cancelado');
    const facturasMes  = facturas.filter(f => esMesISO(f.creadoEn, m, y));
    const totalFacturado = facturasMes.reduce((s, f) => s + (Number(f.total) || 0), 0);
    const totalCobrado   = facturasMes.filter(f => f.estado === 'pagada').reduce((s, f) => s + (Number(f.total) || 0), 0);
    const porChofer = {};
    viajesMes.forEach(v => {
      const ch = v.choferNombre || 'Sin asignar';
      if (!porChofer[ch]) porChofer[ch] = { nombre: ch, total: 0, completados: 0, cancelados: 0 };
      porChofer[ch].total++;
      if (v.estado === 'completado') porChofer[ch].completados++;
      if (v.estado === 'cancelado')  porChofer[ch].cancelados++;
    });
    res.json({
      ok: true, mes: MESES[m - 1], anio: y,
      totalViajes: viajesMes.length, completados: completados.length, cancelados: cancelados.length,
      efectividad: viajesMes.length > 0 ? Math.round(completados.length / viajesMes.length * 100) : 0,
      totalFacturado, totalCobrado, porChofer: Object.values(porChofer)
    });
  } catch (e) { errHandler(res, req, e); }
});

// ── SEGUIMIENTO PÚBLICO (sin auth) ───────────────────────────────────────────

router.get('/seguimiento/:nroViaje', async (req, res) => {
  try {
    const nroViaje = String(req.params.nroViaje);
    const snap = await db.collectionGroup('tras_viajes').where('nroViaje', '==', nroViaje).limit(1).get();
    if (snap.empty) return res.status(404).json({ ok: false, mensaje: 'Viaje no encontrado.' });
    const viaje = snap.docs[0].data();
    let ubicacionChofer = null;
    const estadosActivos = ['asignado', 'en_camino_origen', 'a_bordo', 'en_camino_destino'];
    if (viaje.choferNombre && estadosActivos.includes(viaje.estado)) {
      try {
        const pathParts = snap.docs[0].ref.path.split('/');
        const tenantId  = pathParts[1];
        const ubSnap = await db.collection('empresas').doc(tenantId).collection('ubicaciones').where('usuario', '==', viaje.choferNombre).limit(1).get();
        if (!ubSnap.empty) {
          const ub = ubSnap.docs[0].data();
          if (ub.lat && ub.lng) ubicacionChofer = { lat: ub.lat, lng: ub.lng };
        }
      } catch (eUb) {}
    }
    res.json({
      ok: true, nroViaje: viaje.nroViaje, estado: viaje.estado,
      pasajeroNombre: viaje.pasajeroNombre, origen: viaje.origen, destino: viaje.destino,
      fecha: viaje.fecha, hora: viaje.hora, choferNombre: viaje.choferNombre || '',
      fechaCompletado: viaje.fechaCompletado || '',
      historial: (viaje.historial || []).map(h => ({ estado: h.estado, fecha: h.fecha, nota: h.nota || '' })),
      ubicacionChofer
    });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
