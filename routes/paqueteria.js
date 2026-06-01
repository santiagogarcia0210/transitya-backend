const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const {
  normalizarText_, parseMonto_, fechaHoyAR, esAdmin, nombreUsuario,
  esMesISO, generarCorrelativo, col, MESES, randomUUID
} = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR paqueteria]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── REPARTIDORES ──────────────────────────────────────────────────────────────

router.get('/repartidores', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'paq_repartidores').get();
    const docs = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    res.json({ ok: true, repartidores: docs, hayMas: docs.length >= 500 });
  } catch (e) { err(res, req, e); }
});

router.post('/repartidores', auth, async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = {
      id, nombre: data.nombre || '', telefono: data.telefono || '',
      email: data.email || '', dni: data.dni || '', licencia: data.licencia || '',
      vehiculo: data.vehiculo || '', patente: data.patente || '',
      tipoVehiculo: data.tipoVehiculo || 'moto', capacidadKg: data.capacidadKg || 0,
      activo: data.activo !== false, notas: data.notas || '',
      creadoEn: data.creadoEn || new Date().toISOString()
    };
    await col(req.tenantId, 'paq_repartidores').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Repartidor guardado.', id });
  } catch (e) { err(res, req, e); }
});

router.delete('/repartidores/:id', auth, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'paq_repartidores').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ activo: false });
    res.json({ ok: true, mensaje: 'Repartidor desactivado.' });
  } catch (e) { err(res, req, e); }
});

// ── CLIENTES ──────────────────────────────────────────────────────────────────

router.get('/clientes', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'paq_clientes').get();
    const docs = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    res.json({ ok: true, clientes: docs, hayMas: docs.length >= 500 });
  } catch (e) { err(res, req, e); }
});

router.post('/clientes', auth, async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = {
      id, nombre: data.nombre || '', telefono: data.telefono || '',
      email: data.email || '', dni: data.dni || '', direccion: data.direccion || '',
      localidad: data.localidad || '', notas: data.notas || '',
      activo: data.activo !== false, creadoEn: data.creadoEn || new Date().toISOString()
    };
    await col(req.tenantId, 'paq_clientes').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Cliente guardado.', id });
  } catch (e) { err(res, req, e); }
});

router.delete('/clientes/:id', auth, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'paq_clientes').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ activo: false });
    res.json({ ok: true, mensaje: 'Cliente eliminado.' });
  } catch (e) { err(res, req, e); }
});

// ── ENVÍOS ────────────────────────────────────────────────────────────────────

router.get('/envios', auth, async (req, res) => {
  try {
    const filtros = req.query;
    const snap = await col(req.tenantId, 'paq_envios').get();
    let todos = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    const admin = esAdmin(req.user);

    todos = todos.filter(doc => {
      if (!admin) {
        const rep = normalizarText_(doc.repartidorId || '');
        if (rep && rep !== normalizarText_(req.user?.uid || '')) return false;
      }
      if (filtros.estado && doc.estado !== filtros.estado) return false;
      if (filtros.repartidorId && doc.repartidorId !== filtros.repartidorId) return false;
      if (filtros.clienteId && doc.clienteId !== filtros.clienteId) return false;
      if (filtros.texto) {
        const q = normalizarText_(filtros.texto);
        const txt = normalizarText_([doc.nroEnvio, doc.clienteNombre, doc.direccionDestino, doc.descripcion].join(' '));
        if (!txt.includes(q)) return false;
      }
      return true;
    });

    todos.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    const pp = Number(filtros.porPagina) || 50;
    const pg = Math.max(1, Number(filtros.pagina) || 1);
    res.json({
      ok: true, envios: todos.slice((pg - 1) * pp, pg * pp),
      total: todos.length, pagina: pg, paginas: Math.max(1, Math.ceil(todos.length / pp))
    });
  } catch (e) { err(res, req, e); }
});

router.get('/envios-repartidor', auth, async (req, res) => {
  try {
    const snapReps = await col(req.tenantId, 'paq_repartidores').get();
    const reps = snapReps.docs.map(d => d.data());
    const usuario = nombreUsuario(req.user);
    const email = req.user?.email || '';
    const rep = reps.find(r =>
      (email && r.email && r.email.toLowerCase() === email.toLowerCase()) ||
      normalizarText_(r.nombre) === normalizarText_(usuario)
    );
    if (!rep) return res.status(404).json({ ok: false, mensaje: 'No tenés un perfil de repartidor asociado a tu usuario.' });
    const snap = await col(req.tenantId, 'paq_envios').get();
    const activos = snap.docs.map(d => d.data())
      .filter(e => e.repartidorId === rep.id && (e.estado === 'asignado' || e.estado === 'en_camino'))
      .sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ ok: true, envios: activos, repartidor: rep });
  } catch (e) { err(res, req, e); }
});

