/**
 * Datos clínicos del legajo (CUD y orden médica): lectura con IA, guardado cifrado, permisos, auditoría y recomendación.
 *
 * Todo con Firestore en memoria y un cliente de IA falso: sin red, sin clave de la IA, sin datos reales.
 * El diagnóstico de las pruebas es una frase inventada ("SENTINELA…") para poder buscarla: si aparece en texto
 * plano en cualquier documento de la base, en un log o en un listado, el test falla.
 *
 * Correr: npm test
 */
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);   // antes de cargar helpers/cripto

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');

const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const C = require('../services/legajoClinico');
const S = require('../services/legajoIA');
const { crearStore } = require('../services/legajoClinicoStore');
const { puedeVerClinico } = require('../middleware/permisos');

const RAIZ = path.join(__dirname, '..');
const SENT = 'SENTINELA trastorno inventado de prueba';
const CIE = 'F84.0';
const CERT = 'CERT-777-XYZ';
const b64 = txt => Buffer.from(txt).toString('base64');
const archivo = txt => ({ base64: b64(txt), mimeType: 'image/jpeg', nombre: 'doc.jpg' });
const respuesta = obj => ({ texto: typeof obj === 'string' ? obj : JSON.stringify(obj), uso: { entrada: 1000, salida: 300 }, modelo: 'modelo-de-prueba', parada: 'end_turn' });

const base = (tipoKey, clinico) => ({
  legible: true,
  tipo: { requisitoKey: tipoKey, descripcion: tipoKey, confianza: 'alta' },
  fechaEmision: { valor: '10/10/2026', confianza: 'alta' }, fechaVenc: { valor: '10/10/2031', confianza: 'alta' },
  paciente: { nombre: { valor: 'Paciente Ficticio', confianza: 'alta' }, dni: { valor: '30111222', confianza: 'alta' } },
  emisor: { valor: 'Junta Ficticia', confianza: 'media' }, presupuesto: null, clinico,
});
const clinicoCud = (extra = {}) => ({
  documento: 'cud', diagnostico: { valor: SENT, confianza: 'alta' }, cie10: { valor: CIE, confianza: 'alta' },
  tipoDiscapacidad: { valor: 'Mental', confianza: 'media' }, nroCertificado: { valor: CERT, confianza: 'alta' },
  vencimientoCertificado: { valor: '10/10/2031', confianza: 'alta' },
  orientacionTexto: { valor: 'Centro de día, jornada simple', confianza: 'alta' },
  orientacionPrestaciones: { valor: ['centro_dia'], confianza: 'alta' }, ...extra,
});
const clinicoOrden = (extra = {}) => ({
  documento: 'orden_medica', diagnostico: { valor: SENT, confianza: 'alta' },
  prestacionIndicada: { valor: 'Centro de día, jornada simple, 5 días por semana', confianza: 'alta' },
  diasPorSemana: { valor: 5, confianza: 'alta' }, profesional: { valor: 'Dra. Ficticia', confianza: 'media' }, ...extra,
});

/* ── Servicio puro ───────────────────────────────────────────────────────── */

