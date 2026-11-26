// Presupuestos de transporte: configuración, cálculo, ciclo de vida y documento .docx. Solo administración, por empresa.
//
//   Configuración   GET /config · PUT /transportista · PUT /obras/:obraId · POST|DELETE /obras/:obraId/plantilla
//   Asistente       GET /prefill/:beneficiarioId · POST /calcular
//   Ciclo de vida   GET / · POST / · GET|PUT|DELETE /:id · POST /:id/emitir|respuesta|anular|duplicar · GET /:id/docx
//
// Estados: BORRADOR → EMITIDO → ACEPTADO | RECHAZADO, y ANULADO. Un presupuesto emitido NO se edita: se anula y se
// genera otro (duplicar). El número es correlativo por empresa y se asigna al emitir.
//
// Datos clínicos: el asistente puede pre-completar los días por semana con lo que dice la orden médica (solo para
// quien puede ver datos clínicos), pero el presupuesto NO guarda diagnóstico ni nada clínico.
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { puedeVerClinico } = require('../middleware/permisos');
const { col, randomUUID, nombreUsuario } = require('../utils');
const { normalizarFecha, fechaToDate } = require('../utils/fechas');
const L = require('../services/legajos');
const A = require('../services/arancel');
const P = require('../services/presupuestoConfig');
const { calcularPresupuesto, DIAS } = require('../services/presupuestoCalculo');
const D = require('../services/presupuestoDocx');
const { crearStore } = require('../services/legajoClinicoStore');

const ESTADOS = ['BORRADOR', 'EMITIDO', 'ACEPTADO', 'RECHAZADO', 'ANULADO'];
const DIAS_SIN_RESPUESTA_DEFAULT = 7;
const MAX_PLANTILLA_BYTES = 8 * 1024 * 1024;
const MODALIDADES = ['solo_ida', 'ida_vuelta_total', 'dos_recorridos'];
const recortar = (v, n) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const campo = (reg, ...claves) => { for (const k of claves) if (reg[k] !== undefined && reg[k] !== null && String(reg[k]).trim()) return String(reg[k]).trim(); return ''; };
const hoyDMY = ahora => normalizarFecha(ahora);

