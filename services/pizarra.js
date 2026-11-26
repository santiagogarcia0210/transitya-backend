// Pizarra del Inicio (solo admin): todo lo pendiente en UNA respuesta liviana.
//
// El GET /panel de la agenda administrativa arma lo mismo pero con consultas pesadas (trae todos los
// mails, todos los vencimientos y el estado de todas las carpetas en cada llamada) y sin límites. Acá:
//   - se consulta solo lo que se muestra (días puntuales, mails que piden acción, tareas del período);
//   - cada columna devuelve a lo sumo LIMITE_ITEMS ítems más el total real, para que el contador sea
//     verdadero aunque la lista esté recortada;
//   - la parte más cara (estado de todas las carpetas de pacientes) se guarda un minuto por empresa;
//   - si una columna falla, las demás igual llegan (la que falló viene marcada con error: true).
//
// Las reglas son las del panel y el resto del sistema, no copias: ocurrencias() para las tareas,
// vencimientosCriticos / ordenarAlertasDocs / correoDestacados (extraídas del panel) y estadoGeneral()
// para los documentos. "Hoy" es la fecha de Argentina (utils/fechas), no la del servidor.
const { ocurrencias, ordenar, vencimientosCriticos, ordenarAlertasDocs, correoDestacados } = require('./agenda');
const { calcularKmPendientes, leerPorValores } = require('./kmPendientes');
const { hoyAR, fechaToDate, sumarDias, fechaDoc, ordenarPorFechaDesc } = require('../utils/fechas');

const LIMITE_ITEMS = 8;           // ítems por columna (el total real viaja aparte)
const DIAS_PROXIMOS = 7;          // "vencen en los próximos 7 días"
const DIAS_COMPROBANTES = 7;      // remitos y egresos de los últimos 7 días
const TTL_LEGAJOS_MS = 60_000;

const pad2 = n => String(n).padStart(2, '0');

/** Caché de proceso con vencimiento; el reloj se inyecta para probarlo. */
const cacheLegajos = new Map();
async function conCache(cache, clave, ttlMs, ahoraMs, refrescar, fn) {
  const hit = cache.get(clave);
  if (!refrescar && hit && hit.hasta > ahoraMs) return hit.valor;
  const valor = await fn();
  cache.set(clave, { hasta: ahoraMs + ttlMs, valor });
  return valor;
}

/** Que una columna que falla no tire abajo a las demás. */
async function seguro(nombre, fn) {
  try { return await fn(); }
  catch (e) {
    console.error('[PIZARRA]', nombre, e.message);
    return { error: true, mensaje: 'No se pudo cargar esta sección.', urgentes: 0, pendientes: 0 };
  }
}

/* ── KM de choferes ──────────────────────────────────────────────────────────────────────── */
async function columnaKm(tenantId, { col, ahora, limite }) {
  const r = await calcularKmPendientes(tenantId, { col, ahora });
  if (r.sinChoferes) return { sinChoferes: true, hoy: null, anterior: null, urgentes: 0, pendientes: 0 };
  const recortar = dia => dia && { ...dia, faltanTotal: dia.faltan.length, faltan: dia.faltan.slice(0, limite) };
  return {
    sinChoferes: false,
    hoy: recortar(r.hoy),
    anterior: recortar(r.anterior),
    urgentes: r.anterior ? r.anterior.faltan.length : 0,     // el día ya pasó: rojo
    pendientes: r.hoy ? r.hoy.faltan.length : 0,             // hoy todavía hay tiempo: ámbar
  };
}

/* ── Presupuestos emitidos sin respuesta (van dentro de la columna de Administración) ─────── */
const DIAS_SIN_RESPUESTA_DEFAULT = 7;
const MS_DIA = 86400000;

/**
 * Presupuestos EMITIDOS que siguen sin aceptarse ni rechazarse pasados X días (configurable, 7 por defecto).
 * Solo número, paciente, obra social y días: NUNCA datos clínicos (el presupuesto no los guarda).
 */
