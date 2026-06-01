const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { parseMonto_, normalizarText_, esMesDMY, fechaHoyAR, col, MESES, randomUUID } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[INGRESOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const fechaSort = (f) => {
  const p = String(f || '').split('/');
  if (p.length < 3) return 0;
  const y = p[2].length === 2 ? '20' + p[2] : p[2];
  return Number(`${y}${p[1].padStart(2, '0')}${p[0].padStart(2, '0')}`);
};

// GET /reporte-mensual must be before GET /:id
router.get('/reporte-mensual', verifyToken, requireAdmin, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const snap = await col(req.tenantId, 'ingresos').get();
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const filas = todos.filter(doc => {
      const estado = normalizarText_(doc.estado || doc.ESTADO || '');
      if (estado === 'presentado') return true;
      return esMesDMY(doc.fecha || doc.FECHA || '', m, y);
    });
    const total     = filas.reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0);
    const pagado    = filas.filter(r => normalizarText_(r.estado || r.ESTADO || '') === 'pagado')
                           .reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0);
    res.json({
      ok: true,
      filas,
      resumen: { mes: MESES[m - 1], anio: y, total, pagado, presentado: total - pagado, cantidad: filas.length },
    });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { q, page, limit, mes, anio, estado } = req.query;
    const snap = await col(req.tenantId, 'ingresos').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Always include PRESENTADO regardless of date; filter rest by mes/anio if given
    if (mes || anio) {
      const m = Number(mes)  || (new Date().getMonth() + 1);
      const y = Number(anio) || new Date().getFullYear();
      todos = todos.filter(doc => {
        const est = normalizarText_(doc.estado || doc.ESTADO || '');
        if (est === 'presentado') return true;
        return esMesDMY(doc.fecha || doc.FECHA || '', m, y);
      });
    }

    if (estado) {
      const en = normalizarText_(estado);
      todos = todos.filter(doc => normalizarText_(doc.estado || doc.ESTADO || '') === en);
    }

    if (q) {
      const qn = normalizarText_(q);
      todos = todos.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(qn));
    }

    todos.sort((a, b) => fechaSort(b.fecha || b.FECHA) - fechaSort(a.fecha || a.FECHA));

    const pp    = Math.max(1, parseInt(limit) || 50);
    const pg    = Math.max(1, parseInt(page) || 1);
    const total = todos.length;
    const resumen = {
      total:      todos.reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0),
      pagado:     todos.filter(r => normalizarText_(r.estado || r.ESTADO || '') === 'pagado')
                       .reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0),
      presentado: todos.filter(r => normalizarText_(r.estado || r.ESTADO || '') === 'presentado')
                       .reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0),
    };

    res.json({
      ok: true,
      resultados: todos.slice((pg - 1) * pp, pg * pp),
      total,
      pagina: pg,
      totalPaginas: Math.max(1, Math.ceil(total / pp)),
      resumen,
    });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = { ...req.body };
    const fecha = String(data.fecha || data.FECHA || '').trim();
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });
    const id = String(data.ID || data.id || '').trim() || randomUUID();
    data.ID     = id;
    data.ESTADO = String(data.estado || data.ESTADO || 'PRESENTADO').trim().toUpperCase();
    await col(req.tenantId, 'ingresos').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'INGRESO GUARDADO', id });
  } catch (e) { errHandler(res, req, e); }
});

// PATCH /:id/pagar must be before PUT /:id to avoid Express conflicts
router.patch('/:id/pagar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'ingresos').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    await ref.update({ ESTADO: 'PAGADO', estado: 'PAGADO', fechaPago: fechaHoyAR() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await col(req.tenantId, 'ingresos').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await col(req.tenantId, 'ingresos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
