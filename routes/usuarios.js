const router = require('express').Router();
const { db, admin } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { normalizarText_, esAdmin, nombreUsuario, col } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR usuarios]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// Listar usuarios (admin)
router.get('/', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'usuarios').get();
    const usuarios = snap.docs.map(d => {
      const u = d.data();
      return {
        id: d.id,
        usuario:  u.usuario  || u.email?.split('@')[0] || u.nombre || '',
        email:    u.email    || '',
        nombre:   u.nombre   || u.usuario || '',
        clave:    '••••••',
        rol:      u.rol      || u.role    || 'chofer',
        activo:   u.activo !== false,
        vehiculo: u.vehiculo || ''
      };
    }).filter(u => u.usuario || u.email);
    res.json({ ok: true, usuarios });
  } catch (e) { err(res, req, e); }
});

// Listar choferes activos
router.get('/choferes', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'usuarios').get();
    const choferes = snap.docs.map(d => d.data())
      .filter(u => {
        const av = u.activo !== undefined ? u.activo : true;
        const estaActivo = av === true || av === 1 || String(av).toUpperCase() === 'SI';
        return (u.rol === 'chofer' || u.role === 'chofer') && estaActivo;
      })
      .map(u => ({
        usuario: u.nombre || u.usuario || (u.email ? u.email.split('@')[0] : ''),
        vehiculo: u.vehiculo || ''
      }));
    res.json({ ok: true, choferes });
  } catch (e) { err(res, req, e); }
});

// Perfil del usuario logueado
router.get('/perfil', auth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const doc = await col(req.tenantId, 'usuarios').doc(uid).get();
    if (!doc.exists) {
      return res.json({
        ok: true,
        usuario: nombreUsuario(req.user),
        rol: req.user?.rol || req.user?.role || 'chofer',
        vehiculo: ''
      });
    }
    const data = doc.data();
    res.json({
      ok: true,
      usuario: data.nombre || data.usuario || nombreUsuario(req.user),
      rol:     data.rol    || data.role    || 'chofer',
      vehiculo: data.vehiculo || ''
    });
  } catch (e) { err(res, req, e); }
});

// Actualizar vehículo del chofer logueado
router.put('/vehiculo', auth, async (req, res) => {
  try {
    const { vehiculo } = req.body;
    const uid = req.user.uid;
    await col(req.tenantId, 'usuarios').doc(uid).set({ vehiculo: String(vehiculo || '').trim() }, { merge: true });
    res.json({ ok: true, mensaje: 'Vehículo actualizado.' });
  } catch (e) { err(res, req, e); }
});

// Crear usuario (Firebase Auth + Firestore)
router.post('/', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const { email, password, nombre, rol, vehiculo } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, mensaje: 'Email y clave son obligatorios.' });

    const rolFinal = rol === 'admin' ? 'admin' : 'chofer';
    const userRecord = await admin.auth().createUser({ email, password, displayName: nombre || email.split('@')[0] });
    await admin.auth().setCustomUserClaims(userRecord.uid, { rol: rolFinal, tenantId: req.tenantId });
    await col(req.tenantId, 'usuarios').doc(userRecord.uid).set({
      uid: userRecord.uid, email, nombre: nombre || email.split('@')[0],
      rol: rolFinal, activo: true, vehiculo: vehiculo || '',
      tenantId: req.tenantId, creadoEn: new Date()
    });
    res.json({ ok: true, mensaje: `Usuario "${email}" creado correctamente.`, uid: userRecord.uid });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') return res.status(409).json({ ok: false, mensaje: 'El email ya existe.' });
    err(res, req, e);
  }
});

// Editar usuario
router.put('/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const { nombre, rol, activo, vehiculo, password } = req.body;
    const ref = col(req.tenantId, 'usuarios').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado.' });

    const updates = {};
    if (nombre    !== undefined) updates.nombre   = nombre;
    if (rol       !== undefined) updates.rol      = rol;
    if (activo    !== undefined) updates.activo   = !!activo;
    if (vehiculo  !== undefined) updates.vehiculo = vehiculo;

    await ref.update({ ...updates, actualizadoEn: new Date() });

    if (rol !== undefined) {
      try { await admin.auth().setCustomUserClaims(req.params.id, { rol, tenantId: req.tenantId }); } catch (eC) {}
    }
    if (password && password !== '••••••') {
      try { await admin.auth().updateUser(req.params.id, { password }); } catch (eP) {}
    }
    res.json({ ok: true, mensaje: 'Usuario actualizado.' });
  } catch (e) { err(res, req, e); }
});

// Eliminar usuario (desactivar)
router.delete('/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    if (req.params.id === req.user.uid) return res.status(400).json({ ok: false, mensaje: 'No podés eliminar tu propio usuario.' });
    await col(req.tenantId, 'usuarios').doc(req.params.id).update({ activo: false });
    res.json({ ok: true, mensaje: 'Usuario desactivado.' });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
