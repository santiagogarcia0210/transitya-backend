const router = require('express').Router();
const { db, admin } = require('../firebase');
const { verifyToken } = require('../middleware/auth');
const { col } = require('../utils');
const { enviarBienvenida, enviarNotificacionInterna } = require('../helpers/mailer');

// Genera tenantId URL-safe a partir del nombre de la empresa
const toTenantId = (nombre) => {
  const base = nombre.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
};

// ── REGISTRO PÚBLICO — crea empresa + admin ───────────────────────────────────

router.post('/registro', async (req, res) => {
  try {
    const { email, password, nombreEmpresa, tipo, adminNombre, telefono } = req.body;

    if (!email || !password || !nombreEmpresa)
      return res.status(400).json({ ok: false, mensaje: 'Faltan campos obligatorios: email, password, nombreEmpresa.' });
    if (password.length < 6)
      return res.status(400).json({ ok: false, mensaje: 'La contraseña debe tener al menos 6 caracteres.' });

    const tipos = ['transporte_escolar', 'paqueteria', 'traslado'];
    const tipoFinal = tipos.includes(tipo) ? tipo : 'transporte_escolar';

    const tenantId = toTenantId(nombreEmpresa);

    // Crear usuario en Firebase Auth
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: adminNombre || nombreEmpresa,
    });

    // Setear custom claims
    await admin.auth().setCustomUserClaims(userRecord.uid, {
      rol: 'admin',
      tenantId,
      tipoEmpresa: tipoFinal,
    });

    const ahora = new Date().toISOString();
    const trialFin = new Date(Date.now() + 15 * 86400000).toISOString();

    // Crear doc de empresa
    await db.collection('empresas').doc(tenantId).set({
      nombre:      nombreEmpresa,
      tipo:        tipoFinal,
      email,
      telefono:    telefono || '',
      activo:      true,
      creadoEn:    ahora,
      planActivo:  false,
      trialFin,
    });

    // Crear doc del admin dentro de la empresa
    await col(tenantId, 'usuarios').doc(userRecord.uid).set({
      uid:      userRecord.uid,
      email,
      nombre:   adminNombre || nombreEmpresa,
      rol:      'admin',
      activo:   true,
      tenantId,
      creadoEn: ahora,
    });

    res.status(201).json({ ok: true, uid: userRecord.uid, tenantId, tipo: tipoFinal });

    // Fire-and-forget emails (no bloquea la respuesta al cliente)
    enviarBienvenida({ email, nombreEmpresa, tipo: tipoFinal })
      .catch(err => console.error('[MAILER] fallo envío', { template: 'bienvenida', to: email, error: err.message }));
    enviarNotificacionInterna({ email, nombreEmpresa, tipo: tipoFinal, tenantId })
      .catch(err => console.error('[MAILER] fallo envío', { template: 'notificacion-interna', to: process.env.SUPERADMIN_EMAIL || 'info@transitya.com', error: err.message }));
  } catch (e) {
    // Firebase devuelve códigos de error descriptivos
    if (e.code === 'auth/email-already-exists')
      return res.status(409).json({ ok: false, mensaje: 'Ya existe una cuenta con ese email.' });
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

// ── PERFIL DEL USUARIO AUTENTICADO ───────────────────────────────────────────

router.get('/me', verifyToken, async (req, res) => {
  try {
    const { tenantId, uid } = req.user;
    const doc = await col(tenantId, 'usuarios').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado.' });
    res.json({ ok: true, uid, tenantId, ...doc.data() });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
