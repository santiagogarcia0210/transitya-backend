const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, col, randomUUID } = require('../utils');
const { calcEstado, normalizarDMY } = require('../helpers/fechas');

const errHandler = (res, req, e) => {
  console.error('[VENCIMIENTOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tipo, persona, estado, todos } = req.query;
    const snap = await col(req.tenantId, 'vencimientos').get();

    // Soft-delete: se filtra por el campo guardado, no por el estado calculado.
    let resultado = snap.docs
      .filter(d => todos || d.data().estado !== 'ELIMINADO')
      .map(d => {
      const doc = d.data();
      const { estado: est, diffDias } = calcEstado(doc.fechaVenc, doc.diasAviso);
      return {
        id:          doc.ID || d.id,
        tipo:        doc.tipo        || '',
        persona:     doc.persona     || '',
        descripcion: doc.descripcion || '',
        fechaVenc:   doc.fechaVenc   || '',
        chofer:      doc.chofer      || '',
        vehiculo:    doc.vehiculo    || '',
        diasAviso:   doc.diasAviso   || 30,
        notas:       doc.notas       || '',
        estado:      est,
        diffDias,
      };
    });

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
    const { tipo, persona, descripcion, diasAviso, notas } = req.body;
    // El frontend manda fechaVencimiento (yyyy-MM-dd); versiones viejas mandan fechaVenc (dd/MM/yyyy).
    const fechaVenc = normalizarDMY(req.body.fechaVenc || req.body.fechaVencimiento);
    const id = randomUUID();
    await col(req.tenantId, 'vencimientos').doc(id).set({
      ID: id, tipo: tipo || '', persona: persona || '',
      descripcion: descripcion || '', fechaVenc,
      diasAviso: Number(diasAviso) || 30, notas: notas || '',
      estado: 'ACTIVO', creadoEn: new Date(),
    });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { id: _id, estado: _estado, diffDias: _d, fechaVencimiento, ...datos } = req.body;
    if (datos.fechaVenc || fechaVencimiento) datos.fechaVenc = normalizarDMY(datos.fechaVenc || fechaVencimiento);
    if (datos.diasAviso !== undefined) datos.diasAviso = Number(datos.diasAviso) || 30;
    await col(req.tenantId, 'vencimientos').doc(req.params.id)
      .update({ ...datos, actualizadoEn: new Date() });
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
