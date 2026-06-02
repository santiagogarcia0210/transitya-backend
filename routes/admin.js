const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { fechaHoyAR, col } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[ADMIN]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const COLECCIONES_PRINCIPALES = [
  'registro', 'egresos', 'ingresos', 'reportes',
  'remitos', 'vencimientos', 'usuarios',
];

// ── SALUD DEL SISTEMA ─────────────────────────────────────────────────────────

router.get('/salud', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tenantId } = req;

    const snaps = await Promise.all(
      COLECCIONES_PRINCIPALES.map(c => col(tenantId, c).get())
    );
    const colecciones = {};
    COLECCIONES_PRINCIPALES.forEach((c, i) => { colecciones[c] = snaps[i].size; });

    let ultimaUbicacion = null;
    try {
      const ubSnap = await col(tenantId, 'ubicaciones').get();
      let mas = null;
      ubSnap.docs.forEach(d => {
        const ts = d.data().timestamp || '';
        if (!mas || ts > mas.timestamp) mas = { usuario: d.data().usuario || d.id, timestamp: ts };
      });
      ultimaUbicacion = mas;
    } catch (eUb) {}

    res.json({
      ok: true, colecciones, ultimaUbicacion, fechaConsulta: fechaHoyAR(),
    });
  } catch (e) { errHandler(res, req, e); }
});

// ── BACKUP ────────────────────────────────────────────────────────────────────

router.post('/backup', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tenantId } = req;
    const fecha         = fechaHoyAR().replace(/\//g, '-');
    const nombreArchivo = `backup_${tenantId}_${fecha}.json`;

    const snaps = await Promise.all(
      COLECCIONES_PRINCIPALES.map(c => col(tenantId, c).get())
    );
    const exportData = { tenantId, generadoEn: new Date().toISOString(), colecciones: {} };
    COLECCIONES_PRINCIPALES.forEach((c, i) => {
      exportData.colecciones[c] = snaps[i].docs.map(d => ({ _id: d.id, ...d.data() }));
    });

    res.setHeader('Content-Disposition', `attachment; filename=${nombreArchivo}`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(exportData, null, 2));
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
