// Clasificación de mails: ¿es de trabajo? ¿de qué tipo? ¿requiere acción?
// Reglas primero (gratis, deterministas); lo que las reglas no resuelven lo decide Claude Haiku.
// Lo que NO es de trabajo nunca se guarda.
const { normalizarText_ } = require('../utils');

const CATEGORIAS = {
  OBRA_SOCIAL:   'Obra social',
  PACIENTE:      'Paciente / familia',
  CENTRO:        'Centro / institución',
  IMPUESTOS:     'Contador / impuestos',
  COBROS:        'Cobros / banco',
  PROVEEDOR:     'Proveedor / servicio',
  FLOTA:         'Choferes / vehículos',
  ASOCIACION:    'Asociación / cámara',
  OTRO:          'Otro de trabajo',
};

const PALABRAS_DEFAULT = [
  'obra social', 'osprera', 'pami', 'incluir salud', 'prestacion', 'prestador', 'autorizacion',
  'presupuesto', 'planilla', 'traslado', 'transporte', 'discapacidad', 'beneficiario', 'afiliado',
  'cud', 'fim', 'expediente', 'factura', 'facturacion', 'liquidacion', 'arca', 'afip', 'iibb',
  'monotributo', 'vtv', 'poliza', 'habilitacion',
];

const REGLAS_DEFAULT = { trabajo: [], ignorar: [], palabrasClave: PALABRAS_DEFAULT };

const lista = v => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
  .map(s => String(s).trim().toLowerCase()).filter(Boolean);

function limpiarReglas(r = {}) {
  return {
    trabajo:       [...new Set(lista(r.trabajo))].slice(0, 300),
    ignorar:       [...new Set(lista(r.ignorar))].slice(0, 300),
    palabrasClave: [...new Set(lista(r.palabrasClave).map(normalizarText_))].slice(0, 200),
  };
}

/** 'juan@osprera.org.ar' matchea 'juan@osprera.org.ar', '@osprera.org.ar' u 'osprera.org.ar'. */
function remitenteCoincide(email, patrones) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return false;
  const dominio = e.split('@')[1] || '';
  return patrones.some(p => {
    if (p.includes('@') && !p.startsWith('@')) return e === p;
    const d = p.replace(/^@/, '');
    return dominio === d || dominio.endsWith('.' + d);
  });
}

function palabraEncontrada(texto, palabras) {
  const t = ' ' + normalizarText_(texto).replace(/[^a-z0-9ñ ]+/g, ' ') + ' ';
  return palabras.find(p => t.includes(' ' + p + ' ')) || null;
}

/**
 * Decide con reglas. Devuelve:
 *  { decision: 'IGNORAR' | 'TRABAJO' | 'DUDA', motivo, palabra }
 */
function decidirPorReglas(mail, reglas) {
  if (remitenteCoincide(mail.de, reglas.ignorar)) return { decision: 'IGNORAR', motivo: 'remitente ignorado' };
  if (remitenteCoincide(mail.de, reglas.trabajo)) return { decision: 'TRABAJO', motivo: 'remitente de trabajo' };
  const palabra = palabraEncontrada(`${mail.asunto} ${String(mail.texto || '').slice(0, 400)}`, reglas.palabrasClave);
  return { decision: 'DUDA', motivo: palabra ? `palabra "${palabra}"` : 'sin coincidencias', palabra };
}

/** Sin IA: una DUDA es de trabajo solo si tiene palabra clave y no parece newsletter. */
function resolverSinIA(mail, r) {
  if (r.decision === 'TRABAJO') return { trabajo: true };
  if (r.decision === 'IGNORAR') return { trabajo: false };
  return { trabajo: !!r.palabra && !mail.esNewsletter };
}

function categoriaHeuristica(mail) {
  const t = normalizarText_(`${mail.de} ${mail.asunto} ${String(mail.texto || '').slice(0, 300)}`);
  if (/osprera|pami|incluir|obra social|ugp|ugl|auditoria/.test(t)) return 'OBRA_SOCIAL';
  if (/arca|afip|iibb|iva|monotributo|contador|ingresos brutos|rentas/.test(t)) return 'IMPUESTOS';
  if (/transferencia|acreditacion|pago recibido|banco|cbu/.test(t)) return 'COBROS';
  if (/vtv|poliza|seguro|licencia|habilitacion|chofer/.test(t)) return 'FLOTA';
  if (/centro|escuela|instituto|fundacion|rehabilitacion/.test(t)) return 'CENTRO';
  return 'OTRO';
}

