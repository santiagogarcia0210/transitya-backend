// Fechas del sistema.
//
// Formato de almacenamiento: dd/MM/yyyy (texto). Es lo que usa todo el sistema y lo que muestran
// las pantallas. El problema que resuelve este archivo: algunas rutas guardaban la fecha cruda en
// ISO (yyyy-MM-dd, lo que manda <input type="date">), y como los ordenamientos y filtros solo
// entendían dd/MM/yyyy, esos documentos caían al final de la lista o quedaban fuera de los filtros.
//
// Sin dependencias a propósito (no carga Firebase): se puede usar y probar en cualquier lado.

// Misma zona que utils.TIMEZONE. Argentina no tiene horario de verano, pero se usa Intl en vez de
// un desfase fijo para no depender de eso.
const ZONA = 'America/Argentina/Tucuman';
const ANIO_MIN = 1900;
const ANIO_MAX = 2100;

const fmtZona = new Intl.DateTimeFormat('en-US', { timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric' });

const pad2 = n => String(n).padStart(2, '0');
const diasEnMes = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).getUTCDate(); // mes 1-12

/** Arma 'dd/MM/yyyy' si día/mes/año forman una fecha real del calendario; si no, ''. */
function armar(dia, mes, anio) {
  const d = Number(dia), m = Number(mes), y = Number(anio);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return '';
  if (y < ANIO_MIN || y > ANIO_MAX || m < 1 || m > 12 || d < 1 || d > diasEnMes(y, m)) return '';
  return `${pad2(d)}/${pad2(m)}/${y}`;
}

/** Un instante (Date) → su día en hora de Argentina, no en la del servidor (en Railway es UTC). */
function desdeInstante(date) {
  if (!(date instanceof Date) || isNaN(date)) return '';
  const p = Object.fromEntries(fmtZona.formatToParts(date).map(x => [x.type, x.value]));
  return armar(p.day, p.month, p.year);
}

// yyyy-MM-dd, con hora y zona opcionales: "2026-11-05", "2026-11-05T14:30:00.000Z", "2026-11-05 14:30"
const RE_ISO = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;
// d/M/yyyy, dd/MM/yy, con "/", "-" o "." y una hora opcional al final: "05/11/2026 14:30"
const RE_DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[ T,]+\d{1,2}:\d{2}(?::\d{2})?)?$/;

/**
 * Cualquier fecha reconocible → 'dd/MM/yyyy' válida, o '' si no se puede interpretar.
 *
 * Acepta: dd/MM/yyyy, d/M/yyyy, dd/MM/yy (el año de 2 dígitos es 20yy), yyyy-MM-dd, ISO con hora,
 * Date y Timestamp de Firestore (instancia con toDate(), o el objeto {seconds, nanoseconds}).
 *
 * Una fecha sola ("2026-11-05", "05/11/2026") es un día de calendario y se toma tal cual. Un
 * instante (Date, Timestamp, ISO con "Z" u offset) se pasa a hora de Argentina antes de sacar el
 * día. Años fuera de 1900-2100 y fechas imposibles ("31/02/2026") dan ''.
 */
function normalizarFecha(f) {
  if (f === null || f === undefined || f === '') return '';
  if (f instanceof Date) return desdeInstante(f);

  if (typeof f === 'object') {
    if (typeof f.toDate === 'function') {
      try { return desdeInstante(f.toDate()); } catch { return ''; }
    }
    const seg = f.seconds ?? f._seconds;
    if (Number.isFinite(seg)) {
      const nano = Number(f.nanoseconds ?? f._nanoseconds) || 0;
      return desdeInstante(new Date(seg * 1000 + Math.floor(nano / 1e6)));
    }
    return '';
  }
  if (typeof f !== 'string') return '';

  const s = f.trim();
  let m = RE_ISO.exec(s);
  if (m) {
    const [, anio, mes, dia, hora, , , zona] = m;
    // Con hora y zona explícita es un instante: se convierte. Sin zona, es hora local de pared.
    if (hora !== undefined && zona) return desdeInstante(new Date(s.replace(' ', 'T')));
    return armar(dia, mes, anio);
  }
  m = RE_DMY.exec(s);
  if (m) {
    const [, dia, mes, anio] = m;
    return armar(dia, mes, anio.length === 2 ? 2000 + Number(anio) : Number(anio));
  }
  return '';
}

/** Número YYYYMMDD para ordenar; 0 si la fecha no se puede interpretar (queda al final en orden descendente). */
function fechaSort(f) {
  const n = normalizarFecha(f);
  if (!n) return 0;
  const [d, m, y] = n.split('/');
  return Number(`${y}${m}${d}`);
}

/** Date a medianoche local (para comparar rangos), o null si no se puede interpretar. */
function fechaToDate(f) {
  const n = normalizarFecha(f);
  if (!n) return null;
  const [d, m, y] = n.split('/');
  return new Date(Number(y), Number(m) - 1, Number(d));
}

/**
 * Fecha normalizada de un documento. Los viejos (migrados de Sheets) traen FECHA en mayúsculas:
 * se usa la primera de las dos que sea una fecha válida.
 */
const fechaDoc = doc => normalizarFecha(doc && doc.fecha) || normalizarFecha(doc && doc.FECHA);