router.get('/envios/:id', auth, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'paq_envios').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'Envío no encontrado.' });
    res.json({ ok: true, envio: { ...doc.data(), _fsId: doc.id } });
  } catch (e) { err(res, req, e); }
});

router.post('/envios', auth, async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || randomUUID();
    const nroEnvio = data.nroEnvio || ('ENV-' + String(await generarCorrelativo(req.tenantId, 'paq_nro_envio')).padStart(6, '0'));
    const usuario = nombreUsuario(req.user);
    const doc = {
      id, nroEnvio,
      clienteId: data.clienteId || '', clienteNombre: data.clienteNombre || '',
      clienteTelefono: data.clienteTelefono || '', repartidorId: data.repartidorId || '',
      repartidorNombre: data.repartidorNombre || '', direccionOrigen: data.direccionOrigen || '',
      direccionDestino: data.direccionDestino || '', localidadDestino: data.localidadDestino || '',
      descripcion: data.descripcion || '', pesoKg: data.pesoKg || 0,
      bultos: data.bultos || 1, valorDeclarado: data.valorDeclarado || 0,
      precio: data.precio || 0, estado: data.estado || 'pendiente',
      prioridad: data.prioridad || 'normal', notas: data.notas || '',
      fotoEntrega: data.fotoEntrega || '', firmaEntrega: data.firmaEntrega || '',
      fechaEntrega: data.fechaEntrega || '', creadoPor: usuario,
      creadoEn: data.creadoEn || new Date().toISOString(),
      historial: data.historial || [{ estado: 'pendiente', fecha: new Date().toISOString(), usuario, nota: 'Envío creado' }]
    };
    await col(req.tenantId, 'paq_envios').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Envío guardado.', id, nroEnvio });
  } catch (e) { err(res, req, e); }
});

router.put('/envios/:id/estado', auth, async (req, res) => {
  try {
    const { nuevoEstado, nota, fotoUrl } = req.body;
    const ESTADOS_VALIDOS = ['pendiente', 'asignado', 'en_camino', 'entregado', 'devuelto', 'cancelado'];
    if (!ESTADOS_VALIDOS.includes(nuevoEstado)) return res.status(400).json({ ok: false, mensaje: 'Estado inválido.' });
    const ref = col(req.tenantId, 'paq_envios').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Envío no encontrado.' });
    const doc = snap.data();
    doc.estado = nuevoEstado;
    if (nuevoEstado === 'entregado') {
      doc.fechaEntrega = new Date().toISOString();
      if (fotoUrl) doc.fotoEntrega = fotoUrl;
    }
    const entrada = { estado: nuevoEstado, fecha: new Date().toISOString(), usuario: nombreUsuario(req.user), nota: nota || '' };
    if (fotoUrl) entrada.foto = fotoUrl;
    if (!doc.historial) doc.historial = [];
    doc.historial.push(entrada);
    await ref.set(doc);
    res.json({ ok: true, mensaje: `Estado actualizado a "${nuevoEstado}".` });
  } catch (e) { err(res, req, e); }
});

router.post('/envios/:id/asignar', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Solo el admin puede asignar envíos.' });
    const { repartidorId } = req.body;
    const [envioSnap, repSnap] = await Promise.all([
      col(req.tenantId, 'paq_envios').doc(req.params.id).get(),
      col(req.tenantId, 'paq_repartidores').doc(repartidorId).get()
    ]);
    if (!envioSnap.exists) return res.status(404).json({ ok: false, mensaje: 'Envío no encontrado.' });
    if (!repSnap.exists) return res.status(404).json({ ok: false, mensaje: 'Repartidor no encontrado.' });
    const doc = envioSnap.data();
    const rep = repSnap.data();
    doc.repartidorId = rep.id; doc.repartidorNombre = rep.nombre; doc.estado = 'asignado';
    if (!doc.historial) doc.historial = [];
    doc.historial.push({ estado: 'asignado', fecha: new Date().toISOString(), usuario: nombreUsuario(req.user), nota: 'Asignado a ' + rep.nombre });
    await col(req.tenantId, 'paq_envios').doc(req.params.id).set(doc);
    res.json({ ok: true, mensaje: 'Asignado a ' + rep.nombre + '.', repartidorNombre: rep.nombre });
  } catch (e) { err(res, req, e); }
});