describe('parsearClinico', () => {
  test('CUD: campos, CIE-10 válido y orientación normalizada', () => {
    const r = C.parsearClinico(clinicoCud());
    assert.equal(r.documento, 'cud');
    assert.equal(r.campos.cie10.valor, 'F84.0');
    assert.equal(r.campos.vencimientoCertificado.valor, '10/10/2031');
    assert.deepEqual(r.campos.orientacionPrestaciones.valor, ['centro_dia']);
  });
  test('CIE-10 inválido y fecha imposible se descartan con advertencia', () => {
    const r = C.parsearClinico(clinicoCud({ cie10: { valor: 'zzz', confianza: 'alta' }, vencimientoCertificado: { valor: '45/13/2030', confianza: 'alta' } }));
    assert.ok(!r.campos.cie10 && !r.campos.vencimientoCertificado);
    assert.equal(r.advertencias.length, 2);
  });
  test('la orientación solo admite modalidades conocidas; si la lista falta, se deduce del texto con menos confianza', () => {
    const a = C.parsearClinico(clinicoCud({ orientacionPrestaciones: { valor: ['centro_dia', 'inventada'], confianza: 'alta' } }));
    assert.deepEqual(a.campos.orientacionPrestaciones.valor, ['centro_dia']);
    const b = C.parsearClinico(clinicoCud({ orientacionPrestaciones: undefined }));
    assert.deepEqual(b.campos.orientacionPrestaciones.valor, ['centro_dia']);
    assert.equal(b.campos.orientacionPrestaciones.confianza, 'media');
  });
  test('orden médica: días por semana entre 1 y 7', () => {
    assert.equal(C.parsearClinico(clinicoOrden()).campos.diasPorSemana.valor, 5);
    const r = C.parsearClinico(clinicoOrden({ diasPorSemana: { valor: 9, confianza: 'alta' } }));
    assert.ok(!r.campos.diasPorSemana);
    assert.equal(r.advertencias.length, 1);
  });
  test('campos faltantes: no inventa nada; un valor suelto entra con confianza baja', () => {
    const r = C.parsearClinico({ documento: 'cud', diagnostico: 'Solo el texto' });
    assert.equal(r.campos.diagnostico.confianza, 'baja');
    assert.equal(Object.keys(r.campos).length, 1);
  });
  test('documento que no es CUD ni orden, o basura: null', () => {
    assert.equal(C.parsearClinico({ documento: 'dni', diagnostico: { valor: 'x' } }), null);
    assert.equal(C.parsearClinico('texto'), null);
    assert.equal(C.parsearClinico(null), null);
    assert.equal(C.parsearClinico([]), null);
  });
});

describe('parsearLectura con y sin permiso clínico', () => {
  const ctx = { requisitos: [{ key: 'cud', nombre: 'CUD' }] };
  const ahora = new Date(2026, 10, 25);
  test('sin permiso se ignora "clinico" aunque la IA lo mande (un documento no puede colarlo)', () => {
    const l = S.parsearLectura(JSON.stringify(base('cud', clinicoCud())), ctx, ahora);
    assert.ok(!('clinico' in l));
  });
  test('con permiso se incluye', () => {
    const l = S.parsearLectura(JSON.stringify(base('cud', clinicoCud())), { ...ctx, pedirClinico: true }, ahora);
    assert.equal(l.clinico.documento, 'cud');
  });
  test('con fences y texto alrededor igual se interpreta', () => {
    const l = S.parsearLectura('Va:\n```json\n' + JSON.stringify(base('cud', clinicoCud())) + '\n```', { ...ctx, pedirClinico: true }, ahora);
    assert.equal(l.clinico.campos.cie10.valor, 'F84.0');
  });
  test('JSON roto: el error NO cita el contenido (ni el diagnóstico)', async () => {
    const roto = `{"legible": true, "clinico": {"diagnostico": {"valor": "${SENT}", "confi`;
    await assert.rejects(
      S.leerDocumento({ archivo: { base64: b64('x'), mime: 'image/jpeg' }, contexto: { ...ctx, pedirClinico: true }, beneficiario: {}, llamar: async () => respuesta(roto) }),
      e => e.codigo === 'sin_json' && !JSON.stringify(e).includes('SENTINELA') && !String(e.message).includes('SENTINELA') && !('causa' in e),
    );
  });
  test('el prompt pide lo clínico solo con permiso, y nunca medicación', () => {
    const con = S.construirPrompt({ ...ctx, pedirClinico: true });
    const sin = S.construirPrompt(ctx);
    assert.match(con, /orientacionPrestaciones/);
    assert.match(con, /NUNCA extraigas medicación/);
    assert.ok(!/orientacionPrestaciones/.test(sin));
    assert.match(sin, /NO extraigas diagnósticos/);
  });
});

