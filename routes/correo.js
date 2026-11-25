// Correo de la empresa: cada empresa conecta SU casilla desde la app (nada queda fijo en el código).
const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, normalizarText_ } = require('../utils');
const cripto = require('../helpers/cripto');
const { encriptar } = cripto;
const C = require('../services/correoClasificador');
const S = require('../services/correoSync');
const O = require('../services/correoOauth');

const errHandler = (res, req, e) => {
  console.error('[CORREO]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// Sin ENCRYPTION_KEY válida no se puede guardar ni leer la contraseña de la casilla,
// así que el módulo entero queda deshabilitado con 503 (Service Unavailable): es un
// problema de configuración del servidor, no del cliente. El resto del backend
// arranca y funciona normal. Va antes de las rutas para que aplique a todas.
router.use((req, res, next) => {
  if (cripto.disponible()) return next();
  console.error('[CORREO] 503 deshabilitado:', req.method, req.path, '—', cripto.motivoNoDisponible());
  res.status(503).json({
    ok: false,
    codigo: 'CORREO_DESHABILITADO',
    mensaje: 'El módulo de correo está deshabilitado porque falta configurar el cifrado en el servidor. Avisale a soporte.',
  });
});

const ESTADOS = new Set(['NUEVO', 'VISTO', 'RESUELTO']);

function datosConexion(b, previo = {}) {
  const user = String(b.user || previo.user || '').trim().toLowerCase();
  const host = String(b.host || previo.host || '').trim().toLowerCase();
  const port = Number(b.port || previo.port || 993);
  return { user, host, port, secure: b.secure !== undefined ? b.secure !== false : previo.secure !== false, proveedor: String(b.proveedor || previo.proveedor || 'otro') };
}

function vistaConfig(cfg) {
  if (!cfg) return { conectado: false, tipo: '', requiereReconexion: false, carpetas: [S.CARPETA_DEFAULT], carpetasPendientes: [], iaDisponible: !!process.env.ANTHROPIC_API_KEY, reglas: C.REGLAS_DEFAULT, categorias: C.CATEGORIAS };
  // Lista blanca explícita: passEnc y refreshTokenEnc NO salen nunca de acá.
  return {
    conectado: true, user: cfg.user, host: cfg.host, port: cfg.port, secure: cfg.secure !== false,
    tipo: cfg.tipo === 'oauth' ? 'oauth' : 'password',
    // Configs anteriores a las carpetas se leen migradas (INBOX), sin tocar Firestore.
    carpetas: S.leerCarpetas(cfg).carpetas, carpetasPendientes: S.carpetasPendientes(cfg),
    requiereReconexion: cfg.requiereReconexion === true,
    proveedor: cfg.proveedor || 'otro', activo: cfg.activo !== false, usarIA: cfg.usarIA !== false,
    ultimaSync: cfg.ultimaSync || '', error: cfg.error || '', aviso: cfg.aviso || '', stats: cfg.stats || null,
    reglas: C.limpiarReglas(cfg.reglas || C.REGLAS_DEFAULT),
    iaDisponible: !!process.env.ANTHROPIC_API_KEY, categorias: C.CATEGORIAS,
  };
}

router.get('/config', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await S.refConfig(req.tenantId).get();
    res.json({ ok: true, ...vistaConfig(snap.exists ? snap.data() : null) });
  } catch (e) { errHandler(res, req, e); }
});

