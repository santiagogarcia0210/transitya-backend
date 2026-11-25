// Rutas de vinculación por OAuth del módulo Correo.
//
// Va en un router aparte, montado en /api/correo/oauth ANTES de /api/correo, porque
// el callback es una redirección del navegador: si cayera en el guard 503 de
// routes/correo.js, el usuario vería un JSON crudo en la pantalla. Acá el callback
// siempre redirige al dashboard con ?conectado=1 o ?error=<codigo>.
const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const cripto = require('../helpers/cripto');
const O = require('../services/correoOauth');
const S = require('../services/correoSync');
const C = require('../services/correoClasificador');

/** Redirección al dashboard. Nunca lleva texto del proveedor, solo un código nuestro. */
const volver = (res, params) => res.redirect(302, O.urlDashboard(params));
const volverError = (res, codigo) => volver(res, 'error=' + encodeURIComponent(codigo));

/* ── Qué proveedores están disponibles ─────────────────────────────────── */

router.get('/proveedores', verifyToken, requireAdmin, async (req, res) => {
  try {
    // Si no hay cifrado no se puede guardar el refresh token: se informa como
    // "nada habilitado" en lugar de ofrecer botones que van a fallar.
    const cifrado = cripto.disponible();
    const lista = cifrado
      ? await O.listarProveedoresParaEmpresa(req.tenantId)
      : O.listarProveedores().map(p => ({ ...p, habilitado: false }));
    res.json({ ok: true, cifradoDisponible: cifrado, proveedores: lista });
  } catch (e) {
    console.error('[CORREO-OAUTH] proveedores:', e.message);
    // Ante un error se responde "ninguno habilitado": la pantalla cae en la
    // contraseña de aplicación y sigue siendo usable.
    res.json({
      ok: true,
      cifradoDisponible: cripto.disponible(),
      proveedores: O.listarProveedores().map(p => ({ ...p, habilitado: false })),
    });
  }
});

/* ── Paso 1: armar la URL de autorización ──────────────────────────────── */

router.post('/:proveedor/iniciar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const proveedor = String(req.params.proveedor || '').toLowerCase();
    if (!O.PROVEEDORES[proveedor]) {
      return res.status(400).json({ ok: false, codigo: O.CODIGOS.PROVEEDOR, mensaje: 'Proveedor desconocido.' });
    }
    if (!cripto.disponible()) {
      return res.status(503).json({
        ok: false,
        codigo: O.CODIGOS.CIFRADO,
        mensaje: 'El módulo de correo está deshabilitado porque falta configurar el cifrado en el servidor. Avisale a soporte.',
      });
    }
    if (!O.estaHabilitado(proveedor)) {
      return res.status(400).json({
        ok: false,
        codigo: O.CODIGOS.DESHABILITADO,
        mensaje: 'Ese proveedor no está configurado en el servidor. Podés conectar con contraseña de aplicación.',
      });
    }
    // La habilitación por empresa se valida también acá, no solo escondiendo el
    // botón: si no, cualquiera con token de admin podría llamar este endpoint.
    if (!(await O.habilitadoParaEmpresa(proveedor, req.tenantId))) {
      return res.status(403).json({
        ok: false,
        codigo: O.CODIGOS.NO_HABILITADO_EMPRESA,
        mensaje: 'La conexión con ese proveedor todavía no está habilitada para tu empresa. Podés conectar con contraseña de aplicación.',
      });
    }

    const { state, nonce, exp } = O.firmarState({ tenantId: req.tenantId, uid: req.user?.uid || '', proveedor });
    const { verifier, challenge } = O.generarPkce();
    await O.guardarState({ tenantId: req.tenantId, uid: req.user?.uid || '', proveedor, nonce, exp, verifier });
    // Oportunista: saca los states viejos de esta empresa para que no se acumulen.
    O.limpiarStates(req.tenantId).catch(() => {});

    const url = O.urlAutorizacion({
      proveedor,
      state,
      challenge,
      // Prellenar el selector de cuenta con el mail del admin logueado, si no mandan otro.
      loginHint: String(req.body?.loginHint || req.user?.email || '').trim().toLowerCase(),
    });
    res.json({ ok: true, url, vence: new Date(exp).toISOString() });
  } catch (e) {
    // El mensaje de error puede venir de cripto o de Firestore: no incluye tokens.
    console.error('[CORREO-OAUTH] iniciar:', e.message);
    res.status(500).json({ ok: false, codigo: O.CODIGOS.INTERNO, mensaje: 'No se pudo iniciar la vinculación.' });
  }
});

