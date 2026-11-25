// Sincronización IMAP por empresa.
// Config:  empresas/{t}/correo_config/principal
//   { host, port, secure, user, passEnc, proveedor, activo, reglas{}, usarIA,
//     uidValidity, ultimoUid, ultimaSync, error, stats{revisados,guardados,ignorados} }
// Mails de trabajo: empresas/{t}/correo_mails/{id}
// La casilla se abre en SOLO LECTURA y se lee con BODY.PEEK: no se marca nada como leído,
// no se borra ni se mueve nada.
const { createHash } = require('crypto');
const { col } = require('../utils');
const C = require('./correoClasificador');

const MENSAJE_RECONEXION =
  'Se cortó el permiso de acceso a la casilla. Volvé a apretar Reconectar para autorizarla de nuevo.';

const DIAS_PRIMERA_SYNC = 30;
const MAX_POR_SYNC = 300;
const MAX_BYTES_MAIL = 150 * 1024;
const enCurso = new Set();

const refConfig = t => col(t, 'correo_config').doc('principal');

// Acepta las dos formas de autenticación: contraseña de aplicación (pass) o
// access token de OAuth (accessToken, que imapflow manda como XOAUTH2).
function crearCliente({ host, port, secure, user, pass, accessToken }) {
  const { ImapFlow } = require('imapflow');
  const auth = accessToken ? { user, accessToken } : { user, pass };
  return new ImapFlow({
    host, port: Number(port) || 993, secure: secure !== false,
    auth, logger: false, socketTimeout: 60_000, greetingTimeout: 20_000,
  });
}

function traducirError(e) {
  const m = String(e?.responseText || e?.message || e || '');
  if (e?.authenticationFailed || /auth|credentials|invalid login|LOGIN failed|AUTHENTICATIONFAILED/i.test(m)) {
    return 'Usuario o contraseña incorrectos. En Gmail hay que usar una contraseña de aplicación, no la normal.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'No se encontró el servidor de correo. Revisá el servidor IMAP.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(m)) return 'El servidor de correo no responde. Revisá servidor y puerto.';
  if (/IMAP.*disabled|not enabled/i.test(m)) return 'La casilla tiene IMAP deshabilitado. Activalo en la configuración del mail.';
  if (/invalid_grant|reconexion|reconexión/i.test(m)) return MENSAJE_RECONEXION;
  return m.slice(0, 200) || 'Error desconocido al conectar con el correo.';
}

/** Solo prueba login + abrir INBOX. */
async function probarConexion(cfg, factory = crearCliente) {
  // El cliente se construye ADENTRO del try: si el constructor falla (p. ej. una
  // dependencia que necesita un global ausente), sale como mensaje claro y no como
  // un 500 crudo en la pantalla.
  let client = null;
  try {
    client = factory(cfg);
    await client.connect();
    const mb = await client.mailboxOpen('INBOX', { readOnly: true });
    return { ok: true, mensajes: mb.exists };
  } catch (e) {
    return { ok: false, mensaje: traducirError(e) };
  } finally {
    try { if (client) await client.logout(); } catch { /* ignore */ }
  }
}

/**
 * Devuelve con qué credenciales conectarse, según el tipo de config.
 *  - tipo 'oauth'    -> renueva el access token con el refresh token guardado.
 *  - cualquier otro  -> descifra la contraseña de aplicación (comportamiento previo).
 *
 * Si el refresh falla con invalid_grant (permiso revocado o vencido), marca la config
 * como requiereReconexion para que la pantalla ofrezca el botón Reconectar, y NO
 * reintenta: el usuario tiene que autorizar de nuevo.
 *
 * Si el proveedor devuelve un refresh token nuevo, se guarda cifrado.
 * Devuelve { ok, creds?, mensaje?, requiereReconexion? }. Nunca loguea tokens.
 */
