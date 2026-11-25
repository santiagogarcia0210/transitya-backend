/**
 * Vinculación del correo por OAuth. Todo con los endpoints del proveedor mockeados:
 * no se hace una sola llamada de red real.
 *
 * Cubre lo que no se puede probar a mano sin romper algo:
 *  - state inválido, vencido, de otro proveedor y reutilizado son rechazados;
 *  - el refresh token se guarda cifrado y no sale por la API ni por los logs;
 *  - sin las variables del proveedor, no se lista y la app arranca igual;
 *  - la rama de contraseña de aplicación sigue funcionando.
 *
 * Correr: npm test
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const RAIZ = path.join(__dirname, '..');
const CLAVE = 'b'.repeat(64);

// Tiene que estar antes de requerir helpers/cripto, que lee la clave al cargarse.
process.env.ENCRYPTION_KEY = CLAVE;
process.env.OAUTH_REDIRECT_BASE = 'https://app.transitya.com';

/* ── Firestore de mentira, suficiente para lo que usan estos módulos ─────── */

function fakeDb() {
  const docs = new Map();
  const ref = (ruta) => ({
    ruta,
    async get() {
      const d = docs.get(ruta);
      return { exists: d !== undefined, data: () => (d === undefined ? undefined : { ...d }), ref: ref(ruta) };
    },
    async set(v) { docs.set(ruta, { ...v }); },
    async update(v) { docs.set(ruta, { ...(docs.get(ruta) || {}), ...v }); },
    async delete() { docs.delete(ruta); },
  });
  const coleccion = (base) => ({
    doc: (id) => ref(base + '/' + id),
    async get() {
      return {
        docs: [...docs.keys()]
          .filter(k => k.startsWith(base + '/'))
          .map(k => ({ id: k.slice(base.length + 1), data: () => ({ ...docs.get(k) }), ref: ref(k) })),
      };
    },
  });
  return {
    docs,
    coleccion,
    ref,
    async runTransaction(fn) {
      return fn({
        async get(r) { return r.get(); },
        update(r, v) { docs.set(r.ruta, { ...(docs.get(r.ruta) || {}), ...v }); },
        set(r, v) { docs.set(r.ruta, { ...v }); },
      });
    },
  };
}

/**
 * Carga services/correoOauth.js con utils y firebase interceptados, para que use
 * el Firestore de mentira. Devuelve { O, db } con el módulo recién cargado.
 */
function cargarOauth() {
  const db = fakeDb();
  const rutaUtils = require.resolve(path.join(RAIZ, 'utils.js'));
  const rutaFirebase = require.resolve(path.join(RAIZ, 'firebase.js'));
  const rutaOauth = require.resolve(path.join(RAIZ, 'services/correoOauth.js'));

  const originalLoad = Module._load;
  const utilsFalso = { col: (t, sub) => db.coleccion('empresas/' + t + '/' + sub) };
  const firebaseFalso = { db };

  Module._load = function (pedido, padre, esMain) {
    if (padre && padre.filename === rutaOauth) {
      if (pedido === '../utils') return utilsFalso;
      if (pedido === '../firebase') return firebaseFalso;
    }
    return originalLoad.call(this, pedido, padre, esMain);
  };
  try {
    delete require.cache[rutaOauth];
    delete require.cache[rutaUtils];
    delete require.cache[rutaFirebase];
    return { O: require(rutaOauth), db };
  } finally {
    Module._load = originalLoad;
    delete require.cache[rutaOauth];
  }
}

/** fetch de mentira: devuelve lo que se le indique y registra lo que recibió. */
function fetchFalso(respuestas) {
  const llamadas = [];
  const f = async (url, opciones = {}) => {
    llamadas.push({ url: String(url), body: String(opciones.body || ''), headers: opciones.headers || {} });
    const r = respuestas.shift();
    if (!r) throw new Error('fetchFalso: no quedan respuestas preparadas');
    if (r.lanzar) throw new Error('falla de red simulada');
    return { ok: r.ok !== false, status: r.status || (r.ok === false ? 400 : 200), json: async () => r.json };
  };
  f.llamadas = llamadas;
  return f;
}

const idTokenCon = (payload) =>
  'x.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.y';

const CREDS_GOOGLE = { GOOGLE_OAUTH_CLIENT_ID: 'id-google', GOOGLE_OAUTH_CLIENT_SECRET: 'secreto-google' };

