// Choferes que todavía no cargaron los km de hoy, y los que quedaron sin cargar el último día de servicio.
//
// Cómo se cargan los km hoy (para que esta definición coincida con lo que ya hace el sistema):
//   - El chofer (o el admin) carga un reporte en Reportes KM. POST /api/reportes guarda un documento
//     en empresas/{t}/reportes con chofer = el EMAIL del usuario, fecha (ISO o dd/MM/yyyy, según de
//     dónde salió) y kmInicial / kmFinal. El inicio y el final se cargan en momentos distintos del día.
//   - resumenDiario.js ya une cada reporte con su chofer por email y acepta las dos fechas.
//   - La asignación diaria de chicos vive en ASISTENCIA ({ fecha ISO, choferId, beneficiarios[] }).
//
// DEFINICIÓN de "falta cargar" para un chofer activo (rol chofer, activo !== false) y un día D:
//   1. Se espera que cargue si D es de lunes a viernes, o si ese día tiene chicos asignados en
//      ASISTENCIA (así se cubren los sábados que se trabajan sin marcar a todos).
//   2. Tiene cargado si existe al menos un reporte suyo con fecha D.
//   3. HOY: solo cuenta "sin ningún reporte". El km final se carga a la tarde, así que un reporte
//      con solo el inicial es normal y no se marca. Es PENDIENTE (ámbar), no vencido.
//   4. EL ÚLTIMO DÍA DE SERVICIO anterior a hoy: además de "sin ningún reporte", se marca el que
//      cargó solo el inicial y nunca el final. Es VENCIDO (rojo): ya pasó el día.
//   5. "Día de servicio" = un día (de los últimos 5 anteriores a hoy) en el que al menos UN chofer de
//      la empresa cargó un reporte o tuvo chicos asignados. Así los feriados y los días sin servicio
//      no llenan la pizarra de falsas alarmas, y un lunes se mira el viernes y no el domingo.
//
// Límite conocido: si en un día hábil NINGÚN chofer cargó nada ni tuvo chicos asignados, se lo toma por
// día sin servicio y no se marca a nadie (no se puede distinguir de un feriado). Un chofer de licencia
// que sigue activo se marca todos los días hábiles: se resuelve dándolo de baja en Choferes.
const { normalizarText_ } = require('../utils');
const { cargarChoferes } = require('./resumenDiario');
const {
  normalizarFecha, fechaDoc, hoyAR, sumarDias, variantesFecha, nombreDiaSemana, esDiaHabil,
} = require('../utils/fechas');

const DIAS_ATRAS = 5;
// Firestore limita cuántos valores admite un "in" (30 hoy, 10 antes): se consulta de a 10 por las dudas.
const LOTE_IN = 10;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const campo = (doc, ...claves) => { for (const k of claves) if (doc[k] !== undefined && doc[k] !== null && doc[k] !== '') return doc[k]; return undefined; };

/**
 * Documentos de una colección cuyo `campo` vale alguno de `valores`, sin traer el resto.
 * Devuelve [{ id, ...datos }] sin repetidos. Es la forma de no leer una colección entera
 * (reportes crece todos los días) cuando solo importan unos pocos días.
 */
async function leerPorValores(coleccion, nombreCampo, valores) {
  const unicos = [...new Set(valores)];
  const out = new Map();
  for (let i = 0; i < unicos.length; i += LOTE_IN) {
    const snap = await coleccion.where(nombreCampo, 'in', unicos.slice(i, i + LOTE_IN)).get();
    snap.docs.forEach(d => out.set(d.id, { id: d.id, ...d.data() }));
  }
  return [...out.values()];
}

/** Con qué textos puede venir el chofer en un reporte: su email, su nombre o la parte local del email. */
const clavesDe = c => new Set([c.email, c.nombre, (c.email || '').split('@')[0]].map(normalizarText_).filter(Boolean));

const esDeChofer = (rep, claves) => claves.has(normalizarText_(campo(rep, 'chofer', 'CHOFER') || ''));
const asignadoA = (asig, chofer, claves) =>
  asig.choferId === chofer.uid
  || claves.has(normalizarText_(asig.choferId || ''))
  || claves.has(normalizarText_(asig.choferNombre || ''));

