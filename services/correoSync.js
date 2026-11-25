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

const idMail = (messageId, uidValidity, uid) =>
  createHash('sha1').update(messageId || `${uidValidity}:${uid}`).digest('hex').slice(0, 24);

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
    const client = factory({ ...cfg, ...cred.creds });
    const nuevos = [];
    let uidValidity, maxUid = Number(cfg.ultimoUid) || 0;
    try {
      await client.connect();
      const mb = await client.mailboxOpen('INBOX', { readOnly: true });
      uidValidity = String(mb.uidValidity);
      // Si el servidor reinició los UIDs, se vuelve a leer desde 30 días atrás.
      if (cfg.uidValidity && String(cfg.uidValidity) !== uidValidity) maxUid = 0;
      let uids;
      if (maxUid > 0) uids = (await client.search({ uid: `${maxUid + 1}:*` }, { uid: true })) || [];
      else uids = (await client.search({ since: new Date(Date.now() - DIAS_PRIMERA_SYNC * 86400000) }, { uid: true })) || [];
      uids = uids.filter(u => u > maxUid).sort((a, b) => a - b).slice(-MAX_POR_SYNC);
      if (uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, internalDate: true, source: { maxLength: MAX_BYTES_MAIL } }, { uid: true })) {
          let parsed = null;
          try { parsed = await parse(msg.source); } catch { /* mail truncado o raro: se usa el envelope */ }
          nuevos.push(normalizarMensaje(msg, parsed));
          if (msg.uid > maxUid) maxUid = msg.uid;
        }
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }

    // ── Clasificación ──
    const decisiones = nuevos.map(m => C.decidirPorReglas(m, reglas));
    const paraIA = nuevos.filter((m, i) => decisiones[i].decision !== 'IGNORAR');
    let ia = [];
    let avisoIA = '';
    if (llamarIA && paraIA.length) {
      try { ia = await C.clasificarConIA(paraIA, llamarIA); }
      catch (e) { avisoIA = `IA no disponible (${String(e.message).slice(0, 80)}); se usaron solo reglas.`; ia = []; }
    }
    const iaPorUid = new Map(paraIA.map((m, i) => [m.uid, ia[i] || null]));

    const pacientes = await cargarPacientes(tenantId);
    let guardados = 0, ignorados = 0;
    for (let i = 0; i < nuevos.length; i++) {
      const m = nuevos[i], r = decisiones[i], res = iaPorUid.get(m.uid);
      let trabajo, clasificadoPor;
      if (r.decision === 'IGNORAR') { trabajo = false; clasificadoPor = 'regla'; }
      else if (r.decision === 'TRABAJO') { trabajo = true; clasificadoPor = 'regla'; }
      else if (res) { trabajo = res.trabajo; clasificadoPor = 'ia'; }
      else { trabajo = C.resolverSinIA(m, r).trabajo; clasificadoPor = 'regla'; }
      if (!trabajo) { ignorados++; continue; }

      const pac = C.vincularPaciente(m, pacientes);
      const id = idMail(m.messageId, uidValidity, m.uid);
      const docRef = col(tenantId, 'correo_mails').doc(id);
      if ((await docRef.get()).exists) continue;
      await docRef.set({
        id, uid: m.uid, messageId: m.messageId, de: m.de, deNombre: m.deNombre, para: m.para,
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

    const stats = { revisados: nuevos.length, guardados, ignorados };
    await ref.update({
      uidValidity: uidValidity || cfg.uidValidity || '', ultimoUid: maxUid,
      ultimaSync: new Date().toISOString(), error: '', aviso: avisoIA, stats,
      requiereReconexion: false,
    });
    return { ok: true, ...stats, aviso: avisoIA };
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
};
