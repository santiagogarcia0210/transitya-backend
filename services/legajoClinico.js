// Datos clínicos del legajo: qué se lee, cómo se valida y cómo se sugiere una modalidad de centro.
//
// Alcance (a propósito acotado): del CUD, diagnóstico, CIE-10, tipo de discapacidad, nº de certificado, vencimiento y
// orientación prestacional; de la orden médica, diagnóstico, prestación/frecuencia indicada y profesional.
// NO se extrae medicación, estudios ni historia clínica.
//
// Todo lo de este archivo es puro (sin Firestore ni red) para poder probarlo. El guardado cifrado está en
// legajoClinicoStore.js. Los valores de acá NUNCA se escriben en logs.
const { normalizarFecha } = require('../utils/fechas');

const DOCUMENTOS = ['cud', 'orden_medica'];
const CONFIANZAS = ['baja', 'media', 'alta'];

/** Modalidades del Nomenclador de prestaciones básicas (Ley 24.901) que importan para el transporte. */
const MODALIDADES = {
  estimulacion_temprana: 'Estimulación temprana',
  centro_dia: 'Centro de día',
  centro_educativo_terapeutico: 'Centro educativo terapéutico',
  escuela_especial: 'Escuela especial',
  integracion_escolar: 'Apoyo a la integración escolar',
  rehabilitacion_ambulatoria: 'Rehabilitación ambulatoria',
  hogar: 'Hogar / residencia',
  taller_protegido: 'Taller protegido / formación laboral',
};

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const recortar = (v, max) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const confianzaDe = c => { const x = norm(c); return CONFIANZAS.includes(x) ? x : 'baja'; };
const minima = l => l.reduce((m, c) => (CONFIANZAS.indexOf(c) < CONFIANZAS.indexOf(m) ? c : m), 'alta');

/* ── Texto libre → modalidades (para lo que escribe el CUD o la orden médica) ─ */

const PATRONES = [
  ['estimulacion_temprana', /estimulacion temprana/],
  ['centro_dia', /centro de dia/],
  ['centro_educativo_terapeutico', /centro educativo terapeutico|\bcet\b/],
  ['escuela_especial', /escuela especial|educacion especial|educacion basica especial/],
  ['integracion_escolar', /integracion escolar|maestra integradora|apoyo a la integracion/],
  ['rehabilitacion_ambulatoria', /rehabilitacion|kinesio|fisioterap|fonoaudiolog|terapia ocupacional|psicomotric/],
  ['hogar', /\bhogar\b|residencia/],
  ['taller_protegido', /taller protegido|formacion laboral|taller laboral/],
];

/** Modalidades que se mencionan en un texto, en el orden en que figuran en PATRONES. */
function modalidadesDeTexto(texto) {
  const t = norm(texto);
  return t ? PATRONES.filter(([, re]) => re.test(t)).map(([k]) => k) : [];
}

/* ── Campos por documento ────────────────────────────────────────────────── */