async function resolverCredenciales(tenantId, cfg, deps = {}) {
  const desencriptar = deps.desencriptar || require('../helpers/cripto').desencriptar;

  if (cfg.tipo !== 'oauth') {
    if (!cfg.passEnc) return { ok: false, mensaje: 'No hay contraseña guardada para la casilla.' };
    return { ok: true, creds: { pass: desencriptar(cfg.passEnc) } };
  }

  const O = deps.oauth || require('./correoOauth');
  const encriptar = deps.encriptar || require('../helpers/cripto').encriptar;
  if (!cfg.refreshTokenEnc) {
    return { ok: false, mensaje: MENSAJE_RECONEXION, requiereReconexion: true };
  }
  if (!O.estaHabilitado(cfg.proveedor)) {
    return { ok: false, mensaje: 'El proveedor de la casilla ya no está configurado en el servidor.' };
  }

  const r = await O.refrescarAccessToken({
    proveedor: cfg.proveedor,
    refreshToken: desencriptar(cfg.refreshTokenEnc),
  });

  if (!r.ok) {
    if (r.invalidGrant) return { ok: false, mensaje: MENSAJE_RECONEXION, requiereReconexion: true };
    return { ok: false, mensaje: 'No se pudo renovar el permiso de la casilla. Probá de nuevo en unos minutos.' };
  }

  // Algunos proveedores rotan el refresh token: si llega uno nuevo, se reemplaza.
  if (r.datos.refreshToken) {
    // Se cifra ANTES de tocar Firestore: si el write falla, el token nuevo igual
    // quedó cifrado y el error no deja un valor en claro a medio camino.
    const nuevoEnc = encriptar(r.datos.refreshToken);
    try {
      await refConfig(tenantId).update({ refreshTokenEnc: nuevoEnc });
    } catch (e) {
      console.warn('[CORREO] no se pudo guardar el refresh token rotado:', e.message);
    }
  }

  return { ok: true, creds: { accessToken: r.datos.accessToken } };
}

/* ── Carpetas ───────────────────────────────────────────────────────────
 * Config:  carpetas: ['INBOX', 'trabajo']                 (las que se revisan)
 *          estadoCarpetas: [{ carpeta, uidValidity, ultimoUid }]   (uno por carpeta)
 *
 * El estado va en un ARRAY y no en un mapa por nombre: los nombres de carpeta pueden
 * traer puntos o barras ("Clientes.2026", "INBOX/trabajo"), que en Firestore son
 * separadores de ruta y romperían un update() con claves dinámicas.
 *
 * Las configs anteriores a esta versión no tienen carpetas ni estadoCarpetas: guardan
 * un único ultimoUid/uidValidity que era, siempre, el de INBOX. leerCarpetas() las
 * migra al leerlas (sin escribir nada); el primer sync después las persiste ya en el
 * formato nuevo. Una vez que existe estadoCarpetas, los campos viejos se ignoran.
 */
const CARPETA_DEFAULT = 'INBOX';
const MAX_CARPETAS = 20;

/** INBOX no distingue mayúsculas en IMAP; el resto de los nombres sí, así que se respetan. */
const nombreCarpeta = c => {
  const s = String(c ?? '').trim();
  return s.toUpperCase() === 'INBOX' ? 'INBOX' : s;
};

/**
 * Devuelve { carpetas: string[], estado: Map<carpeta, { uidValidity, ultimoUid }> }.
 * Pura: no toca Firestore. Sirve tanto para configs nuevas como para las viejas.
 */
function leerCarpetas(cfg = {}) {
  const pedidas = Array.isArray(cfg.carpetas) ? cfg.carpetas : [];
  const carpetas = [...new Set(pedidas.map(nombreCarpeta).filter(Boolean))];
  if (!carpetas.length) carpetas.push(CARPETA_DEFAULT);

  const estado = new Map();
  if (Array.isArray(cfg.estadoCarpetas)) {
    for (const e of cfg.estadoCarpetas) {
      const c = nombreCarpeta(e && e.carpeta);
      if (c) estado.set(c, { uidValidity: String(e.uidValidity || ''), ultimoUid: Number(e.ultimoUid) || 0 });
    }
  } else {
    // Config anterior a las carpetas: el estado global era el de INBOX.
    estado.set(CARPETA_DEFAULT, {
      uidValidity: String(cfg.uidValidity || ''),
      ultimoUid: Number(cfg.ultimoUid) || 0,
    });
  }
  return { carpetas, estado };
}

