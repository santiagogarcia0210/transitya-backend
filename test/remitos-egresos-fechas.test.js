/**
 * Remitos y egresos: orden, filtros y guardado de fechas, contra las rutas REALES con un
 * Firestore en memoria (sin red ni credenciales).
 *
 * El bug: las rutas guardaban la fecha cruda en ISO (yyyy-MM-dd, del <input type="date">) y
 * fechaSort() solo entendía dd/MM/yyyy, así que esos documentos caían al final de la lista y no
 * entraban en los filtros por fecha. Ahora todo se normaliza a dd/MM/yyyy y las lecturas
 * entienden también lo que ya quedó guardado en otro formato.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const { fakeDb } = require('./helpers/fakeFirestore');

const RAIZ = path.join(__dirname, '..');
const T = 't1';
const HOY_STUB = '15/11/2026';   // lo que devuelve fechaHoyAR() en estas pruebas

/* ── Carga de las rutas reales con sus dependencias reemplazadas ─────────── */

function cargar() {
  const db = fakeDb();
  const rutas = ['routes/remitos.js', 'routes/egresos.js'].map(r => require.resolve(path.join(RAIZ, r)));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const utils = {
    col: (t, sub) => db.coleccion(`empresas/${t}/${sub}`),
    normalizarText_: norm,
    parseMonto_: v => parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0,
    esMesDMY: () => true,
    fechaHoyAR: () => HOY_STUB,
    randomUUID: () => crypto.randomUUID(),
  };
  const pasa = (req, res, next) => next();
  // La autenticación real (Firebase) se reemplaza por una que toma el usuario de los headers.
  const auth = {
    verifyToken: (req, res, next) => {
      req.user = { email: req.headers['x-email'] || 'admin@empresa.com', rol: req.headers['x-rol'] || 'admin' };
      next();
    },
    requireAdmin: pasa,
    requireModulo: () => pasa,
  };
  class AnthropicFalso { constructor() { this.messages = { create: async () => { throw new Error('la IA no se usa en estas pruebas'); } }; } }
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (padre && rutas.includes(padre.filename)) {
      if (pedido === '../utils') return utils;
      if (pedido === '../middleware/auth') return auth;
      if (pedido === '../helpers/storage') return { subirFoto: async () => 'https://storage.test/comprobante.jpg' };
      if (pedido === '@anthropic-ai/sdk') return AnthropicFalso;
    }
    return original.call(this, pedido, padre, esMain);
  };
  try {
    for (const r of rutas) delete require.cache[r];
    return { remitos: require(rutas[0]), egresos: require(rutas[1]), db };
  } finally {
    Module._load = original;
  }
}

async function levantar({ remitos, egresos }) {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.tenantId = T; next(); });
  app.use('/api/remitos', remitos);
  app.use('/api/egresos', egresos);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const llamar = async (metodo, ruta, body, headers = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  return { llamar, cerrar: () => new Promise(r => server.close(r)) };
}

/** Siembra documentos. creadoEn en ms (Date) para controlar el desempate. */
function sembrar(db, coleccion, docs) {
  for (const [id, datos] of Object.entries(docs)) {
    db.docs.set(`empresas/${T}/${coleccion}/${id}`, { ID: id, chofer: 'admin@empresa.com', ...datos });
  }
}
const guardados = (db, coleccion) =>
  [...db.docs.entries()].filter(([k]) => k.startsWith(`empresas/${T}/${coleccion}/`)).map(([, v]) => v);
const ids = r => r.json.resultados.map(x => x.id);
const d = s => new Date(`${s}T12:00:00Z`);

