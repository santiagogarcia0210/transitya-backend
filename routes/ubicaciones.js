const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { esAdmin, nombreUsuario, fechaHoyAR, col } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR ubicaciones]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// Registrar ubicación del usuario logueado
router.post('/', auth, async (req, res) => {
  try {
    const { lat, lng, precision } = req.body;
    const usuario = nombreUsuario(req.user);
    const ahora = new Date();
    const ts    = ahora.toISOString();
    const fecha = fechaHoyAR();
    const hora  = ahora.toTimeString().slice(0, 8);

    const docData = {
      usuario, rol: req.user?.rol || req.user?.role || 'chofer',
      lat, lng, precision: precision || 0,
      timestamp: ts, fecha, hora, actualizadoEn: ahora
    };

    // Actualizar posición actual (por usuario, usando uid para unicidad)
    await col(req.tenantId, 'ubicaciones').doc(req.user.uid || usuario).set(docData);
    // Historial
    await col(req.tenantId, 'ubicaciones_hist').add({ usuario, lat, lng, timestamp: ts, fecha, hora });
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// Registrar ubicación nativa (GPS Android, sin auth tradicional pero con uid en body)
router.post('/nativa', async (req, res) => {
  try {
    const { chofer, lat, lng, velocidad, tenantId } = req.body;
    if (!tenantId || !chofer) return res.status(400).json({ ok: false, mensaje: 'Faltan datos.' });
    const doc = { chofer, lat, lng, velocidad: velocidad || 0, timestamp: new Date().toISOString() };
    await db.collection('empresas').doc(tenantId).collection('ubicaciones').doc(chofer).set(doc);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// Obtener ubicaciones actuales de todos los choferes (admin)
router.get('/', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'ubicaciones').get();
    const ahora = new Date();
    const ubicaciones = snap.docs.map((d, idx) => {
      const data = d.data();
      if (!data.lat || !data.lng) return null;
      const ts      = data.timestamp ? new Date(data.timestamp) : null;
      const diffMin = ts ? Math.round((ahora - ts) / 60000) : null;
      const hace    = diffMin === null ? 'Sin datos' : diffMin < 1 ? 'Hace menos de 1 min' : diffMin < 60 ? `Hace ${diffMin} min` : `Hace ${Math.round(diffMin / 60)} h`;
      const nombre  = data.nombre || (data.usuario && !data.usuario.includes('@') ? data.usuario : (data.usuario ? data.usuario.split('@')[0] : ''));
      return { usuario: nombre, rol: data.rol, lat: Number(data.lat), lng: Number(data.lng), timestamp: (data.fecha || '') + ' ' + (data.hora || ''), hace, diffMin, colorIdx: idx };
    }).filter(Boolean);
    res.json({ ok: true, ubicaciones });
  } catch (e) { err(res, req, e); }
});

// Historial de ubicaciones de un usuario para hoy
router.get('/historial/:usuario', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const hoy = fechaHoyAR();
    const snap = await col(req.tenantId, 'ubicaciones_hist')
      .where('usuario', '==', req.params.usuario)
      .where('fecha', '==', hoy)
      .orderBy('hora', 'asc')
      .limit(200)
      .get();
    const puntos = snap.docs.map(d => d.data()).filter(d => d.lat && d.lng).map(d => ({
      lat: Number(d.lat), lng: Number(d.lng), hora: d.hora || '', ts: d.timestamp || ''
    }));
    res.json({ ok: true, puntos, usuario: req.params.usuario, fecha: hoy });
  } catch (e) { err(res, req, e); }
});

// PUT legacy (compatibilidad con versión anterior)
router.put('/:usuario', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'ubicaciones').doc(req.params.usuario).set({ ...req.body, actualizadoEn: new Date() }, { merge: true });
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
