// Requisitos documentales por obra social.
// Colección: empresas/{tenantId}/requisitos_os/{osId}
//   { id, nombre, alias[], presentacion{dia,canal,notas}, requisitos[], notas, actualizadoEn }
const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col } = require('../utils');
const BORRADOR = require('../data/requisitosBorrador');

const errHandler = (res, req, e) => {
  console.error('[REQUISITOS-OS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const CATEGORIAS = new Set(['paciente', 'prestador', 'mensual']);
const VENCIMIENTOS = new Set(['no', 'fecha_doc', 'meses']);

function limpiarRequisitos(lista) {
  const vistos = new Set();
  return (Array.isArray(lista) ? lista : []).map(r => {
    let key = slug(r.key || r.nombre).replace(/-/g, '_') || 'req';
    while (vistos.has(key)) key += '_2';
    vistos.add(key);
    const vencimiento = VENCIMIENTOS.has(r.vencimiento) ? r.vencimiento : 'no';
    return {
      key,
      nombre:        String(r.nombre || '').trim(),
      categoria:     CATEGORIAS.has(r.categoria) ? r.categoria : 'paciente',
      vencimiento,
      vigenciaMeses: vencimiento === 'meses' ? Math.max(1, Number(r.vigenciaMeses) || 12) : 0,
      obligatorio:   r.obligatorio !== false,
      condicion:     String(r.condicion || ''),
      notas:         String(r.notas || ''),
    };
  }).filter(r => r.nombre);
}

function limpiarOS(body) {
  return {
    nombre: String(body.nombre || '').trim(),
    alias: (Array.isArray(body.alias) ? body.alias : String(body.alias || '').split(','))
      .map(a => String(a).trim().toUpperCase()).filter(Boolean),
    presentacion: {
      dia:   Math.min(31, Math.max(1, Number(body.presentacion?.dia) || 10)),
      canal: String(body.presentacion?.canal || ''),
      notas: String(body.presentacion?.notas || ''),
    },
    requisitos: limpiarRequisitos(body.requisitos),
    notas: String(body.notas || ''),
  };
}

// ── Qué haría la semilla sobre lo que ya hay en la empresa ──────────────────────────────────────
// Firestore no conserva el orden de las claves de un mapa, así que para comparar contenido se
// ordenan recursivamente (los arreglos sí conservan su orden).
const canonico = v => (Array.isArray(v) ? v.map(canonico)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonico(v[k])]))
  : v);
const CAMPOS_CONTENIDO = ['nombre', 'alias', 'presentacion', 'requisitos', 'notas'];
const contenidoDe = o => canonico(Object.fromEntries(CAMPOS_CONTENIDO.map(k => [k, o[k]])));
const mismoContenido = (a, b) => JSON.stringify(contenidoDe(a)) === JSON.stringify(contenidoDe(b));

/**
 * existentes: Map id -> documento. Devuelve:
 *   nuevas       → obras sociales del borrador que la empresa todavía no tiene.
 *   actualizables → obras ya cargadas por la semilla que NUNCA se tocaron (borrador: true y sin
 *                   actualizadoEn: el PUT siempre deja actualizadoEn) y cuyo contenido difiere de
 *                   la versión actual. Todo lo que alguien editó o revisó queda como está.
 */
function planSemilla(existentes) {
  const nuevas = [], actualizables = [];
  for (const os of BORRADOR) {
    const ya = existentes.get(os.id);
    if (!ya) nuevas.push(os.id);
    else if (ya.borrador === true && !ya.actualizadoEn && !mismoContenido(ya, limpiarOS(os))) actualizables.push(os.id);
  }
  return { nuevas, actualizables };
}
const conNombre = ids => ids.map(id => ({ id, nombre: BORRADOR.find(o => o.id === id).nombre }));

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'requisitos_os').get();
    const obras = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    // Lo que la semilla cargaría o actualizaría: la pantalla ofrece el botón solo si hay algo.
    const plan = planSemilla(new Map(obras.map(o => [o.id, o])));
    res.json({ ok: true, obras, semilla: { nuevas: conNombre(plan.nuevas), actualizables: conNombre(plan.actualizables) } });
  } catch (e) { errHandler(res, req, e); }
});

// Carga los requisitos oficiales / el borrador inicial.
//   - Agrega las obras sociales que la empresa todavía no tiene.
//   - Actualiza solo las que la propia semilla cargó y nadie tocó desde entonces (borrador sin
//     editar). Así una empresa que cargó una versión anterior recibe los datos nuevos sin perder
//     nada propio. No pisa nada que se haya editado o marcado como revisado.
router.post('/semilla', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'requisitos_os');
    const snap = await ref.get();
    const existentes = new Map(snap.docs.map(d => [d.id, d.data()]));
    const { nuevas, actualizables } = planSemilla(existentes);
    const ahora = new Date().toISOString();
    for (const os of BORRADOR) {
      if (nuevas.includes(os.id)) {
        await ref.doc(os.id).set({ ...limpiarOS(os), id: os.id, borrador: true, creadoEn: ahora });
      } else if (actualizables.includes(os.id)) {
        // set() reemplaza el documento entero (no quedan campos de la versión anterior); se
        // conserva la fecha de creación original.
        await ref.doc(os.id).set({ ...limpiarOS(os), id: os.id, borrador: true, creadoEn: existentes.get(os.id).creadoEn || ahora });
      }
    }
    const creadas = nuevas.length, actualizadas = actualizables.length;
    const partes = [];
    if (creadas) partes.push(`${creadas} obra(s) social(es) cargadas`);
    if (actualizadas) partes.push(`${actualizadas} actualizada(s) con los requisitos oficiales`);
    res.json({ ok: true, creadas, actualizadas, mensaje: partes.length ? partes.join(' y ') + '.' : 'Ya estaban cargadas.' });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = limpiarOS(req.body);
    if (!data.nombre) return res.status(400).json({ ok: false, mensaje: 'Falta el nombre.' });
    const id = slug(data.nombre);
    const ref = col(req.tenantId, 'requisitos_os').doc(id);
    if ((await ref.get()).exists) return res.status(409).json({ ok: false, mensaje: 'Ya existe esa obra social.' });
    await ref.set({ ...data, id, creadoEn: new Date().toISOString() });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'requisitos_os').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    const data = limpiarOS(req.body);
    if (!data.nombre) return res.status(400).json({ ok: false, mensaje: 'Falta el nombre.' });
    await ref.update({ ...data, borrador: req.body.borrador === true, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'requisitos_os').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
module.exports.limpiarRequisitos = limpiarRequisitos;
module.exports.limpiarOS = limpiarOS;
module.exports.planSemilla = planSemilla;
