const router = require('express').Router();
const { db }  = require('../firebase');
const auth    = require('../middleware/authMiddleware');
const { col } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR asistencia]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── Asistencia legacy (colección 'asistencia') ─────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    let q = col(req.tenantId, 'asistencia');
    if (fecha) q = q.where('fecha', '==', fecha);
    const snap = await q.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/legacy', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'asistencia').add({ ...req.body, creadoEn: new Date() });
    res.json({ ok: true, id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/legacy/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'asistencia').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// ── Asistencia DIARIA (colección 'ASISTENCIA', doc ID: {fecha}_{choferId}) ──────
// GET  /api/asistencia/diaria?fecha=2026-06-04   → todos los choferes del día
// GET  /api/asistencia/diaria/:choferId?fecha=   → asignación de un chofer
// POST /api/asistencia/diaria                    → guardar/actualizar chofer+día
// DELETE /api/asistencia/diaria/:choferId?fecha= → eliminar

router.get('/diaria', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });

    const snap = await col(req.tenantId, 'ASISTENCIA').get();
    const asignaciones = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(d => d.fecha === fecha)
      .map(d => ({
        choferId:     d.choferId,
        choferNombre: d.choferNombre,
        beneficiarios: d.beneficiarios || [],
        confirmado:   d.confirmado !== false,
        creadoEn:     d.creadoEn || ''
      }))
      .sort((a, b) => (a.choferNombre || '').localeCompare(b.choferNombre || ''));

    res.json({ ok: true, fecha, asignaciones });
  } catch (e) { err(res, req, e); }
});

router.get('/diaria/:choferId', auth, async (req, res) => {
  try {
    const { choferId } = req.params;
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });

    const docId = `${fecha}_${choferId}`;
    const snap  = await col(req.tenantId, 'ASISTENCIA').doc(docId).get();
    if (!snap.exists) return res.json({ ok: true, existe: false, beneficiarios: [] });

    const d = snap.data();
    res.json({
      ok:           true,
      existe:       true,
      choferId:     d.choferId,
      choferNombre: d.choferNombre,
      beneficiarios: d.beneficiarios || [],
      confirmado:   d.confirmado !== false
    });
  } catch (e) { err(res, req, e); }
});

router.post('/diaria', auth, async (req, res) => {
  try {
    const { fecha, choferId, choferNombre, beneficiarios } = req.body;
    if (!fecha || !choferId) return res.status(400).json({ ok: false, mensaje: 'Faltan fecha o choferId.' });

    const docId = `${fecha}_${choferId}`;
    const doc = {
      fecha,
      choferId,
      choferNombre: choferNombre || choferId,
      beneficiarios: beneficiarios || [],
      confirmado: true,
      creadoEn: new Date().toISOString()
    };

    await col(req.tenantId, 'ASISTENCIA').doc(docId).set(doc);
    res.json({ ok: true, mensaje: `Asistencia guardada para ${fecha}.`, docId });
  } catch (e) { err(res, req, e); }
});

router.delete('/diaria/:choferId', auth, async (req, res) => {
  try {
    const { choferId } = req.params;
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });
    await col(req.tenantId, 'ASISTENCIA').doc(`${fecha}_${choferId}`).delete();
    res.json({ ok: true, mensaje: 'Asignación eliminada.' });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