describe('recomendarCentro', () => {
  test('la orientación del CUD manda sobre el diagnóstico', () => {
    const r = C.recomendarCentro({ diagnostico: 'Parálisis cerebral', orientacionPrestaciones: ['centro_dia'] });
    assert.equal(r.sugerencias[0].modalidad, 'centro_dia');
    assert.equal(r.base, 'cud');
    assert.ok(!r.sugerencias.some(s => s.modalidad === 'rehabilitacion_ambulatoria'));
  });
  test('también lee la orientación escrita en texto', () => {
    const r = C.recomendarCentro({ orientacionTexto: 'Escuela especial con apoyo terapéutico' });
    assert.equal(r.sugerencias[0].modalidad, 'escuela_especial');
  });
  test('sin CUD usa la prestación de la orden médica; y recién después el diagnóstico', () => {
    assert.equal(C.recomendarCentro({ prestacionIndicada: 'Rehabilitación kinesiológica' }).sugerencias[0].fuente, 'orden');
    const d = C.recomendarCentro({ diagnostico: 'Trastorno del espectro autista (TEA)' });
    assert.equal(d.base, 'diagnostico');
    assert.match(d.sugerencias[0].motivo, /Orientativo/);
  });
  test('máximo 3, sin repetir, y sin datos no sugiere nada', () => {
    const r = C.recomendarCentro({ orientacionPrestaciones: ['centro_dia', 'hogar', 'escuela_especial', 'taller_protegido'], prestacionIndicada: 'centro de día' });
    assert.equal(r.sugerencias.length, 3);
    assert.equal(new Set(r.sugerencias.map(s => s.modalidad)).size, 3);
    assert.deepEqual(C.recomendarCentro({}), { sugerencias: [], base: 'ninguna' });
  });
});

describe('permisos', () => {
  test('solo admin/administrador con empresa', () => {
    assert.equal(puedeVerClinico({ rol: 'admin', tenantId: 't1' }), true);
    assert.equal(puedeVerClinico({ rol: 'administrador', tenantId: 't1' }), true);
    assert.equal(puedeVerClinico({ rol: 'chofer', tenantId: 't1' }), false);
    assert.equal(puedeVerClinico({ rol: 'admin' }), false);
    assert.equal(puedeVerClinico({ rol: 'superadmin', superadmin: true }), false);
    assert.equal(puedeVerClinico(null), false);
  });
});

/* ── Endpoints con Firestore en memoria ──────────────────────────────────── */

const abiertos = new Set();
after(() => { for (const c of abiertos) c(); });