/** Un mismo conjunto con TODOS los formatos mezclados, para remitos y egresos. */
const MEZCLADOS = {
  iso_12_hora: { fecha: '2026-11-12T15:00:00.000Z', creadoEn: d('2026-11-12') },   // ISO con hora
  iso_10:      { fecha: '2026-11-10',               creadoEn: d('2026-11-10') },   // ISO (input date)
  dmy_09:      { fecha: '09/11/2026',               creadoEn: d('2026-11-09') },   // el formato de siempre
  dmy_08_corta: { fecha: '8/11/26',                 creadoEn: d('2026-11-08') },   // d/M/yy
  legacy_07:   { FECHA: '07/11/2026',               creadoEn: d('2026-11-07') },   // migrado de Sheets
  basura:      { fecha: 'basura',                   creadoEn: d('2026-11-14') },   // no se entiende
  sin_fecha:   {                                    creadoEn: d('2026-11-13') },   // sin fecha
};
// Con fecha primero, de la más nueva a la más vieja; sin fecha válida al final, por creadoEn desc.
const ORDEN_ESPERADO = ['iso_12_hora', 'iso_10', 'dmy_09', 'dmy_08_corta', 'legacy_07', 'basura', 'sin_fecha'];

/* ── Remitos ─────────────────────────────────────────────────────────────── */

describe('remitos: orden', () => {
  test('REGRESIÓN: los remitos con fecha ISO se ordenan con el resto y no caen al final', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/remitos');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(ids(r), ORDEN_ESPERADO);
      assert.strictEqual(r.json.resultados[0].id, 'iso_12_hora', 'el más reciente está primero aunque esté guardado en ISO');
    } finally { await srv.cerrar(); }
  });

  test('a igual fecha, el cargado más tarde va primero (con el formato que tenga cada uno)', async () => {
    const m = cargar();
    sembrar(m.db, 'remitos', {
      temprano: { fecha: '05/11/2026', creadoEn: new Date('2026-11-05T09:00:00Z') },
      tarde:    { fecha: '2026-11-05', creadoEn: new Date('2026-11-05T18:00:00Z') },
      medio:    { fecha: '5/11/26',    creadoEn: new Date('2026-11-05T12:00:00Z') },
      sin_hora: { fecha: '05/11/2026' },
    });
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/remitos')), ['tarde', 'medio', 'temprano', 'sin_hora']);
    } finally { await srv.cerrar(); }
  });

  test('un chofer ve solo lo suyo, y también ordenado', async () => {
    const m = cargar();
    sembrar(m.db, 'remitos', {
      mio_viejo: { fecha: '01/11/2026', chofer: 'juan@empresa.com' },
      mio_iso:   { fecha: '2026-11-08', chofer: 'juan@empresa.com' },
      ajeno:     { fecha: '2026-11-09', chofer: 'ana@empresa.com' },
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/remitos', null, { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.deepStrictEqual(ids(r), ['mio_iso', 'mio_viejo']);
    } finally { await srv.cerrar(); }
  });
});

describe('remitos: filtros desde/hasta', () => {
  test('desde y hasta (ISO, como los manda el input) alcanzan a los guardados en ISO y en dd/MM/yyyy', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/remitos?desde=2026-11-08&hasta=2026-11-10');
      assert.deepStrictEqual(ids(r), ['iso_10', 'dmy_09', 'dmy_08_corta'], 'incluye los dos extremos');
    } finally { await srv.cerrar(); }
  });

  test('solo desde, solo hasta, y los extremos exactos', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/remitos?desde=2026-11-10')), ['iso_12_hora', 'iso_10']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/remitos?hasta=2026-11-07')), ['legacy_07']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/remitos?desde=2026-11-09&hasta=2026-11-09')), ['dmy_09']);
    } finally { await srv.cerrar(); }
  });

  test('el rango también acepta dd/MM/yyyy', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/remitos?desde=08/11/2026&hasta=10/11/2026');
      assert.deepStrictEqual(ids(r), ['iso_10', 'dmy_09', 'dmy_08_corta']);
    } finally { await srv.cerrar(); }
  });

  test('con un filtro de fechas, los documentos sin fecha válida quedan afuera (como antes)', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/remitos?desde=2000-01-01');
      assert.ok(!ids(r).includes('basura') && !ids(r).includes('sin_fecha'));
      assert.strictEqual(r.json.total, 5);
    } finally { await srv.cerrar(); }
  });

  test('un desde o hasta que no se entiende no deja el listado vacío', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/remitos?desde=cualquier-cosa');
      assert.strictEqual(r.json.total, 5, 'se ignora el límite inválido');
    } finally { await srv.cerrar(); }
  });
});