/** Estado listo para guardar: solo de las carpetas elegidas (el de las quitadas se descarta). */
function serializarEstado(estado, carpetas) {
  return carpetas.map(carpeta => {
    const e = estado.get(carpeta) || { uidValidity: '', ultimoUid: 0 };
    return { carpeta, uidValidity: String(e.uidValidity || ''), ultimoUid: Number(e.ultimoUid) || 0 };
  });
}

/**
 * Una carpeta está "pendiente" mientras nunca se la revisó: sin estado, o con estado
 * vacío (sin uidValidity). Es lo que la pantalla usa para ofrecer "Revisar últimos 30 días".
 */
function carpetasPendientes(cfg = {}) {
  const { carpetas, estado } = leerCarpetas(cfg);
  return carpetas.filter(c => {
    const e = estado.get(c);
    return !e || (!e.uidValidity && !e.ultimoUid);
  });
}

/** Valores para una casilla nueva (o cambiada): vuelve a INBOX y borra todo el progreso. */
const reinicioCarpetas = () => ({
  carpetas: [CARPETA_DEFAULT],
  estadoCarpetas: [],
  // Campos de antes de las carpetas: con estadoCarpetas presente se ignoran, pero se
  // dejan en cero para que nadie los lea como si siguieran vigentes.
  ultimoUid: 0,
  uidValidity: '',
});

/**
 * Estado para "revisar de nuevo los últimos 30 días": pone ultimoUid en 0 en las
 * carpetas indicadas (todas si no se indica ninguna) y deja el resto como estaba.
 * Se conserva el uidValidity: sirve para detectar cambios más adelante.
 */
function estadoParaReescanear(cfg, carpetasObjetivo = null) {
  const { carpetas, estado } = leerCarpetas(cfg);
  const objetivo = carpetasObjetivo ? new Set(carpetasObjetivo.map(nombreCarpeta)) : new Set(carpetas);
  const nuevo = new Map(estado);
  for (const c of carpetas) {
    if (objetivo.has(c)) nuevo.set(c, { uidValidity: (estado.get(c) || {}).uidValidity || '', ultimoUid: 0 });
  }
  return serializarEstado(nuevo, carpetas);
}

const tieneFlag_ = (flags, f) => (flags instanceof Set ? flags.has(f) : Array.isArray(flags) && flags.includes(f));

/** De la respuesta de LIST deja solo carpetas que se pueden abrir, con un formato estable. */
function normalizarListado(lista, cfg = {}) {
  const { carpetas: elegidas } = leerCarpetas(cfg);
  const sel = new Set(elegidas);
  const pend = new Set(carpetasPendientes(cfg));
  const vistas = new Set();
  const salida = [];
  for (const f of lista || []) {
    const path = nombreCarpeta(f && f.path);
    if (!path || vistas.has(path)) continue;
    // \Noselect / \NonExistent son contenedores ("[Gmail]") que no se pueden abrir.
    if (tieneFlag_(f.flags, '\\Noselect') || tieneFlag_(f.flags, '\\NonExistent')) continue;
    vistas.add(path);
    salida.push({
      path,
      nombre: f.name || path,
      especial: f.specialUse || '',
      seleccionada: sel.has(path),
      pendiente: sel.has(path) && pend.has(path),
    });
  }
  // INBOX primero, después las demás por nombre.
  salida.sort((a, b) => (a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : a.path.localeCompare(b.path, 'es')));
  return salida;
}

/**
 * Abre una conexión con las credenciales de la config (contraseña u OAuth).
 * Devuelve { ok, client?, cfg?, status?, mensaje?, requiereReconexion? }. El llamador
 * tiene que hacer logout() del cliente.
 */