/**
 * ¿Esa fecha (en cualquier formato que entienda normalizarFecha) cae en el mes `m` (1-12) del año `y`?
 * Es el reemplazo de utils.esMesDMY, que solo parte por "/" y por eso deja afuera de los filtros por
 * mes a los documentos guardados en ISO (yyyy-MM-dd). Una fecha que no se entiende da false.
 */
function esMesFecha(f, m, y) {
  const n = normalizarFecha(f);
  if (!n) return false;
  const [, mes, anio] = n.split('/');
  return Number(mes) === Number(m) && Number(anio) === Number(y);
}

/**
 * ¿Son el mismo día? Compara las dos fechas ya normalizadas, así "2026-11-05", "5/11/26" y "05/11/2026"
 * son iguales. Si alguna no se entiende no hay "día" que comparar: solo cuenta como igual si es el mismo
 * texto, y nunca dos vacías (dos fechas inválidas darían '' y se igualarían: un falso positivo).
 */
function mismoDia(a, b) {
  const na = normalizarFecha(a), nb = normalizarFecha(b);
  if (na && nb) return na === nb;
  const ta = typeof a === 'string' ? a.trim() : '';
  const tb = typeof b === 'string' ? b.trim() : '';
  return ta !== '' && ta === tb;
}

/**
 * La fecha con la que se guarda un documento: si no vino (ausente, null o vacía) es `hoy`, como siempre;
 * si vino, se normaliza a dd/MM/yyyy, y si no se entiende da '' (el llamador responde 400). `hoy` se pasa
 * de afuera para poder probarlo; las rutas pasan fechaHoyAR().
 */
function fechaOHoy(valor, hoy = hoyAR()) {
  const falta = valor === undefined || valor === null || String(valor).trim() === '';
  return falta ? hoy : normalizarFecha(valor);
}

/**
 * yyyy-MM-dd → dd/MM/yyyy. Es la ÚNICA conversión ISO → dd/MM/yyyy del sistema (antes había una copia en
 * traslado.js y otra en resumenDiario.js). Cualquier otra cosa se devuelve tal cual: no inventa una fecha.
 */
function isoToDMY(f) {
  if (typeof f !== 'string') return f;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : f;
}

/** Milisegundos de un Timestamp de Firestore, Date, ISO, número o {seconds}; 0 si falta o no se entiende. */
function timestampMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (v instanceof Date) return isNaN(v) ? 0 : v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; }
  if (typeof v === 'object') {
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch { return 0; } }
    if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch { return 0; } }
    const seg = v.seconds ?? v._seconds;
    if (Number.isFinite(seg)) return seg * 1000 + Math.floor((Number(v.nanoseconds ?? v._nanoseconds) || 0) / 1e6);
  }
  return 0;
}

/**
 * Ordena IN PLACE (y devuelve la misma lista): fecha descendente; a igual fecha, creadoEn
 * descendente. Los documentos sin fecha válida quedan al final, también ordenados por creadoEn.
 */
function ordenarPorFechaDesc(lista) {
  const claves = new Map(lista.map(d => [d, [fechaSort(d && d.fecha) || fechaSort(d && d.FECHA), timestampMs(d && d.creadoEn)]]));
  return lista.sort((a, b) => {
    const ka = claves.get(a), kb = claves.get(b);
    return (kb[0] - ka[0]) || (kb[1] - ka[1]);
  });
}

/** El día de hoy en Argentina como dd/MM/yyyy. `ahora` se puede pasar para probar. */
const hoyAR = (ahora = new Date()) => normalizarFecha(ahora);

/**
 * Suma n días (puede ser negativo) a una fecha en cualquier formato → dd/MM/yyyy, o '' si no se
 * entiende. Es aritmética de calendario con Date.UTC: no depende de la zona del servidor ni de
 * cambios de horario.
 */
function sumarDias(f, n) {
  const x = fechaToDate(f);
  if (!x) return '';
  const d = new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate() + Number(n)));
  return armar(d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear());
}

const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Día de la semana de una fecha de calendario: 0 = domingo … 6 = sábado. null si no se entiende. */
function diaSemana(f) {
  const n = normalizarFecha(f);
  if (!n) return null;
  const [d, m, y] = n.split('/');
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay();
}

/** "lunes", "martes"… ('' si no se entiende). */
const nombreDiaSemana = f => { const i = diaSemana(f); return i === null ? '' : NOMBRES_DIA[i]; };

/** ¿Es de lunes a viernes? */
const esDiaHabil = f => { const i = diaSemana(f); return i !== null && i >= 1 && i <= 5; };

/**
 * Las formas en que ese día puede estar guardado en la base: ISO (yyyy-MM-dd, lo que mandaba el
 * <input type="date">), dd/MM/yyyy y d/M/yyyy. Sirve para consultar con `where(campo, 'in', ...)`
 * sin traer toda la colección, mientras haya datos viejos sin normalizar.
 */
function variantesFecha(f) {
  const n = normalizarFecha(f);
  if (!n) return [];
  const [d, m, y] = n.split('/');
  return [...new Set([`${y}-${m}-${d}`, n, `${Number(d)}/${Number(m)}/${y}`])];
}

module.exports = {
  normalizarFecha, fechaSort, fechaToDate, fechaDoc, esMesFecha, mismoDia, fechaOHoy, isoToDMY, timestampMs, ordenarPorFechaDesc,
  hoyAR, sumarDias, diaSemana, nombreDiaSemana, esDiaHabil, variantesFecha,
};
