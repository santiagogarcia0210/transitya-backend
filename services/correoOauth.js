// Vinculación de la casilla por OAuth (Google / Microsoft), como alternativa a la
// contraseña de aplicación. Nada queda fijo en el código: cada empresa conecta la suya.
//
// Reglas de seguridad de este archivo:
//  - Nunca se loguea ni se devuelve un token, un code, un state ni el texto de error
//    del proveedor: los errores salen como códigos genéricos (ver CODIGOS).
//  - El refresh token se guarda SIEMPRE cifrado con helpers/cripto.js.
//  - El state va firmado con HMAC sobre una subclave derivada de ENCRYPTION_KEY,
//    vence a los 10 minutos y es de un solo uso (se consume en una transacción).
const { createHmac, randomBytes, createHash, timingSafeEqual } = require('crypto');
const cripto = require('../helpers/cripto');
const { col } = require('../utils');

const ETIQUETA_STATE = 'correo-oauth-state-v1';
const VENCIMIENTO_MS = 10 * 60 * 1000;
const COLECCION_STATE = 'correo_oauth_state';

/** Códigos que viajan al frontend en ?error=. Nunca texto del proveedor. */
const CODIGOS = {
  PROVEEDOR: 'proveedor_invalido',
  DESHABILITADO: 'proveedor_deshabilitado',
  STATE: 'state_invalido',
  VENCIDO: 'state_vencido',
  USADO: 'state_usado',
  DENEGADO: 'permiso_denegado',
  TOKEN: 'intercambio_fallido',
  SIN_REFRESH: 'sin_refresh_token',
  MAIL: 'no_se_pudo_leer_el_mail',
  IMAP: 'imap_rechazado',
  CIFRADO: 'cifrado_no_disponible',
  INTERNO: 'error_interno',
};

const PROVEEDORES = {
  google: {
    id: 'google',
    nombre: 'Google',
    etiqueta: 'Conectar con Google',
    descripcion: 'Gmail o Google Workspace',
    envId: 'GOOGLE_OAUTH_CLIENT_ID',
    envSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    // mail.google.com es el scope que exige el acceso IMAP con XOAUTH2.
    scopes: ['https://mail.google.com/', 'openid', 'email'],
    pkce: true,
    // access_type=offline + prompt=consent son necesarios para recibir refresh token.
    extraAuth: { access_type: 'offline', prompt: 'consent' },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
  },
  microsoft: {
    id: 'microsoft',
    nombre: 'Microsoft',
    etiqueta: 'Conectar con Microsoft',
    descripcion: 'Outlook, Hotmail o Microsoft 365',
    envId: 'MICROSOFT_OAUTH_CLIENT_ID',
    envSecret: 'MICROSOFT_OAUTH_CLIENT_SECRET',
    // /common/ acepta cuentas personales y de trabajo.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    revokeUrl: '',
    userinfoUrl: '',
    scopes: ['https://outlook.office.com/IMAP.AccessAsUser.All', 'offline_access', 'openid', 'email'],
    pkce: true,
    extraAuth: {},
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
  },
};

/* ── Configuración ─────────────────────────────────────────────────────── */

const baseRedirect = () =>
  String(process.env.OAUTH_REDIRECT_BASE || 'https://app.transitya.com').replace(/\/+$/, '');

/** El frontend proxea /api/* al backend, así que la misma base sirve para las dos cosas. */
const urlCallback = proveedor => baseRedirect() + '/api/correo/oauth/' + proveedor + '/callback';
const urlDashboard = params => baseRedirect() + '/dashboard/correo?' + params;

function credenciales(prov) {
  return {
    clientId: String(process.env[prov.envId] || '').trim(),
    clientSecret: String(process.env[prov.envSecret] || '').trim(),
  };
}

/** Un proveedor está habilitado solo si tiene client id y secret cargados. */
function estaHabilitado(idProveedor) {
  const prov = PROVEEDORES[idProveedor];
  if (!prov) return false;
  const { clientId, clientSecret } = credenciales(prov);
  return !!(clientId && clientSecret);
}

/**
 * Lista para el frontend. Si faltan las variables de un proveedor, no aparece
 * habilitado y la app sigue funcionando con contraseña de aplicación.
 */
function listarProveedores() {
  return Object.values(PROVEEDORES).map(p => ({
    id: p.id,
    nombre: p.nombre,
    etiqueta: p.etiqueta,
    descripcion: p.descripcion,
    habilitado: estaHabilitado(p.id),
  }));
}

const hayAlgunoHabilitado = () => Object.keys(PROVEEDORES).some(estaHabilitado);

/* ── State firmado, con vencimiento y de un solo uso ───────────────────── */

