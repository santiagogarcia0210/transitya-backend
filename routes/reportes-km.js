const router = require('express').Router();
const { verifyToken }           = require('../middleware/auth');
const { calcularResumenDiario } = require('../services/resumenDiario');

/* ── GET /api/reportes-km/resumen-diario?fecha=YYYY-MM-DD ─────────────────── */

router.get('/resumen-diario', verifyToken, async (req, res) => {
  try {
    const fechaISO = (req.query.fecha || '').trim();
    if (!fechaISO || !/^\d{4}-\d{2}-\d{2}$/.test(fechaISO))
      return res.status(400).json({ ok: false, mensaje: 'Falta fecha en formato YYYY-MM-DD.' });

    const isAdmin  = req.user.rol === 'admin' || req.user.rol === 'administrador';
    const soloEmail = isAdmin ? null : (req.user.email || null);

    const resultado = await calcularResumenDiario(req.tenantId, fechaISO, soloEmail);

    // Emitir logs internos al servidor (debug)
    resultado._logs.forEach(l => console.log(l));

    res.json({ ok: true, fecha: resultado.fecha, choferes: resultado.choferes });
  } catch (e) {
    console.error('[RESUMEN-DIARIO]', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