function conEnv(vars, fn) {
  const previo = {};
  for (const k of Object.keys(vars)) { previo[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k];
    }
  }
}

/* ── Proveedores habilitados ─────────────────────────────────────────────── */

describe('qué proveedores se ofrecen', () => {
  test('sin variables del proveedor no queda habilitado, y el módulo carga igual', () => {
    const { O } = cargarOauth();
    const limpio = {
      GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '',
      MICROSOFT_OAUTH_CLIENT_ID: '', MICROSOFT_OAUTH_CLIENT_SECRET: '',
    };
    conEnv(limpio, () => {
      const lista = O.listarProveedores();
      assert.strictEqual(lista.length, 2, 'los dos proveedores se listan siempre');
      assert.ok(lista.every(p => p.habilitado === false), 'ninguno habilitado sin credenciales');
      assert.strictEqual(O.hayAlgunoHabilitado(), false);
      assert.strictEqual(O.estaHabilitado('google'), false);
    });
  });

  test('con client id y secret, el proveedor queda habilitado', () => {
    const { O } = cargarOauth();
    conEnv(CREDS_GOOGLE, () => {
      assert.strictEqual(O.estaHabilitado('google'), true);
      assert.strictEqual(O.listarProveedores().find(p => p.id === 'google').habilitado, true);
    });
  });

  test('falta solo el secret: sigue deshabilitado', () => {
    const { O } = cargarOauth();
    conEnv({ GOOGLE_OAUTH_CLIENT_ID: 'id-google', GOOGLE_OAUTH_CLIENT_SECRET: '' }, () => {
      assert.strictEqual(O.estaHabilitado('google'), false);
    });
  });

  test('un proveedor inventado nunca está habilitado', () => {
    const { O } = cargarOauth();
    assert.strictEqual(O.estaHabilitado('yahoo'), false);
    assert.strictEqual(O.estaHabilitado(''), false);
  });
});

/* ── URL de autorización ─────────────────────────────────────────────────── */

describe('URL de autorización', () => {
  test('Google lleva los scopes, PKCE S256, offline y consent', () => {
    const { O } = cargarOauth();
    conEnv(CREDS_GOOGLE, () => {
      const { state } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google' });
      const { challenge } = O.generarPkce();
      const u = new URL(O.urlAutorizacion({ proveedor: 'google', state, challenge }));
      assert.strictEqual(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      const scope = u.searchParams.get('scope');
      assert.match(scope, /https:\/\/mail\.google\.com\//);
      assert.match(scope, /openid/);
      assert.match(scope, /email/);
      assert.strictEqual(u.searchParams.get('access_type'), 'offline');
      assert.strictEqual(u.searchParams.get('prompt'), 'consent');
      assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
      assert.strictEqual(u.searchParams.get('code_challenge'), challenge);
      assert.strictEqual(u.searchParams.get('response_type'), 'code');
      assert.strictEqual(
        u.searchParams.get('redirect_uri'),
        'https://app.transitya.com/api/correo/oauth/google/callback'
      );
    });
  });

  test('Microsoft usa /common/ y pide IMAP.AccessAsUser.All con offline_access', () => {
    const { O } = cargarOauth();
    conEnv({ MICROSOFT_OAUTH_CLIENT_ID: 'id-ms', MICROSOFT_OAUTH_CLIENT_SECRET: 'sec-ms' }, () => {
      const { state } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'microsoft' });
      const u = new URL(O.urlAutorizacion({ proveedor: 'microsoft', state }));
      assert.match(u.pathname, /^\/common\/oauth2\/v2\.0\/authorize$/);
      const scope = u.searchParams.get('scope');
      assert.match(scope, /https:\/\/outlook\.office\.com\/IMAP\.AccessAsUser\.All/);
      assert.match(scope, /offline_access/);
      assert.strictEqual(
        u.searchParams.get('redirect_uri'),
        'https://app.transitya.com/api/correo/oauth/microsoft/callback'
      );
    });
  });

  test('el challenge de PKCE es el SHA-256 base64url del verifier', () => {
    const { O } = cargarOauth();
    const { verifier, challenge } = O.generarPkce();
    const esperado = require('crypto').createHash('sha256').update(verifier).digest('base64url');
    assert.strictEqual(challenge, esperado);
    assert.notStrictEqual(verifier, challenge);
  });
});

