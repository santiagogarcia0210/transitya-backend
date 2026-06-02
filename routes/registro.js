const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, fechaHoyAR, col, randomUUID } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[REGISTRO]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', verifyToken, async (req, res) => {
  try {
    const { q, chofer, page, limit } = req.query;
    const snap = await col(req.tenantId, 'registro').get();
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (q) {
      const qn = normalizarText_(q);
      items = items.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(qn));
    }
    if (chofer) {
      const cn = normalizarText_(chofer);
      items = items.filter(doc => normalizarText_(doc['CHOFER'] || '').includes(cn));
    }

    items.sort((a, b) =>
      String(a['APELLIDO Y NOMBRE'] || a['NOMBRE'] || '').localeCompare(
        String(b['APELLIDO Y NOMBRE'] || b['NOMBRE'] || '')
      )
    );

    const pp    = Math.max(1, parseInt(limit) || 50);
    const pg    = Math.max(1, parseInt(page)  || 1);
    const total = items.length;
    res.json({
      ok: true,
      resultados: items.slice((pg - 1) * pp, pg * pp),
      total,
      pagina: pg,
      totalPaginas: Math.max(1, Math.ceil(total / pp)),
    });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'registro').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    res.json({ ok: true, registro: { id: doc.id, ...doc.data() } });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = { ...req.body };
    const nombre = String(data['APELLIDO Y NOMBRE'] || data['NOMBRE'] || '').trim();
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Falta el nombre.' });
    const id = data['ID'] || randomUUID();
    data['ID'] = id;
    await col(req.tenantId, 'registro').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'registro').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ ...req.body, actualizadoEn: new Date() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// POST /:id/baja must be before PUT /:id (different method, but kept explicit)
router.post('/:id/baja', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { observaciones } = req.body;
    const ref  = col(req.tenantId, 'registro').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Beneficiario no encontrado.' });
    const data = snap.data();
    const baja = {
      ...data,
      'FECHA DE BAJA': fechaHoyAR(),
      'OBSERVACIONES': String(observaciones || '').trim(),
    };
    await col(req.tenantId, 'bajas').add(baja);
    await ref.delete();
    res.json({ ok: true, mensaje: 'Baja completada.' });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
