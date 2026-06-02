const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, fechaHoyAR, col, randomUUID } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[VENCIMIENTOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const calcEstado = (fechaVenc, diasAviso) => {
  const p = String(fechaVenc || '').split('/');
  if (p.length < 3) return { estado: 'SIN FECHA', diffDias: null };
  const y    = Number(p[2].length === 2 ? '20' + p[2] : p[2]);
  const fecha = new Date(y, Number(p[1]) - 1, Number(p[0]));
  const diff  = Math.round((fecha - new Date()) / (1000 * 60 * 60 * 24));
  const umbral = Number(diasAviso) || 30;
  const estado = diff < 0 ? 'VENCIDO' : diff <= umbral ? 'PROXIMO' : 'VIGENTE';
  return { estado, diffDias: diff };
};

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tipo, persona, estado, todos } = req.query;
    const snap = await col(req.tenantId, 'vencimientos').get();

    let resultado = snap.docs.map(d => {
      const doc = d.data();
      const { estado: est, diffDias } = calcEstado(doc.fechaVenc, doc.diasAviso);
      return {
        id:          doc.ID || d.id,
        tipo:        doc.tipo        || '',
        persona:     doc.persona     || '',
        descripcion: doc.descripcion || '',
        fechaVenc:   doc.fechaVenc   || '',
        diasAviso:   doc.diasAviso   || 30,
        notas:       doc.notas       || '',
        estado:      est,
        diffDias,
      };
    });

    // Exclude soft-deleted unless ?todos=true
    if (!todos) resultado = resultado.filter(r => r.estado !== 'ELIMINADO');

    if (tipo)    resultado = resultado.filter(r => normalizarText_(r.tipo).includes(normalizarText_(tipo)));
    if (persona) resultado = resultado.filter(r => normalizarText_(r.persona).includes(normalizarText_(persona)));
    if (estado)  resultado = resultado.filter(r => r.estado === estado.toUpperCase());

    resultado.sort((a, b) => {
      if (a.diffDias === null) return 1;
      if (b.diffDias === null) return -1;
      return a.diffDias - b.diffDias;
    });

    const proximos = resultado.filter(r => r.estado === 'VENCIDO' || r.estado === 'PROXIMO');
    res.json({ ok: true, vencimientos: resultado, proximos, total: resultado.length });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tipo, persona, descripcion, fechaVenc, diasAviso, notas } = req.body;
    const id = randomUUID();
    await col(req.tenantId, 'vencimientos').doc(id).set({
      ID: id, tipo: tipo || '', persona: persona || '',
      descripcion: descripcion || '', fechaVenc: fechaVenc || '',
      diasAviso: Number(diasAviso) || 30, notas: notas || '',
      estado: 'ACTIVO', creadoEn: new Date(),
    });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await col(req.tenantId, 'vencimientos').doc(req.params.id)
      .update({ ...req.body, actualizadoEn: new Date() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'vencimientos').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ estado: 'ELIMINADO' });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