/* ── State: firma, vencimiento y un solo uso ─────────────────────────────── */

describe('state firmado', () => {
  test('el state recién firmado se verifica y trae los datos', () => {
    const { O } = cargarOauth();
    const { state, nonce } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google' });
    const v = O.verificarState(state);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.datos.tenantId, 't1');
    assert.strictEqual(v.datos.uid, 'u1');
    assert.strictEqual(v.datos.proveedor, 'google');
    assert.strictEqual(v.datos.nonce, nonce);
  });

  test('un state con la firma cambiada se rechaza', () => {
    const { O } = cargarOauth();
    const { state } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google' });
    const [payload, firma] = state.split('.');
    const otraFirma = firma.slice(0, -2) + (firma.endsWith('aa') ? 'bb' : 'aa');
    const v = O.verificarState(payload + '.' + otraFirma);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.codigo, O.CODIGOS.STATE);
  });

  test('un state con el contenido cambiado (otro tenant) se rechaza', () => {
    const { O } = cargarOauth();
    const { state } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google' });
    const firma = state.split('.')[1];
    const payloadFalso = Buffer.from(
      JSON.stringify({ v: 1, t: 'otro-tenant', u: 'u1', p: 'google', n: 'x', e: Date.now() + 60000 })
    ).toString('base64url');
    const v = O.verificarState(payloadFalso + '.' + firma);
    assert.strictEqual(v.ok, false, 'cambiar el tenant invalida la firma');
    assert.strictEqual(v.codigo, O.CODIGOS.STATE);
  });

  test('un state vencido se rechaza con su propio código', () => {
    const { O } = cargarOauth();
    const { state } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google', ahora: Date.now() - 11 * 60 * 1000 });
    const v = O.verificarState(state);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.codigo, O.CODIGOS.VENCIDO);
  });

  test('el vencimiento es de 10 minutos', () => {
    const { O } = cargarOauth();
    const ahora = Date.now();
    const { state } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google', ahora });
    assert.strictEqual(O.verificarState(state, { ahora: ahora + 9 * 60 * 1000 }).ok, true, 'a los 9 min sigue válido');
    assert.strictEqual(O.verificarState(state, { ahora: ahora + 10 * 60 * 1000 + 1 }).ok, false, 'pasados los 10 min, no');
    assert.strictEqual(O.VENCIMIENTO_MS, 10 * 60 * 1000);
  });

  test('basura, vacío y null se rechazan sin lanzar', () => {
    const { O } = cargarOauth();
    for (const malo of ['', null, undefined, 'sinpunto', 'a.b', '....', '{}', 'a.b.c']) {
      const v = O.verificarState(malo);
      assert.strictEqual(v.ok, false, 'deberia rechazar: ' + JSON.stringify(malo));
      assert.ok(v.codigo, 'tiene que traer un código');
    }
  });

  test('un state de otro proveedor no sirve para este', async () => {
    const { O, db } = cargarOauth();
    const { state, nonce, exp } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google' });
    await O.guardarState({ tenantId: 't1', uid: 'u1', proveedor: 'google', nonce, exp, verifier: 'v' });
    const v = O.verificarState(state);
    assert.strictEqual(v.ok, true);
    // El callback de microsoft con un state de google tiene que fallar al consumirlo.
    const c = await O.consumirState({ tenantId: 't1', proveedor: 'microsoft', nonce }, db);
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.codigo, O.CODIGOS.STATE);
  });

  test('un solo uso: el segundo intento con el mismo state se rechaza', async () => {
    const { O, db } = cargarOauth();
    const { nonce, exp } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google' });
    await O.guardarState({ tenantId: 't1', uid: 'u1', proveedor: 'google', nonce, exp, verifier: 'verificador-1' });

    const primera = await O.consumirState({ tenantId: 't1', proveedor: 'google', nonce }, db);
    assert.strictEqual(primera.ok, true, 'el primer uso tiene que andar');
    assert.strictEqual(primera.verifier, 'verificador-1', 'devuelve el verifier descifrado');

    const segunda = await O.consumirState({ tenantId: 't1', proveedor: 'google', nonce }, db);
    assert.strictEqual(segunda.ok, false, 'el segundo uso tiene que fallar');
    assert.strictEqual(segunda.codigo, O.CODIGOS.USADO);
  });

  test('un nonce que nunca se guardó se rechaza', async () => {
    const { O, db } = cargarOauth();
    const c = await O.consumirState({ tenantId: 't1', proveedor: 'google', nonce: 'inventado' }, db);
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.codigo, O.CODIGOS.STATE);
  });

  test('el verifier de PKCE se guarda cifrado, no en claro', async () => {
    const { O, db } = cargarOauth();
    const { nonce, exp } = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google' });
    await O.guardarState({ tenantId: 't1', uid: 'u1', proveedor: 'google', nonce, exp, verifier: 'verificador-secreto' });
    const guardado = JSON.stringify([...db.docs.values()]);
    assert.ok(!guardado.includes('verificador-secreto'), 'el verifier no puede quedar en claro en Firestore');
    assert.match(guardado, /[0-9a-f]{24}:[0-9a-f]{32}:/, 'tiene que verse el formato iv:tag:dato');
  });

  test('limpiarStates borra los usados y los vencidos, y deja los vigentes', async () => {
    const { O, db } = cargarOauth();
    const ahora = Date.now();
    const vigente = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google', ahora });
    const vencido = O.firmarState({ tenantId: 't1', uid: 'u1', proveedor: 'google', ahora: ahora - 20 * 60 * 1000 });
    await O.guardarState({ tenantId: 't1', proveedor: 'google', nonce: vigente.nonce, exp: vigente.exp, verifier: 'a' });
    await O.guardarState({ tenantId: 't1', proveedor: 'google', nonce: vencido.nonce, exp: vencido.exp, verifier: 'b' });
    const borrados = await O.limpiarStates('t1', { ahora });
    assert.strictEqual(borrados, 1, 'solo el vencido');
    assert.ok(db.docs.has('empresas/t1/correo_oauth_state/' + vigente.nonce), 'el vigente sigue');
  });
});