async function presupuestosSinRespuesta(tenantId, { col, ahora, limite }) {
  const [snap, ajustes] = await Promise.all([
    col(tenantId, 'presupuestos').where('estado', '==', 'EMITIDO').get(),
    col(tenantId, 'config').doc('presupuestos').get(),
  ]);
  const dias = (ajustes.exists && Number(ajustes.data().diasSinRespuesta)) || DIAS_SIN_RESPUESTA_DEFAULT;
  const pendientes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .map(p => ({ p, antiguedad: Math.floor((ahora.getTime() - new Date(p.emitidoEn || p.creadoEn || ahora).getTime()) / MS_DIA) }))
    .filter(x => x.antiguedad >= dias)
    .sort((a, b) => b.antiguedad - a.antiguedad);
  return {
    dias, total: pendientes.length,
    items: pendientes.slice(0, limite).map(({ p, antiguedad }) => ({
      id: p.id, numeroTexto: p.numeroTexto || '', beneficiario: (p.beneficiario && p.beneficiario.nombre) || '', obraSocial: p.obraNombre || '',
      fechaEmision: p.fechaEmision || '', diasSinRespuesta: antiguedad, nivel: 'MEDIA',
    })),
  };
}

/* ── Tareas de la agenda administrativa ──────────────────────────────────────────────────── */
async function columnaTareas(tenantId, { col, hoyDMY, ahoraLocal, limite, ahora = new Date() }) {
  const y = Number(hoyDMY.slice(6)), m = Number(hoyDMY.slice(3, 5));
  const mesAnterior = m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
  // Las tareas se marcan hechas con un documento por período: solo importan los dos últimos meses/años.
  const periodos = [`${y}-${pad2(m)}`, mesAnterior, String(y), String(y - 1), 'unica'];
  const [tareasSnap, hechosLista] = await Promise.all([
    col(tenantId, 'agenda_tareas').get(),
    leerPorValores(col(tenantId, 'agenda_hechos'), 'periodo', periodos),
  ]);
  const hechos = new Map(hechosLista.map(h => [h.id, h]));
  const abiertas = tareasSnap.docs
    .flatMap(d => ocurrencias({ id: d.id, ...d.data() }, hechos, ahoraLocal))
    .filter(t => t.estado === 'VENCIDO' || (t.estado !== 'HECHO' && t.diffDias !== null && t.diffDias <= DIAS_PROXIMOS))
    .sort(ordenar);
  const vencidas = abiertas.filter(t => t.estado === 'VENCIDO').length;
  // Si falla la lectura de presupuestos, las tareas igual llegan.
  const presupuestos = await presupuestosSinRespuesta(tenantId, { col, ahora, limite }).catch(() => ({ dias: DIAS_SIN_RESPUESTA_DEFAULT, total: 0, items: [], error: true }));
  return {
    presupuestos,
    configuradas: tareasSnap.size,
    items: abiertas.slice(0, limite).map(t => ({
      tareaId: t.tareaId, titulo: t.titulo, obraSocial: t.obraSocial, periodo: t.periodo, frecuencia: t.frecuencia,
      fecha: t.fecha, estado: t.estado, diffDias: t.diffDias, nivel: t.estado === 'VENCIDO' ? 'ALTA' : 'MEDIA',
    })),
    total: abiertas.length, vencidas, proximas: abiertas.length - vencidas,
    urgentes: vencidas, pendientes: abiertas.length - vencidas + presupuestos.total,
  };
}

/* ── Documentación: vencimientos + carpetas de pacientes ─────────────────────────────────── */

/**
 * Una línea por paciente en vez de una por documento: un paciente al que le falta medio legajo no
 * tiene que ocupar la pizarra entera. Los "sin fecha" y "sin obra social" se cuentan aparte.
 */
function agruparPorPaciente(alertas) {
  const por = new Map();
  const cuentas = { docsVencidos: 0, docsFaltantes: 0, docsPorVencer: 0, sinFecha: 0, sinObraSocial: 0 };
  for (const a of alertas) {
    if (a.tipo === 'SIN_OBRA_SOCIAL') { cuentas.sinObraSocial++; continue; }
    if (a.tipo === 'SIN_FECHA') { cuentas.sinFecha++; continue; }
    if (!['VENCIDO', 'FALTA', 'PROXIMO'].includes(a.tipo)) continue;
    const k = a.beneficiarioId || a.beneficiario;
    if (!por.has(k)) por.set(k, { beneficiarioId: a.beneficiarioId || '', beneficiario: a.beneficiario || '', obraSocial: a.obraSocial || '', vencidos: 0, faltantes: 0, porVencer: 0, detalle: [] });
    const p = por.get(k);
    if (a.tipo === 'VENCIDO') { p.vencidos++; cuentas.docsVencidos++; }
    else if (a.tipo === 'FALTA') { p.faltantes++; cuentas.docsFaltantes++; }
    else { p.porVencer++; cuentas.docsPorVencer++; }
    p.detalle.push({ tipo: a.tipo, documento: a.detalle || '', diffDias: a.diffDias ?? null });
  }
  const pacientes = [...por.values()].map(p => ({
    ...p, detalle: p.detalle.slice(0, 3), nivel: p.vencidos > 0 ? 'ALTA' : 'MEDIA',
  })).sort((a, b) => (b.vencidos - a.vencidos) || (b.faltantes - a.faltantes) || (b.porVencer - a.porVencer)
    || a.beneficiario.localeCompare(b.beneficiario, 'es'));
  return { pacientes, cuentas };
}

