/**
 * Lectura de documentos del legajo con IA (routes/legajos-ia.js + services/legajoIA.js).
 *
 * Todo con un Firestore en memoria y un cliente de IA falso: no hay red, no hay clave, no hay datos reales.
 * Lo que se asegura:
 *  - leer-ia NO guarda nada en legajo_docs ni en vencimientos; confirmar-lectura sí, con origen "ia";
 *  - JSON válido, JSON con ``` y texto suelto, JSON roto, fechas imposibles;
 *  - documento de otra persona: se avisa y no se guarda sin confirmación explícita;
 *  - el mismo archivo no se vuelve a pagar (caché por sha256) y no se duplica el documento;
 *  - 503 sin clave, archivo muy grande, formato no permitido, HEIC, tope de archivos, límite por empresa;
 *  - una empresa no puede leer ni confirmar lo de otra;
 *  - los logs no llevan contenido de documentos ni datos personales.
 *
 * Correr: npm test
 */
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const S = require('../services/legajoIA');

const RAIZ = path.join(__dirname, '..');
const NOMBRE_PRIVADO = 'Zulema Quintanilla';   // dato "personal" ficticio, para comprobar que no aparece en los logs
const DNI_PRIVADO = '30111222';

const b64 = txt => Buffer.from(txt).toString('base64');
const archivo = (txt, extra = {}) => ({ base64: b64(txt), mimeType: 'image/jpeg', nombre: 'foto.jpg', ...extra });
const hashDe = txt => crypto.createHash('sha256').update(Buffer.from(txt)).digest('hex');

const respuesta = (obj, uso = { entrada: 1200, salida: 300 }) => ({ texto: typeof obj === 'string' ? obj : JSON.stringify(obj), uso, modelo: 'modelo-de-prueba', parada: 'end_turn' });
const ordenOk = (extra = {}) => ({
  legible: true,
  tipo: { requisitoKey: 'orden_medica', descripcion: 'Orden médica', confianza: 'alta' },
  fechaEmision: { valor: '10/10/2026', confianza: 'alta' },
  fechaVenc: { valor: null, confianza: 'baja' },
  paciente: { nombre: { valor: NOMBRE_PRIVADO, confianza: 'alta' }, dni: { valor: DNI_PRIVADO, confianza: 'alta' }, obraSocial: { valor: 'OSDE', confianza: 'media' }, afiliado: { valor: '123', confianza: 'media' } },
  emisor: { valor: 'Dra. Prueba', confianza: 'media' },
  presupuesto: null,
  ...extra,
});

/* ── Montaje: router real, Firestore en memoria, IA y auth falsas ─────────── */

const abiertos = new Set();   // servidores de prueba; se cierran todos al terminar para que el proceso salga
after(() => { for (const c of abiertos) c(); });