router.post('/envios/:id/entregar', auth, async (req, res) => {
  req.body.nuevoEstado = 'entregado';
  req.body.nota = 'Entregado por repartidor';
  const fakeNext = async () => {};
  const fakeRes = {
    json: (data) => res.json(data),
    status: (code) => ({ json: (data) => res.status(code).json(data) })
  };
  const modifiedReq = { ...req, params: { id: req.params.id } };
  try {
    const { nuevoEstado, nota, fotoUrl } = req.body;
    const ref = col(req.tenantId, 'paq_envios').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Envío no encontrado.' });
    const doc = snap.data();
    doc.estado = 'entregado'; doc.fechaEntrega = new Date().toISOString();
    if (fotoUrl) doc.fotoEntrega = fotoUrl;
    if (!doc.historial) doc.historial = [];
    doc.historial.push({ estado: 'entregado', fecha: new Date().toISOString(), usuario: nombreUsuario(req.user), nota: 'Entregado por repartidor', foto: fotoUrl || '' });
    await ref.set(doc);
    res.json({ ok: true, mensaje: 'Entrega registrada.' });
  } catch (e) { err(res, req, e); }
});

// ── PAQUETES ──────────────────────────────────────────────────────────────────

router.get('/paquetes', auth, async (req, res) => {
  try {
    const filtros = req.query;
    const snap = await col(req.tenantId, 'paq_paquetes').get();
    let todos = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    if (filtros.estado)  todos = todos.filter(d => d.estado === filtros.estado);
    if (filtros.envioId) todos = todos.filter(d => d.envioId === filtros.envioId);
    const pp = Number(filtros.porPagina) || 50;
    const pg = Math.max(1, Number(filtros.pagina) || 1);
    res.json({ ok: true, paquetes: todos.slice((pg - 1) * pp, pg * pp), total: todos.length, pagina: pg, paginas: Math.max(1, Math.ceil(todos.length / pp)) });
  } catch (e) { err(res, req, e); }
});

router.post('/paquetes', auth, async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = {
      id, envioId: data.envioId || '', nroEnvio: data.nroEnvio || '',
      descripcion: data.descripcion || '', pesoKg: data.pesoKg || 0,
      largo: data.largo || 0, ancho: data.ancho || 0, alto: data.alto || 0,
      fragil: data.fragil || false, estado: data.estado || 'en_deposito',
      ubicacion: data.ubicacion || '', notas: data.notas || '',
      creadoEn: data.creadoEn || new Date().toISOString()
    };
    await col(req.tenantId, 'paq_paquetes').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Paquete guardado.', id });
  } catch (e) { err(res, req, e); }
});

// ── RUTAS DE REPARTO ──────────────────────────────────────────────────────────

router.get('/rutas', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    const snap = await col(req.tenantId, 'paq_rutas').get();
    let todas = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    if (fecha) todas = todas.filter(r => r.fecha === fecha);
    res.json({ ok: true, rutas: todas, hayMas: todas.length >= 1000 });
  } catch (e) { err(res, req, e); }
});

router.post('/rutas', auth, async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = {
      id, fecha: data.fecha || fechaHoyAR(),
      repartidorId: data.repartidorId || '', repartidorNombre: data.repartidorNombre || '',
      envios: data.envios || [], estado: data.estado || 'planificada',
      kmTotal: data.kmTotal || 0, notas: data.notas || '',
      creadoEn: data.creadoEn || new Date().toISOString()
    };
    await col(req.tenantId, 'paq_rutas').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Ruta guardada.', id });
  } catch (e) { err(res, req, e); }
});

// ── FACTURAS ──────────────────────────────────────────────────────────────────

router.get('/facturas', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos para ver facturas.' });
    const filtros = req.query;
    const snap = await col(req.tenantId, 'paq_facturas').get();
    let todas = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }));
    if (filtros.clienteId) todas = todas.filter(f => f.clienteId === filtros.clienteId);
    if (filtros.estado) todas = todas.filter(f => f.estado === filtros.estado);
    todas.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    const pp = Number(filtros.porPagina) || 50;
    const pg = Math.max(1, Number(filtros.pagina) || 1);
    res.json({ ok: true, facturas: todas.slice((pg - 1) * pp, pg * pp), total: todas.length, pagina: pg, paginas: Math.max(1, Math.ceil(todas.length / pp)) });
  } catch (e) { err(res, req, e); }
});