async function conectarCasilla(tenantId, deps = {}) {
  const snap = await refConfig(tenantId).get();
  if (!snap.exists) return { ok: false, status: 404, mensaje: 'Primero conectá el correo.' };
  const cfg = snap.data();
  const desencriptar = deps.desencriptar || require('../helpers/cripto').desencriptar;
  const cred = await resolverCredenciales(tenantId, cfg, { ...deps, desencriptar });
  if (!cred.ok) {
    return { ok: false, status: 400, mensaje: cred.mensaje, requiereReconexion: !!cred.requiereReconexion };
  }
  const factory = deps.factory || crearCliente;
  let client = null;
  try {
    client = factory({ ...cfg, ...cred.creds });
    await client.connect();
    return { ok: true, client, cfg };
  } catch (e) {
    try { if (client) await client.logout(); } catch { /* ignore */ }
    return { ok: false, status: 400, mensaje: traducirError(e) };
  }
}

/** Carpetas de la casilla conectada, marcando cuáles se revisan. */
async function listarCarpetas(tenantId, deps = {}) {
  const c = await conectarCasilla(tenantId, deps);
  if (!c.ok) return c;
  try {
    const lista = await c.client.list();
    const carpetas = normalizarListado(lista, c.cfg);
    return { ok: true, carpetas, seleccionadas: leerCarpetas(c.cfg).carpetas, pendientes: carpetasPendientes(c.cfg) };
  } catch (e) {
    return { ok: false, status: 400, mensaje: traducirError(e) };
  } finally {
    try { await c.client.logout(); } catch { /* ignore */ }
  }
}

/**
 * Guarda qué carpetas se revisan. Valida contra el LIST real de la casilla: no se puede
 * elegir una carpeta que no existe (o que no se puede abrir). Las carpetas que siguen
 * conservan su progreso; las quitadas lo pierden, así que si se vuelven a agregar se
 * revisan de nuevo desde 30 días atrás (sin duplicar: el id del mail es estable).
 */
async function guardarCarpetas(tenantId, pedidas, deps = {}) {
  if (!Array.isArray(pedidas) || pedidas.some(p => typeof p !== 'string')) {
    return { ok: false, status: 400, mensaje: 'Mandá la lista de carpetas a revisar.' };
  }
  const elegidas = [...new Set(pedidas.map(nombreCarpeta).filter(Boolean))];
  if (!elegidas.length) return { ok: false, status: 400, mensaje: 'Elegí al menos una carpeta para revisar.' };
  if (elegidas.length > MAX_CARPETAS) {
    return { ok: false, status: 400, mensaje: `Se pueden revisar hasta ${MAX_CARPETAS} carpetas.` };
  }

  const c = await conectarCasilla(tenantId, deps);
  if (!c.ok) return c;
  try {
    const existentes = new Set(normalizarListado(await c.client.list(), c.cfg).map(f => f.path));
    const faltan = elegidas.filter(e => !existentes.has(e));
    if (faltan.length) {
      return {
        ok: false, status: 400,
        mensaje: `${faltan.length === 1 ? 'La carpeta' : 'Las carpetas'} ${faltan.map(f => `"${f}"`).join(', ')} no ${faltan.length === 1 ? 'existe' : 'existen'} en la casilla.`,
      };
    }

    const { carpetas: previas, estado } = leerCarpetas(c.cfg);
    await refConfig(tenantId).update({
      carpetas: elegidas,
      estadoCarpetas: serializarEstado(estado, elegidas),
    });
    return { ok: true, carpetas: elegidas, nuevas: elegidas.filter(e => !previas.includes(e)) };
  } catch (e) {
    return { ok: false, status: 400, mensaje: traducirError(e) };
  } finally {
    try { await c.client.logout(); } catch { /* ignore */ }
  }
}

// Id estable del mail guardado.
//  - Con Message-ID, NO depende de la carpeta: el mismo mail que se mueve de INBOX a
//    "trabajo" (cambia de UID) sigue siendo el mismo documento y no se duplica.
//  - Sin Message-ID hace falta carpeta + uidValidity + uid, porque dos carpetas
//    distintas pueden tener el mismo UID. Para INBOX se conserva la fórmula de antes
//    de las carpetas, así un re-escaneo no duplica lo que ya estaba guardado.
const idMail = (messageId, carpeta, uidValidity, uid) => {
  const base = messageId || (carpeta === CARPETA_DEFAULT
    ? `${uidValidity}:${uid}`
    : `${carpeta}|${uidValidity}:${uid}`);
  return createHash('sha1').update(base).digest('hex').slice(0, 24);
};