/** Busca si el mail nombra a un paciente del registro (por DNI o por apellido + nombre). */
function vincularPaciente(mail, pacientes) {
  const texto = normalizarText_(`${mail.asunto} ${String(mail.texto || '').slice(0, 3000)}`);
  const digitos = texto.replace(/\./g, '');
  for (const p of pacientes) {
    if (p.dni && String(p.dni).replace(/\D/g, '').length >= 7 && digitos.includes(String(p.dni).replace(/\D/g, ''))) return p;
  }
  for (const p of pacientes) {
    const tokens = normalizarText_(p.nombre).split(/\s+/).filter(t => t.length >= 3);
    if (tokens.length >= 2 && tokens.every(t => new RegExp(`\\b${t}\\b`).test(texto))) return p;
  }
  return null;
}

const PROMPT = `Sos el asistente administrativo de una empresa argentina de transporte de personas con discapacidad que factura sus traslados a obras sociales (PAMI, OSPRERA, Incluir Salud, etc.).
Te paso mails de la casilla de la empresa. Para cada uno decidí si es DE TRABAJO (obras sociales, pacientes o sus familias, centros de rehabilitación o escuelas, contador e impuestos, cobros y bancos de la empresa, proveedores, choferes, vehículos, seguros, habilitaciones, asociaciones del rubro) o NO (publicidad, newsletters genéricos, redes sociales, compras o viajes personales, notificaciones de apps sin relación).
Respondé SOLO con un array JSON, un objeto por mail, en el mismo orden:
[{"i":0,"trabajo":true,"categoria":"OBRA_SOCIAL|PACIENTE|CENTRO|IMPUESTOS|COBROS|PROVEEDOR|FLOTA|ASOCIACION|OTRO","resumen":"máx 140 caracteres, en castellano rioplatense","accion":"qué hay que hacer, o vacío si es informativo","urgencia":"ALTA|MEDIA|BAJA"}]
Si "trabajo" es false, el resto de los campos puede ir vacío.`;

function construirLote(mails) {
  return mails.map((m, i) => [
    `--- MAIL ${i} ---`,
    `De: ${m.deNombre ? `${m.deNombre} <${m.de}>` : m.de}`,
    `Asunto: ${m.asunto || '(sin asunto)'}`,
    m.adjuntos?.length ? `Adjuntos: ${m.adjuntos.map(a => a.nombre).join(', ').slice(0, 200)}` : '',
    m.esNewsletter ? 'Tiene link para desuscribirse.' : '',
    `Texto: ${String(m.texto || '').replace(/\s+/g, ' ').slice(0, 700)}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function parsearRespuesta(texto, n) {
  const limpio = String(texto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const ini = limpio.indexOf('['), fin = limpio.lastIndexOf(']');
  if (ini < 0 || fin < ini) throw new Error('La IA no devolvió JSON');
  const arr = JSON.parse(limpio.slice(ini, fin + 1));
  const out = new Array(n).fill(null);
  for (const r of arr) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    out[i] = {
      trabajo:   r.trabajo === true,
      categoria: CATEGORIAS[r.categoria] ? r.categoria : 'OTRO',
      resumen:   String(r.resumen || '').slice(0, 200),
      accion:    String(r.accion || '').slice(0, 200),
      urgencia:  ['ALTA', 'MEDIA', 'BAJA'].includes(r.urgencia) ? r.urgencia : 'BAJA',
    };
  }
  return out;
}

/** Llama a Claude en lotes de 15. `llamar(prompt)` devuelve el texto de la respuesta (inyectable para tests). */
async function clasificarConIA(mails, llamar) {
  const resultados = [];
  for (let k = 0; k < mails.length; k += 15) {
    const lote = mails.slice(k, k + 15);
    const texto = await llamar(`${PROMPT}\n\n${construirLote(lote)}`);
    resultados.push(...parsearRespuesta(texto, lote.length));
  }
  return resultados;
}

function llamadorAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return async (prompt) => {
    const msg = await anthropic.messages.create({
      model: process.env.CORREO_MODELO || 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content.map(c => c.text || '').join('');
  };
}

module.exports = {
  CATEGORIAS, REGLAS_DEFAULT, PALABRAS_DEFAULT, limpiarReglas, remitenteCoincide, decidirPorReglas,
  resolverSinIA, categoriaHeuristica, vincularPaciente, clasificarConIA, parsearRespuesta, llamadorAnthropic,
};
