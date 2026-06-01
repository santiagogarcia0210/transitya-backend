const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { normalizarText_, esAdmin, fechaHoyAR, col, randomUUID } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR vencimientos]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', auth, async (req, res) => {
  try {
    const filtros = req.query;
    const snap = await col(req.tenantId, 'vencimientos').get();
    const todos = snap.docs.map(d => ({ _fsId: d.id, ...d.data() }));
    const hoy = new Date();

    let resultado = todos
      .filter(doc => doc.ID && (filtros.todos || (doc.estado || '').toUpperCase() !== 'ELIMINADO'))
      .map(doc => {
        const p = String(doc.fechaVenc || '').split('/');
        const fecha = p.length >= 3 ? new Date(Number(p[2].length === 2 ? '20' + p[2] : p[2]), Number(p[1]) - 1, Number(p[0])) : null;
        const diff  = fecha ? Math.round((fecha - hoy) / (1000 * 60 * 60 * 24)) : null;
        const estado = diff === null ? 'SIN FECHA' : diff < 0 ? 'VENCIDO' : diff <= 30 ? 'PROXIMO' : 'VIGENTE';
        return { id: doc.ID, tipo: doc.tipo, persona: doc.persona, descripcion: doc.descripcion, fechaVenc: doc.fechaVenc, diasAviso: doc.diasAviso, estado, notas: doc.notas, diffDias: diff };
      });

    if (filtros.tipo)    resultado = resultado.filter(r => normalizarText_(r.tipo).includes(normalizarText_(filtros.tipo)));
    if (filtros.persona) resultado = resultado.filter(r => normalizarText_(r.persona).includes(normalizarText_(filtros.persona)));
    if (filtros.estado)  resultado = resultado.filter(r => r.estado === filtros.estado);

    resultado.sort((a, b) => {
      if (a.diffDias === null) return 1;
      if (b.diffDias === null) return -1;
      return a.diffDias - b.diffDias;
    });

    const proximos = resultado.filter(r => r.estado === 'VENCIDO' || r.estado === 'PROXIMO');
    res.json({ ok: true, vencimientos: resultado, proximos, total: resultado.length });
  } catch (e) { err(res, req, e); }
});

router.post('/', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const data = req.body;
    const id = data.id || randomUUID();
    const doc = {
      ID: id, tipo: data.tipo || '', persona: data.persona || '',
      descripcion: data.descripcion || '', fechaVenc: data.fechaVenc || '',
      diasAviso: data.diasAviso || 30, estado: 'ACTIVO', notas: data.notas || '',
      timestamp: fechaHoyAR() + ' ' + new Date().toTimeString().slice(0, 5),
      creadoEn: new Date()
    };
    await col(req.tenantId, 'vencimientos').doc(id).set(doc);
    res.json({ ok: true, mensaje: data.id ? 'Vencimiento actualizado.' : 'Vencimiento guardado.', id });
  } catch (e) { err(res, req, e); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    await col(req.tenantId, 'vencimientos').doc(req.params.id).update({ ...req.body, actualizadoEn: new Date() });
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const ref = col(req.tenantId, 'vencimientos').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ estado: 'ELIMINADO' });
    res.json({ ok: true, mensaje: 'Vencimiento eliminado.' });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