async function columnaDocumentacion(tenantId, { col, ahoraLocal, ahoraMs, estadoGeneral, cache, refrescar, limite }) {
  const [vencSnap, legajos] = await Promise.all([
    col(tenantId, 'vencimientos').get(),
    conCache(cache, tenantId, TTL_LEGAJOS_MS, ahoraMs, refrescar, () => estadoGeneral(tenantId)),
  ]);
  const venc = vencimientosCriticos(vencSnap.docs.map(d => ({ id: d.id, ...d.data() })), ahoraLocal);
  const { pacientes, cuentas } = agruparPorPaciente(ordenarAlertasDocs([...legajos.alertas]));

  const vencVencidos = venc.filter(v => v.estado === 'VENCIDO').length;
  const pacVencidos = pacientes.filter(p => p.nivel === 'ALTA').length;
  return {
    vencimientos: {
      items: venc.slice(0, limite).map(v => ({ ...v, nivel: v.estado === 'VENCIDO' ? 'ALTA' : 'MEDIA' })),
      total: venc.length, vencidos: vencVencidos, proximos: venc.length - vencVencidos,
    },
    pacientes: {
      items: pacientes.slice(0, limite), total: pacientes.length, ...cuentas, hayRequisitos: legajos.hayRequisitos,
    },
    urgentes: vencVencidos + pacVencidos,
    pendientes: (venc.length - vencVencidos) + (pacientes.length - pacVencidos),
  };
}

/* ── Correo ──────────────────────────────────────────────────────────────────────────────── */
async function columnaCorreo(tenantId, { col, limite }) {
  const cfgSnap = await col(tenantId, 'correo_config').doc('principal').get();
  if (!cfgSnap.exists) return { conectado: false, urgentes: 0, pendientes: 0 };
  const cfg = cfgSnap.data();
  // Dos consultas por igualdad (sin índices compuestos) en lugar de leer todos los mails.
  const [conAccionSnap, altasSnap] = await Promise.all([
    col(tenantId, 'correo_mails').where('requiereAccion', '==', true).get(),
    col(tenantId, 'correo_mails').where('urgencia', '==', 'ALTA').get(),
  ]);
  const porId = new Map();
  for (const d of [...conAccionSnap.docs, ...altasSnap.docs]) porId.set(d.id, { id: d.id, ...d.data() });
  const pendientes = [...porId.values()].filter(m => m.estado !== 'RESUELTO');

  const { conAccion, total, destacados } = correoDestacados(pendientes, limite);
  const altas = pendientes.filter(m => m.urgencia === 'ALTA').length;
  // Si hay que reautorizar la casilla no entra ningún mail nuevo: es lo más urgente de la columna.
  const alerta = cfg.requiereReconexion
    ? { tipo: 'RECONEXION', mensaje: 'Hay que volver a autorizar la casilla: mientras tanto no entran mails nuevos.' }
    : cfg.error ? { tipo: 'ERROR', mensaje: String(cfg.error).slice(0, 200) } : null;
  return {
    conectado: true, alerta, conAccion, total,
    items: destacados.map(m => ({ ...m, nivel: m.urgencia === 'ALTA' ? 'ALTA' : 'MEDIA' })),
    urgentes: altas + (alerta && alerta.tipo === 'RECONEXION' ? 1 : 0),
    pendientes: (total - altas) + (alerta && alerta.tipo === 'ERROR' ? 1 : 0),
  };
}

/* ── Comprobantes sin foto (remitos y egresos de los últimos 7 días) ──────────────────────── */
const tieneFoto = d => [d.comprobanteUrl, d.comprobante, d.COMPROBANTEURL, d.COMPROBANTE].some(v => typeof v === 'string' && v.trim() !== '');