const entero = (v, min, max) => { const n = Number(String(v).replace(/\D/g, '')); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

/**
 * Cada campo sabe normalizarse: devuelve { valor } o { descartado: 'motivo' } (nunca lanza).
 * `valor` de una lista es un array de claves de MODALIDADES.
 */
const CAMPOS = {
  cud: {
    diagnostico: v => ({ valor: recortar(v, 300) }),
    cie10: v => {
      const c = String(v || '').toUpperCase().replace(/\s+/g, '');
      if (!c) return { valor: '' };
      return /^[A-TV-Z]\d{2}(\.\d{1,2})?$/.test(c) ? { valor: c } : { descartado: 'El código CIE-10 no tiene un formato válido.' };
    },
    tipoDiscapacidad: v => ({ valor: recortar(v, 120) }),
    nroCertificado: v => ({ valor: recortar(v, 40) }),
    vencimientoCertificado: v => {
      if (!v) return { valor: '' };
      const f = normalizarFecha(v);
      return f ? { valor: f } : { descartado: 'La fecha de vencimiento del certificado no es válida.' };
    },
    orientacionTexto: v => ({ valor: recortar(v, 600) }),
    orientacionPrestaciones: v => {
      const lista = (Array.isArray(v) ? v : []).map(x => String(x)).filter(k => MODALIDADES[k]);
      return { valor: [...new Set(lista)].slice(0, 6) };
    },
  },
  orden_medica: {
    diagnostico: v => ({ valor: recortar(v, 300) }),
    prestacionIndicada: v => ({ valor: recortar(v, 300) }),
    diasPorSemana: v => {
      if (v === null || v === undefined || v === '') return { valor: null };
      const n = entero(v, 1, 7);
      return n === null ? { descartado: 'Los días por semana tienen que estar entre 1 y 7.' } : { valor: n };
    },
    profesional: v => ({ valor: recortar(v, 120) }),
  },
};

const vacio = v => v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** Lista de campos de cada documento (para que el frontend y los tests no la repitan). */
const camposDe = doc => Object.keys(CAMPOS[doc] || {});

/* ── Lo que devuelve la IA → propuesta ───────────────────────────────────── */

const datoIA = x => (x && typeof x === 'object' && !Array.isArray(x) && 'valor' in x
  ? { valor: x.valor, confianza: confianzaDe(x.confianza) } : { valor: x === undefined ? null : x, confianza: 'baja' });

/**
 * Convierte el bloque "clinico" de la respuesta de la IA en una propuesta validada, o null si no corresponde
 * (no es CUD ni orden médica, o no vino nada). Los valores imposibles se descartan con una advertencia.
 */
function parsearClinico(crudo) {
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return null;
  const documento = DOCUMENTOS.includes(crudo.documento) ? crudo.documento : null;
  if (!documento) return null;
  const campos = {}, advertencias = [];
  for (const k of camposDe(documento)) {
    if (k === 'orientacionPrestaciones') continue;
    const d = datoIA(crudo[k]);
    if (vacio(d.valor)) continue;
    const r = CAMPOS[documento][k](d.valor);
    if (r.descartado) { advertencias.push(r.descartado); continue; }
    if (!vacio(r.valor)) campos[k] = { valor: r.valor, confianza: d.confianza };
  }
  if (documento === 'cud') {
    const op = crudo.orientacionPrestaciones && typeof crudo.orientacionPrestaciones === 'object' ? crudo.orientacionPrestaciones : {};
    const lista = (Array.isArray(op.valor) ? op.valor : []).map(x => (x && typeof x === 'object' ? x.valor : x));
    let { valor } = CAMPOS.cud.orientacionPrestaciones(lista);
    let confianza = valor.length ? minima([confianzaDe(op.confianza)]) : 'baja';
    // Si la IA no normalizó la lista pero copió el texto, se deduce del texto (con menos confianza).
    if (!valor.length && campos.orientacionTexto) {
      valor = modalidadesDeTexto(campos.orientacionTexto.valor).slice(0, 6);
      confianza = 'media';
    }
    if (valor.length) campos.orientacionPrestaciones = { valor, confianza };
  }
  return Object.keys(campos).length ? { documento, campos, advertencias } : { documento, campos: {}, advertencias };
}

/**
 * Valida lo que el administrativo confirmó (o editó). Estricto: si algo está mal, lanza Error con `.mensaje`.
 * Devuelve { documento, campos: { k: { valor, confianza, editado } } }. Los campos vacíos se omiten.
 */
function sanitizarClinicoConfirmado(clin) {
  const err = mensaje => Object.assign(new Error(mensaje), { mensaje });
  if (!clin || typeof clin !== 'object') throw err('Datos clínicos inválidos.');
  const documento = clin.documento;
  if (!DOCUMENTOS.includes(documento)) throw err('Tipo de documento clínico inválido.');
  const entrada = clin.campos && typeof clin.campos === 'object' ? clin.campos : {};
  const campos = {};
  for (const k of Object.keys(entrada)) {
    if (!CAMPOS[documento][k]) throw err('Campo clínico desconocido.');
    const raw = entrada[k] && typeof entrada[k] === 'object' && !Array.isArray(entrada[k]) ? entrada[k] : { valor: entrada[k] };
    const r = CAMPOS[documento][k](raw.valor);
    if (r.descartado) throw err(r.descartado);
    if (vacio(r.valor)) continue;
    campos[k] = { valor: r.valor, confianza: confianzaDe(raw.confianza), editado: raw.editado === true };
  }
  return { documento, campos };
}

/** Lista de modalidades elegidas a mano (o null). */
function sanitizarModalidades(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw Object.assign(new Error('x'), { mensaje: 'Las modalidades elegidas son inválidas.' });
  return [...new Set(v.map(String).filter(k => MODALIDADES[k]))].slice(0, 3);
}

/* ── Recomendación de tipo de centro (sugerencia, sin juicios clínicos) ───── */

const INFERENCIAS_DIAGNOSTICO = [
  [/autis|\btea\b|asperger|sindrome de down|discapacidad intelectual|retraso (mental|madurativo)|\bTGD\b/i, ['centro_dia', 'centro_educativo_terapeutico']],
  [/paralisis cerebral|lesion medular|espina bifida|distrofia|motora|motriz|hemiplej|parapleji|cuadripleji/i, ['rehabilitacion_ambulatoria']],
];

/**
 * Sugiere de 1 a 3 modalidades. Orden de prioridad (la primera que aporta algo manda):
 *  1) la orientación prestacional del CUD (lista normalizada y texto);
 *  2) la prestación indicada en la orden médica;
 *  3) el diagnóstico / tipo de discapacidad, solo como orientación (nunca pisa a 1 ni a 2).
 * Devuelve { sugerencias: [{ modalidad, etiqueta, motivo, fuente }], base }.
 */
function recomendarCentro({ diagnostico = '', tipoDiscapacidad = '', orientacionPrestaciones = [], orientacionTexto = '', prestacionIndicada = '' } = {}) {
  const out = [];
  const sumar = (modalidad, motivo, fuente) => {
    if (out.length < 3 && MODALIDADES[modalidad] && !out.some(s => s.modalidad === modalidad)) out.push({ modalidad, etiqueta: MODALIDADES[modalidad], motivo, fuente });
  };
  const delCud = [...new Set([...(orientacionPrestaciones || []).filter(k => MODALIDADES[k]), ...modalidadesDeTexto(orientacionTexto)])];
  delCud.forEach(k => sumar(k, 'La orientación prestacional del CUD la indica.', 'cud'));
  modalidadesDeTexto(prestacionIndicada).forEach(k => sumar(k, 'La orden médica indica esta prestación.', 'orden'));
  if (!out.length) {
    const texto = `${diagnostico} ${tipoDiscapacidad}`;
    for (const [re, mods] of INFERENCIAS_DIAGNOSTICO) {
      if (re.test(norm(texto)) || re.test(texto)) mods.forEach(k => sumar(k, 'Orientativo según el diagnóstico; confirmalo con el CUD o el equipo tratante.', 'diagnostico'));
    }
  }
  return { sugerencias: out, base: out[0] ? out[0].fuente : 'ninguna' };
}

module.exports = {
  DOCUMENTOS, MODALIDADES, CAMPOS, camposDe, modalidadesDeTexto, parsearClinico,
  sanitizarClinicoConfirmado, sanitizarModalidades, recomendarCentro,
};