/* ── Paso 2: callback del proveedor (sin Bearer: lo abre el navegador) ─── */

router.get('/:proveedor/callback', async (req, res) => {
  const proveedor = String(req.params.proveedor || '').toLowerCase();
  try {
    if (!O.PROVEEDORES[proveedor]) return volverError(res, O.CODIGOS.PROVEEDOR);
    if (!cripto.disponible()) return volverError(res, O.CODIGOS.CIFRADO);

    // El usuario puede haber apretado "Cancelar" en la pantalla del proveedor.
    if (req.query.error) return volverError(res, O.CODIGOS.DENEGADO);

    const code = String(req.query.code || '');
    if (!code) return volverError(res, O.CODIGOS.STATE);

    // 1) Firma y vencimiento del state.
    const v = O.verificarState(req.query.state);
    if (!v.ok) return volverError(res, v.codigo);
    const { tenantId, proveedor: provState, nonce } = v.datos;
    if (provState !== proveedor) return volverError(res, O.CODIGOS.STATE);

    // 2) La habilitación puede haberse apagado mientras el usuario estaba en la
    // pantalla del proveedor: se vuelve a chequear antes de guardar nada.
    if (!(await O.habilitadoParaEmpresa(proveedor, tenantId))) {
      return volverError(res, O.CODIGOS.NO_HABILITADO_EMPRESA);
    }

    // 3) Un solo uso: consumir el nonce en transacción.
    const consumo = await O.consumirState({ tenantId, proveedor, nonce });
    if (!consumo.ok) return volverError(res, consumo.codigo);

    // 4) Code por tokens.
    const tok = await O.intercambiarCode({ proveedor, code, verifier: consumo.verifier });
    if (!tok.ok) return volverError(res, tok.codigo);
    if (!tok.datos.refreshToken) {
      // Sin refresh token no se puede sincronizar más adelante.
      return volverError(res, O.CODIGOS.SIN_REFRESH);
    }

    // 5) Mail de la cuenta que se acaba de autorizar.
    const user = await O.obtenerMail({
      proveedor,
      idToken: tok.datos.idToken,
      accessToken: tok.datos.accessToken,
    });
    if (!user) return volverError(res, O.CODIGOS.MAIL);

    // 6) Probar IMAP antes de guardar, para no dejar una casilla "conectada" que falla.
    const imap = O.PROVEEDORES[proveedor].imap;
    const prueba = await S.probarConexion({ ...imap, user, accessToken: tok.datos.accessToken });
    if (!prueba.ok) {
      console.warn('[CORREO-OAUTH]', proveedor, 'IMAP rechazó la cuenta recién vinculada.');
      return volverError(res, O.CODIGOS.IMAP);
    }

    // 7) Guardar. El refresh token va cifrado; el access token no se persiste.
    const ref = S.refConfig(tenantId);
    const snap = await ref.get();
    const previo = snap.exists ? snap.data() : {};
    const cambioCasilla = previo.user && previo.user !== user;

    await ref.set({
      ...previo,
      tipo: 'oauth',
      proveedor,
      user,
      host: imap.host,
      port: imap.port,
      secure: true,
      refreshTokenEnc: cripto.encriptar(tok.datos.refreshToken),
      // Al pasar a OAuth se descarta la contraseña de aplicación que hubiera.
      passEnc: '',
      activo: true,
      error: '',
      requiereReconexion: false,
      usarIA: previo.usarIA !== false,
      reglas: previo.reglas || C.REGLAS_DEFAULT,
      ...(cambioCasilla || !previo.user ? S.reinicioCarpetas() : {}),
      conectadoEn: previo.conectadoEn || new Date().toISOString(),
      actualizadoEn: new Date().toISOString(),
    });

    O.limpiarStates(tenantId).catch(() => {});
    return volver(res, 'conectado=1');
  } catch (e) {
    console.error('[CORREO-OAUTH] callback:', e.message);
    return volverError(res, O.CODIGOS.INTERNO);
  }
});

module.exports = router;