async function columnaComprobantes(tenantId, { col, hoyDMY, limite }) {
  // Remitos y egresos se guardan siempre en dd/MM/yyyy (las rutas lo normalizan): alcanza con esa forma.
  const dias = Array.from({ length: DIAS_COMPROBANTES }, (_, i) => sumarDias(hoyDMY, -i));
  const leer = async nombre => {
    const [a, b] = await Promise.all([
      leerPorValores(col(tenantId, nombre), 'fecha', dias),
      leerPorValores(col(tenantId, nombre), 'FECHA', dias),
    ]);
    return [...new Map([...a, ...b].map(x => [x.id, x])).values()];
  };
  const [remitos, egresos] = await Promise.all([leer('remitos'), leer('egresos')]);
  const sinFoto = [
    ...remitos.filter(d => !tieneFoto(d)).map(d => ({
      tipo: 'REMITO', id: d.id, fecha: fechaDoc(d), chofer: d.chofer || d.CHOFER || '',
      detalle: [d.nroRemito && `N° ${d.nroRemito}`, d.razonSocial].filter(Boolean).join(' · ') || 'Remito',
    })),
    ...egresos.filter(d => !tieneFoto(d)).map(d => ({
      tipo: 'EGRESO', id: d.id, fecha: fechaDoc(d), chofer: d.chofer || d.CHOFER || '',
      detalle: [d.concepto || d.categoria, d.proveedor].filter(Boolean).join(' · ') || 'Egreso',
    })),
  ];
  ordenarPorFechaDesc(sinFoto);
  return {
    items: sinFoto.slice(0, limite).map(x => ({ ...x, nivel: 'MEDIA' })),
    total: sinFoto.length, remitos: sinFoto.filter(x => x.tipo === 'REMITO').length, egresos: sinFoto.filter(x => x.tipo === 'EGRESO').length,
    urgentes: 0, pendientes: sinFoto.length,
  };
}

/* ── Armado final ────────────────────────────────────────────────────────────────────────── */

/**
 * deps: { col, estadoGeneral } (obligatorias: Firestore y la función que arma el estado de las carpetas)
 *       { ahora, refrescar, limite, cache } (opcionales; para probar y para el botón Actualizar)
 */
async function calcularPizarra(tenantId, deps = {}) {
  const { col, estadoGeneral } = deps;
  if (typeof col !== 'function' || typeof estadoGeneral !== 'function') throw new Error('calcularPizarra necesita col y estadoGeneral.');
  const ahora = deps.ahora || new Date();
  const limite = deps.limite || LIMITE_ITEMS;
  const hoyDMY = hoyAR(ahora);
  // Medianoche local del día de ARGENTINA: lo que esperan ocurrencias() y calcEstado() como "ahora".
  const ahoraLocal = fechaToDate(hoyDMY);
  const comun = { col, ahora, hoyDMY, ahoraLocal, ahoraMs: ahora.getTime(), limite,
    estadoGeneral, cache: deps.cache || cacheLegajos, refrescar: !!deps.refrescar };

  const [km, tareas, documentacion, correo, comprobantes] = await Promise.all([
    seguro('km', () => columnaKm(tenantId, comun)),
    seguro('tareas', () => columnaTareas(tenantId, comun)),
    seguro('documentacion', () => columnaDocumentacion(tenantId, comun)),
    seguro('correo', () => columnaCorreo(tenantId, comun)),
    seguro('comprobantes', () => columnaComprobantes(tenantId, comun)),
  ]);
  const columnas = { km, tareas, documentacion, correo, comprobantes };
  const suma = campo => Object.values(columnas).reduce((s, c) => s + (c[campo] || 0), 0);
  return {
    hoy: hoyDMY, generadoEn: ahora.toISOString(),
    resumen: { urgentes: suma('urgentes'), pendientes: suma('pendientes'), errores: Object.keys(columnas).filter(k => columnas[k].error) },
    ...columnas,
  };
}

module.exports = {
  calcularPizarra, agruparPorPaciente, conCache, LIMITE_ITEMS, DIAS_PROXIMOS, TTL_LEGAJOS_MS,
  columnaKm, columnaTareas, columnaDocumentacion, columnaCorreo, columnaComprobantes,
};