function linkWeb(cfg, messageId) {
  if (!messageId) return '';
  if (/gmail|googlemail/i.test(cfg.host)) {
    return `https://mail.google.com/mail/u/${encodeURIComponent(cfg.user)}/#search/rfc822msgid:${encodeURIComponent(messageId.replace(/^<|>$/g, ''))}`;
  }
  return '';
}

/** Convierte un mensaje IMAP ya parseado en el objeto que usa el clasificador. */
function normalizarMensaje(msg, parsed) {
  const from = parsed?.from?.value?.[0] || msg.envelope?.from?.[0] || {};
  return {
    uid: msg.uid,
    messageId: parsed?.messageId || msg.envelope?.messageId || '',
    de: String(from.address || '').toLowerCase(),
    deNombre: from.name || '',
    para: (parsed?.to?.value || msg.envelope?.to || []).map(a => a.address).filter(Boolean).slice(0, 10),
    asunto: parsed?.subject || msg.envelope?.subject || '',
    fecha: (parsed?.date || msg.envelope?.date || msg.internalDate || new Date()).toISOString(),
    texto: String(parsed?.text || '').replace(/\r/g, '').slice(0, 6000),
    adjuntos: (parsed?.attachments || []).filter(a => a.contentDisposition !== 'inline')
      .map(a => ({ nombre: a.filename || 'adjunto', tipo: a.contentType || '', tamano: a.size || 0 })).slice(0, 20),
    esNewsletter: !!(parsed?.headers?.get?.('list-unsubscribe')),
  };
}

async function cargarPacientes(tenantId) {
  const snap = await col(tenantId, 'registro').get();
  return snap.docs.map(d => {
    const x = d.data();
    return { id: d.id, nombre: x['APELLIDO Y NOMBRE'] || x.NOMBRE || '', dni: x.DNI || '' };
  }).filter(p => p.nombre);
}

/**
 * Sincroniza una empresa. deps inyectables para tests: { factory, llamarIA, parse, desencriptar }.
 */