// Conectar o cambiar la casilla. Prueba el login antes de guardar.
// Si no se manda contraseña y ya había una guardada para el mismo usuario, se reutiliza.
router.post('/config', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = S.refConfig(req.tenantId);
    const snap = await ref.get();
    const previo = snap.exists ? snap.data() : {};
    const con = datosConexion(req.body, previo);
    if (!con.user || !con.host) return res.status(400).json({ ok: false, mensaje: 'Completá el mail y el servidor.' });
    let pass = String(req.body.pass || '').replace(/\s+/g, '');
    let passEnc = '';
    if (pass) passEnc = encriptar(pass);
    else if (previo.passEnc && previo.user === con.user) {
      passEnc = previo.passEnc;
      pass = require('../helpers/cripto').desencriptar(previo.passEnc);
    } else return res.status(400).json({ ok: false, mensaje: 'Falta la contraseña.' });

    const prueba = await S.probarConexion({ ...con, pass });
    if (!prueba.ok) return res.status(400).json({ ok: false, mensaje: prueba.mensaje });

    const cambioCasilla = previo.user && (previo.user !== con.user || previo.host !== con.host);
    await ref.set({
      ...previo, ...con, passEnc, activo: true, error: '',
      // Pasar a contraseña de aplicación descarta la vinculación OAuth anterior.
      tipo: 'password', refreshTokenEnc: '', requiereReconexion: false,
      usarIA: previo.usarIA !== false,
      reglas: previo.reglas || C.REGLAS_DEFAULT,
      // Casilla nueva → arranca de cero (últimos 30 días).
      ...(cambioCasilla || !previo.user ? S.reinicioCarpetas() : {}),
      conectadoEn: previo.conectadoEn || new Date().toISOString(), actualizadoEn: new Date().toISOString(),
    });
    res.json({ ok: true, mensajes: prueba.mensajes });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/config', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = S.refConfig(req.tenantId);
    // Si estaba vinculada por OAuth, se intenta revocar el permiso en el proveedor
    // antes de borrar el token. Si no se puede (Microsoft no expone endpoint de
    // revocación), se borra igual: lo importante es no quedarnos el refresh token.
    let revocado = null;
    try {
      const snap = await ref.get();
      const cfg = snap.exists ? snap.data() : null;
      if (cfg && cfg.tipo === 'oauth' && cfg.refreshTokenEnc) {
        const r = await O.revocar({
          proveedor: cfg.proveedor,
          refreshToken: cripto.desencriptar(cfg.refreshTokenEnc),
        });
        revocado = r.ok;
      }
    } catch (e) {
      console.warn('[CORREO] no se pudo revocar el permiso:', e.message);
      revocado = false;
    }
    await ref.delete();
    if (req.query.borrarMails === 'true') {
      const snap = await col(req.tenantId, 'correo_mails').get();
      await Promise.all(snap.docs.map(d => d.ref.delete()));
    }
    res.json({ ok: true, revocado });
  } catch (e) { errHandler(res, req, e); }
});

// Carpetas de la casilla conectada, marcando cuáles se revisan.
router.get('/carpetas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const r = await S.listarCarpetas(req.tenantId);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, mensaje: r.mensaje, requiereReconexion: !!r.requiereReconexion });
    res.json({ ok: true, carpetas: r.carpetas, seleccionadas: r.seleccionadas, pendientes: r.pendientes });
  } catch (e) { errHandler(res, req, e); }
});

// Guarda qué carpetas se revisan. Valida que existan en la casilla.
router.put('/config/carpetas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const r = await S.guardarCarpetas(req.tenantId, req.body && req.body.carpetas);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, mensaje: r.mensaje });
    res.json({ ok: true, carpetas: r.carpetas, nuevas: r.nuevas });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/reglas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = S.refConfig(req.tenantId);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'Primero conectá el correo.' });
    const upd = { reglas: C.limpiarReglas(req.body.reglas || req.body) };
    if (req.body.usarIA !== undefined) upd.usarIA = req.body.usarIA !== false;
    if (req.body.activo !== undefined) upd.activo = req.body.activo !== false;
    await ref.update(upd);
    res.json({ ok: true, reglas: upd.reglas });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/sincronizar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const r = await S.sincronizarEmpresa(req.tenantId);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { errHandler(res, req, e); }
});