router.post('/facturas', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos para guardar facturas.' });
    const data = req.body;
    const esNueva = !data.id;
    const id = data.id || randomUUID();
    const tipoFac = String(data.tipoFactura || 'X').toUpperCase();
    const puntoVenta = Number(data.puntoVenta) || 1;
    const pv = String(puntoVenta).padStart(4, '0');

    let nroComprobante, nroFormateado;
    if (esNueva) {
      nroComprobante = await generarCorrelativo(req.tenantId, `paq_fac_${tipoFac}_${pv}`);
      nroFormateado = pv + '-' + String(nroComprobante).padStart(8, '0');
    } else {
      nroComprobante = data.nroComprobante || 0;
      nroFormateado = data.nroFactura || '';
    }

    const doc = {
      id, nroFactura: nroFormateado, nroComprobante, tipoFactura: tipoFac, puntoVenta,
      cuitEmisor: String(data.cuitEmisor || '').trim(), razonSocialEmisor: String(data.razonSocialEmisor || '').trim(),
      condicionIVAEmisor: String(data.condicionIVAEmisor || '').trim(), domicilioEmisor: String(data.domicilioEmisor || '').trim(),
      iibbEmisor: String(data.iibbEmisor || '').trim(), clienteId: data.clienteId || '',
      clienteNombre: String(data.clienteNombre || '').trim(), cuitReceptor: String(data.cuitReceptor || '').trim(),
      condicionIVAReceptor: String(data.condicionIVAReceptor || '').trim(),
      items: Array.isArray(data.items) ? data.items : [], envios: data.envios || [],
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
    await col(req.tenantId, 'paq_facturas').doc(id).set(doc);

    if (esNueva) {
      try {
        const ingresoId = randomUUID();
        const ingreso = {
          id: ingresoId, tipo: 'FACTURA', numero: nroFormateado,
          cliente: doc.clienteNombre, cuit: doc.cuitReceptor, fecha: doc.fecha,
          monto: doc.total, estado: 'PRESENTADO', facturaId: id,
          concepto: 'Factura ' + tipoFac + ' ' + nroFormateado,
          _origen: 'facturacion_automatica', modulo: 'paqueteria',
          fechaPago: '', creadoEn: new Date().toISOString()
        };
        await col(req.tenantId, 'ingresos').doc(ingresoId).set(ingreso);
        await col(req.tenantId, 'paq_facturas').doc(id).update({ ingresoId });
      } catch (eIng) { console.error('[paq ingreso error]', eIng.message); }
    }

    res.json({ ok: true, mensaje: 'Factura guardada.', id, nroFactura: nroFormateado });
  } catch (e) { err(res, req, e); }
});

router.put('/facturas/:id/pagar', auth, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'paq_facturas').doc(req.params.id);
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
    res.json({ ok: true, mensaje: 'Factura marcada como pagada.' });
  } catch (e) { err(res, req, e); }
});

// ── INGRESOS ──────────────────────────────────────────────────────────────────

router.get('/ingresos', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'ingresos').get();
    const todos = snap.docs.map(d => ({ ...d.data(), _fsId: d.id }))
      .filter(i => i.modulo === 'paqueteria' || i.modulo === 'arca')
      .sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ ok: true, ingresos: todos });
  } catch (e) { err(res, req, e); }
});

router.put('/ingresos/:id/pagar', auth, async (req, res) => {
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
        const facRef = col(req.tenantId, 'paq_facturas').doc(ing.facturaId);
        const facSnap = await facRef.get();
        if (facSnap.exists) await facRef.update({ estado: 'pagada', fechaPago: fechaHoy });
      } catch (eF) {}
    }
    res.json({ ok: true, mensaje: 'Ingreso marcado como pagado.' });
  } catch (e) { err(res, req, e); }
});

// ── REPORTES ──────────────────────────────────────────────────────────────────

