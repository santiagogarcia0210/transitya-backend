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

// ── ALERTAS CONFIG ────────────────────────────────────────────────────────────

router.get('/alertas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('empresas').doc(req.tenantId).get();
    const alertas = doc.exists ? (doc.data().alertas || {}) : {};
    res.json({ ok: true, alertas });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/alertas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { montoMaxEgreso, pctAusenciaMax, email, activo } = req.body;
    await db.collection('empresas').doc(req.tenantId).set(
      { alertas: { montoMaxEgreso, pctAusenciaMax, email, activo, actualizadoEn: new Date().toISOString() } },
      { merge: true }
    );
    res.json({ ok: true, mensaje: 'Configuración de alertas guardada' });
  } catch (e) { errHandler(res, req, e); }
});

// ── TRIGGERS (stubs — activar/desactivar desde el panel) ──────────────────────

router.post('/trigger-cierre', verifyToken, requireAdmin, async (req, res) => {
  try {
    await db.collection('empresas').doc(req.tenantId).set(
      { triggers: { cierreDia: { activo: true, actualizadoEn: new Date().toISOString() } } },
      { merge: true }
    );
    res.json({ ok: true, mensaje: 'Trigger de cierre diario activado ✓' });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/trigger-cierre', verifyToken, requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('empresas').doc(req.tenantId).get();
    const trigger = doc.exists ? (doc.data().triggers?.cierreDia || {}) : {};
    res.json({ ok: true, activo: !!trigger.activo, actualizadoEn: trigger.actualizadoEn || null });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/trigger-renovacion', verifyToken, requireAdmin, async (req, res) => {
  try {
    await db.collection('empresas').doc(req.tenantId).set(
      { triggers: { renovacionMes: { activo: true, actualizadoEn: new Date().toISOString() } } },
      { merge: true }
    );
    res.json({ ok: true, mensaje: 'Trigger de renovación mensual activado ✓' });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/whatsapp-ahora', verifyToken, requireAdmin, async (req, res) => {
  res.json({ ok: false, mensaje: 'Configurar CALLMEBOT_PHONE y CALLMEBOT_APIKEY en el servidor para activar WhatsApp' });
});

router.post('/probar-whatsapp', verifyToken, requireAdmin, async (req, res) => {
  res.json({ ok: false, mensaje: 'Configurar CALLMEBOT_PHONE y CALLMEBOT_APIKEY en el servidor para probar WhatsApp' });
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