// Vuelve a revisar los últimos 30 días (útil después de cambiar las reglas). No duplica.
// Body opcional { carpetas: [...] }: solo esas (útil para las recién agregadas). Sin body, todas.
router.post('/reescanear', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = S.refConfig(req.tenantId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Primero conectá el correo.' });
    const cfg = snap.data();
    const { carpetas } = S.leerCarpetas(cfg);
    const pedidas = Array.isArray(req.body && req.body.carpetas) ? req.body.carpetas.map(S.nombreCarpeta) : null;
    const objetivo = pedidas ? pedidas.filter(c => carpetas.includes(c)) : carpetas;
    if (!objetivo.length) return res.status(400).json({ ok: false, mensaje: 'Esas carpetas no están entre las que se revisan.' });
    await ref.update({ carpetas, estadoCarpetas: S.estadoParaReescanear(cfg, objetivo) });
    const r = await S.sincronizarEmpresa(req.tenantId);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { errHandler(res, req, e); }
});

router.get('/mails', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { estado, categoria, q, pacienteId } = req.query;
    const snap = await col(req.tenantId, 'correo_mails').get();
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data(), carpeta: d.data().carpeta || S.CARPETA_DEFAULT }));
    const contadores = {
      NUEVO: todos.filter(m => m.estado === 'NUEVO').length,
      ACCION: todos.filter(m => m.requiereAccion && m.estado !== 'RESUELTO').length,
      RESUELTO: todos.filter(m => m.estado === 'RESUELTO').length,
      total: todos.length,
      porCategoria: Object.fromEntries(Object.keys(C.CATEGORIAS).map(k => [k, todos.filter(m => m.categoria === k && m.estado !== 'RESUELTO').length])),
    };
    let mails = todos;
    if (estado === 'ACCION') mails = mails.filter(m => m.requiereAccion && m.estado !== 'RESUELTO');
    else if (estado === 'PENDIENTES') mails = mails.filter(m => m.estado !== 'RESUELTO');
    else if (ESTADOS.has(estado)) mails = mails.filter(m => m.estado === estado);
    if (categoria) mails = mails.filter(m => m.categoria === categoria);
    if (pacienteId) mails = mails.filter(m => m.pacienteId === pacienteId);
    if (q) {
      const qn = normalizarText_(q);
      mails = mails.filter(m => normalizarText_(`${m.asunto} ${m.de} ${m.deNombre} ${m.resumen} ${m.pacienteNombre} ${m.extracto}`).includes(qn));
    }
    mails.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    res.json({ ok: true, mails: mails.slice(0, 300), contadores, categorias: C.CATEGORIAS });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/mails/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'correo_mails').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    const upd = { actualizadoEn: new Date().toISOString() };
    if (ESTADOS.has(req.body.estado)) upd.estado = req.body.estado;
    if (C.CATEGORIAS[req.body.categoria]) upd.categoria = req.body.categoria;
    if (req.body.nota !== undefined) upd.nota = String(req.body.nota || '').slice(0, 500);
    await ref.update(upd);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// "No es de trabajo": se borra y, si se pide, el remitente pasa a la lista de ignorados.
router.post('/mails/:id/no-es-trabajo', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'correo_mails').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    const de = snap.data().de;
    await ref.delete();
    if (req.body.ignorarRemitente && de) {
      const cfgRef = S.refConfig(req.tenantId);
      const cfg = await cfgRef.get();
      if (cfg.exists) {
        const reglas = C.limpiarReglas(cfg.data().reglas || C.REGLAS_DEFAULT);
        reglas.ignorar = [...new Set([...reglas.ignorar, de])];
        reglas.trabajo = reglas.trabajo.filter(x => x !== de);
        await cfgRef.update({ reglas });
      }
    }
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// "Siempre es de trabajo": agrega el remitente a la lista de trabajo.
router.post('/mails/:id/remitente-trabajo', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'correo_mails').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    const cfgRef = S.refConfig(req.tenantId);
    const cfg = await cfgRef.get();
    if (!cfg.exists) return res.status(404).json({ ok: false, mensaje: 'Primero conectá el correo.' });
    const reglas = C.limpiarReglas(cfg.data().reglas || C.REGLAS_DEFAULT);
    const de = snap.data().de;
    reglas.trabajo = [...new Set([...reglas.trabajo, de])];
    reglas.ignorar = reglas.ignorar.filter(x => x !== de);
    await cfgRef.update({ reglas });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
