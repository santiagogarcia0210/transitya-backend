// Utilidades de fechas compartidas por vencimientos, legajos y agenda administrativa.
// Acepta 'dd/MM/yyyy' (formato histórico del sistema) y 'yyyy-MM-dd' (input type=date).

const MS_DIA = 1000 * 60 * 60 * 24;

/** Devuelve un Date a medianoche local, o null si no se puede interpretar. */
function parseFecha(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'object' && typeof v.toDate === 'function') return parseFecha(v.toDate());
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = Number(m[3].length === 2 ? '20' + m[3] : m[3]);
    return new Date(y, Number(m[2]) - 1, Number(m[1]));
  }
  return null;
}

/** Date → 'dd/MM/yyyy' */
function aDMY(d) {
  if (!d) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Normaliza cualquier fecha aceptada a 'dd/MM/yyyy' ('' si no es válida). */
function normalizarDMY(v) {
  return aDMY(parseFecha(v));
}

function hoy(ahora = new Date()) {
  return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
}

/** Días desde hoy hasta la fecha (negativo = ya pasó). */
function diasHasta(fecha, ahora = new Date()) {
  const f = parseFecha(fecha);
  if (!f) return null;
  return Math.round((f - hoy(ahora)) / MS_DIA);
}

/**
 * Estado de un vencimiento.
 * VENCIDO (<0) · PROXIMO (<= diasAviso) · VIGENTE · SIN FECHA
 */
function calcEstado(fechaVenc, diasAviso = 30, ahora = new Date()) {
  const diff = diasHasta(fechaVenc, ahora);
  if (diff === null) return { estado: 'SIN FECHA', diffDias: null };
  const umbral = Number(diasAviso) || 30;
  const estado = diff < 0 ? 'VENCIDO' : diff <= umbral ? 'PROXIMO' : 'VIGENTE';
  return { estado, diffDias: diff };
}

/** Suma meses respetando fin de mes (31/01 + 1 mes → 28 o 29/02). */
function sumarMeses(fecha, meses) {
  const f = parseFecha(fecha);
  if (!f || !meses) return null;
  const y = f.getFullYear(), m = f.getMonth() + Number(meses), d = f.getDate();
  const ultimo = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d, ultimo));
}

/** 'YYYY-MM' del mes de la fecha dada. */
function periodo(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { parseFecha, aDMY, normalizarDMY, hoy, diasHasta, calcEstado, sumarMeses, periodo };