function montar({ llamador, limitador, prepararArchivo } = {}) {
  const db = fakeDb();
  const utils = { ...fakeUtils(db), randomUUID: () => crypto.randomUUID(), nombreUsuario: u => (u && u.nombre) || 'admin' };
  const rutaIA = require.resolve(path.join(RAIZ, 'routes/legajos-ia.js'));
  const rutaLeg = require.resolve(path.join(RAIZ, 'services/legajos.js'));
  const auth = { verifyToken: (req, res, next) => { req.tenantId = req.headers['x-tenant'] || 't1'; req.user = { nombre: 'Admin Prueba' }; next(); }, requireAdmin: (req, res, next) => next() };
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (padre && (padre.filename === rutaIA || padre.filename === rutaLeg)) {
      if (pedido === '../utils') return utils;
      if (pedido === '../middleware/auth') return auth;
    }
    return original.call(this, pedido, padre, esMain);
  };
  let fabrica;
  try { delete require.cache[rutaIA]; delete require.cache[rutaLeg]; fabrica = require(rutaIA); } finally { Module._load = original; }

  const subidas = [];
  const subir = prepararArchivo || (async (tenantId, benId, a) => { subidas.push({ tenantId, benId }); return { archivoUrl: `https://almacen.test/${tenantId}/${benId}/${subidas.length}`, archivoNombre: a.nombre, archivoRuta: `legajos/${tenantId}/${benId}/${subidas.length}` }; });
  const router = fabrica({ prepararArchivo: subir, llamador, limitador, ahora: () => new Date(2026, 10, 25, 12) });
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  app.use('/api/legajos', router);
  const server = app.listen(0, '127.0.0.1');
  return new Promise(r => server.once('listening', () => {
    const base = `http://127.0.0.1:${server.address().port}/api/legajos`;
    const post = async (ruta, body, tenant = 't1') => {
      const res = await fetch(base + ruta, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': tenant }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const cerrar = () => { server.closeAllConnections(); server.close(); };
    abiertos.add(cerrar);
    r({ db, post, subidas, cerrar });
  }));
}

function sembrar(db, tenant = 't1') {
  db.docs.set(`empresas/${tenant}/registro/b1`, { 'APELLIDO Y NOMBRE': NOMBRE_PRIVADO, DNI: DNI_PRIVADO, 'OBRA SOCIAL': 'OSDE' });
  db.docs.set(`empresas/${tenant}/requisitos_os/osde`, {
    nombre: 'OSDE', alias: [],
    requisitos: [
      { key: 'orden_medica', nombre: 'Orden médica', categoria: 'paciente', vencimiento: 'meses', vigenciaMeses: 6 },
      { key: 'dni', nombre: 'DNI', categoria: 'paciente', vencimiento: 'ninguno' },
      { key: 'presupuesto', nombre: 'Presupuesto', categoria: 'paciente', vencimiento: 'ninguno' },
      { key: 'cert_mensual', nombre: 'Certificado mensual', categoria: 'mensual', vencimiento: 'ninguno' },
    ],
  });
}
const docsLegajo = (db, t = 't1') => [...db.docs.keys()].filter(k => k.startsWith(`empresas/${t}/legajo_docs/`));
const hayVencimientos = db => [...db.docs.keys()].some(k => k.includes('/vencimientos/'));

/* ── Servicio: parseo, fechas, paciente, límite ──────────────────────────── */

describe('parsearLectura', () => {
  const ctx = { requisitos: [{ key: 'orden_medica', nombre: 'Orden', vencimiento: 'meses', vigenciaMeses: 6 }, { key: 'dni', nombre: 'DNI' }] };
  const ahora = new Date(2026, 10, 25);

  test('JSON válido: tipo, fecha y vencimiento calculado según el requisito', () => {
    const l = S.parsearLectura(JSON.stringify(ordenOk()), ctx, ahora);
    assert.equal(l.requisitoKey, 'orden_medica');
    assert.equal(l.fechaEmision, '10/10/2026');
    assert.equal(l.fechaVenc, '10/04/2027');
    assert.equal(l.fechaVencCalculada, true);
  });
  test('JSON dentro de ``` y con texto alrededor', () => {
    const l = S.parsearLectura('Acá va:\n```json\n' + JSON.stringify(ordenOk()) + '\n```\nListo.', ctx, ahora);
    assert.equal(l.requisitoKey, 'orden_medica');
  });
  test('JSON roto: falla con un error controlado, no con una excepción rara', () => {
    assert.throws(() => S.parsearLectura('{"legible": true, "tipo": ', ctx, ahora), e => e instanceof Error);
    assert.throws(() => S.parsearLectura('no hay nada', ctx, ahora));
  });
  test('fechas imposibles o futuras se descartan con advertencia', () => {
    const l = S.parsearLectura(JSON.stringify(ordenOk({ fechaEmision: { valor: '31/02/2026', confianza: 'alta' } })), ctx, ahora);
    assert.equal(l.fechaEmision, '');
    assert.ok(l.advertencias.some(a => /emisión/.test(a)));
    const f = S.parsearLectura(JSON.stringify(ordenOk({ fechaEmision: { valor: '01/01/2030', confianza: 'alta' } })), ctx, ahora);
    assert.equal(f.fechaEmision, '');
  });
  test('vencimiento anterior a la emisión se descarta', () => {
    const l = S.parsearLectura(JSON.stringify(ordenOk({ fechaVenc: { valor: '01/01/2026', confianza: 'alta' } })), ctx, ahora);
    assert.notEqual(l.fechaVenc, '01/01/2026');
  });
  test('tipo que no existe en la obra social queda como "otro"', () => {
    const l = S.parsearLectura(JSON.stringify(ordenOk({ tipo: { requisitoKey: 'inventado', descripcion: 'x', confianza: 'alta' } })), ctx, ahora);
    assert.equal(l.requisitoKey, 'otro');
  });
  test('"legible: false" no inventa nada', () => {
    const l = S.parsearLectura('{"legible": false}', ctx, ahora);
    assert.equal(l.legible, false);
    assert.equal(l.confianzaGeneral, 'baja');
  });
  test('sin nombre ni DNI leídos, la confianza del paciente es baja', () => {
    const l = S.parsearLectura(JSON.stringify(ordenOk({ paciente: {} })), ctx, ahora);
    assert.equal(l.confianza.paciente, 'baja');
  });
  test('importe: acepta formato argentino y rechaza negativos', () => {
    assert.equal(S.parseImporte('1.250.000,50'), 1250000.5);
    assert.equal(S.parseImporte(-5), null);
    assert.equal(S.parseImporte('abc'), null);
  });
});

describe('evaluarPaciente', () => {
  const ben = { nombre: NOMBRE_PRIVADO, dni: DNI_PRIVADO };
  test('el DNI manda', () => {
    assert.equal(S.evaluarPaciente({ dni: '30.111.222', nombre: 'Otro Nombre' }, ben).coincide, true);
    assert.equal(S.evaluarPaciente({ dni: '99999999', nombre: NOMBRE_PRIVADO }, ben).coincide, false);
  });
  test('sin DNI se usa el nombre, en cualquier orden', () => {
    assert.equal(S.evaluarPaciente({ nombre: 'Quintanilla, Zulema' }, ben).coincide, true);
    assert.equal(S.evaluarPaciente({ nombre: 'Marta Gómez' }, ben).coincide, false);
  });
  test('sin nada para comparar no bloquea', () => {
    assert.equal(S.evaluarPaciente({}, ben).coincide, null);
  });
});

describe('limitador', () => {
  test('reserva, rechaza al pasarse, devuelve y libera con la ventana', () => {
    let t = 0;
    const l = S.crearLimitador({ max: 3, ventanaMs: 1000, ahora: () => t });
    assert.equal(l.reservar('a', 2).ok, true);
    assert.equal(l.reservar('a', 2).ok, false);
    assert.equal(l.reservar('b', 3).ok, true);   // otra empresa, otro cupo
    l.devolver('a', 1);
    assert.equal(l.reservar('a', 2).ok, true);
    t = 5000;
    assert.equal(l.disponibles('a'), 3);
  });
});

describe('llamadorAnthropic', () => {
  test('sin ANTHROPIC_API_KEY devuelve null', () => {
    const k = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try { assert.equal(S.llamadorAnthropic(), null); } finally { if (k !== undefined) process.env.ANTHROPIC_API_KEY = k; }
  });
});

/* ── Endpoints ───────────────────────────────────────────────────────────── */

describe('POST /:id/leer-ia', () => {
  let ctx, llamadas;
  const iniciar = async (resp = () => respuesta(ordenOk()), extra = {}) => {
    llamadas = [];
    ctx = await montar({ llamador: () => async args => { llamadas.push(args); return resp(args); }, ...extra });
    sembrar(ctx.db);
  };
  beforeEach(() => { if (ctx) ctx.cerrar(); ctx = null; });

  test('devuelve la propuesta y el archivo subido, y NO guarda nada en el legajo', async () => {
    await iniciar();
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('hoja-1')] });
    assert.equal(r.status, 200);
    const it = r.json.resultados[0];
    assert.equal(it.ok, true);
    assert.equal(it.requisitoKey, 'orden_medica');
    assert.equal(it.fechaEmision, '10/10/2026');
    assert.equal(it.coincidePaciente, true);
    assert.ok(it.archivoUrl.startsWith('https://almacen.test/'));
    assert.equal(it.hash, hashDe('hoja-1'));
    assert.equal(docsLegajo(ctx.db).length, 0);
    assert.equal(hayVencimientos(ctx.db), false);
    ctx.cerrar();
  });

  test('a la IA no le llegan el nombre ni el DNI del paciente', async () => {
    await iniciar();
    await ctx.post('/b1/leer-ia', { archivos: [archivo('hoja-1')] });
    const enviado = JSON.stringify(llamadas[0].prompt);
    assert.ok(!enviado.includes(NOMBRE_PRIVADO));
    assert.ok(!enviado.includes(DNI_PRIVADO));
    assert.ok(/OSDE/.test(enviado));
    ctx.cerrar();
  });

  test('JSON con ``` y texto alrededor igual se interpreta', async () => {
    await iniciar(() => respuesta('Claro:\n```json\n' + JSON.stringify(ordenOk()) + '\n```'));
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('hoja-2')] });
    assert.equal(r.json.resultados[0].ok, true);
    ctx.cerrar();
  });

  test('JSON roto: error claro para ese archivo, no se sube el original y se devuelve el cupo', async () => {
    const limitador = S.crearLimitador({ max: 5 });
    await iniciar(() => respuesta('{"legible": tru'), { limitador });
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('roto')] });
    assert.equal(r.status, 200);
    assert.equal(r.json.resultados[0].ok, false);
    assert.match(r.json.resultados[0].mensaje, /interpretar/);
    assert.equal(ctx.subidas.length, 0);
    assert.equal(limitador.disponibles('t1'), 5);
    ctx.cerrar();
  });

  test('fechas inválidas: se descartan y se avisa', async () => {
    await iniciar(() => respuesta(ordenOk({ fechaEmision: { valor: '45/13/2026', confianza: 'alta' } })));
    const it = (await ctx.post('/b1/leer-ia', { archivos: [archivo('f')] })).json.resultados[0];
    assert.equal(it.fechaEmision, '');
    assert.ok(it.advertencias.length > 0);
    ctx.cerrar();
  });

  test('documento de otra persona: marca posiblePacienteEquivocado', async () => {
    await iniciar(() => respuesta(ordenOk({ paciente: { nombre: { valor: 'Marta Gómez', confianza: 'alta' }, dni: { valor: '20999888', confianza: 'alta' } } })));
    const it = (await ctx.post('/b1/leer-ia', { archivos: [archivo('ajeno')] })).json.resultados[0];
    assert.equal(it.coincidePaciente, false);
    assert.equal(it.posiblePacienteEquivocado, true);
    ctx.cerrar();
  });

  test('mismo archivo dos veces: la segunda sale de la caché, sin llamar a la IA ni subir de nuevo', async () => {
    await iniciar();
    await ctx.post('/b1/leer-ia', { archivos: [archivo('igual')] });
    const r2 = await ctx.post('/b1/leer-ia', { archivos: [archivo('igual')] });
    assert.equal(llamadas.length, 1);
    assert.equal(ctx.subidas.length, 1);
    assert.equal(r2.json.resultados[0].repetido, true);
    ctx.cerrar();
  });

  test('"forzar" vuelve a leer', async () => {
    await iniciar();
    await ctx.post('/b1/leer-ia', { archivos: [archivo('igual')] });
    await ctx.post('/b1/leer-ia', { archivos: [archivo('igual')], forzar: true });
    assert.equal(llamadas.length, 2);
    ctx.cerrar();
  });

  test('el mismo archivo repetido dentro de la tanda se lee una sola vez', async () => {
    await iniciar();
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('x'), archivo('x')] });
    assert.equal(llamadas.length, 1);
    assert.equal(r.json.resultados[1].ok, false);
    ctx.cerrar();
  });

  test('sin ANTHROPIC_API_KEY: 503 con mensaje claro', async () => {
    ctx = await montar({ llamador: () => null });
    sembrar(ctx.db);
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('a')] });
    assert.equal(r.status, 503);
    assert.match(r.json.mensaje, /no está configurada/);
    ctx.cerrar();
  });

  test('archivo demasiado grande, HEIC y formato no permitido se rechazan sin llamar a la IA', async () => {
    await iniciar();
    const grande = { base64: Buffer.alloc(S.MAX_BYTES + 10, 1).toString('base64'), mimeType: 'image/jpeg', nombre: 'g.jpg' };
    const r = await ctx.post('/b1/leer-ia', { archivos: [grande, archivo('h', { mimeType: 'image/heic' }), archivo('t', { mimeType: 'text/plain' })] });
    assert.equal(r.status, 200);
    assert.ok(r.json.resultados.every(x => x.ok === false));
    assert.match(r.json.resultados[0].mensaje, /8 MB/);
    assert.match(r.json.resultados[1].mensaje, /HEIC/);
    assert.equal(llamadas.length, 0);
    ctx.cerrar();
  });

  test('más archivos que el tope por pedido: 400', async () => {
    await iniciar();
    const muchos = Array.from({ length: S.MAX_ARCHIVOS + 1 }, (_, i) => archivo('m' + i));
    assert.equal((await ctx.post('/b1/leer-ia', { archivos: muchos })).status, 400);
    assert.equal((await ctx.post('/b1/leer-ia', { archivos: [] })).status, 400);
    ctx.cerrar();
  });

  test('límite por empresa: 429 al pasarse, y otra empresa no se ve afectada', async () => {
    const limitador = S.crearLimitador({ max: 2 });
    await iniciar(undefined, { limitador });
    sembrar(ctx.db, 't2');
    assert.equal((await ctx.post('/b1/leer-ia', { archivos: [archivo('1'), archivo('2')] })).status, 200);
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('3')] });
    assert.equal(r.status, 429);
    assert.equal((await ctx.post('/b1/leer-ia', { archivos: [archivo('3')] }, 't2')).status, 200);
    ctx.cerrar();
  });

  test('error de la IA (ocupada): mensaje amable y no se sube el archivo', async () => {
    await iniciar(() => { throw Object.assign(new Error('overloaded'), { status: 529 }); });
    const it = (await ctx.post('/b1/leer-ia', { archivos: [archivo('a')] })).json.resultados[0];
    assert.equal(it.ok, false);
    assert.match(it.mensaje, /ocupada/);
    assert.equal(ctx.subidas.length, 0);
    ctx.cerrar();
  });

  test('paciente inexistente: 404', async () => {
    await iniciar();
    assert.equal((await ctx.post('/nadie/leer-ia', { archivos: [archivo('a')] })).status, 404);
    ctx.cerrar();
  });

  test('aislamiento entre empresas: no se lee un paciente de otra', async () => {
    await iniciar();
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo('a')] }, 't-otra');
    assert.equal(r.status, 404);
    assert.equal(llamadas.length, 0);
    ctx.cerrar();
  });

  test('los logs llevan solo cantidades: nada del documento ni del paciente', async () => {
    await iniciar();
    const logs = [];
    const orig = [console.log, console.error];
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => logs.push(a.join(' '));
    try {
      await ctx.post('/b1/leer-ia', { archivos: [archivo('a')] });
      await iniciar(() => { throw Object.assign(new Error(`falló con ${NOMBRE_PRIVADO}`), { status: 500 }); });
      await ctx.post('/b1/leer-ia', { archivos: [archivo('b')] });
    } finally { [console.log, console.error] = orig; }
    const todo = logs.join('\n');
    assert.ok(todo.includes('[LEGAJO-IA]'));
    assert.ok(/tokensEntrada/.test(todo));
    assert.ok(!todo.includes(NOMBRE_PRIVADO));
    assert.ok(!todo.includes(DNI_PRIVADO));
    ctx.cerrar();
  });
});

