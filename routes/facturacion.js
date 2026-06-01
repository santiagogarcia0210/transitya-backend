const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { esAdmin, fechaHoyAR, generarCorrelativo, nombreUsuario, col, randomUUID } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR facturacion]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── DATOS FISCALES ────────────────────────────────────────────────────────────

router.get('/datos-fiscales', auth, async (req, res) => {
  try {
    const doc = await db.collection('empresas').doc(req.tenantId).get();
    const datos = doc.exists ? (doc.data().datosFiscales || {}) : {};
    res.json({ ok: true, datosFiscales: datos });
  } catch (e) { err(res, req, e); }
});

router.put('/datos-fiscales', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    await db.collection('empresas').doc(req.tenantId).update({ datosFiscales: req.body });
    res.json({ ok: true, mensaje: 'Datos fiscales actualizados.' });
  } catch (e) { err(res, req, e); }
});

// ── FACTURAS ARCA/AFIP EMITIDAS ───────────────────────────────────────────────

router.get('/emitidas', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'facturas_emitidas').get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    res.json({ ok: true, facturas: docs, headers: docs[0] ? Object.keys(docs[0]).filter(k => !k.startsWith('_')) : [] });
  } catch (e) { err(res, req, e); }
});

router.post('/emitidas', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = { ...data, id, creadoPor: nombreUsuario(req.user), creadoEn: new Date().toISOString() };
    await col(req.tenantId, 'facturas_emitidas').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Factura ARCA registrada.', id });
  } catch (e) { err(res, req, e); }
});

router.put('/emitidas/:id/pagar', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const ref = col(req.tenantId, 'facturas_emitidas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    const doc = snap.data();
    doc.estado = 'PAGADO'; doc.fechaPago = fechaHoyAR();
    await ref.set(doc);
    if (doc.ingresoId) {
      try {
        const ingRef = col(req.tenantId, 'ingresos').doc(doc.ingresoId);
        const ingSnap = await ingRef.get();
        if (ingSnap.exists) await ingRef.update({ estado: 'PAGADO', fechaPago: fechaHoyAR() });
      } catch (eI) {}
    }
    res.json({ ok: true, mensaje: 'Factura ARCA marcada como pagada.' });
  } catch (e) { err(res, req, e); }
});

// ── FACTURAS ESPECIALES (esp_*) ───────────────────────────────────────────────

router.get('/esp/facturas', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const filtros = req.query;
    const snap = await col(req.tenantId, 'esp_facturas').get();
    let todas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (filtros.clienteId) todas = todas.filter(f => f.clienteId === filtros.clienteId);
    if (filtros.estado)    todas = todas.filter(f => f.estado === filtros.estado);
    todas.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    const pp = Number(filtros.porPagina) || 50;
    const pg = Math.max(1, Number(filtros.pagina) || 1);
    res.json({ ok: true, facturas: todas.slice((pg - 1) * pp, pg * pp), total: todas.length, pagina: pg, paginas: Math.max(1, Math.ceil(todas.length / pp)) });
  } catch (e) { err(res, req, e); }
});

router.post('/esp/facturas', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const data = req.body;
    const esNueva = !data.id;
    const id = data.id || randomUUID();
    const tipoFac = String(data.tipoFactura || 'X').toUpperCase();
    const puntoVenta = Number(data.puntoVenta) || 1;
    const pv = String(puntoVenta).padStart(4, '0');

    let nroComprobante, nroFormateado;
    if (esNueva) {
      nroComprobante = await generarCorrelativo(req.tenantId, `esp_fac_${tipoFac}_${pv}`);
      nroFormateado = pv + '-' + String(nroComprobante).padStart(8, '0');
    } else {
      nroComprobante = data.nroComprobante || 0;
      nroFormateado = data.nroFactura || '';
    }

    const doc = {
      id, nroFactura: nroFormateado, nroComprobante, tipoFactura: tipoFac, puntoVenta,
      cuitEmisor: String(data.cuitEmisor || '').trim(), razonSocialEmisor: String(data.razonSocialEmisor || '').trim(),
      condicionIVAEmisor: String(data.condicionIVAEmisor || '').trim(),
      clienteId: data.clienteId || '', clienteNombre: String(data.clienteNombre || '').trim(),
      cuitReceptor: String(data.cuitReceptor || '').trim(),
      condicionIVAReceptor: String(data.condicionIVAReceptor || '').trim(),
      items: Array.isArray(data.items) ? data.items : [],
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
    await col(req.tenantId, 'esp_facturas').doc(id).set(doc);

    if (esNueva) {
      try {
        const ingresoId = randomUUID();
        const ingreso = {
          id: ingresoId, tipo: 'FACTURA', numero: nroFormateado,
          cliente: doc.clienteNombre, cuit: doc.cuitReceptor, fecha: doc.fecha,
          monto: doc.total, estado: 'PRESENTADO', facturaId: id,
          concepto: 'Factura Esp ' + tipoFac + ' ' + nroFormateado,
          _origen: 'facturacion_automatica', modulo: 'especial',
          fechaPago: '', creadoEn: new Date().toISOString()
        };
        await col(req.tenantId, 'ingresos').doc(ingresoId).set(ingreso);
        await col(req.tenantId, 'esp_facturas').doc(id).update({ ingresoId });
      } catch (eIng) { console.error('[esp ingreso error]', eIng.message); }
    }

    res.json({ ok: true, mensaje: 'Factura especial guardada.', id, nroFactura: nroFormateado });
  } catch (e) { err(res, req, e); }
});