const b64u = buf => Buffer.from(buf).toString('base64url');

function firmar_(payloadB64) {
  return b64u(createHmac('sha256', cripto.derivarClave(ETIQUETA_STATE)).update(payloadB64).digest());
}

/** Devuelve { state, nonce, exp }. El nonce se guarda aparte para consumirlo una sola vez. */
function firmarState({ tenantId, uid, proveedor, ahora = Date.now() }) {
  const nonce = randomBytes(18).toString('base64url');
  const payload = { v: 1, t: tenantId, u: uid || '', p: proveedor, n: nonce, e: ahora + VENCIMIENTO_MS };
  const payloadB64 = b64u(JSON.stringify(payload));
  return { state: payloadB64 + '.' + firmar_(payloadB64), nonce, exp: payload.e };
}

/**
 * Valida firma y vencimiento. NO consume el nonce (eso lo hace consumirState).
 * Devuelve { ok, codigo?, datos? }. Nunca lanza por un state mal formado.
 */
function verificarState(state, { ahora = Date.now() } = {}) {
  try {
    const partes = String(state || '').split('.');
    if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, codigo: CODIGOS.STATE };
    const payloadB64 = partes[0];
    const firma = partes[1];

    const esperada = Buffer.from(firmar_(payloadB64));
    const recibida = Buffer.from(firma);
    // timingSafeEqual exige mismo largo: si difiere, la firma ya es inválida.
    if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) {
      return { ok: false, codigo: CODIGOS.STATE };
    }

    const datos = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (datos.v !== 1 || !datos.t || !datos.p || !datos.n) return { ok: false, codigo: CODIGOS.STATE };
    if (!PROVEEDORES[datos.p]) return { ok: false, codigo: CODIGOS.PROVEEDOR };
    if (!Number.isFinite(datos.e) || datos.e <= ahora) return { ok: false, codigo: CODIGOS.VENCIDO };

    return {
      ok: true,
      datos: { tenantId: datos.t, uid: datos.u, proveedor: datos.p, nonce: datos.n, exp: datos.e },
    };
  } catch {
    return { ok: false, codigo: CODIGOS.STATE };
  }
}

const refState = (tenantId, nonce) => col(tenantId, COLECCION_STATE).doc(nonce);

/** Guarda el nonce pendiente junto al verifier de PKCE (cifrado). */
async function guardarState({ tenantId, uid, proveedor, nonce, exp, verifier }) {
  await refState(tenantId, nonce).set({
    proveedor,
    uid: uid || '',
    exp,
    usado: false,
    verifier: verifier ? cripto.encriptar(verifier) : '',
    creadoEn: new Date().toISOString(),
  });
}

/**
 * Consume el nonce en una transacción: si ya fue usado, falla. Garantiza un solo uso
 * incluso si el proveedor reenvía el callback o alguien repite la URL a mano.
 * Devuelve { ok, codigo?, verifier? }.
 */
async function consumirState({ tenantId, proveedor, nonce, ahora = Date.now() }, db = null) {
  const ref = refState(tenantId, nonce);
  const base = db || require('../firebase').db;
  try {
    return await base.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, codigo: CODIGOS.STATE };
      const d = snap.data();
      if (d.usado === true) return { ok: false, codigo: CODIGOS.USADO };
      if (d.proveedor !== proveedor) return { ok: false, codigo: CODIGOS.STATE };
      if (Number(d.exp) <= ahora) return { ok: false, codigo: CODIGOS.VENCIDO };
      tx.update(ref, { usado: true, usadoEn: new Date().toISOString() });
      return { ok: true, verifier: d.verifier ? cripto.desencriptar(d.verifier) : '' };
    });
  } catch {
    return { ok: false, codigo: CODIGOS.INTERNO };
  }
}

/** Borra los states ya usados o vencidos de una empresa. Best-effort. */
async function limpiarStates(tenantId, { ahora = Date.now() } = {}) {
  try {
    const snap = await col(tenantId, COLECCION_STATE).get();
    const viejos = snap.docs.filter(d => d.data().usado === true || Number(d.data().exp) <= ahora);
    await Promise.all(viejos.map(d => d.ref.delete()));
    return viejos.length;
  } catch {
    return 0;
  }
}

/* ── PKCE ──────────────────────────────────────────────────────────────── */

function generarPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/* ── URL de autorización ───────────────────────────────────────────────── */

