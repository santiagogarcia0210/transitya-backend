const router = require('express').Router();
const { db, admin } = require('../firebase');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { nombreUsuario, col } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[USUARIOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
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
  } catch (e) { errHandler(res, req, e); }
});

router.get('/choferes', verifyToken, requireAdmin, async (req, res) => {
  try {
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
  } catch (e) { errHandler(res, req, e); }
});

router.get('/perfil', verifyToken, async (req, res) => {
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
  } catch (e) { errHandler(res, req, e); }
});

router.put('/vehiculo', verifyToken, async (req, res) => {
  try {
    const { vehiculo } = req.body;
    const uid = req.user.uid;
    await col(req.tenantId, 'usuarios').doc(uid).set({ vehiculo: String(vehiculo || '').trim() }, { merge: true });
    res.json({ ok: true, mensaje: 'Vehículo actualizado.' });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { email, password, nombre, rol, vehiculo, telefono, licencia } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, mensaje: 'Email y clave son obligatorios.' });

    const rolFinal = rol === 'admin' ? 'admin' : 'chofer';
    const userRecord = await admin.auth().createUser({ email, password, displayName: nombre || email.split('@')[0] });
    await admin.auth().setCustomUserClaims(userRecord.uid, { rol: rolFinal, tenantId: req.tenantId });
    await col(req.tenantId, 'usuarios').doc(userRecord.uid).set({
      uid: userRecord.uid, email, nombre: nombre || email.split('@')[0],
      rol: rolFinal, activo: true, vehiculo: vehiculo || '',
      telefono: telefono || '', licencia: licencia || '',
      tenantId: req.tenantId, creadoEn: new Date()
    });
    res.json({ ok: true, mensaje: `Usuario "${email}" creado correctamente.`, uid: userRecord.uid });
  } catch (e) {
    const FB_4XX = {
      'auth/email-already-exists': { status: 409, mensaje: 'El email ya existe.' },
      'auth/invalid-email':        { status: 400, mensaje: 'El email no tiene un formato válido.' },
      'auth/invalid-password':     { status: 400, mensaje: 'La contraseña debe tener al menos 6 caracteres.' },
    };
    const mapped = FB_4XX[e.code];
    if (mapped) return res.status(mapped.status).json({ ok: false, mensaje: mapped.mensaje });
    errHandler(res, req, e);
  }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { nombre, rol, activo, vehiculo, password, telefono, licencia } = req.body;
    const ref = col(req.tenantId, 'usuarios').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado.' });

    const updates = {};
    if (nombre   !== undefined) updates.nombre   = nombre;
    if (rol      !== undefined) updates.rol      = rol;
    if (activo   !== undefined) updates.activo   = !!activo;
    if (vehiculo !== undefined) updates.vehiculo = vehiculo;
    if (telefono !== undefined) updates.telefono = telefono;
    if (licencia !== undefined) updates.licencia = licencia;

    await ref.update({ ...updates, actualizadoEn: new Date() });

    if (rol !== undefined) {
      try { await admin.auth().setCustomUserClaims(req.params.id, { rol, tenantId: req.tenantId }); } catch (eC) {}
    }
    if (password && password !== '••••••') {
      try { await admin.auth().updateUser(req.params.id, { password }); } catch (eP) {}
    }
    res.json({ ok: true, mensaje: 'Usuario actualizado.' });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.uid) return res.status(400).json({ ok: false, mensaje: 'No podés eliminar tu propio usuario.' });
    try { await admin.auth().deleteUser(req.params.id); } catch (eAuth) {}
    await col(req.tenantId, 'usuarios').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