function crearRouterPresupuestos({ descargar, subirArchivo, ahora = () => new Date(), almacenClinico } = {}) {
  const router = require('express').Router();
  const { db } = require('../firebase');
  const clinicoStore = almacenClinico || crearStore({ col, ahora });
  const subir = subirArchivo || ((...a) => require('../helpers/storage').subirFoto(...a));
  const bajar = descargar || (async url => { const r = await fetch(url); if (!r.ok) throw new Error('descarga'); return Buffer.from(await r.arrayBuffer()); });
  const auth = [verifyToken, requireAdmin];

  const fallo = (res, status, mensaje, extra = {}) => res.status(status).json({ ok: false, mensaje, ...extra });
  const errHandler = (res, req, e) => {
    if (e.mensaje) return fallo(res, e.status || 400, e.mensaje, e.extra || {});
    console.error('[PRESUPUESTOS]', req.method, req.path, { codigo: e.codigo || e.name });     // nunca datos del paciente
    return fallo(res, 500, 'No se pudo procesar el presupuesto.');
  };
  const lanzar = (status, mensaje, extra) => { throw Object.assign(new Error(mensaje), { status, mensaje, extra }); };

  /* ── Lecturas auxiliares ───────────────────────────────────────────────── */
  async function obrasRequisitos(t) { return (await col(t, 'requisitos_os').get()).docs.map(d => ({ id: d.id, ...d.data() })); }
  async function transportista(t) { const s = await col(t, 'config').doc('transportista').get(); return s.exists ? s.data() : {}; }
  async function aranceles(t) { return (await col(t, 'aranceles_nomenclador').get()).docs.map(d => ({ id: d.id, ...d.data() })); }
  async function obraConfig(t, obraId, nombre = '') {
    if (!obraId) return P.obraPorDefecto(null, nombre);
    const s = await col(t, 'presupuesto_obras').doc(obraId).get();
    return s.exists ? { ...P.obraPorDefecto(obraId, nombre), ...s.data() } : P.obraPorDefecto(obraId, nombre);
  }
  async function beneficiario(t, id) {
    let s = await col(t, 'registro').doc(id).get();
    if (!s.exists) s = await col(t, 'BENEFICIARIOS').doc(id).get();
    if (!s.exists) return null;
    const raw = s.data(), b = L.datosBeneficiario({ id: s.id, ...raw });
    return {
      id: s.id, nombre: b.nombre, dni: b.dni, afiliado: b.afiliado, obraSocial: b.obraSocial,
      domicilio: campo(raw, 'DOMICILIO', 'domicilio'), localidad: campo(raw, 'LOCALIDAD', 'localidad'),
      tutor: campo(raw, 'TUTOR', 'RESPONSABLE', 'FAMILIAR', 'tutor'), contacto: campo(raw, 'TELEFONO', 'CELULAR', 'TEL', 'CONTACTO', 'telefono'),
    };
  }
  async function obraDe(t, ben) {
    const obras = await obrasRequisitos(t);
    const o = L.matchObraSocial(ben && ben.obraSocial, obras);
    return o ? { id: o.id, nombre: o.nombre } : { id: null, nombre: (ben && ben.obraSocial) || '' };
  }

  /* ── Validación de viajes ──────────────────────────────────────────────── */
  function limpiarViajes(viajes) {
    if (!Array.isArray(viajes) || !viajes.length) lanzar(400, 'Cargá al menos un viaje.');
    if (viajes.length > 12) lanzar(400, 'Hasta 12 viajes por presupuesto.');
    return viajes.map((v, i) => {
      const id = recortar(v.id, 6) || String(i + 1);
      const num = x => Number(String(x).replace(',', '.'));
      const out = { id, origen: recortar(v.origen, 200), destino: recortar(v.destino, 200), centro: recortar(v.centro, 150), modalidad: MODALIDADES.includes(v.modalidad) ? v.modalidad : 'solo_ida', incluyeVuelta: v.incluyeVuelta === true };
      const dias = (Array.isArray(v.dias) ? v.dias : []).filter(d => DIAS.includes(d));
      if (!dias.length) lanzar(400, `El viaje ${id} necesita al menos un día de traslado.`);
      out.dias = [...new Set(dias)];
      if (out.modalidad === 'dos_recorridos') { out.kmIda = num(v.kmIda); out.kmVuelta = num(v.kmVuelta); }
      else if (Array.isArray(v.tramos) && v.tramos.length) out.tramos = v.tramos.slice(0, 8).map(num);
      else out.km = num(v.km);
      for (const k of [out.kmIda, out.kmVuelta, out.km, ...(out.tramos || [])]) if (k !== undefined && !(k >= 0.1 && k <= 300)) lanzar(400, `El viaje ${id} tiene km fuera de rango (0,1 a 300).`);
      const m = v.mapa && typeof v.mapa === 'object' ? v.mapa : null;
      if (m) out.mapa = {
        hashes: (Array.isArray(m.hashes) ? m.hashes : []).filter(h => /^[a-f0-9]{64}$/.test(h)).slice(0, 2),
        origen: m.origen === 'impresion' ? 'impresion' : 'manual', confianza: ['alta', 'media', 'baja'].includes(m.confianza) ? m.confianza : 'baja',
        coincide: m.coincide === true ? true : m.coincide === false ? false : null, confirmadoManual: m.confirmadoManual === true,
      };
      return out;
    });
  }

  /* ── Cálculo con la configuración del servidor ─────────────────────────── */
  async function armarCalculo(t, p) {
    const fecha = normalizarFecha(p.fechaReferencia) || hoyDMY(ahora());
    const cfg = await obraConfig(t, p.obraId || null, p.obraNombre || '');
    const lista = await aranceles(t);
    const vig = A.valorVigente(lista, { fecha, obraId: p.obraId || null });
    if (!vig) lanzar(409, 'No hay un valor del km cargado para esa fecha. Cargalo en Aranceles.');
    const dep = { activa: p.dependencia && p.dependencia.activa === true, porcentaje: p.dependencia && p.dependencia.porcentaje !== undefined && p.dependencia.porcentaje !== '' ? Number(p.dependencia.porcentaje) : cfg.dependenciaPct };
    const semanas = p.semanasPorMes !== undefined && p.semanasPorMes !== '' ? Number(p.semanasPorMes) : cfg.semanasPorMes;
    let calculo;
    try { calculo = calcularPresupuesto({ viajes: p.viajes, valorKmBase: vig.arancel.valorKmTransporte, dependencia: dep, semanasPorMes: semanas, tramoCorto: cfg.tramoCorto }); }
    catch (e) { lanzar(400, e.mensaje || 'No se pudo calcular el presupuesto.'); }
    const a = vig.arancel;
    return {
      calculo, cfg: { formato: cfg.formato, tramoCorto: cfg.tramoCorto, semanasPorMes: semanas, dependenciaPct: cfg.dependenciaPct, tienePlantilla: !!cfg.plantilla },
      arancel: { id: a.id, valorKmTransporte: a.valorKmTransporte, resolucion: a.resolucion, mes: a.mes || '', vigenteDesde: a.vigenteDesde, origen: vig.origen, verificar: a.verificar === true },
      fechaReferencia: fecha, aviso: A.estadoActualizacion(lista, { hoy: ahora(), obraId: p.obraId || null }),
    };
  }

  /* ═════════════ Configuración ═════════════ */
  router.get('/config', ...auth, async (req, res) => {
    try {
      const t = req.tenantId;
      const [tr, obras, cfgSnap] = await Promise.all([transportista(t), obrasRequisitos(t), col(t, 'presupuesto_obras').get()]);
      const propias = Object.fromEntries(cfgSnap.docs.map(d => [d.id, d.data()]));
      const lista = obras.map(o => ({ ...P.obraPorDefecto(o.id, o.nombre), ...(propias[o.id] || {}), obraId: o.id, nombre: (propias[o.id] && propias[o.id].nombre) || o.nombre }));
      const ajustes = (await col(t, 'config').doc('presupuestos').get()).data() || {};
      res.json({ ok: true, transportista: tr, faltantes: P.faltantesTransportista(tr), obras: lista, diasSinRespuesta: ajustes.diasSinRespuesta || DIAS_SIN_RESPUESTA_DEFAULT });
    } catch (e) { errHandler(res, req, e); }
  });

  router.put('/transportista', ...auth, async (req, res) => {
    try {
      const datos = P.limpiarTransportista(req.body || {});
      await col(req.tenantId, 'config').doc('transportista').set({ ...datos, actualizadoEn: ahora().toISOString(), actualizadoPor: nombreUsuario(req.user) });
      res.json({ ok: true, transportista: datos, faltantes: P.faltantesTransportista(datos) });
    } catch (e) { errHandler(res, req, e); }
  });

  router.put('/obras/:obraId', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, obraId = req.params.obraId;
      const previa = (await col(t, 'presupuesto_obras').doc(obraId).get()).data() || {};
      const datos = P.limpiarObra({ ...req.body });
      await col(t, 'presupuesto_obras').doc(obraId).set({ ...previa, ...datos, obraId, actualizadoEn: ahora().toISOString(), actualizadoPor: nombreUsuario(req.user) });
      res.json({ ok: true, obra: { ...datos, obraId, plantilla: previa.plantilla || null } });
    } catch (e) { errHandler(res, req, e); }
  });

  router.post('/obras/:obraId/plantilla', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, obraId = req.params.obraId;
      const a = req.body && req.body.archivo;
      if (!a || !a.base64) return fallo(res, 400, 'Falta el archivo.');
      const base64 = String(a.base64).replace(/^data:[^,]+,/, '');
      const buffer = Buffer.from(base64, 'base64');
      if (!buffer.length) return fallo(res, 400, 'El archivo está vacío.');
      if (buffer.length > MAX_PLANTILLA_BYTES) return fallo(res, 400, 'El archivo supera 8 MB.');
      const v = await D.validarPlantillaTraslados(buffer);
      if (!v.ok) return fallo(res, 400, v.mensaje);
      const nombre = String(a.nombre || 'plantilla.docx').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
      const ruta = `presupuestos-plantillas/${t}/${obraId}/${randomUUID()}-${nombre}`;
      const url = await subir(base64, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ruta);
      const previa = (await col(t, 'presupuesto_obras').doc(obraId).get()).data() || P.obraPorDefecto(obraId);
      const plantilla = { nombre, url, ruta, tamano: buffer.length, copias: v.copias, subidaEn: ahora().toISOString(), subidaPor: nombreUsuario(req.user) };
      await col(t, 'presupuesto_obras').doc(obraId).set({ ...previa, obraId, formato: 'traslados_programados', plantilla });
      res.json({ ok: true, plantilla, formato: 'traslados_programados' });
    } catch (e) { errHandler(res, req, e); }
  });

  router.delete('/obras/:obraId/plantilla', ...auth, async (req, res) => {
    try {
      const ref = col(req.tenantId, 'presupuesto_obras').doc(req.params.obraId);
      const s = await ref.get();
      if (!s.exists) return res.json({ ok: true });
      await ref.set({ ...s.data(), plantilla: null, formato: P.FORMATO_DEFAULT });   // sin plantilla propia vuelve al multi-viaje
      res.json({ ok: true, formato: P.FORMATO_DEFAULT });
    } catch (e) { errHandler(res, req, e); }
  });

  /* ═════════════ Asistente ═════════════ */
  router.get('/prefill/:beneficiarioId', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, ben = await beneficiario(t, req.params.beneficiarioId);
      if (!ben) return fallo(res, 404, 'Paciente no encontrado.');
      const obra = await obraDe(t, ben);
      const cfg = await obraConfig(t, obra.id, obra.nombre);
      const lista = await aranceles(t), fecha = hoyDMY(ahora());
      const vig = A.valorVigente(lista, { fecha, obraId: obra.id });
      const tr = await transportista(t);
      // Pistas desde la orden médica (solo si el usuario puede ver datos clínicos): únicamente los días por semana.
      const pistas = {};
      if (puedeVerClinico(req.user)) {
        try {
          const c = await clinicoStore.ver(t, { ...req.user, nombre: nombreUsuario(req.user) }, ben.id);
          const dias = c && c.ordenMedica && c.ordenMedica.campos.diasPorSemana;
          if (dias) pistas.diasPorSemana = dias.valor;
        } catch { /* sin clave o sin datos: no es un error del asistente */ }
      }
      res.json({
        ok: true, beneficiario: ben, obra: { id: obra.id, nombre: obra.nombre, formato: cfg.formato, tieneUnaPlantilla: !!cfg.plantilla, tramoCorto: cfg.tramoCorto, semanasPorMes: cfg.semanasPorMes, dependenciaPct: cfg.dependenciaPct },
        arancel: vig ? { valorKmTransporte: vig.arancel.valorKmTransporte, resolucion: vig.arancel.resolucion, mes: vig.arancel.mes || '', origen: vig.origen, verificar: vig.arancel.verificar === true } : null,
        aviso: A.estadoActualizacion(lista, { hoy: ahora(), obraId: obra.id }), transportista: P.faltantesTransportista(tr), pistas, fecha,
      });
    } catch (e) { errHandler(res, req, e); }
  });

  router.post('/calcular', ...auth, async (req, res) => {
    try {
      const b = req.body || {};
      const viajes = limpiarViajes(b.viajes);
      res.json({ ok: true, ...(await armarCalculo(req.tenantId, { ...b, viajes })) });
    } catch (e) { errHandler(res, req, e); }
  });

  /* ═════════════ Ciclo de vida ═════════════ */
  const cargar = async (t, id) => { const s = await col(t, 'presupuestos').doc(id).get(); return s.exists ? { id: s.id, ...s.data() } : null; };

  /** Lo que se guarda de un presupuesto (borrador): entradas validadas, sin cálculo (se recalcula al emitir). */
  async function datosDeBorrador(t, b) {
    const ben = await beneficiario(t, b.beneficiarioId);
    if (!ben) lanzar(404, 'Paciente no encontrado.');
    const obra = b.obraId !== undefined ? { id: b.obraId || null, nombre: recortar(b.obraNombre, 120) || ben.obraSocial } : await obraDe(t, ben);
    const mes = /^\d{4}-(0[1-9]|1[0-2])$/;
    if (b.periodoDesde && !mes.test(b.periodoDesde)) lanzar(400, 'El período "desde" no es válido.');
    if (b.periodoHasta && !mes.test(b.periodoHasta)) lanzar(400, 'El período "hasta" no es válido.');
    if (b.periodoDesde && b.periodoHasta && b.periodoHasta < b.periodoDesde) lanzar(400, 'El período "hasta" no puede ser anterior al "desde".');
    return {
      beneficiarioId: ben.id, beneficiario: { nombre: ben.nombre, dni: ben.dni, afiliado: ben.afiliado, obraSocial: ben.obraSocial, domicilio: recortar(b.domicilioOrigen, 200) || ben.domicilio, localidad: ben.localidad, tutor: recortar(b.tutor, 120) || ben.tutor, contacto: recortar(b.contacto, 60) || ben.contacto },
      obraId: obra.id, obraNombre: obra.nombre, periodoDesde: b.periodoDesde || '', periodoHasta: b.periodoHasta || '',
      fechaReferencia: normalizarFecha(b.fechaReferencia) || hoyDMY(ahora()), acompanante: b.acompanante === true, vehiculo: recortar(b.vehiculo, 80),
      observaciones: recortar(b.observaciones, 500), dependencia: { activa: b.dependencia && b.dependencia.activa === true, porcentaje: b.dependencia && b.dependencia.porcentaje !== undefined && b.dependencia.porcentaje !== '' ? Number(b.dependencia.porcentaje) : undefined },
      semanasPorMes: b.semanasPorMes !== undefined && b.semanasPorMes !== '' ? Number(b.semanasPorMes) : undefined,
      viajes: limpiarViajes(b.viajes), respaldoDocs: (Array.isArray(b.respaldoDocs) ? b.respaldoDocs : []).map(x => recortar(x, 80)).filter(Boolean).slice(0, 10),
    };
  }
  const limpiarUndefined = o => JSON.parse(JSON.stringify(o));

  router.get('/', ...auth, async (req, res) => {
    try {
      const snap = await col(req.tenantId, 'presupuestos').get();
      let lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (req.query.estado && ESTADOS.includes(req.query.estado)) lista = lista.filter(p => p.estado === req.query.estado);
      if (req.query.beneficiarioId) lista = lista.filter(p => p.beneficiarioId === req.query.beneficiarioId);
      lista.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
      // Listado liviano: sin el desglose completo.
      res.json({ ok: true, presupuestos: lista.map(p => ({ id: p.id, numero: p.numero || null, numeroTexto: p.numeroTexto || '', estado: p.estado, beneficiarioId: p.beneficiarioId, beneficiarioNombre: p.beneficiario && p.beneficiario.nombre, obraNombre: p.obraNombre, periodoDesde: p.periodoDesde, periodoHasta: p.periodoHasta, total: p.calculo ? p.calculo.total : null, fechaEmision: p.fechaEmision || '', creadoEn: p.creadoEn, respondidoEn: p.respondidoEn || null })) });
    } catch (e) { errHandler(res, req, e); }
  });

  router.post('/', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, id = randomUUID();
      const datos = await datosDeBorrador(t, req.body || {});
      await col(t, 'presupuestos').doc(id).set(limpiarUndefined({ id, ...datos, estado: 'BORRADOR', creadoEn: ahora().toISOString(), creadoPor: nombreUsuario(req.user) }));
      res.json({ ok: true, id });
    } catch (e) { errHandler(res, req, e); }
  });

  router.get('/:id', ...auth, async (req, res) => {
    try {
      const p = await cargar(req.tenantId, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      // Respaldo: documentos del legajo y recorridos de Google Maps (con su URL, sin datos clínicos).
      const respaldo = [];
      for (const docId of p.respaldoDocs || []) {
        const d = await col(req.tenantId, 'legajo_docs').doc(docId).get();
        if (d.exists && d.data().beneficiarioId === p.beneficiarioId) respaldo.push({ tipo: 'documento', nombre: d.data().nombre || d.data().requisitoKey, archivoUrl: d.data().archivoUrl || '' });
      }
      for (const v of p.viajes || []) for (const h of (v.mapa && v.mapa.hashes) || []) {
        const l = await col(req.tenantId, 'recorrido_lecturas').doc(`${p.beneficiarioId}_${h}`).get();
        if (l.exists) respaldo.push({ tipo: 'google_maps', viaje: v.id, nombre: l.data().archivoNombre, archivoUrl: l.data().archivoUrl });
      }
      res.json({ ok: true, presupuesto: p, respaldo });
    } catch (e) { errHandler(res, req, e); }
  });

  router.put('/:id', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, p = await cargar(t, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      if (p.estado !== 'BORRADOR') return fallo(res, 409, 'Un presupuesto emitido no se edita: anulalo y generá otro.');
      const datos = await datosDeBorrador(t, { beneficiarioId: p.beneficiarioId, ...req.body });
      await col(t, 'presupuestos').doc(p.id).set(limpiarUndefined({ ...p, ...datos, actualizadoEn: ahora().toISOString(), actualizadoPor: nombreUsuario(req.user) }));
      res.json({ ok: true });
    } catch (e) { errHandler(res, req, e); }
  });

  router.delete('/:id', ...auth, async (req, res) => {
    try {
      const p = await cargar(req.tenantId, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      if (p.estado !== 'BORRADOR') return fallo(res, 409, 'Solo se borran los borradores. Un presupuesto emitido se anula.');
      await col(req.tenantId, 'presupuestos').doc(p.id).delete();
      res.json({ ok: true });
    } catch (e) { errHandler(res, req, e); }
  });

  router.post('/:id/emitir', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, p = await cargar(t, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      if (p.estado !== 'BORRADOR') return fallo(res, 409, 'Este presupuesto ya fue emitido.');
      const tr = await transportista(t), falt = P.faltantesTransportista(tr);
      if (falt.faltan.length) return fallo(res, 409, `Faltan datos del transportista: ${falt.faltan.join(', ')}. Cargalos en la configuración.`);
      if (!p.periodoDesde || !p.periodoHasta) return fallo(res, 409, 'Falta el período del presupuesto.');
      if (!p.beneficiario || !p.beneficiario.nombre || !p.beneficiario.dni) return fallo(res, 409, 'Faltan el nombre o el DNI del beneficiario.');
      const sinConfirmar = (p.viajes || []).filter(v => v.mapa && v.mapa.coincide === false && v.mapa.confirmadoManual !== true);
      if (sinConfirmar.length) return fallo(res, 409, `El recorrido del viaje ${sinConfirmar.map(v => v.id).join(', ')} no parece corresponder a este paciente o centro: confirmalo para poder emitir.`);
      const r = await armarCalculo(t, { ...p, fechaReferencia: p.fechaReferencia });
      const numero = await db.runTransaction(async tx => {
        const ref = col(t, 'config').doc('contador_presupuestos');
        const s = await tx.get(ref);
        const n = ((s.exists && s.data().ultimo) || 0) + 1;
        tx.set(ref, { ultimo: n });
        return n;
      });
      const obra = await obraConfig(t, p.obraId, p.obraNombre);
      const emitido = limpiarUndefined({
        ...p, estado: 'EMITIDO', numero, numeroTexto: String(numero).padStart(5, '0'), fechaEmision: hoyDMY(ahora()), emitidoEn: ahora().toISOString(), emitidoPor: nombreUsuario(req.user),
        calculo: r.calculo, arancel: r.arancel, formato: r.cfg.formato, plantillaUsada: obra.plantilla ? { nombre: obra.plantilla.nombre, ruta: obra.plantilla.ruta, url: obra.plantilla.url } : null,
        obraSocial: { nombre: obra.nombre || p.obraNombre, cuit: obra.cuit || '' }, transportista: tr,
      });
      await col(t, 'presupuestos').doc(p.id).set(emitido);
      res.json({ ok: true, id: p.id, numero, numeroTexto: emitido.numeroTexto, total: r.calculo.total });
    } catch (e) { errHandler(res, req, e); }
  });

  router.post('/:id/respuesta', ...auth, async (req, res) => {
    try {
      const p = await cargar(req.tenantId, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      const estado = req.body && req.body.estado;
      if (!['ACEPTADO', 'RECHAZADO'].includes(estado)) return fallo(res, 400, 'El estado tiene que ser ACEPTADO o RECHAZADO.');
      if (p.estado !== 'EMITIDO') return fallo(res, 409, 'Solo un presupuesto emitido (y sin respuesta) puede aceptarse o rechazarse.');
      await col(req.tenantId, 'presupuestos').doc(p.id).update({ estado, respondidoEn: ahora().toISOString(), respondidoPor: nombreUsuario(req.user), motivoRespuesta: recortar(req.body.motivo, 300) });
      res.json({ ok: true });
    } catch (e) { errHandler(res, req, e); }
  });

  router.post('/:id/anular', ...auth, async (req, res) => {
    try {
      const p = await cargar(req.tenantId, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      if (!['EMITIDO', 'ACEPTADO', 'RECHAZADO'].includes(p.estado)) return fallo(res, 409, 'Solo se anula un presupuesto emitido.');
      const motivo = recortar(req.body && req.body.motivo, 300);
      if (!motivo) return fallo(res, 400, 'Indicá el motivo de la anulación.');
      await col(req.tenantId, 'presupuestos').doc(p.id).update({ estado: 'ANULADO', anuladoEn: ahora().toISOString(), anuladoPor: nombreUsuario(req.user), motivoAnulacion: motivo });
      res.json({ ok: true });
    } catch (e) { errHandler(res, req, e); }
  });

  /** Copia un presupuesto (típicamente uno anulado) a un borrador nuevo, para corregirlo y emitir otro. */
  router.post('/:id/duplicar', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, p = await cargar(t, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      const id = randomUUID();
      const copia = { id, beneficiarioId: p.beneficiarioId, beneficiario: p.beneficiario, obraId: p.obraId, obraNombre: p.obraNombre, periodoDesde: p.periodoDesde, periodoHasta: p.periodoHasta,
        fechaReferencia: hoyDMY(ahora()), acompanante: p.acompanante, vehiculo: p.vehiculo, observaciones: p.observaciones, dependencia: p.dependencia, semanasPorMes: p.semanasPorMes,
        viajes: p.viajes, respaldoDocs: p.respaldoDocs || [], estado: 'BORRADOR', origenDuplicado: p.numeroTexto || p.id, creadoEn: ahora().toISOString(), creadoPor: nombreUsuario(req.user) };
      await col(t, 'presupuestos').doc(id).set(limpiarUndefined(copia));
      res.json({ ok: true, id });
    } catch (e) { errHandler(res, req, e); }
  });

  /** .docx del formulario "Servicio de Traslados Programados" rellenado (solo si la obra social tiene esa plantilla). */
  router.get('/:id/docx', ...auth, async (req, res) => {
    try {
      const t = req.tenantId, p = await cargar(t, req.params.id);
      if (!p) return fallo(res, 404, 'No encontrado.');
      let calculo = p.calculo, arancel = p.arancel, tr = p.transportista, plantilla = p.plantillaUsada;
      if (p.estado === 'BORRADOR') {          // vista previa: se calcula con lo vigente
        const r = await armarCalculo(t, { ...p, fechaReferencia: p.fechaReferencia });
        calculo = r.calculo; arancel = r.arancel; tr = await transportista(t);
        plantilla = (await obraConfig(t, p.obraId, p.obraNombre)).plantilla;
      }
      if (!plantilla || !plantilla.url) return fallo(res, 409, 'Esta obra social no tiene plantilla propia (usa el formato multi-viaje, que se descarga en PDF).');
      const buffer = await bajar(plantilla.url);
      const b = p.beneficiario || {}, dep = calculo.valorKm;
      const docx = await D.rellenarTraslados(buffer, {
        transportista: tr, obraSocial: { esObraSocial: true, prestadora: p.obraNombre, nroAfiliado: b.afiliado },
        beneficiario: { nombre: b.nombre, dni: b.dni, domicilio: b.domicilio, localidad: b.localidad, tutor: b.tutor, contacto: b.contacto },
        viajes: calculo.viajes.map((v, i) => ({ destino: (p.viajes[i] && (p.viajes[i].destino || p.viajes[i].centro)) || v.destino, prestador: (p.viajes[i] && p.viajes[i].centro) || '', kmDiarios: v.kmFacturables, viajesMes: v.viajesMes })),
        totales: { kmMensuales: calculo.kmMensuales, valorKm: dep.final, importeMensual: calculo.total }, incluirValores: true, acompanante: p.acompanante === true,
        observaciones: dep.aplicado ? `Adicional por dependencia ${dep.porcentaje}%: valor base ${D.pesos(dep.base)} + ${D.pesos(dep.adicional)} = ${D.pesos(dep.final)} por km.` : '',
        duplicado: req.query.duplicado === '1' || req.query.duplicado === 'true',
      });
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="presupuesto-${p.numeroTexto || 'borrador'}.docx"`, 'Cache-Control': 'no-store' });
      res.send(docx);
    } catch (e) { errHandler(res, req, e); }
  });

  return router;
}

module.exports = crearRouterPresupuestos;
module.exports.ESTADOS = ESTADOS;
module.exports.DIAS_SIN_RESPUESTA_DEFAULT = DIAS_SIN_RESPUESTA_DEFAULT;