/** Cargó el inicial pero nunca el final (ni los recorridos). */
function soloInicial(reportes) {
  const final = reportes.some(r => num(campo(r, 'kmFinal', 'KM FINAL', 'km_final')) > 0
    || num(campo(r, 'kmRecorridos', 'KM RECORRIDOS', 'km_recorridos')) > 0);
  const inicial = reportes.some(r => num(campo(r, 'kmInicial', 'KM INICIAL', 'km_inicial')) > 0);
  return !final && inicial;
}

/** Evalúa un día: quiénes debían cargar y quiénes no lo hicieron. `exigirFinal` = es un día ya cerrado. */
function evaluarDia(dia, choferes, slot, { exigirFinal }) {
  const habil = esDiaHabil(dia);
  const esperados = choferes.filter(c => habil || slot.asignados.some(a => asignadoA(a, c, c.claves)));
  const faltan = [];
  for (const c of esperados) {
    const reps = slot.reportes.filter(r => esDeChofer(r, c.claves));
    const base = { nombre: c.nombre, email: c.email, vehiculo: c.vehiculo };
    if (!reps.length) faltan.push({ ...base, motivo: 'SIN_REPORTE' });
    else if (exigirFinal && soloInicial(reps)) faltan.push({ ...base, motivo: 'SIN_KM_FINAL' });
  }
  return {
    fecha: dia, diaSemana: nombreDiaSemana(dia), esDiaHabil: habil,
    esperados: esperados.length, cargaron: esperados.length - faltan.length, faltan,
  };
}

/**
 * deps: { col (Firestore inyectable), ahora (Date, para probar), diasAtras }
 * Devuelve { sinChoferes, hoy, anterior, totalFaltan, urgentes }.
 *   hoy:      evaluación de hoy (pendiente).
 *   anterior: el último día de servicio antes de hoy, o null si no hubo ninguno en los últimos días.
 */
async function calcularKmPendientes(tenantId, { col, ahora = new Date(), diasAtras = DIAS_ATRAS } = {}) {
  if (typeof col !== 'function') throw new Error('calcularKmPendientes necesita col (Firestore).');
  const hoy = hoyAR(ahora);
  const dias = Array.from({ length: diasAtras + 1 }, (_, i) => sumarDias(hoy, -i));   // [hoy, ayer, …]

  const choferes = (await cargarChoferes(tenantId, null, col)).map(c => ({ ...c, claves: clavesDe(c) }));
  if (!choferes.length) {
    return { sinChoferes: true, hoy: null, anterior: null, totalFaltan: 0, urgentes: 0 };
  }

  // Solo los días que importan, en todas las formas en que pueden estar guardados.
  const variantes = dias.flatMap(variantesFecha);
  const isos = dias.map(d => variantesFecha(d)[0]);
  const [repFecha, repFECHA, asignaciones] = await Promise.all([
    leerPorValores(col(tenantId, 'reportes'), 'fecha', variantes),
    leerPorValores(col(tenantId, 'reportes'), 'FECHA', variantes),     // documentos viejos con la clave en mayúsculas
    leerPorValores(col(tenantId, 'ASISTENCIA'), 'fecha', isos),
  ]);

  const porDia = new Map(dias.map(d => [d, { reportes: [], asignados: [] }]));
  for (const r of new Map([...repFecha, ...repFECHA].map(x => [x.id, x])).values()) {
    const slot = porDia.get(fechaDoc(r));
    if (slot) slot.reportes.push(r);
  }
  for (const a of asignaciones) {
    const slot = porDia.get(normalizarFecha(a.fecha));
    if (slot && Array.isArray(a.beneficiarios) && a.beneficiarios.length) slot.asignados.push(a);
  }
  const hayActividad = d => { const s = porDia.get(d); return s.reportes.length > 0 || s.asignados.length > 0; };

  const evHoy = evaluarDia(hoy, choferes, porDia.get(hoy), { exigirFinal: false });

  let anterior = null;
  for (let i = 1; i < dias.length; i++) {
    if (hayActividad(dias[i])) {
      anterior = { ...evaluarDia(dias[i], choferes, porDia.get(dias[i]), { exigirFinal: true }), esAyer: i === 1 };
      break;
    }
  }

  return {
    sinChoferes: false,
    hoy: evHoy,
    anterior,
    totalFaltan: evHoy.faltan.length + (anterior ? anterior.faltan.length : 0),
    urgentes: anterior ? anterior.faltan.length : 0,
  };
}

module.exports = { calcularKmPendientes, leerPorValores, evaluarDia, soloInicial, DIAS_ATRAS, LOTE_IN };
