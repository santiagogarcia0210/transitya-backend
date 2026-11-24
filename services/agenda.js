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

module.exports = { ocurrencias, ocurrenciaEn, ordenar };