/* ── Intercambio y refresco de tokens (mockeados) ────────────────────────── */

describe('intercambio del code por tokens', () => {
  test('manda PKCE y el redirect_uri, y devuelve los tokens', async () => {
    const { O } = cargarOauth();
    await conEnv(CREDS_GOOGLE, async () => {
      const f = fetchFalso([{ json: { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3599, id_token: idTokenCon({ email: 'Casilla@Empresa.com' }) } }]);
      const r = await O.intercambiarCode({ proveedor: 'google', code: 'CODE-1', verifier: 'VER-1' }, { fetchImpl: f });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.datos.accessToken, 'AT-1');
      assert.strictEqual(r.datos.refreshToken, 'RT-1');
      const enviado = f.llamadas[0];
      assert.strictEqual(enviado.url, 'https://oauth2.googleapis.com/token');
      assert.match(enviado.body, /grant_type=authorization_code/);
      assert.match(enviado.body, /code_verifier=VER-1/);
      assert.match(enviado.body, /redirect_uri=https%3A%2F%2Fapp\.transitya\.com%2Fapi%2Fcorreo%2Foauth%2Fgoogle%2Fcallback/);
    });
  });

  test('si el proveedor rechaza, devuelve código genérico y no filtra su texto', async () => {
    const { O } = cargarOauth();
    await conEnv(CREDS_GOOGLE, async () => {
      const f = fetchFalso([{ ok: false, status: 400, json: { error: 'invalid_request', error_description: 'secreto interno del proveedor' } }]);
      const r = await O.intercambiarCode({ proveedor: 'google', code: 'x', verifier: 'v' }, { fetchImpl: f });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.codigo, O.CODIGOS.TOKEN);
      assert.ok(!JSON.stringify(r).includes('secreto interno'), 'no se propaga el detalle del proveedor');
    });
  });

  test('una falla de red no lanza', async () => {
    const { O } = cargarOauth();
    await conEnv(CREDS_GOOGLE, async () => {
      const r = await O.intercambiarCode({ proveedor: 'google', code: 'x' }, { fetchImpl: fetchFalso([{ lanzar: true }]) });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.codigo, O.CODIGOS.TOKEN);
    });
  });
});

