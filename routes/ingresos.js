const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { esAdmin, parseMonto_, normalizarText_, esMesDMY, col, MESES, randomUUID } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR ingresos]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const { termino, pagina } = req.query;
    const snap = await col(req.tenantId, 'ingresos').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (termino) {
      const q = normalizarText_(termino);
      todos = todos.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(q));
    }
    const pp = 50;
    const pg = Math.max(1, Number(pagina) || 1);
    res.json({ ok: true, resultados: todos.slice((pg - 1) * pp, pg * pp), total: todos.length, pagina: pg, paginas: Math.max(1, Math.ceil(todos.length / pp)) });
  } catch (e) { err(res, req, e); }
});

router.post('/', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const data = { ...req.body };
    if (!String(data['FECHA'] || '').trim()) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });
    const id = String(data['ID'] || '').trim() || randomUUID();
    data['ID']     = id;
    data['ESTADO'] = String(data['ESTADO'] || 'PRESENTADO').trim().toUpperCase();
    await col(req.tenantId, 'ingresos').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'INGRESO GUARDADO', id });
  } catch (e) { err(res, req, e); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    await col(req.tenantId, 'ingresos').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.put('/:id/pagar', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const ref = col(req.tenantId, 'ingresos').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    const doc = snap.data();
    doc['ESTADO'] = 'PAGADO';
    await ref.set(doc);
    res.json({ ok: true, mensaje: 'Factura marcada como PAGADA.' });
  } catch (e) { err(res, req, e); }
});

router.get('/reporte-mensual', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const snap = await col(req.tenantId, 'ingresos').get();
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const filas = todos.filter(doc => {
      const est = normalizarText_(doc['ESTADO'] || '');
      if (est === 'presentado') return true;
      return esMesDMY(doc['FECHA'] || '', m, y);
    });
    const total      = filas.reduce((s, r) => s + parseMonto_(r['MONTO'] || 0), 0);
    const pagado     = filas.filter(r => normalizarText_(r['ESTADO'] || '') === 'pagado').reduce((s, r) => s + parseMonto_(r['MONTO'] || 0), 0);
    res.json({
      ok: true, filas,
      resumen: { mes: MESES[m - 1], anio: y, total, pagado, presentado: total - pagado, cantidad: filas.length }
    });
  } catch (e) { err(res, req, e); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    await col(req.tenantId, 'ingresos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
