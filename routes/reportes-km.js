const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { calcularResumenDiario, calcularResumenMensual } = require('../services/resumenDiario');

/* ── GET /api/reportes-km/resumen-diario?fecha=YYYY-MM-DD ────────────────── */

router.get('/resumen-diario', verifyToken, async (req, res) => {
  try {
    const fechaISO = (req.query.fecha || '').trim();
    if (!fechaISO || !/^\d{4}-\d{2}-\d{2}$/.test(fechaISO))
      return res.status(400).json({ ok: false, mensaje: 'Falta fecha en formato YYYY-MM-DD.' });

    const isAdmin   = req.user.rol === 'admin' || req.user.rol === 'administrador';
    const soloEmail = isAdmin ? null : (req.user.email || null);

    const resultado = await calcularResumenDiario(req.tenantId, fechaISO, soloEmail);
    resultado._logs.forEach(l => console.log(l));

    res.json({ ok: true, fecha: resultado.fecha, choferes: resultado.choferes });
  } catch (e) {
    console.error('[RESUMEN-DIARIO]', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

/* ── GET /api/reportes-km/resumen-mensual?mes=YYYY-MM ────────────────────── */

router.get('/resumen-mensual', verifyToken, async (req, res) => {
  try {
    const mesISO = (req.query.mes || '').trim();
    if (!mesISO || !/^\d{4}-\d{2}$/.test(mesISO))
      return res.status(400).json({ ok: false, mensaje: 'Falta mes en formato YYYY-MM.' });

    const isAdmin   = req.user.rol === 'admin' || req.user.rol === 'administrador';
    const soloEmail = isAdmin ? null : (req.user.email || null);

    const resultado = await calcularResumenMensual(req.tenantId, mesISO, soloEmail);
    resultado._logs.forEach(l => console.log(l));

    res.json({ ok: true, mes: resultado.mes, choferes: resultado.choferes });
  } catch (e) {
    console.error('[RESUMEN-MENSUAL]', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