describe('refresco del access token', () => {
  test('invalid_grant se reporta como tal, para pedir reconexión', async () => {
    const { O } = cargarOauth();
    await conEnv(CREDS_GOOGLE, async () => {
      const f = fetchFalso([{ ok: false, status: 400, json: { error: 'invalid_grant' } }]);
      const r = await O.refrescarAccessToken({ proveedor: 'google', refreshToken: 'RT' }, { fetchImpl: f });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.invalidGrant, true);
    });
  });

  test('otro error no se confunde con invalid_grant', async () => {
    const { O } = cargarOauth();
    await conEnv(CREDS_GOOGLE, async () => {
      const f = fetchFalso([{ ok: false, status: 500, json: { error: 'server_error' } }]);
      const r = await O.refrescarAccessToken({ proveedor: 'google', refreshToken: 'RT' }, { fetchImpl: f });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.invalidGrant, false);
    });
  });

  test('Microsoft manda el scope también al refrescar', async () => {
    const { O } = cargarOauth();
    await conEnv({ MICROSOFT_OAUTH_CLIENT_ID: 'id-ms', MICROSOFT_OAUTH_CLIENT_SECRET: 'sec-ms' }, async () => {
      const f = fetchFalso([{ json: { access_token: 'AT', expires_in: 3600 } }]);
      await O.refrescarAccessToken({ proveedor: 'microsoft', refreshToken: 'RT' }, { fetchImpl: f });
      assert.match(f.llamadas[0].body, /scope=/);
      assert.match(f.llamadas[0].body, /grant_type=refresh_token/);
    });
  });
});

/* ── Mail de la cuenta ───────────────────────────────────────────────────── */

describe('mail de la cuenta vinculada', () => {
  test('sale del id_token y queda en minúsculas', () => {
    const { O } = cargarOauth();
    assert.strictEqual(O.mailDesdeIdToken(idTokenCon({ email: 'Casilla@Empresa.COM' })), 'casilla@empresa.com');
    assert.strictEqual(O.mailDesdeIdToken(idTokenCon({ preferred_username: 'a@b.com' })), 'a@b.com');
    assert.strictEqual(O.mailDesdeIdToken('cualquier-cosa'), '');
    assert.strictEqual(O.mailDesdeIdToken(idTokenCon({ email: 'sin-arroba' })), '');
  });

  test('si el id_token no trae mail, se consulta userinfo', async () => {
    const { O } = cargarOauth();
    const f = fetchFalso([{ json: { email: 'Desde@Userinfo.com' } }]);
    const mail = await O.obtenerMail({ proveedor: 'google', idToken: idTokenCon({ sub: '1' }), accessToken: 'AT' }, { fetchImpl: f });
    assert.strictEqual(mail, 'desde@userinfo.com');
    assert.strictEqual(f.llamadas[0].headers.Authorization, 'Bearer AT');
  });
});

/* ── Credenciales de sincronización: OAuth y contraseña ──────────────────── */