function urlAutorizacion({ proveedor, state, challenge, loginHint = '' }) {
  const prov = PROVEEDORES[proveedor];
  const { clientId } = credenciales(prov);
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: urlCallback(proveedor),
    scope: prov.scopes.join(' '),
    state,
    ...prov.extraAuth,
  });
  if (prov.pkce && challenge) {
    p.set('code_challenge', challenge);
    p.set('code_challenge_method', 'S256');
  }
  if (loginHint) p.set('login_hint', loginHint);
  return prov.authUrl + '?' + p.toString();
}

/* ── Intercambio y refresco de tokens ──────────────────────────────────── */

/**
 * POST al token endpoint. Devuelve { ok, datos?, codigo?, invalidGrant? }.
 * El cuerpo de error del proveedor NO se propaga: solo se mira error === invalid_grant.
 */
async function pedirTokens_(prov, params, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  let resp;
  let cuerpo;
  try {
    resp = await f(prov.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    cuerpo = await resp.json().catch(() => ({}));
  } catch {
    return { ok: false, codigo: CODIGOS.TOKEN };
  }
  if (!resp.ok || !cuerpo || !cuerpo.access_token) {
    const invalidGrant = String(cuerpo && cuerpo.error ? cuerpo.error : '') === 'invalid_grant';
    // Se registra solo el código del proveedor, nunca el detalle ni el token.
    const codigoProv = String((cuerpo && cuerpo.error) || (resp && resp.status) || 'sin detalle').slice(0, 40);
    console.warn('[CORREO-OAUTH]', prov.id, 'token endpoint rechazó:', codigoProv);
    return { ok: false, codigo: CODIGOS.TOKEN, invalidGrant };
  }
  return {
    ok: true,
    datos: {
      accessToken: cuerpo.access_token,
      refreshToken: cuerpo.refresh_token || '',
      expiraEn: Number(cuerpo.expires_in) || 3600,
      idToken: cuerpo.id_token || '',
      scope: cuerpo.scope || '',
    },
  };
}

async function intercambiarCode({ proveedor, code, verifier }, { fetchImpl } = {}) {
  const prov = PROVEEDORES[proveedor];
  const { clientId, clientSecret } = credenciales(prov);
  const params = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: urlCallback(proveedor),
  };
  if (prov.pkce && verifier) params.code_verifier = verifier;
  return pedirTokens_(prov, params, fetchImpl);
}

async function refrescarAccessToken({ proveedor, refreshToken }, { fetchImpl } = {}) {
  const prov = PROVEEDORES[proveedor];
  const { clientId, clientSecret } = credenciales(prov);
  const params = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  };
  // Microsoft pide el scope también al refrescar.
  if (proveedor === 'microsoft') params.scope = prov.scopes.join(' ');
  return pedirTokens_(prov, params, fetchImpl);
}

async function revocar({ proveedor, refreshToken }, { fetchImpl } = {}) {
  const prov = PROVEEDORES[proveedor];
  if (!prov || !prov.revokeUrl || !refreshToken) return { ok: false, motivo: 'sin_endpoint' };
  const f = fetchImpl || globalThis.fetch;
  try {
    const r = await f(prov.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    return { ok: !!r.ok };
  } catch {
    return { ok: false, motivo: 'error_red' };
  }
}

/* ── Mail de la cuenta ─────────────────────────────────────────────────── */

/** Lee el payload de un JWT sin validar firma: viene del token endpoint por TLS. */
function mailDesdeIdToken(idToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')
    );
    const mail = payload.email || payload.preferred_username || payload.upn || '';
    return /@/.test(mail) ? String(mail).trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/** id_token primero; si no trae mail y el proveedor tiene userinfo, se consulta. */
async function obtenerMail({ proveedor, idToken, accessToken }, { fetchImpl } = {}) {
  const directo = mailDesdeIdToken(idToken);
  if (directo) return directo;
  const prov = PROVEEDORES[proveedor];
  if (!prov || !prov.userinfoUrl || !accessToken) return '';
  const f = fetchImpl || globalThis.fetch;
  try {
    const r = await f(prov.userinfoUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!r.ok) return '';
    const j = await r.json().catch(() => ({}));
    const mail = j.email || j.preferred_username || '';
    return /@/.test(mail) ? String(mail).trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

module.exports = {
  PROVEEDORES,
  CODIGOS,
  VENCIMIENTO_MS,
  COLECCION_STATE,
  estaHabilitado,
  listarProveedores,
  hayAlgunoHabilitado,
  baseRedirect,
  urlCallback,
  urlDashboard,
  firmarState,
  verificarState,
  guardarState,
  consumirState,
  limpiarStates,
  refState,
  generarPkce,
  urlAutorizacion,
  intercambiarCode,
  refrescarAccessToken,
  revocar,
  mailDesdeIdToken,
  obtenerMail,
};
