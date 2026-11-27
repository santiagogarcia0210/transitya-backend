const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, fechaHoyAR, col, randomUUID } = require('../utils');
const B = require('../utils/beneficiarios');

const errHandler = (res, req, e) => {
  console.error('[REGISTRO]', req.method, req.path, e.message);
  res.status(500).json({ ok: false, mensaje: `No se pudo completar la operación: ${e.message}` });
};

router.get('/', verifyToken, async (req, res) => {
  try {
    const { q, chofer, page, limit } = req.query;
    let items = (await B.cargarBeneficiarios(col, req.tenantId)).map(b => ({ ...b.data, id: b.id }));

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
    const h = await B.buscarDoc(col, req.tenantId, req.params.id);
    if (!h) return res.status(404).json({ ok: false, mensaje: 'No se encontró al paciente (se buscó en registro y en BENEFICIARIOS).' });
    res.json({ ok: true, registro: { ...h.snap.data(), id: req.params.id } });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = B.limpiarPayload(req.body);
    const nombre = B.normalizarBeneficiario('', data).nombre;
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Falta el nombre del paciente.' });
    const id = String((req.body || {})['ID'] || '').trim() || randomUUID();
    data['ID'] = id;
    await col(req.tenantId, 'registro').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const h = await B.buscarDoc(col, req.tenantId, req.params.id);
    if (!h) return res.status(404).json({ ok: false, mensaje: 'No se encontró al paciente (se buscó en registro y en BENEFICIARIOS).' });
    const data = B.limpiarPayload(req.body);
    if (!Object.keys(data).length) return res.status(400).json({ ok: false, mensaje: 'No llegó ningún dato para guardar.' });
    await h.ref.update({ ...data, actualizadoEn: new Date() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// POST /:id/baja must be before PUT /:id (different method, but kept explicit)
router.post('/:id/baja', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { observaciones } = req.body;
    const h = await B.buscarDoc(col, req.tenantId, req.params.id);
    if (!h) return res.status(404).json({ ok: false, mensaje: 'No se encontró al paciente (se buscó en registro y en BENEFICIARIOS).' });
    const ref = h.ref;
    const data = h.snap.data();
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