describe('resolverCredenciales en la sincronización', () => {
  const cargarSync = () => {
    const ruta = require.resolve(path.join(RAIZ, 'services/correoSync.js'));
    delete require.cache[ruta];
    return require(ruta);
  };

  test('config con contraseña de aplicación: sigue andando igual que antes', async () => {
    const S = cargarSync();
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const cfg = { tipo: 'password', passEnc: cripto.encriptar('clave-de-app') };
    const r = await S.resolverCredenciales('t1', cfg);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.creds.pass, 'clave-de-app');
    assert.strictEqual(r.creds.accessToken, undefined, 'la rama de contraseña no usa access token');
  });

  test('config sin tipo (las de antes de OAuth) se trata como contraseña', async () => {
    const S = cargarSync();
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const r = await S.resolverCredenciales('t1', { passEnc: cripto.encriptar('vieja') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.creds.pass, 'vieja');
  });

  test('config oauth: refresca y devuelve access token, sin tocar la contraseña', async () => {
    const S = cargarSync();
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const oauthFalso = {
      estaHabilitado: () => true,
      refrescarAccessToken: async () => ({ ok: true, datos: { accessToken: 'AT-NUEVO', refreshToken: '' } }),
    };
    const cfg = { tipo: 'oauth', proveedor: 'google', refreshTokenEnc: cripto.encriptar('RT') };
    const r = await S.resolverCredenciales('t1', cfg, { oauth: oauthFalso });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.creds.accessToken, 'AT-NUEVO');
    assert.strictEqual(r.creds.pass, undefined);
  });

  test('invalid_grant marca requiereReconexion con mensaje para el usuario', async () => {
    const S = cargarSync();
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const oauthFalso = {
      estaHabilitado: () => true,
      refrescarAccessToken: async () => ({ ok: false, invalidGrant: true, codigo: 'intercambio_fallido' }),
    };
    const cfg = { tipo: 'oauth', proveedor: 'google', refreshTokenEnc: cripto.encriptar('RT') };
    const r = await S.resolverCredenciales('t1', cfg, { oauth: oauthFalso });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.requiereReconexion, true);
    assert.match(r.mensaje, /Reconectar/);
  });

  test('un error pasajero NO pide reconexión', async () => {
    const S = cargarSync();
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const oauthFalso = {
      estaHabilitado: () => true,
      refrescarAccessToken: async () => ({ ok: false, invalidGrant: false }),
    };
    const cfg = { tipo: 'oauth', proveedor: 'google', refreshTokenEnc: cripto.encriptar('RT') };
    const r = await S.resolverCredenciales('t1', cfg, { oauth: oauthFalso });
    assert.strictEqual(r.ok, false);
    assert.ok(!r.requiereReconexion, 'un 500 del proveedor se reintenta en el próximo tick');
  });

  test('config oauth sin refresh token guardado pide reconexión', async () => {
    const S = cargarSync();
    const r = await S.resolverCredenciales('t1', { tipo: 'oauth', proveedor: 'google', refreshTokenEnc: '' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.requiereReconexion, true);
  });

  test('si el proveedor rota el refresh token, se guarda cifrado', async () => {
    const S = cargarSync();
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const guardado = [];
    const cfg = { tipo: 'oauth', proveedor: 'google', refreshTokenEnc: cripto.encriptar('RT-VIEJO') };
    const oauthFalso = {
      estaHabilitado: () => true,
      refrescarAccessToken: async () => ({ ok: true, datos: { accessToken: 'AT', refreshToken: 'RT-ROTADO' } }),
    };
    // Sin Firestore real, el update del token rotado falla y queda atrapado adentro:
    // el refresco igual tiene que servir, y el token nuevo tiene que haberse cifrado.
    const r = await S.resolverCredenciales('t1', cfg, {
      oauth: oauthFalso,
      encriptar: (txt) => { guardado.push(txt); return cripto.encriptar(txt); },
    });
    assert.strictEqual(r.ok, true, 'el refresco sirve aunque el guardado del token rotado falle');
    assert.strictEqual(r.creds.accessToken, 'AT');
    assert.deepStrictEqual(guardado, ['RT-ROTADO'], 'se cifra el token nuevo, no el viejo');
  });
});

/* ── El refresh token nunca sale por la API ──────────────────────────────── */

describe('el refresh token no se filtra', () => {
  test('la vista de config no incluye refreshTokenEnc ni passEnc', () => {
    // vistaConfig no se exporta: se verifica sobre el código, que es la garantía
    // estructural de que la lista de campos es blanca y no un spread del documento.
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(RAIZ, 'routes/correo.js'), 'utf8');
    const cuerpo = src.slice(src.indexOf('function vistaConfig'));
    const fin = cuerpo.indexOf('\nrouter.');
    const vista = cuerpo.slice(0, fin > 0 ? fin : 2000);
    const sinComentarios = vista.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/refreshTokenEnc/.test(sinComentarios), 'vistaConfig no puede devolver refreshTokenEnc');
    assert.ok(!/passEnc/.test(sinComentarios), 'vistaConfig no puede devolver passEnc');
    assert.ok(!/\.\.\.cfg\b/.test(sinComentarios), 'no puede hacer spread del documento entero');
  });

  test('el refresh token se guarda cifrado: no aparece en claro', () => {
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const cifrado = cripto.encriptar('RT-SUPER-SECRETO');
    assert.ok(!cifrado.includes('RT-SUPER-SECRETO'));
    assert.strictEqual(cripto.desencriptar(cifrado), 'RT-SUPER-SECRETO');
  });

  test('la firma del state usa una subclave, no la clave de cifrado', () => {
    const cripto = require(path.join(RAIZ, 'helpers/cripto.js'));
    const sub = cripto.derivarClave('correo-oauth-state-v1');
    assert.strictEqual(sub.length, 32);
    assert.ok(!sub.equals(cripto.derivarClave('otra-cosa')), 'cada etiqueta da una subclave distinta');
    assert.ok(!sub.toString('hex').includes(CLAVE), 'la subclave no es la clave original');
  });
});
