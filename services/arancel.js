// Arancel del nomenclador: valor del km de transporte por período, con valor propio por obra social.
// Funciones puras. Colección: empresas/{tenant}/aranceles_nomenclador
//   { id, vigenteDesde (dd/MM/yyyy), vigenteHasta?, valorKmTransporte, resolucion, fuente, mes, obraId|null, verificar, cargadoPor, creadoEn }
// obraId null = valor del nomenclador (por defecto); con obraId = valor propio de esa obra social (p. ej. PAMI).
const { normalizarFecha, fechaToDate } = require('../utils/fechas');

const DIAS_AVISO_DESACTUALIZADO = 35;
const MS_DIA = 86400000;

/** Valor inicial sugerido: dato de prensa, NO verificado todavía contra el Boletín Oficial. */
const SEMILLA_NOV_2026 = {
  vigenteDesde: '01/11/2026', valorKmTransporte: 953.22, mes: 'Noviembre 2026',
  resolucion: 'Resolución 3715/2026 de la Secretaría Nacional de Discapacidad',
  fuente: 'Prensa. Verificar contra el Boletín Oficial', verificar: true, obraId: null,
};

const err = mensaje => Object.assign(new Error(mensaje), { mensaje });
const recortar = (v, n) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** Valida y normaliza lo que llega de la pantalla. Lanza Error con `.mensaje`. */
function limpiarArancel(body) {
  const desde = normalizarFecha(body.vigenteDesde);
  if (!desde) throw err('Falta la fecha desde la que rige el valor.');
  const hasta = body.vigenteHasta ? normalizarFecha(body.vigenteHasta) : '';
  if (body.vigenteHasta && !hasta) throw err('La fecha hasta la que rige no es válida.');
  if (hasta && fechaToDate(hasta) < fechaToDate(desde)) throw err('La fecha "hasta" no puede ser anterior a la fecha "desde".');
  const valor = Number(String(body.valorKmTransporte).replace(',', '.'));
  if (!(valor > 0 && valor < 1e6)) throw err('El valor del km no es válido.');
  const resolucion = recortar(body.resolucion, 200);
  if (!resolucion) throw err('Indicá la resolución que fija el valor.');
  return {
    vigenteDesde: desde, ...(hasta ? { vigenteHasta: hasta } : {}), valorKmTransporte: Math.round(valor * 100) / 100,
    resolucion, fuente: recortar(body.fuente, 200), mes: recortar(body.mes, 40), obraId: body.obraId ? recortar(body.obraId, 80) : null,
    verificar: body.verificar === true,
  };
}

/**
 * Valor vigente a una fecha. Si la obra social tiene valor propio que rige esa fecha, gana; si no, el del nomenclador.
 * Devuelve { arancel, origen: 'obra_social' | 'nomenclador' } o null.
 */
function valorVigente(aranceles, { fecha, obraId = null }) {
  const f = fechaToDate(fecha);
  if (!f) return null;
  const rige = a => {
    const d = fechaToDate(a.vigenteDesde), h = a.vigenteHasta ? fechaToDate(a.vigenteHasta) : null;
    return d && d <= f && (!h || f <= h);
  };
  const masReciente = lista => lista.filter(rige).sort((a, b) => fechaToDate(b.vigenteDesde) - fechaToDate(a.vigenteDesde))[0] || null;
  const propio = obraId ? masReciente(aranceles.filter(a => a.obraId === obraId)) : null;
  if (propio) return { arancel: propio, origen: 'obra_social' };
  const general = masReciente(aranceles.filter(a => !a.obraId));
  return general ? { arancel: general, origen: 'nomenclador' } : null;
}

/** ¿El último valor cargado (para esa obra, o el general) tiene más de 35 días? */
function estadoActualizacion(aranceles, { hoy = new Date(), obraId = null } = {}) {
  const propios = obraId ? aranceles.filter(a => a.obraId === obraId) : [];
  const lista = propios.length ? propios : aranceles.filter(a => !a.obraId);
  const ultimo = lista.sort((a, b) => fechaToDate(b.vigenteDesde) - fechaToDate(a.vigenteDesde))[0] || null;
  if (!ultimo) return { desactualizado: true, ultimo: null, diasDesde: null, mensaje: 'Todavía no hay un valor del km cargado.' };
  const dias = Math.floor((new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) - fechaToDate(ultimo.vigenteDesde)) / MS_DIA);
  const desactualizado = dias > DIAS_AVISO_DESACTUALIZADO;
  return {
    desactualizado, ultimo, diasDesde: dias,
    mensaje: desactualizado ? `El último valor cargado rige desde hace ${dias} días (${ultimo.mes || ultimo.vigenteDesde}). Revisá si salió uno nuevo.` : '',
  };
}

/** Al cargar un valor nuevo, cierra el anterior que seguía abierto (misma obra) el día antes. Devuelve los cambios. */
function cierresPorNuevo(aranceles, nuevo) {
  const desde = fechaToDate(nuevo.vigenteDesde);
  const dia = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() - 1);
  const dmy = `${String(dia.getDate()).padStart(2, '0')}/${String(dia.getMonth() + 1).padStart(2, '0')}/${dia.getFullYear()}`;
  return aranceles
    .filter(a => (a.obraId || null) === (nuevo.obraId || null) && a.id !== nuevo.id && !a.vigenteHasta && fechaToDate(a.vigenteDesde) < desde)
    .map(a => ({ id: a.id, vigenteHasta: dmy }));
}

module.exports = { limpiarArancel, valorVigente, estadoActualizacion, cierresPorNuevo, SEMILLA_NOV_2026, DIAS_AVISO_DESACTUALIZADO };