async function sincronizarEmpresa(tenantId, deps = {}) {
  if (enCurso.has(tenantId)) return { ok: false, mensaje: 'Ya hay una sincronización en curso.' };
  enCurso.add(tenantId);
  const ref = refConfig(tenantId);
  try {
    const snap = await ref.get();
    if (!snap.exists || snap.data().activo === false) return { ok: false, mensaje: 'No hay correo conectado.' };
    const cfg = snap.data();
    const desencriptar = deps.desencriptar || require('../helpers/cripto').desencriptar;
    const parse = deps.parse || require('mailparser').simpleParser;
    const factory = deps.factory || crearCliente;
    const llamarIA = deps.llamarIA !== undefined ? deps.llamarIA : (cfg.usarIA !== false ? C.llamadorAnthropic() : null);
    const reglas = C.limpiarReglas(cfg.reglas || C.REGLAS_DEFAULT);

    const cred = await resolverCredenciales(tenantId, cfg, { ...deps, desencriptar });
    if (!cred.ok) {
      await ref.update({
        error: cred.mensaje,
        requiereReconexion: !!cred.requiereReconexion,
        ultimaSync: new Date().toISOString(),
      }).catch(() => {});
      return { ok: false, mensaje: cred.mensaje, requiereReconexion: !!cred.requiereReconexion };
    }

    // ── Lectura: se recorre cada carpeta elegida, con su propio UID incremental ──
    const { carpetas, estado } = leerCarpetas(cfg);
    const estadoNuevo = new Map(estado);
    const nuevos = [];
    const avisosCarpeta = [];
    let restante = MAX_POR_SYNC;   // el tope es del sync completo, no de cada carpeta
    let fallidas = 0, ultimoError = null;
    const diferidas = [];          // carpetas que no se llegaron a abrir por el tope
    let quedanMas = false;         // hay mails sin leer en alguna carpeta (siguen el próximo sync)

    const client = factory({ ...cfg, ...cred.creds });
    try {
      await client.connect();
      for (const carpeta of carpetas) {
        if (restante <= 0) { diferidas.push(carpeta); continue; }
        try {
          // Solo lectura: nada se marca como leído, se borra ni se mueve.
          const mb = await client.mailboxOpen(carpeta, { readOnly: true });
          const uidValidity = String(mb.uidValidity);
          const previo = estado.get(carpeta) || { uidValidity: '', ultimoUid: 0 };
          let maxUid = Number(previo.ultimoUid) || 0;
          // Si el servidor reinició los UIDs de ESTA carpeta, se vuelve a leer desde 30 días atrás.
          if (previo.uidValidity && String(previo.uidValidity) !== uidValidity) maxUid = 0;

          let uids;
          if (maxUid > 0) uids = (await client.search({ uid: `${maxUid + 1}:*` }, { uid: true })) || [];
          else uids = (await client.search({ since: new Date(Date.now() - DIAS_PRIMERA_SYNC * 86400000) }, { uid: true })) || [];
          // 'N:*' siempre incluye el último mensaje aunque sea anterior a N: se filtra.
          uids = uids.filter(u => u > maxUid).sort((a, b) => a - b);

          // Si no entra todo, se toman los MÁS VIEJOS y el progreso avanza solo hasta ahí:
          // el resto queda para el próximo sync y no se pierde nada.
          if (uids.length > restante) { quedanMas = true; uids = uids.slice(0, restante); }

          if (uids.length) {
            for await (const msg of client.fetch(uids, { uid: true, envelope: true, internalDate: true, source: { maxLength: MAX_BYTES_MAIL } }, { uid: true })) {
              let parsed = null;
              try { parsed = await parse(msg.source); } catch { /* mail truncado o raro: se usa el envelope */ }
              nuevos.push({ ...normalizarMensaje(msg, parsed), carpeta, uidValidity });
              if (msg.uid > maxUid) maxUid = msg.uid;
            }
            restante -= uids.length;
          }
          estadoNuevo.set(carpeta, { uidValidity, ultimoUid: maxUid });
        } catch (e) {
          // Una carpeta que falla (borrada, renombrada) no tira abajo a las demás.
          fallidas++; ultimoError = e;
          avisosCarpeta.push(`No se pudo leer la carpeta "${carpeta}": ${e && e.mailboxMissing ? 'ya no existe en la casilla' : traducirError(e)}.`);
        }
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
    // Si fallaron TODAS, es un problema de la casilla y se informa como error.
    if (carpetas.length && fallidas === carpetas.length) throw ultimoError;

    // ── Clasificación ──
    const decisiones = nuevos.map(m => C.decidirPorReglas(m, reglas));
    const paraIA = nuevos.filter((m, i) => decisiones[i].decision !== 'IGNORAR');
    let ia = [];
    let avisoIA = '';
    if (llamarIA && paraIA.length) {
      try { ia = await C.clasificarConIA(paraIA, llamarIA); }
      catch (e) { avisoIA = `IA no disponible (${String(e.message).slice(0, 80)}); se usaron solo reglas.`; ia = []; }
    }
    // La clave es el propio objeto del mail: el UID solo no alcanza, se repite entre carpetas.
    const iaPorMail = new Map(paraIA.map((m, i) => [m, ia[i] || null]));

    const pacientes = await cargarPacientes(tenantId);
    let guardados = 0, ignorados = 0;
    for (let i = 0; i < nuevos.length; i++) {
      const m = nuevos[i], r = decisiones[i], res = iaPorMail.get(m);
      let trabajo, clasificadoPor;
      if (r.decision === 'IGNORAR') { trabajo = false; clasificadoPor = 'regla'; }
      else if (r.decision === 'TRABAJO') { trabajo = true; clasificadoPor = 'regla'; }
      else if (res) { trabajo = res.trabajo; clasificadoPor = 'ia'; }
      else { trabajo = C.resolverSinIA(m, r).trabajo; clasificadoPor = 'regla'; }
      if (!trabajo) { ignorados++; continue; }

      const pac = C.vincularPaciente(m, pacientes);
      const id = idMail(m.messageId, m.carpeta, m.uidValidity, m.uid);
      const docRef = col(tenantId, 'correo_mails').doc(id);
      if ((await docRef.get()).exists) continue;
      await docRef.set({
        id, uid: m.uid, carpeta: m.carpeta, messageId: m.messageId, de: m.de, deNombre: m.deNombre, para: m.para,
        asunto: m.asunto, fecha: m.fecha, extracto: m.texto.replace(/\n{3,}/g, '\n\n').slice(0, 1500),
        adjuntos: m.adjuntos,
        categoria: res?.categoria || C.categoriaHeuristica(m),
        resumen: res?.resumen || '', accion: res?.accion || '', urgencia: res?.urgencia || 'BAJA',
        requiereAccion: !!res?.accion,
        pacienteId: pac?.id || '', pacienteNombre: pac?.nombre || '',
        clasificadoPor, motivoRegla: r.decision !== 'DUDA' || !res ? r.motivo : '',
        link: linkWeb(cfg, m.messageId), estado: 'NUEVO', creadoEn: new Date().toISOString(),
      });
      guardados++;
    }

    const avisoTope = (diferidas.length || quedanMas)
      ? `Se llegó al tope de ${MAX_POR_SYNC} mails por sincronización${diferidas.length ? ` (quedaron para la próxima: ${diferidas.map(d => `"${d}"`).join(', ')})` : ''}; el resto entra en las próximas.`
      : '';
    const aviso = [avisoIA, ...avisosCarpeta, avisoTope].filter(Boolean).join(' · ');

    const stats = { revisados: nuevos.length, guardados, ignorados };
    await ref.update({
      // Se persiste ya en el formato con carpetas: así las configs viejas quedan migradas.
      carpetas, estadoCarpetas: serializarEstado(estadoNuevo, carpetas),
      ultimaSync: new Date().toISOString(), error: '', aviso, stats,
      requiereReconexion: false,
    });
    return { ok: true, ...stats, aviso };
  } catch (e) {
    const mensaje = traducirError(e);
    try { await ref.update({ error: mensaje, ultimaSync: new Date().toISOString() }); } catch { /* ignore */ }
    return { ok: false, mensaje };
  } finally {
    enCurso.delete(tenantId);
  }
}

/** Corre la sincronización de todas las empresas con correo activo. */
async function sincronizarTodas(db) {
  const empresas = await db.collection('empresas').get();
  for (const emp of empresas.docs) {
    const cfg = await refConfig(emp.id).get();
    if (cfg.exists && cfg.data().activo !== false) {
      const r = await sincronizarEmpresa(emp.id);
      if (!r.ok) console.warn('[CORREO]', emp.id, r.mensaje);
    }
  }
}

function iniciarProgramador(db) {
  const minutos = Number(process.env.CORREO_SYNC_MINUTOS ?? 10);
  if (!minutos || minutos < 1) return null;
  // Sin clave de cifrado no se puede descifrar la contraseña guardada: cada tick
  // fallaría. Mejor no despertar el programador y avisar una sola vez al arrancar.
  if (!require('../helpers/cripto').disponible()) {
    console.warn('[CORREO] programador apagado: falta ENCRYPTION_KEY.');
    return null;
  }
  const tick = () => sincronizarTodas(db).catch(e => console.error('[CORREO] programador:', e.message));
  setTimeout(tick, 60_000);
  return setInterval(tick, minutos * 60_000);
}

module.exports = {
  probarConexion, sincronizarEmpresa, sincronizarTodas, iniciarProgramador,
  normalizarMensaje, traducirError, refConfig, crearCliente, resolverCredenciales,
  MENSAJE_RECONEXION,
  // carpetas
  CARPETA_DEFAULT, MAX_POR_SYNC, idMail, nombreCarpeta, leerCarpetas, serializarEstado,
  carpetasPendientes, reinicioCarpetas, estadoParaReescanear, normalizarListado,
  listarCarpetas, guardarCarpetas,
};
