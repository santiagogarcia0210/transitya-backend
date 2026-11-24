// Lógica pura de la carpeta del paciente (sin Firestore) — testeable.
const { normalizarText_ } = require('../utils');
const { parseFecha, aDMY, calcEstado, sumarMeses } = require('../helpers/fechas');

/** Lee un campo del beneficiario tolerando variantes de nombre de columna (migración desde Sheets). */
function campo(reg, ...claves) {
  const norm = s => normalizarText_(s).replace(/[^a-z0-9]/g, '');
  for (const clave of claves) {
    const k = Object.keys(reg || {}).find(x => norm(x) === norm(clave));
    if (k && reg[k] !== undefined && reg[k] !== null && String(reg[k]).trim() !== '') return String(reg[k]).trim();
  }
  return '';
}

function datosBeneficiario(reg) {
  return {
    id:         reg.id,
    nombre:     campo(reg, 'APELLIDO Y NOMBRE', 'NOMBRE', 'nombre'),
    dni:        campo(reg, 'DNI', 'dni'),
    afiliado:   campo(reg, 'N° AFILIADO', 'NRO AFILIADO', 'AFILIADO', 'afiliado'),
    obraSocial: campo(reg, 'OBRA SOCIAL', 'OBRA_SOCIAL', 'obraSocial', 'OS'),
    localidad:  campo(reg, 'LOCALIDAD', 'localidad'),
    chofer:     campo(reg, 'CHOFER', 'chofer'),
  };
}

/** Busca la obra social configurada que corresponde al texto cargado en el registro. */
function matchObraSocial(texto, obras) {
  const t = normalizarText_(texto);
  if (!t) return null;
  let mejor = null, largo = 0;
  for (const os of obras || []) {
    for (const cand of [os.nombre, ...(os.alias || [])]) {
      const c = normalizarText_(cand);
      if (c && t.includes(c) && c.length > largo) { mejor = os; largo = c.length; }
    }
  }
  return mejor;
}

function diasAvisoDe(req) {
  return req && req.vencimiento === 'meses' && Number(req.vigenciaMeses) <= 1 ? 7 : 30;
}

/** Fecha de vencimiento efectiva de un documento cargado. */
function fechaVencDoc(doc, req) {
  if (doc.fechaVenc && parseFecha(doc.fechaVenc)) return aDMY(parseFecha(doc.fechaVenc));
  if (req && req.vencimiento === 'meses' && doc.fechaEmision) {
    return aDMY(sumarMeses(doc.fechaEmision, req.vigenciaMeses));
  }
  return '';
}

const fechaOrden = d => (parseFecha(d.fechaEmision) || parseFecha(d.creadoEn) || new Date(0)).getTime();

/**
 * Checklist de la carpeta: un ítem por requisito de categoría 'paciente'.
 * estado: FALTA | OPCIONAL | NO_VENCE | VIGENTE | PROXIMO | VENCIDO | SIN_FECHA
 */
function checklist(obra, docs, ahora = new Date()) {
  const reqs = (obra?.requisitos || []).filter(r => r.categoria === 'paciente');
  return reqs.map(req => {
    const propios = (docs || []).filter(d => d.requisitoKey === req.key).sort((a, b) => fechaOrden(b) - fechaOrden(a));
    const actual = propios[0] || null;
    if (!actual) {
      return { requisito: req, estado: req.obligatorio ? 'FALTA' : 'OPCIONAL', documento: null, historial: [], fechaVenc: '', diffDias: null };
    }
    let estado, diffDias = null;
    const fechaVenc = fechaVencDoc(actual, req);
    if (req.vencimiento === 'no') estado = 'NO_VENCE';
    else if (!fechaVenc) estado = 'SIN_FECHA';
    else ({ estado, diffDias } = calcEstado(fechaVenc, diasAvisoDe(req), ahora));
    return { requisito: req, estado, documento: actual, historial: propios.slice(1), fechaVenc, diffDias };
  });
}

function resumenChecklist(items) {
  const c = { FALTA: 0, VENCIDO: 0, PROXIMO: 0, SIN_FECHA: 0, OK: 0, total: 0 };
  for (const it of items) {
    if (it.estado === 'OPCIONAL') continue;
    c.total++;
    if (it.estado === 'VIGENTE' || it.estado === 'NO_VENCE') c.OK++;
    else c[it.estado] = (c[it.estado] || 0) + 1;
  }
  c.completo = c.total > 0 && c.OK === c.total;
  return c;
}

/** Lista plana de alertas para el panel administrativo. */
function alertasDe(benef, obra, items) {
  if (!obra) {
    return [{ tipo: 'SIN_OBRA_SOCIAL', beneficiarioId: benef.id, beneficiario: benef.nombre,
      detalle: benef.obraSocial ? `La obra social "${benef.obraSocial}" no tiene requisitos configurados` : 'Sin obra social cargada en el registro',
      diffDias: null }];
  }
  return items
    .filter(it => ['FALTA', 'VENCIDO', 'PROXIMO', 'SIN_FECHA'].includes(it.estado))
    .map(it => ({
      tipo: it.estado, beneficiarioId: benef.id, beneficiario: benef.nombre, obraSocial: obra.nombre,
      requisitoKey: it.requisito.key, detalle: it.requisito.nombre, fechaVenc: it.fechaVenc, diffDias: it.diffDias,
    }));
}

module.exports = { campo, datosBeneficiario, matchObraSocial, fechaVencDoc, checklist, resumenChecklist, alertasDe, diasAvisoDe };
