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

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'requisitos_os').get();
    const obras = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    res.json({ ok: true, obras });
  } catch (e) { errHandler(res, req, e); }
});

// Carga el borrador inicial. No pisa obras sociales que ya existan.
router.post('/semilla', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'requisitos_os');
    let creadas = 0;
    for (const os of BORRADOR) {
      const doc = ref.doc(os.id);
      if ((await doc.get()).exists) continue;
      await doc.set({ ...limpiarOS(os), id: os.id, borrador: true, creadoEn: new Date().toISOString() });
      creadas++;
    }
    res.json({ ok: true, creadas, mensaje: creadas ? `${creadas} obra(s) social(es) cargadas.` : 'Ya estaban cargadas.' });
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