describe('remitos: /pdf-data', () => {
  test('filtra y ordena igual, con documentos en ISO y dd/MM/yyyy', async () => {
    const m = cargar();
    sembrar(m.db, 'remitos', {
      iso_10: { fecha: '2026-11-10', combustible: 40, monto: '1000' },
      dmy_09: { fecha: '09/11/2026', combustible: 30, monto: '500' },
      fuera:  { fecha: '2026-10-01', combustible: 99, monto: '99' },
      basura: { fecha: 'basura', combustible: 99, monto: '99' },
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/remitos/pdf-data?desde=2026-11-01&hasta=2026-11-30');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.remitos.map(x => x.id), ['iso_10', 'dmy_09']);
      assert.deepStrictEqual(r.json.totales, { totalLitros: 70, totalMonto: 1500, cantRemitos: 2 });
    } finally { await srv.cerrar(); }
  });
});

describe('remitos: guardado', () => {
  test('POST con fecha ISO (input date) guarda dd/MM/yyyy', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/remitos', { fecha: '2026-11-05', nroRemito: '1', monto: 100 });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(guardados(m.db, 'remitos')[0].fecha, '05/11/2026');
    } finally { await srv.cerrar(); }
  });

  test('POST normaliza otros formatos, incluido el de 2 dígitos y el ISO con hora', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const entrada of ['5/11/26', '05/11/2026', '2026-11-06T01:30:00.000Z']) {
        const r = await srv.llamar('POST', '/api/remitos', { fecha: entrada, nroRemito: 'x' });
        assert.strictEqual(r.status, 200, entrada);
      }
      assert.deepStrictEqual(guardados(m.db, 'remitos').map(x => x.fecha), ['05/11/2026', '05/11/2026', '05/11/2026']);
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha sigue guardando la de hoy (comportamiento de siempre)', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const cuerpo of [{ nroRemito: 'a' }, { nroRemito: 'b', fecha: '' }, { nroRemito: 'c', fecha: null }, { nroRemito: 'd', fecha: '   ' }]) {
        assert.strictEqual((await srv.llamar('POST', '/api/remitos', cuerpo)).status, 200);
      }
      assert.ok(guardados(m.db, 'remitos').every(x => x.fecha === HOY_STUB));
    } finally { await srv.cerrar(); }
  });

  test('POST con una fecha que no se entiende: 400 con mensaje claro y no se guarda nada', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const fecha of ['basura', '31/02/2026', '2026-13-45', '05/11/0206']) {
        const r = await srv.llamar('POST', '/api/remitos', { fecha, nroRemito: '1' });
        assert.strictEqual(r.status, 400, fecha);
        assert.strictEqual(r.json.ok, false);
        assert.match(r.json.mensaje, /fecha no es válida.*dd\/MM\/yyyy/);
      }
      assert.strictEqual(guardados(m.db, 'remitos').length, 0);
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha que llega', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', { r1: { fecha: '01/11/2026', observaciones: '' } });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('PUT', '/api/remitos/r1', { fecha: '2026-11-06', observaciones: 'corregido' });
      assert.strictEqual(r.status, 200);
      const doc = guardados(m.db, 'remitos')[0];
      assert.strictEqual(doc.fecha, '06/11/2026');
      assert.strictEqual(doc.observaciones, 'corregido');
    } finally { await srv.cerrar(); }
  });

  test('PUT con fecha inválida o vacía: 400 y el documento queda como estaba', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', { r1: { fecha: '01/11/2026', observaciones: 'original' } });
    const srv = await levantar(m);
    try {
      for (const fecha of ['basura', '31/02/2026', '']) {
        const r = await srv.llamar('PUT', '/api/remitos/r1', { fecha, observaciones: 'no debería guardarse' });
        assert.strictEqual(r.status, 400, JSON.stringify(fecha));
        assert.match(r.json.mensaje, /fecha no es válida/);
      }
      assert.deepStrictEqual(
        { fecha: guardados(m.db, 'remitos')[0].fecha, observaciones: guardados(m.db, 'remitos')[0].observaciones },
        { fecha: '01/11/2026', observaciones: 'original' });
    } finally { await srv.cerrar(); }
  });

  test('PUT sin fecha en el cuerpo no toca la fecha guardada', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', { r1: { fecha: '2026-11-03', observaciones: 'a' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/remitos/r1', { observaciones: 'b' })).status, 200);
      assert.strictEqual(guardados(m.db, 'remitos')[0].fecha, '2026-11-03', 'eso lo arregla el script de migración, no un PUT ajeno');
    } finally { await srv.cerrar(); }
  });

  test('un chofer sigue sin poder editar el remito de otro', async () => {
    const m = cargar(); sembrar(m.db, 'remitos', { ajeno: { fecha: '01/11/2026', chofer: 'ana@empresa.com' } });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('PUT', '/api/remitos/ajeno', { fecha: '2026-11-06' }, { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(guardados(m.db, 'remitos')[0].fecha, '01/11/2026');
    } finally { await srv.cerrar(); }
  });
});