router.get('/reportes', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos para ver reportes financieros.' });
    const m = Number(req.query.mes) || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const [enviosSnap, facturasSnap] = await Promise.all([
      col(req.tenantId, 'paq_envios').get(),
      col(req.tenantId, 'paq_facturas').get()
    ]);
    const envios = enviosSnap.docs.map(d => d.data());
    const facturas = facturasSnap.docs.map(d => d.data());
    const enviosMes = envios.filter(e => esMesISO(e.creadoEn, m, y));
    const entregados = enviosMes.filter(e => e.estado === 'entregado');
    const devueltos  = enviosMes.filter(e => e.estado === 'devuelto');
    const cancelados = enviosMes.filter(e => e.estado === 'cancelado');
    const facturasMes = facturas.filter(f => esMesISO(f.creadoEn, m, y));
    const totalFacturado = facturasMes.reduce((s, f) => s + (Number(f.total) || 0), 0);
    const totalCobrado = facturasMes.filter(f => f.estado === 'pagada').reduce((s, f) => s + (Number(f.total) || 0), 0);
    const porRepartidor = {};
    enviosMes.forEach(e => {
      const rep = e.repartidorNombre || 'Sin asignar';
      if (!porRepartidor[rep]) porRepartidor[rep] = { nombre: rep, total: 0, entregados: 0, devueltos: 0 };
      porRepartidor[rep].total++;
      if (e.estado === 'entregado') porRepartidor[rep].entregados++;
      if (e.estado === 'devuelto')  porRepartidor[rep].devueltos++;
    });
    res.json({
      ok: true, mes: MESES[m - 1], anio: y,
      totalEnvios: enviosMes.length, entregados: entregados.length,
      devueltos: devueltos.length, cancelados: cancelados.length,
      efectividad: enviosMes.length > 0 ? Math.round(entregados.length / enviosMes.length * 100) : 0,
      totalFacturado, totalCobrado, porRepartidor: Object.values(porRepartidor)
    });
  } catch (e) { err(res, req, e); }
});

// ── TRACKING CON AUTH ─────────────────────────────────────────────────────────

router.get('/tracking/:id', auth, async (req, res) => {
  try {
    const nroOId = req.params.id;
    let doc = await col(req.tenantId, 'paq_envios').doc(nroOId).get();
    let envio = doc.exists ? doc.data() : null;
    if (!envio) {
      const snap = await col(req.tenantId, 'paq_envios').where('nroEnvio', '==', nroOId).limit(1).get();
      envio = snap.empty ? null : snap.docs[0].data();
    }
    if (!envio) return res.status(404).json({ ok: false, mensaje: 'Envío no encontrado.' });
    res.json({ ok: true, nroEnvio: envio.nroEnvio, estado: envio.estado, clienteNombre: envio.clienteNombre, direccionDestino: envio.direccionDestino, repartidorNombre: envio.repartidorNombre, fechaEntrega: envio.fechaEntrega, fotoEntrega: envio.fotoEntrega, historial: envio.historial || [] });
  } catch (e) { err(res, req, e); }
});

// ── SEGUIMIENTO PÚBLICO ───────────────────────────────────────────────────────

router.get('/seguimiento/:nroEnvio', async (req, res) => {
  try {
    const nroEnvio = String(req.params.nroEnvio);
    const snap = await db.collectionGroup('paq_envios').where('nroEnvio', '==', nroEnvio).limit(1).get();
    if (snap.empty) return res.status(404).json({ ok: false, mensaje: 'Envío no encontrado.' });
    const envio = snap.docs[0].data();
    let ubicacionRepartidor = null;
    if (envio.repartidorNombre && (envio.estado === 'en_camino' || envio.estado === 'asignado')) {
      try {
        const pathParts = snap.docs[0].ref.path.split('/');
        const tenantId = pathParts[1];
        const ubSnap = await db.collection('empresas').doc(tenantId).collection('ubicaciones').where('usuario', '==', envio.repartidorNombre).limit(1).get();
        if (!ubSnap.empty) {
          const ub = ubSnap.docs[0].data();
          if (ub.lat && ub.lng) ubicacionRepartidor = { lat: ub.lat, lng: ub.lng };
        }
      } catch (eUb) {}
    }
    res.json({
      ok: true, nroEnvio: envio.nroEnvio, estado: envio.estado,
      clienteNombre: envio.clienteNombre, direccionDestino: envio.direccionDestino,
      repartidorNombre: envio.repartidorNombre || '', fechaEntrega: envio.fechaEntrega || '',
      fotoEntrega: envio.fotoEntrega || '',
      historial: (envio.historial || []).map(h => ({ estado: h.estado, fecha: h.fecha, nota: h.nota || '' })),
      ubicacionRepartidor
    });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