router.put('/esp/facturas/:id/pagar', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const ref = col(req.tenantId, 'esp_facturas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    const doc = snap.data();
    const fechaHoy = fechaHoyAR();
    doc.estado = 'pagada'; doc.fechaPago = fechaHoy;
    await ref.set(doc);
    if (doc.ingresoId) {
      try {
        const ingRef = col(req.tenantId, 'ingresos').doc(doc.ingresoId);
        const ingSnap = await ingRef.get();
        if (ingSnap.exists) await ingRef.update({ estado: 'PAGADO', fechaPago: fechaHoy });
      } catch (eI) {}
    }
    res.json({ ok: true, mensaje: 'Factura especial marcada como pagada.' });
  } catch (e) { err(res, req, e); }
});

router.get('/esp/ingresos', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'ingresos').get();
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(i => i.modulo === 'especial' || i.modulo === 'arca')
      .sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ ok: true, ingresos: todos });
  } catch (e) { err(res, req, e); }
});

router.put('/esp/ingresos/:id/pagar', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const ref = col(req.tenantId, 'ingresos').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Ingreso no encontrado.' });
    const ing = snap.data();
    const fechaHoy = fechaHoyAR();
    ing.estado = 'PAGADO'; ing.fechaPago = fechaHoy;
    await ref.set(ing);
    if (ing.facturaId) {
      try {
        const facRef = col(req.tenantId, 'esp_facturas').doc(ing.facturaId);
        const facSnap = await facRef.get();
        if (facSnap.exists) await facRef.update({ estado: 'pagada', fechaPago: fechaHoy });
      } catch (eF) {}
    }
    res.json({ ok: true, mensaje: 'Ingreso marcado como pagado.' });
  } catch (e) { err(res, req, e); }
});

// ── PUNTOS DE VENTA ───────────────────────────────────────────────────────────

router.get('/puntos-venta', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'puntosVenta').get();
    res.json({ ok: true, puntosVenta: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) { err(res, req, e); }
});

router.post('/puntos-venta', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const ref = await col(req.tenantId, 'puntosVenta').add({ ...req.body, creadoEn: new Date() });
    res.json({ ok: true, id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/puntos-venta/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    await col(req.tenantId, 'puntosVenta').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/puntos-venta/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    await col(req.tenantId, 'puntosVenta').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// ── DATOS MÓDULOS ESPECIALES (presentación, altas, cambio transporte) ─────────

router.get('/datos/facturacion', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'facturacion').get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, headers: docs[0] ? Object.keys(docs[0]).filter(k => !k.startsWith('_')) : [], valores: docs });
  } catch (e) { err(res, req, e); }
});

router.get('/datos/presentacion', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'presentacion_docs').get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, registros: docs, headers: docs[0] ? Object.keys(docs[0]).filter(k => !k.startsWith('_')) : [] });
  } catch (e) { err(res, req, e); }
});

router.get('/datos/altas', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'altas_pres').get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, registros: docs, headers: docs[0] ? Object.keys(docs[0]).filter(k => !k.startsWith('_')) : [] });
  } catch (e) { err(res, req, e); }
});

router.get('/datos/cambio-transporte', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'cambio_transporte').get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, registros: docs, headers: docs[0] ? Object.keys(docs[0]).filter(k => !k.startsWith('_')) : [] });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