/* ── Egresos ─────────────────────────────────────────────────────────────── */

describe('egresos: orden y filtros', () => {
  test('REGRESIÓN: los egresos con fecha ISO se ordenan con el resto y no caen al final', async () => {
    const m = cargar(); sembrar(m.db, 'egresos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/egresos');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(ids(r), ORDEN_ESPERADO);
    } finally { await srv.cerrar(); }
  });

  test('a igual fecha, el cargado más tarde va primero', async () => {
    const m = cargar();
    sembrar(m.db, 'egresos', {
      temprano: { fecha: '05/11/2026', creadoEn: new Date('2026-11-05T09:00:00Z') },
      tarde:    { fecha: '2026-11-05', creadoEn: new Date('2026-11-05T18:00:00Z') },
    });
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/egresos')), ['tarde', 'temprano']);
    } finally { await srv.cerrar(); }
  });

  test('desde/hasta en ISO alcanzan a los documentos guardados en cualquier formato', async () => {
    const m = cargar(); sembrar(m.db, 'egresos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/egresos?desde=2026-11-08&hasta=2026-11-10')), ['iso_10', 'dmy_09', 'dmy_08_corta']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/egresos?desde=2026-11-12')), ['iso_12_hora']);
      assert.strictEqual((await srv.llamar('GET', '/api/egresos?desde=cualquier-cosa')).json.total, 5);
    } finally { await srv.cerrar(); }
  });

  test('los otros filtros siguen funcionando junto con el de fechas', async () => {
    const m = cargar();
    sembrar(m.db, 'egresos', {
      a: { fecha: '2026-11-10', categoria: 'Combustible', monto: 100 },
      b: { fecha: '09/11/2026', categoria: 'Peaje', monto: 50 },
      c: { fecha: '2026-11-08', categoria: 'Combustible', monto: 900 },
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/egresos?categoria=combustible&desde=2026-11-09');
      assert.deepStrictEqual(ids(r), ['a']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/egresos?montoMin=60')), ['a', 'c']);
    } finally { await srv.cerrar(); }
  });
});

