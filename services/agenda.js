// Ocurrencias de tareas administrativas recurrentes (lógica pura, testeable).
const { parseFecha, aDMY, calcEstado, hoy } = require('../helpers/fechas');

function clampDia(y, m0, dia) {
  return new Date(y, m0, Math.min(Number(dia) || 1, new Date(y, m0 + 1, 0).getDate()));
}

/** Ocurrencia de la tarea en un período. MENSUAL 'YYYY-MM' · ANUAL 'YYYY' · UNICA 'unica'. */
function ocurrenciaEn(tarea, y, m0) {
  if (tarea.frecuencia === 'MENSUAL') {
    return { periodo: `${y}-${String(m0 + 1).padStart(2, '0')}`, fecha: clampDia(y, m0, tarea.dia) };
  }
  if (tarea.frecuencia === 'ANUAL') {
    return { periodo: String(y), fecha: clampDia(y, (Number(tarea.mes) || 1) - 1, tarea.dia) };
  }
  const f = parseFecha(tarea.fecha);
  return f ? { periodo: 'unica', fecha: f } : null;
}

/**
 * Ocurrencias a mostrar en el panel: la del período actual (hecha o no)
 * y la del período anterior si quedó sin hacer (VENCIDO).
 * No genera ocurrencias anteriores a la creación de la tarea.
 */
function ocurrencias(tarea, hechos, ahora = new Date()) {
  if (tarea.activo === false) return [];
  const h = hoy(ahora);
  const creada = parseFecha(tarea.creadoEn) || new Date(0);
  const candidatas = [];
  if (tarea.frecuencia === 'MENSUAL') {
    const ant = new Date(h.getFullYear(), h.getMonth() - 1, 1);
    candidatas.push(ocurrenciaEn(tarea, ant.getFullYear(), ant.getMonth()));
    candidatas.push(ocurrenciaEn(tarea, h.getFullYear(), h.getMonth()));
  } else if (tarea.frecuencia === 'ANUAL') {
    candidatas.push(ocurrenciaEn(tarea, h.getFullYear() - 1, 0));
    candidatas.push(ocurrenciaEn(tarea, h.getFullYear(), 0));
  } else {
    candidatas.push(ocurrenciaEn(tarea, 0, 0));
  }
  const out = [];
  candidatas.filter(Boolean).forEach((oc, i) => {
    const esAnterior = candidatas.length > 1 && i === 0;
    const creadaPeriodo = new Date(creada.getFullYear(), tarea.frecuencia === 'ANUAL' ? 0 : creada.getMonth(), 1);
    const inicioPeriodo = tarea.frecuencia === 'ANUAL' ? new Date(oc.fecha.getFullYear(), 0, 1) : new Date(oc.fecha.getFullYear(), oc.fecha.getMonth(), 1);
    if (inicioPeriodo < creadaPeriodo) return;
    const hecho = hechos.get(`${tarea.id}_${oc.periodo}`) || null;
    if (esAnterior && hecho) return;
    let { estado, diffDias } = calcEstado(oc.fecha, Number(tarea.diasAviso) || 5, ahora);
    if (hecho) estado = 'HECHO';
    else if (estado === 'VIGENTE') estado = 'PENDIENTE';
    out.push({
      tareaId: tarea.id, titulo: tarea.titulo, obraSocial: tarea.obraSocial || '', notas: tarea.notas || '',
      frecuencia: tarea.frecuencia, periodo: oc.periodo, fecha: aDMY(oc.fecha), estado, diffDias,
      hechoPor: hecho?.hechoPor || '', hechoEn: hecho?.hechoEn || '',
    });
  });
  return out;
}

const ORDEN = { VENCIDO: 0, PROXIMO: 1, PENDIENTE: 2, HECHO: 3 };
const ordenar = (a, b) => (ORDEN[a.estado] - ORDEN[b.estado]) || ((a.diffDias ?? 999) - (b.diffDias ?? 999));

/* ── Piezas del panel administrativo que también usa la pizarra del Inicio ───────────────────
 * Estaban escritas dentro de GET /panel. Viven acá, puras, para que el panel y la pizarra
 * calculen exactamente lo mismo y no haya dos versiones de la misma regla. */

/**
 * Vencimientos de personas y vehículos que ya vencieron o están por vencer, del más urgente al menos.
 * lista: [{ id, ...datos }] · ahora: se puede pasar para fijar "hoy" (la pizarra usa el de Argentina).
 */
function vencimientosCriticos(lista, ahora = new Date()) {
  return lista
    .filter(v => v.estado !== 'ELIMINADO')
    .map(v => ({ id: v.ID || v.id, descripcion: v.descripcion || '', persona: v.persona || v.chofer || '',
      tipo: v.tipo || '', fechaVenc: v.fechaVenc || '', ...calcEstado(v.fechaVenc, v.diasAviso, ahora) }))
    .filter(v => v.estado === 'VENCIDO' || v.estado === 'PROXIMO')
    .sort((a, b) => a.diffDias - b.diffDias);
}

const ORDEN_DOCS = { VENCIDO: 0, FALTA: 1, PROXIMO: 2, SIN_FECHA: 3, SIN_OBRA_SOCIAL: 4 };
/** Ordena EN EL LUGAR las alertas de documentos de pacientes: vencidos, faltantes, por vencer, el resto. */
function ordenarAlertasDocs(alertas) {
  return alertas.sort((a, b) => (ORDEN_DOCS[a.tipo] - ORDEN_DOCS[b.tipo]) || ((a.diffDias ?? 999) - (b.diffDias ?? 999)));
}

const URGENCIA_MAIL = { ALTA: 0, MEDIA: 1, BAJA: 2 };
/**
 * De los mails pendientes (no resueltos), los que piden acción o son de urgencia alta.
 * Devuelve { conAccion, total, destacados }: conAccion cuenta los que piden acción, total los
 * destacados (acción o urgencia alta) y destacados es la lista, la más urgente y reciente primero.
 */
function correoDestacados(mailsPend, limite = 5) {
  const lista = mailsPend
    .filter(m => m.requiereAccion || m.urgencia === 'ALTA')
    .sort((a, b) => (URGENCIA_MAIL[a.urgencia] ?? 2) - (URGENCIA_MAIL[b.urgencia] ?? 2) || String(b.fecha).localeCompare(String(a.fecha)));
  return {
    conAccion: mailsPend.filter(m => m.requiereAccion).length,
    total: lista.length,
    destacados: lista.slice(0, limite).map(m => ({
      id: m.id, asunto: m.asunto, deNombre: m.deNombre || m.de, resumen: m.resumen, accion: m.accion,
      urgencia: m.urgencia, categoria: m.categoria, fecha: m.fecha, pacienteNombre: m.pacienteNombre || '',
    })),
  };
}

module.exports = { ocurrencias, ocurrenciaEn, ordenar, vencimientosCriticos, ordenarAlertasDocs, correoDestacados };