describe('POST /:id/confirmar-lectura', () => {
  let ctx;
  beforeEach(() => { if (ctx) ctx.cerrar(); ctx = null; });
  const leer = async (txt = 'doc', resp = ordenOk()) => {
    const r = await ctx.post('/b1/leer-ia', { archivos: [archivo(txt)] });
    return r.json.resultados[0];
  };
  const iniciar = async resp => { ctx = await montar({ llamador: () => async () => respuesta(resp || ordenOk()) }); sembrar(ctx.db); };

  test('recién al confirmar se crea el documento, con origen "ia" y la URL que guardó el servidor', async () => {
    await iniciar();
    const it = await leer('d1');
    assert.equal(docsLegajo(ctx.db).length, 0);
    const r = await ctx.post('/b1/confirmar-lectura', { items: [{ hash: it.hash, requisitoKey: 'orden_medica', fechaEmision: '10/10/2026', fechaVenc: '10/04/2027', archivoUrl: 'https://malo.test/x' }] });
    assert.equal(r.status, 200);
    assert.equal(r.json.resultados[0].ok, true);
    const [k] = docsLegajo(ctx.db);
    const doc = ctx.db.docs.get(k);
    assert.equal(doc.origen, 'ia');
    assert.equal(doc.confianzaIA, 'media');   // el vencimiento fue calculado, no leído
    assert.equal(doc.beneficiarioId, 'b1');
    assert.equal(doc.fechaVenc, '10/04/2027');
    assert.equal(doc.archivoUrl, it.archivoUrl);          // la del servidor, no la que mandó el cliente
    assert.equal(doc.archivoHash, it.hash);
    assert.equal(hayVencimientos(ctx.db), false);
    // y el registro del paciente no se tocó
    assert.deepEqual(Object.keys(ctx.db.docs.get('empresas/t1/registro/b1')).sort(), ['APELLIDO Y NOMBRE', 'DNI', 'OBRA SOCIAL']);
    ctx.cerrar();
  });

  test('lo que edita el administrativo se guarda y queda registrado como editado', async () => {
    await iniciar();
    const it = await leer('d2');
    await ctx.post('/b1/confirmar-lectura', { items: [{ hash: it.hash, requisitoKey: 'dni', fechaEmision: '01/09/2026', fechaVenc: '' }] });
    const doc = ctx.db.docs.get(docsLegajo(ctx.db)[0]);
    assert.equal(doc.requisitoKey, 'dni');
    assert.equal(doc.nombre, 'DNI');
    assert.equal(doc.fechaEmision, '01/09/2026');
    assert.ok(doc.camposEditados.includes('requisitoKey') && doc.camposEditados.includes('fechaEmision'));
    ctx.cerrar();
  });

  test('confirmar dos veces no duplica', async () => {
    await iniciar();
    const it = await leer('d3');
    const item = { hash: it.hash, requisitoKey: 'orden_medica', fechaEmision: '10/10/2026', fechaVenc: '10/04/2027' };
    await ctx.post('/b1/confirmar-lectura', { items: [item] });
    const r2 = await ctx.post('/b1/confirmar-lectura', { items: [item] });
    assert.equal(r2.json.resultados[0].yaExistia, true);
    assert.equal(docsLegajo(ctx.db).length, 1);
    ctx.cerrar();
  });

  test('documento de otra persona: 409 sin confirmación explícita, y se guarda marcado si se acepta', async () => {
    await iniciar(ordenOk({ paciente: { nombre: { valor: 'Marta Gómez', confianza: 'alta' }, dni: { valor: '20999888', confianza: 'alta' } } }));
    const it = await leer('ajeno');
    const item = { hash: it.hash, requisitoKey: 'orden_medica', fechaEmision: '10/10/2026', fechaVenc: '10/04/2027' };
    const r = await ctx.post('/b1/confirmar-lectura', { items: [item] });
    assert.equal(r.json.resultados[0].status, 409);
    assert.equal(docsLegajo(ctx.db).length, 0);
    const r2 = await ctx.post('/b1/confirmar-lectura', { items: [{ ...item, aceptarPacienteDistinto: true }] });
    assert.equal(r2.json.resultados[0].ok, true);
    assert.equal(ctx.db.docs.get(docsLegajo(ctx.db)[0]).pacienteConfirmadoManual, true);
    ctx.cerrar();
  });

  test('un hash que no leyó el servidor (o de otra empresa) no se puede confirmar', async () => {
    await iniciar();
    sembrar(ctx.db, 't2');
    const it = await leer('d4');
    const item = { hash: it.hash, requisitoKey: 'orden_medica', fechaEmision: '10/10/2026', fechaVenc: '10/04/2027' };
    assert.equal((await ctx.post('/b1/confirmar-lectura', { items: [{ ...item, hash: hashDe('inventado') }] })).json.resultados[0].status, 404);
    assert.equal((await ctx.post('/b1/confirmar-lectura', { items: [item] }, 't2')).json.resultados[0].status, 404);
    assert.equal(docsLegajo(ctx.db, 't2').length, 0);
    ctx.cerrar();
  });

  test('valida tipo, fechas y vencimiento obligatorio', async () => {
    await iniciar();
    const it = await leer('d5');
    const base = { hash: it.hash, requisitoKey: 'orden_medica', fechaEmision: '10/10/2026', fechaVenc: '10/04/2027' };
    const estado = async patch => (await ctx.post('/b1/confirmar-lectura', { items: [{ ...base, ...patch }] })).json.resultados[0];
    assert.equal((await estado({ requisitoKey: 'no_existe' })).status, 400);
    assert.equal((await estado({ fechaEmision: '99/99/2026' })).status, 400);
    assert.equal((await estado({ fechaVenc: '01/01/2020' })).status, 400);
    assert.equal(docsLegajo(ctx.db).length, 0);
    ctx.cerrar();
  });

  test('presupuesto: importe, concepto y validez van a notas y datosIA', async () => {
    await iniciar(ordenOk({ tipo: { requisitoKey: 'presupuesto', descripcion: 'Presupuesto', confianza: 'alta' } }));
    const it = await leer('pres');
    await ctx.post('/b1/confirmar-lectura', { items: [{ hash: it.hash, requisitoKey: 'presupuesto', fechaEmision: '10/10/2026', datos: { importe: '1.250.000', concepto: 'Traslados noviembre', validez: '30 días' } }] });
    const doc = ctx.db.docs.get(docsLegajo(ctx.db)[0]);
    assert.equal(doc.datosIA.importe, 1250000);
    assert.match(doc.notas, /Traslados noviembre/);
    ctx.cerrar();
  });

  test('sin items: 400', async () => {
    await iniciar();
    assert.equal((await ctx.post('/b1/confirmar-lectura', { items: [] })).status, 400);
    ctx.cerrar();
  });
});