describe('egresos: guardado', () => {
  const cuerpo = (extra = {}) => ({ monto: 1500, categoria: 'Peaje', ...extra });

  test('POST con fecha ISO (input date) guarda dd/MM/yyyy', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/egresos', cuerpo({ fecha: '2026-11-05' }));
      assert.strictEqual(r.status, 200);
      const doc = guardados(m.db, 'egresos')[0];
      assert.strictEqual(doc.fecha, '05/11/2026');
      assert.ok(doc.creadoEn, 'sigue guardando creadoEn');
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha o con fecha inválida: 400 y no se guarda nada', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const extra of [{}, { fecha: '' }, { fecha: null }, { fecha: '   ' }]) {
        const r = await srv.llamar('POST', '/api/egresos', cuerpo(extra));
        assert.strictEqual(r.status, 400, JSON.stringify(extra));
        assert.match(r.json.mensaje, /Falta la fecha/);
      }
      for (const fecha of ['basura', '31/02/2026', '2026-13-45']) {
        const r = await srv.llamar('POST', '/api/egresos', cuerpo({ fecha }));
        assert.strictEqual(r.status, 400, fecha);
        assert.match(r.json.mensaje, /fecha no es válida.*dd\/MM\/yyyy/);
      }
      assert.strictEqual(guardados(m.db, 'egresos').length, 0);
    } finally { await srv.cerrar(); }
  });

  test('POST sigue asignando al chofer como siempre', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      await srv.llamar('POST', '/api/egresos', cuerpo({ fecha: '2026-11-05', chofer: 'otro@x.com' }), { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.strictEqual(guardados(m.db, 'egresos')[0].chofer, 'juan@empresa.com');
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha que llega; inválida o vacía da 400 y no cambia nada', async () => {
    const m = cargar(); sembrar(m.db, 'egresos', { e1: { fecha: '01/11/2026', concepto: 'original' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/egresos/e1', { fecha: '2026-11-06', concepto: 'nuevo' })).status, 200);
      assert.strictEqual(guardados(m.db, 'egresos')[0].fecha, '06/11/2026');
      for (const fecha of ['basura', '31/02/2026', '']) {
        assert.strictEqual((await srv.llamar('PUT', '/api/egresos/e1', { fecha, concepto: 'no' })).status, 400, JSON.stringify(fecha));
      }
      assert.deepStrictEqual({ f: guardados(m.db, 'egresos')[0].fecha, c: guardados(m.db, 'egresos')[0].concepto }, { f: '06/11/2026', c: 'nuevo' });
    } finally { await srv.cerrar(); }
  });

  test('PUT sin fecha en el cuerpo no la toca', async () => {
    const m = cargar(); sembrar(m.db, 'egresos', { e1: { fecha: '2026-11-03', concepto: 'a' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/egresos/e1', { concepto: 'b' })).status, 200);
      assert.strictEqual(guardados(m.db, 'egresos')[0].fecha, '2026-11-03');
    } finally { await srv.cerrar(); }
  });
});

describe('egresos: /duplicado', () => {
  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'egresos', {
      e1: { fecha: '05/11/2026', monto: 1000 },
      e2: { fecha: '2026-11-06', monto: '2500' },        // guardado en ISO
      e3: { fecha: 'basura',     monto: 777 },
      e4: {                      monto: 888 },           // sin fecha
    });
    return m;
  };
  const dup = async (srv, fecha, monto) =>
    (await srv.llamar('GET', `/api/egresos/duplicado?fecha=${encodeURIComponent(fecha)}&monto=${monto}`)).json;

  test('compara por día, sin importar en qué formato llegó o quedó guardada cada fecha', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      assert.strictEqual((await dup(srv, '2026-11-05', 1000)).duplicado, true, 'ISO recibida vs dd/MM/yyyy guardada');
      assert.strictEqual((await dup(srv, '05/11/2026', 1000)).duplicado, true, 'mismo formato');
      assert.strictEqual((await dup(srv, '5/11/26', 1000)).duplicado, true, 'dd/MM/yy recibida');
      assert.strictEqual((await dup(srv, '06/11/2026', 2500)).duplicado, true, 'dd/MM/yyyy recibida vs ISO guardada');
      assert.strictEqual((await dup(srv, '2026-11-05', 1000)).cantidad, 1);
    } finally { await srv.cerrar(); }
  });

  test('no marca duplicado si cambia el día o el monto', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      assert.strictEqual((await dup(srv, '2026-11-05', 999)).duplicado, false);
      assert.strictEqual((await dup(srv, '06/11/2026', 1000)).duplicado, false);
      assert.strictEqual((await dup(srv, '2026-11-07', 1000)).duplicado, false);
    } finally { await srv.cerrar(); }
  });

  test('una fecha inválida o ausente NUNCA marca duplicado (no se iguala con documentos de fecha rota)', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      // e3 tiene fecha "basura" y monto 777; e4 no tiene fecha y monto 888.
      assert.strictEqual((await dup(srv, 'basura', 777)).duplicado, false, 'dos fechas inválidas no son "la misma fecha"');
      assert.strictEqual((await dup(srv, '', 888)).duplicado, false);
      assert.strictEqual((await dup(srv, '31/02/2026', 777)).duplicado, false);
      const sinParametro = (await srv.llamar('GET', '/api/egresos/duplicado?monto=888')).json;
      assert.strictEqual(sinParametro.duplicado, false);
    } finally { await srv.cerrar(); }
  });
});