function montar({ llamador, cifrado } = {}) {
  const db = fakeDb();
  const utils = { ...fakeUtils(db), randomUUID: () => crypto.randomUUID(), nombreUsuario: u => (u && u.nombre) || 'admin' };
  const rutas = ['routes/legajos-ia.js', 'routes/legajos-clinico.js', 'services/legajos.js'].map(r => require.resolve(path.join(RAIZ, r)));
  const auth = {
    verifyToken: (req, res, next) => {
      req.tenantId = req.headers['x-tenant'] || 't1';
      req.user = { uid: 'u-' + (req.headers['x-rol'] || 'admin'), nombre: 'Persona ' + (req.headers['x-rol'] || 'admin'), rol: req.headers['x-rol'] || 'admin', tenantId: req.tenantId };
      next();
    },
    requireAdmin: (req, res, next) => next(),
  };
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (padre && rutas.includes(padre.filename)) {
      if (pedido === '../utils') return utils;
      if (pedido === '../middleware/auth') return auth;
    }
    return original.call(this, pedido, padre, esMain);
  };
  let fabIA, fabClin;
  try { rutas.forEach(r => delete require.cache[r]); fabIA = require(rutas[0]); fabClin = require(rutas[1]); } finally { Module._load = original; }

  const ahora = () => new Date(2026, 10, 25, 12);
  const store = crearStore({ col: utils.col, ahora, ...(cifrado ? { cifrado } : {}) });
  const subidas = [];
  const prepararArchivo = async (t, b, a) => { subidas.push(1); return { archivoUrl: `https://almacen.test/${subidas.length}`, archivoNombre: a.nombre, archivoRuta: `r/${subidas.length}` }; };
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  app.use('/api/legajos', fabIA({ prepararArchivo, llamador, ahora, almacenClinico: store, limitador: S.crearLimitador({ max: 100 }) }));
  app.use('/api/legajos', fabClin({ almacenClinico: store, ahora }));
  const server = app.listen(0, '127.0.0.1');
  return new Promise(r => server.once('listening', () => {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/legajos`;
    const llamar = async (metodo, ruta, body, { tenant = 't1', rol = 'admin' } = {}) => {
      const res = await fetch(baseUrl + ruta, { method: metodo, headers: { 'content-type': 'application/json', 'x-tenant': tenant, 'x-rol': rol }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json(), headers: res.headers };
    };
    const cerrar = () => { server.closeAllConnections(); server.close(); };
    abiertos.add(cerrar);
    r({ db, store, subidas, post: (...a) => llamar('POST', ...a), get: (r2, o) => llamar('GET', r2, undefined, o), put: (...a) => llamar('PUT', ...a), cerrar });
  }));
}

function sembrar(db, tenant = 't1') {
  db.docs.set(`empresas/${tenant}/registro/b1`, { 'APELLIDO Y NOMBRE': 'Paciente Ficticio', DNI: '30111222', 'OBRA SOCIAL': 'OSDE' });
  db.docs.set(`empresas/${tenant}/registro/b2`, { 'APELLIDO Y NOMBRE': 'Otra Persona', DNI: '20999888', 'OBRA SOCIAL': 'OSDE' });
  db.docs.set(`empresas/${tenant}/requisitos_os/osde`, { nombre: 'OSDE', alias: [], requisitos: [
    { key: 'cud', nombre: 'CUD', categoria: 'paciente', vencimiento: 'fecha_doc', vigenciaMeses: 0 },
    { key: 'orden_medica', nombre: 'Orden médica', categoria: 'paciente', vencimiento: 'meses', vigenciaMeses: 6 },
  ] });
}
const toda = db => JSON.stringify([...db.docs.entries()]);
const sinTextoClinico = (texto, donde) => {
  for (const s of [SENT, CIE, CERT, 'Centro de día, jornada simple']) assert.ok(!texto.includes(s), `"${s}" apareció en claro en ${donde}`);
};

function capturarLogs() {
  const lineas = [], orig = [console.log, console.error, console.warn, console.info];
  const f = (...a) => lineas.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.log = console.error = console.warn = console.info = f;
  return { lineas, parar: () => { [console.log, console.error, console.warn, console.info] = orig; } };
}

describe('leer-ia con datos clínicos', () => {
  let ctx, prompts;
  const iniciar = async (resp, opts = {}) => {
    prompts = [];
    ctx = await montar({ llamador: () => async a => { prompts.push(a.prompt); return resp(a); }, ...opts });
    sembrar(ctx.db);
  };
  beforeEach(() => { if (ctx) ctx.cerrar(); ctx = null; });

  test('un admin recibe el diagnóstico en la respuesta, pero NADA queda en la caché ni en la base', async () => {
    await iniciar(() => respuesta(base('cud', clinicoCud())));
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-1')] });
    const it = r.json.resultados[0];
    assert.equal(it.clinico.documento, 'cud');
    assert.equal(it.clinico.campos.diagnostico.valor, SENT);
    const cache = ctx.db.docs.get(`empresas/t1/legajo_lecturas/b1_${crypto.createHash('sha256').update(Buffer.from('cud-1')).digest('hex')}`);
    assert.equal(cache.resultado.clinicoDocumento, 'cud');     // solo "era un CUD"
    assert.ok(!('clinico' in cache.resultado));
    sinTextoClinico(toda(ctx.db), 'la base');
    ctx.cerrar();
  });

  test('sin permiso (rol chofer) no se le pide ni se le devuelve nada clínico', async () => {
    await iniciar(() => respuesta(base('cud', clinicoCud())));
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-2')] }, { rol: 'chofer' });
    assert.ok(!('clinico' in r.json.resultados[0]));
    assert.ok(!/orientacionPrestaciones/.test(prompts[0]));
    sinTextoClinico(JSON.stringify(r.json), 'la respuesta');
    ctx.cerrar();
  });

  test('el prompt no lleva datos del paciente ni de la base', async () => {
    await iniciar(() => respuesta(base('cud', clinicoCud())));
    await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-3')] });
    assert.ok(!prompts[0].includes('Paciente Ficticio') && !prompts[0].includes('30111222'));
    ctx.cerrar();
  });

  test('un CUD sin confirmar se vuelve a leer (lo clínico no está en la caché) sin subir de nuevo el archivo', async () => {
    let n = 0;
    await iniciar(() => { n++; return respuesta(base('cud', clinicoCud())); });
    await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-4')] });
    const r2 = await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-4')] });
    assert.equal(n, 2);
    assert.equal(ctx.subidas.length, 1);
    assert.equal(r2.json.resultados[0].clinico.campos.diagnostico.valor, SENT);
    ctx.cerrar();
  });

  test('un documento que no es CUD/orden médica no trae datos clínicos', async () => {
    await iniciar(() => respuesta(base('otro', null)));
    const it = (await ctx.post('/b1/leer-ia', { archivos: [archivo('dni-1')] })).json.resultados[0];
    assert.ok(!it.clinico);
    ctx.cerrar();
  });

  test('paciente que no coincide: sigue avisando, también en un CUD', async () => {
    await iniciar(() => respuesta({ ...base('cud', clinicoCud()), paciente: { nombre: { valor: 'Marta Gómez', confianza: 'alta' }, dni: { valor: '11000111', confianza: 'alta' } } }));
    const it = (await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-5')] })).json.resultados[0];
    assert.equal(it.posiblePacienteEquivocado, true);
    ctx.cerrar();
  });

  test('los logs (incluso con JSON roto que cita el diagnóstico) no llevan datos clínicos', async () => {
    const logs = capturarLogs();
    try {
      await iniciar(() => respuesta(`{"clinico": {"diagnostico": {"valor": "${SENT}", "cie10": "${CIE}`));
      await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-6')] });
      ctx.cerrar();
      await iniciar(() => { throw Object.assign(new Error(`falló leyendo ${SENT}`), { status: 500 }); });
      await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-7')] });
      ctx.cerrar();
      await iniciar(() => respuesta(base('cud', clinicoCud())));
      const it = (await ctx.post('/b1/leer-ia', { archivos: [archivo('cud-8')] })).json.resultados[0];
      await ctx.post('/b1/confirmar-lectura', { items: [{ hash: it.hash, requisitoKey: 'cud', fechaEmision: '10/10/2026', fechaVenc: '10/10/2031', clinico: { documento: 'cud', campos: it.clinico.campos } }] });
      await ctx.get('/b1/clinico');
    } finally { logs.parar(); }
    sinTextoClinico(logs.lineas.join('\n'), 'los logs');
    assert.ok(logs.lineas.some(l => l.includes('[LEGAJO-IA]')));
  });
});

describe('confirmar-lectura, guardado cifrado y auditoría', () => {
  let ctx;
  beforeEach(() => { if (ctx) ctx.cerrar(); ctx = null; });
  const iniciar = async (opts = {}) => { ctx = await montar({ llamador: () => async () => respuesta(opts.resp || base('cud', clinicoCud())), cifrado: opts.cifrado }); sembrar(ctx.db); };
  const leerYConfirmar = async (txt, { rol = 'admin', tenant = 't1', benId = 'b1', clinicoExtra } = {}) => {
    const it = (await ctx.post(`/${benId}/leer-ia`, { archivos: [archivo(txt)] }, { rol, tenant })).json.resultados[0];
    const clinico = clinicoExtra || (it.clinico && { documento: it.clinico.documento, campos: it.clinico.campos });
    return { it, r: await ctx.post(`/${benId}/confirmar-lectura`, { items: [{ hash: it.hash, requisitoKey: it.requisitoKey, fechaEmision: '10/10/2026', fechaVenc: '10/10/2031', clinico }] }, { rol, tenant }) };
  };

  test('lo confirmado se guarda CIFRADO: en la base no hay ningún dato clínico en claro', async () => {
    await iniciar();
    const { r } = await leerYConfirmar('c1');
    assert.equal(r.json.resultados[0].ok, true);
    assert.equal(r.json.resultados[0].clinicoGuardado, true);
    const doc = ctx.db.docs.get('empresas/t1/legajo_clinico/b1');
    assert.match(doc.datos, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);       // iv:tag:cifrado
    sinTextoClinico(toda(ctx.db), 'la base');
    // y el legajo_doc guardado no lleva campos clínicos
    const ld = [...ctx.db.docs.entries()].find(([k]) => k.includes('/legajo_docs/'))[1];
    assert.ok(!('cie10' in ld) && !('diagnostico' in ld) && !('clinico' in ld));
    ctx.cerrar();
  });

  test('ver devuelve lo descifrado + la sugerencia, con origen "ia" y confianza por dato, sin caché', async () => {
    await iniciar();
    await leerYConfirmar('c2');
    const g = await ctx.get('/b1/clinico');
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('cache-control'), 'no-store');
    const campo = g.json.clinico.cud.campos.diagnostico;
    assert.equal(campo.valor, SENT);
    assert.equal(campo.origen, 'ia');
    assert.equal(campo.confianza, 'alta');
    assert.equal(g.json.recomendacion.sugerencias[0].modalidad, 'centro_dia');
    ctx.cerrar();
  });

  test('auditoría: quién creó y quién vio, cuándo, con nombres de campos y sin valores', async () => {
    await iniciar();
    await leerYConfirmar('c3');
    await ctx.get('/b1/clinico', { rol: 'administrador' });
    const a = await ctx.get('/b1/clinico/auditoria');
    assert.equal(a.status, 200);
    const acciones = a.json.eventos.map(e => e.accion).sort();
    assert.deepEqual(acciones, ['crear', 'ver']);
    const crear = a.json.eventos.find(e => e.accion === 'crear');
    assert.ok(crear.campos.includes('cud.diagnostico'));
    assert.ok(crear.usuario && crear.en && crear.uid);
    sinTextoClinico(JSON.stringify(a.json), 'la auditoría');
    ctx.cerrar();
  });

  test('sin permiso: 403 para ver, editar y auditoría; y confirmar con datos clínicos se rechaza sin crear nada', async () => {
    await iniciar();
    await leerYConfirmar('c4');
    for (const [m, ruta, body] of [['GET', '/b1/clinico'], ['PUT', '/b1/clinico', { modalidadElegida: ['centro_dia'] }], ['GET', '/b1/clinico/auditoria']]) {
      const r = m === 'GET' ? await ctx.get(ruta, { rol: 'chofer' }) : await ctx.put(ruta, body, { rol: 'chofer' });
      assert.equal(r.status, 403, `${m} ${ruta}`);
      sinTextoClinico(JSON.stringify(r.json), 'el 403');
    }
    const antes = [...ctx.db.docs.keys()].filter(k => k.includes('/legajo_docs/')).length;
    const { r } = await leerYConfirmar('c5', { rol: 'chofer', clinicoExtra: { documento: 'cud', campos: { diagnostico: { valor: 'x' } } } });
    assert.equal(r.json.resultados[0].status, 403);
    assert.equal([...ctx.db.docs.keys()].filter(k => k.includes('/legajo_docs/')).length, antes);
    ctx.cerrar();
  });

  test('aislamiento entre empresas: otra empresa no ve nada y no se mezclan los datos', async () => {
    await iniciar();
    sembrar(ctx.db, 't2');
    await leerYConfirmar('c6');
    // t2 consulta el mismo id: es SU b1 (sin datos clínicos)
    const g = await ctx.get('/b1/clinico', { tenant: 't2' });
    assert.equal(g.status, 200);
    assert.equal(g.json.clinico, null);
    sinTextoClinico(JSON.stringify(g.json), 't2');
    assert.ok(!ctx.db.docs.has('empresas/t2/legajo_clinico/b1'));
    // y un paciente inexistente en t2: 404
    assert.equal((await ctx.get('/nadie/clinico', { tenant: 't2' })).status, 404);
    ctx.cerrar();
  });

  test('un blob copiado de otro paciente no se acepta', async () => {
    await iniciar();
    await leerYConfirmar('c7');
    ctx.db.docs.set('empresas/t1/legajo_clinico/b2', { ...ctx.db.docs.get('empresas/t1/legajo_clinico/b1'), beneficiarioId: 'b2' });
    const g = await ctx.get('/b2/clinico');
    assert.equal(g.status, 500);
    assert.equal(g.json.codigo, 'clinico_ilegible');
    ctx.cerrar();
  });

  test('si no se puede descifrar (clave perdida o dato dañado): error claro, sin contenido, y se registra solo el código', async () => {
    await iniciar();
    await leerYConfirmar('c8');
    const doc = ctx.db.docs.get('empresas/t1/legajo_clinico/b1');
    ctx.db.docs.set('empresas/t1/legajo_clinico/b1', { ...doc, datos: doc.datos.replace(/.$/, c => (c === '0' ? '1' : '0')) });
    const logs = capturarLogs();
    let g;
    try { g = await ctx.get('/b1/clinico'); } finally { logs.parar(); }
    assert.equal(g.status, 500);
    assert.equal(g.json.codigo, 'clinico_ilegible');
    sinTextoClinico(logs.lineas.join('\n') + JSON.stringify(g.json), 'el log/respuesta');
    ctx.cerrar();
  });

  test('sin clave de cifrado: nunca se guarda en texto plano (503) y el documento no se crea', async () => {
    await iniciar({ cifrado: { disponible: () => false, encriptar: () => { throw new Error('no'); }, desencriptar: () => { throw new Error('no'); } } });
    const { r } = await leerYConfirmar('c9');
    assert.equal(r.json.resultados[0].status, 503);
    assert.ok(![...ctx.db.docs.keys()].some(k => k.includes('/legajo_docs/') || k.includes('/legajo_clinico/')));
    sinTextoClinico(toda(ctx.db), 'la base');
    ctx.cerrar();
  });

  test('confirmar dos veces no duplica; datos inválidos se rechazan antes de escribir', async () => {
    await iniciar();
    const { it } = await leerYConfirmar('c10');
    const item = { hash: it.hash, requisitoKey: 'cud', fechaEmision: '10/10/2026', fechaVenc: '10/10/2031', clinico: { documento: 'cud', campos: it.clinico.campos } };
    const r2 = await ctx.post('/b1/confirmar-lectura', { items: [item] });
    assert.equal(r2.json.resultados[0].yaExistia, true);
    assert.equal([...ctx.db.docs.keys()].filter(k => k.includes('/legajo_docs/')).length, 1);
    // inválido, sobre otro archivo
    const it2 = (await ctx.post('/b1/leer-ia', { archivos: [archivo('c11')] })).json.resultados[0];
    const malo = await ctx.post('/b1/confirmar-lectura', { items: [{ hash: it2.hash, requisitoKey: 'cud', fechaEmision: '10/10/2026', fechaVenc: '10/10/2031', clinico: { documento: 'cud', campos: { cie10: { valor: 'zzz' } } } }] });
    assert.equal(malo.json.resultados[0].status, 400);
    assert.equal([...ctx.db.docs.keys()].filter(k => k.includes('/legajo_docs/')).length, 1);
    ctx.cerrar();
  });

  test('el CUD y la orden médica de un mismo paciente conviven', async () => {
    await iniciar();
    await leerYConfirmar('m1');
    ctx.cerrar();
    // misma base, otra lectura: orden médica
    const dbPrevia = ctx.db;
    await iniciar({ resp: base('orden_medica', clinicoOrden()) });
    for (const [k, v] of dbPrevia.docs) ctx.db.docs.set(k, v);
    await leerYConfirmar('m2');
    const g = await ctx.get('/b1/clinico');
    assert.ok(g.json.clinico.cud && g.json.clinico.ordenMedica);
    assert.equal(g.json.clinico.ordenMedica.campos.diasPorSemana.valor, 5);
    assert.equal(g.json.recomendacion.base, 'cud');     // el CUD manda
    ctx.cerrar();
  });

  test('editar: corrige un dato (origen manual), quita otro, elige modalidad, y queda en la auditoría', async () => {
    await iniciar();
    await leerYConfirmar('e1');
    const r = await ctx.put('/b1/clinico', { documento: 'cud', campos: { diagnostico: 'Dx corregido a mano', tipoDiscapacidad: '' }, modalidadElegida: ['escuela_especial'] });
    assert.equal(r.status, 200);
    const c = r.json.clinico;
    assert.equal(c.cud.campos.diagnostico.valor, 'Dx corregido a mano');
    assert.equal(c.cud.campos.diagnostico.origen, 'manual');
    assert.ok(!c.cud.campos.tipoDiscapacidad);
    assert.deepEqual(c.modalidadElegida, ['escuela_especial']);
    const a = (await ctx.get('/b1/clinico/auditoria')).json.eventos;
    assert.ok(a.filter(e => e.accion === 'editar').length >= 1);
    sinTextoClinico(toda(ctx.db), 'la base');
    // inválidos
    assert.equal((await ctx.put('/b1/clinico', { documento: 'cud', campos: { cie10: 'zzz' } })).status, 400);
    assert.equal((await ctx.put('/b1/clinico', { documento: 'cud', campos: { inventado: 'x' } })).status, 400);
    assert.equal((await ctx.put('/b1/clinico', {})).status, 400);
    ctx.cerrar();
  });
});

describe('los datos clínicos no salen por listados, pizarra ni exportaciones', () => {
  test('ninguna otra ruta o servicio lee la colección clínica', () => {
    const dueños = ['routes/legajos-clinico.js', 'routes/legajos-ia.js', 'services/legajoClinicoStore.js', 'services/legajoClinico.js'];
    const archivos = [];
    for (const dir of ['routes', 'services', 'helpers', 'utils']) for (const f of fs.readdirSync(path.join(RAIZ, dir))) if (f.endsWith('.js')) archivos.push(`${dir}/${f}`);
    archivos.push('utils.js', 'index.js');
    for (const f of archivos) {
      if (dueños.includes(f)) continue;
      const txt = fs.readFileSync(path.join(RAIZ, f), 'utf8');
      assert.ok(!/legajo_clinico/.test(txt), `${f} no debería tocar legajo_clinico`);
    }
  });
  test('legajos.js solo monta el router clínico; no lo lee', () => {
    const txt = fs.readFileSync(path.join(RAIZ, 'routes/legajos.js'), 'utf8');
    assert.ok(!/legajo_clinico/.test(txt));
    assert.match(txt, /legajos-clinico/);
  });
});
