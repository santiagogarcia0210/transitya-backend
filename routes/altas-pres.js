const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, col, randomUUID } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[ALTAS-PRES]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { q, page, limit } = req.query;
    const snap = await col(req.tenantId, 'altas_pres').get();
    let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (q) {
      const qn = normalizarText_(q);
      docs = docs.filter(d => normalizarText_(Object.values(d).join(' ')).includes(qn));
    }

    docs.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));

    const pp    = Math.max(1, parseInt(limit) || 50);
    const pg    = Math.max(1, parseInt(page)  || 1);
    const total = docs.length;
    res.json({
      ok: true,
      registros: docs.slice((pg - 1) * pp, pg * pp),
      total, pagina: pg, totalPaginas: Math.max(1, Math.ceil(total / pp)),
      headers: docs[0] ? Object.keys(docs[0]).filter(k => !k.startsWith('_')) : [],
    });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'altas_pres').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    res.json({ ok: true, registro: { id: doc.id, ...doc.data() } });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const id  = randomUUID();
    const doc = { ...req.body, id, creadoEn: new Date().toISOString() };
    await col(req.tenantId, 'altas_pres').doc(id).set(doc);
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'altas_pres').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ ...req.body, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'altas_pres').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
