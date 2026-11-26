/**
 * Ingresos y reportes de km: orden, filtros y guardado de fechas, contra las rutas REALES con un
 * Firestore en memoria (sin red ni credenciales).
 *
 * El bug (el mismo que ya se arregló en remitos y egresos): las rutas guardaban la fecha cruda en ISO
 * (yyyy-MM-dd, del <input type="date">) y tenían su propia fechaSort(), que solo entendía dd/MM/yyyy y
 * devolvía 0 para ISO. Esos documentos caían al final de la lista y no entraban en los filtros por mes.
 * Ahora todo se normaliza a dd/MM/yyyy y las lecturas entienden también lo que ya quedó guardado en otro
 * formato (mientras no se corra scripts/normalizarFechas.js --apply).
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
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/* ── Carga de las rutas reales con sus dependencias reemplazadas ─────────── */

function cargar() {
  const db = fakeDb();
  const rutas = ['routes/ingresos.js', 'routes/reportes.js'].map(r => require.resolve(path.join(RAIZ, r)));
  const fotos = [];   // cada subida a Storage, para comprobar que un reporte rechazado no deja archivos
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const utils = {
    col: (t, sub) => db.coleccion(`empresas/${t}/${sub}`),
    normalizarText_: norm,
    parseMonto_: v => parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0,
    fechaHoyAR: () => HOY_STUB,
    randomUUID: () => crypto.randomUUID(),
    MESES,
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
  const storage = { subirFoto: async (b64, mime, ruta) => { fotos.push(ruta); return 'https://storage.test/' + ruta; } };
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (padre && rutas.includes(padre.filename)) {
      if (pedido === '../utils') return utils;
      if (pedido === '../middleware/auth') return auth;
      if (pedido === '../helpers/storage') return storage;
    }
    return original.call(this, pedido, padre, esMain);
  };
  try {
    for (const r of rutas) delete require.cache[r];
    return { ingresos: require(rutas[0]), reportes: require(rutas[1]), db, fotos };
  } finally {
    Module._load = original;
  }
}

async function levantar({ ingresos, reportes }) {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.tenantId = T; next(); });
  app.use('/api/ingresos', ingresos);
  app.use('/api/reportes', reportes);
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

/** Siembra documentos. creadoEn controla el desempate entre dos documentos del mismo día. */
function sembrar(db, coleccion, docs) {
  for (const [id, datos] of Object.entries(docs)) {
    db.docs.set(`empresas/${T}/${coleccion}/${id}`, { ID: id, chofer: 'admin@empresa.com', ...datos });
  }
}
const guardados = (db, coleccion) =>
  [...db.docs.entries()].filter(([k]) => k.startsWith(`empresas/${T}/${coleccion}/`)).map(([, v]) => v);
const ids = r => r.json.resultados.map(x => x.id);
const d = s => new Date(`${s}T12:00:00Z`);

/** Un mismo conjunto con TODOS los formatos mezclados. */
const MEZCLADOS = {
  iso_12_hora:  { fecha: '2026-11-12T15:00:00.000Z', creadoEn: d('2026-11-12') },   // ISO con hora
  iso_10:       { fecha: '2026-11-10',               creadoEn: d('2026-11-10') },   // ISO (input date)
  dmy_09:       { fecha: '09/11/2026',               creadoEn: d('2026-11-09') },   // el formato de siempre
  dmy_08_corta: { fecha: '8/11/26',                  creadoEn: d('2026-11-08') },   // d/M/yy
  legacy_07:    { FECHA: '07/11/2026',               creadoEn: d('2026-11-07') },   // migrado de Sheets
  basura:       { fecha: 'basura',                   creadoEn: d('2026-11-14') },   // no se entiende
  sin_fecha:    {                                    creadoEn: d('2026-11-13') },   // sin fecha
};
// Con fecha primero, de la más nueva a la más vieja; sin fecha válida al final, por creadoEn desc.
const ORDEN_ESPERADO = ['iso_12_hora', 'iso_10', 'dmy_09', 'dmy_08_corta', 'legacy_07', 'basura', 'sin_fecha'];

/* ══════════════════════════════ INGRESOS ══════════════════════════════════ */

describe('ingresos: orden', () => {
  test('REGRESIÓN: los ingresos con fecha ISO se ordenan con el resto y no caen al final', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/ingresos');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(ids(r), ORDEN_ESPERADO);
      assert.strictEqual(r.json.resultados[0].id, 'iso_12_hora', 'el más reciente está primero aunque esté guardado en ISO');
    } finally { await srv.cerrar(); }
  });

  test('a igual fecha, el cargado más tarde va primero, con cualquier formato y con creadoEn Date o texto ISO', async () => {
    const m = cargar();
    sembrar(m.db, 'ingresos', {
      temprano: { fecha: '05/11/2026', creadoEn: new Date('2026-11-05T09:00:00Z') },
      tarde:    { fecha: '2026-11-05', creadoEn: new Date('2026-11-05T18:00:00Z') },
      // las facturas que se vuelcan a ingresos guardan creadoEn como texto ISO, no como Date
      factura:  { fecha: '5/11/26',    creadoEn: '2026-11-05T12:00:00.000Z' },
      sin_hora: { fecha: '05/11/2026' },
    });
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/ingresos')), ['tarde', 'factura', 'temprano', 'sin_hora']);
    } finally { await srv.cerrar(); }
  });

  test('la paginación y el resumen siguen funcionando sobre la lista ordenada', async () => {
    const m = cargar();
    sembrar(m.db, 'ingresos', {
      a: { fecha: '2026-11-10', monto: 1000, estado: 'PAGADO' },
      b: { fecha: '09/11/2026', monto: 500, estado: 'PRESENTADO' },
      c: { fecha: '2026-11-08', monto: 200, estado: 'PAGADO' },
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/ingresos?limit=2&page=2');
      assert.deepStrictEqual(ids(r), ['c']);
      assert.deepStrictEqual({ total: r.json.total, totalPaginas: r.json.totalPaginas, pagina: r.json.pagina }, { total: 3, totalPaginas: 2, pagina: 2 });
      assert.deepStrictEqual(r.json.resumen, { total: 1700, pagado: 1200, presentado: 500 });
    } finally { await srv.cerrar(); }
  });
});

describe('ingresos: filtro por mes', () => {
  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'ingresos', {
      a_iso:      { fecha: '2026-11-10', estado: 'PAGADO',     monto: 100 },
      b_dmy:      { fecha: '09/11/2026', estado: 'PAGADO',     monto: 200 },
      c_oct:      { fecha: '2026-10-05', estado: 'PAGADO',     monto: 999 },   // otro mes: afuera
      d_pres_oct: { fecha: '2026-10-01', estado: 'PRESENTADO', monto: 50 },    // PRESENTADO entra siempre
      e_basura:   { fecha: 'basura',     estado: 'PAGADO',     monto: 888 },   // no se entiende: afuera
      f_legacy:   { FECHA: '07/11/2026', estado: 'PAGADO',     monto: 300 },   // migrado de Sheets
    });
    return m;
  };

  test('REGRESIÓN: ?mes&anio incluye los guardados en ISO (esMesDMY los dejaba afuera) y los PRESENTADO de cualquier fecha', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/ingresos?mes=11&anio=2026');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(ids(r), ['a_iso', 'b_dmy', 'f_legacy', 'd_pres_oct']);
      assert.deepStrictEqual(r.json.resumen, { total: 650, pagado: 600, presentado: 50 });
    } finally { await srv.cerrar(); }
  });

  test('/reporte-mensual cuenta igual: ISO, dd/MM/yyyy y FECHA en mayúsculas', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/ingresos/reporte-mensual?mes=11&anio=2026');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.filas.map(x => x.id).sort(), ['a_iso', 'b_dmy', 'd_pres_oct', 'f_legacy']);
      assert.deepStrictEqual(r.json.resumen, { mes: 'Noviembre', anio: 2026, total: 650, pagado: 600, presentado: 50, cantidad: 4 });
    } finally { await srv.cerrar(); }
  });

  test('el filtro de estado y la búsqueda siguen funcionando junto con el de fechas', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/ingresos?mes=11&anio=2026&estado=presentado')), ['d_pres_oct']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/ingresos?mes=11&anio=2026&q=b_dmy')), ['b_dmy']);
    } finally { await srv.cerrar(); }
  });
});

describe('ingresos: filtros desde/hasta', () => {
  test('desde y hasta (ISO, como los manda el input) alcanzan a los guardados en ISO y en dd/MM/yyyy', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/ingresos?desde=2026-11-08&hasta=2026-11-10');
      assert.deepStrictEqual(ids(r), ['iso_10', 'dmy_09', 'dmy_08_corta'], 'incluye los dos extremos');
    } finally { await srv.cerrar(); }
  });

  test('solo desde, solo hasta, los extremos exactos, y el rango también acepta dd/MM/yyyy', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/ingresos?desde=2026-11-10')), ['iso_12_hora', 'iso_10']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/ingresos?hasta=2026-11-07')), ['legacy_07']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/ingresos?desde=2026-11-09&hasta=2026-11-09')), ['dmy_09']);
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/ingresos?desde=08/11/2026&hasta=10/11/2026')), ['iso_10', 'dmy_09', 'dmy_08_corta']);
    } finally { await srv.cerrar(); }
  });

  test('con un filtro de fechas los documentos sin fecha válida quedan afuera; un límite que no se entiende se ignora', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/ingresos?desde=2000-01-01');
      assert.ok(!ids(r).includes('basura') && !ids(r).includes('sin_fecha'));
      assert.strictEqual(r.json.total, 5);
      assert.strictEqual((await srv.llamar('GET', '/api/ingresos?desde=cualquier-cosa')).json.total, 5, 'se ignora el límite inválido');
    } finally { await srv.cerrar(); }
  });
});

describe('ingresos: guardado', () => {
  const cuerpo = (extra = {}) => ({ concepto: 'Factura 0001', monto: 1500, ...extra });

  test('POST con fecha ISO (input date) guarda dd/MM/yyyy y conserva creadoEn y el estado en mayúsculas', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/ingresos', cuerpo({ fecha: '2026-11-05', estado: 'presentado' }));
      assert.strictEqual(r.status, 200);
      const doc = guardados(m.db, 'ingresos')[0];
      assert.strictEqual(doc.fecha, '05/11/2026');
      assert.strictEqual(doc.ESTADO, 'PRESENTADO');
      assert.ok(doc.creadoEn, 'sigue guardando creadoEn');
    } finally { await srv.cerrar(); }
  });

  test('POST normaliza otros formatos, incluido el de 2 dígitos y el ISO con hora (día en hora de Argentina)', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const entrada of ['5/11/26', '05/11/2026', '2026-11-06T01:30:00.000Z']) {
        assert.strictEqual((await srv.llamar('POST', '/api/ingresos', cuerpo({ fecha: entrada }))).status, 200, entrada);
      }
      assert.deepStrictEqual(guardados(m.db, 'ingresos').map(x => x.fecha), ['05/11/2026', '05/11/2026', '05/11/2026']);
    } finally { await srv.cerrar(); }
  });

  test('POST acepta la clave FECHA en mayúsculas (como antes) y la guarda como `fecha`', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/ingresos', cuerpo({ FECHA: '2026-11-05' }))).status, 200);
      const doc = guardados(m.db, 'ingresos')[0];
      assert.strictEqual(doc.fecha, '05/11/2026');
      assert.strictEqual(doc.FECHA, undefined, 'no queda un segundo campo con la fecha cruda');
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha: 400 "Falta la fecha" y no se guarda nada', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const extra of [{}, { fecha: '' }, { fecha: null }, { fecha: '   ' }]) {
        const r = await srv.llamar('POST', '/api/ingresos', cuerpo(extra));
        assert.strictEqual(r.status, 400, JSON.stringify(extra));
        assert.strictEqual(r.json.ok, false);
        assert.match(r.json.mensaje, /Falta la fecha del ingreso/);
      }
      assert.strictEqual(guardados(m.db, 'ingresos').length, 0);
    } finally { await srv.cerrar(); }
  });

  test('POST con una fecha que no se entiende: 400 con mensaje claro y no se guarda nada', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const fecha of ['basura', '31/02/2026', '2026-13-45', '05/11/0206']) {
        const r = await srv.llamar('POST', '/api/ingresos', cuerpo({ fecha }));
        assert.strictEqual(r.status, 400, fecha);
        assert.strictEqual(r.json.ok, false);
        assert.match(r.json.mensaje, /fecha no es válida.*dd\/MM\/yyyy/);
      }
      assert.strictEqual(guardados(m.db, 'ingresos').length, 0);
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha que llega y no toca el resto', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', { i1: { fecha: '01/11/2026', concepto: 'original', monto: 10 } });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('PUT', '/api/ingresos/i1', { fecha: '2026-11-06', concepto: 'corregido' });
      assert.strictEqual(r.status, 200);
      const doc = guardados(m.db, 'ingresos')[0];
      assert.deepStrictEqual({ f: doc.fecha, c: doc.concepto, m: doc.monto }, { f: '06/11/2026', c: 'corregido', m: 10 });
    } finally { await srv.cerrar(); }
  });

  test('PUT con fecha inválida o vacía: 400 y el documento queda como estaba', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', { i1: { fecha: '01/11/2026', concepto: 'original' } });
    const srv = await levantar(m);
    try {
      for (const fecha of ['basura', '31/02/2026', '', null]) {
        const r = await srv.llamar('PUT', '/api/ingresos/i1', { fecha, concepto: 'no debería guardarse' });
        assert.strictEqual(r.status, 400, JSON.stringify(fecha));
        assert.match(r.json.mensaje, /fecha no es válida/);
      }
      assert.deepStrictEqual({ f: guardados(m.db, 'ingresos')[0].fecha, c: guardados(m.db, 'ingresos')[0].concepto }, { f: '01/11/2026', c: 'original' });
    } finally { await srv.cerrar(); }
  });

  test('PUT sin fecha en el cuerpo no toca la fecha guardada (eso lo arregla el script de migración)', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', { i1: { fecha: '2026-11-03', concepto: 'a' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/ingresos/i1', { concepto: 'b' })).status, 200);
      assert.strictEqual(guardados(m.db, 'ingresos')[0].fecha, '2026-11-03');
    } finally { await srv.cerrar(); }
  });

  test('PATCH /:id/pagar sigue guardando fechaPago como dd/MM/yyyy', async () => {
    const m = cargar(); sembrar(m.db, 'ingresos', { i1: { fecha: '2026-11-03', estado: 'PRESENTADO' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PATCH', '/api/ingresos/i1/pagar')).status, 200);
      const doc = guardados(m.db, 'ingresos')[0];
      assert.deepStrictEqual({ e: doc.estado, p: doc.fechaPago }, { e: 'PAGADO', p: HOY_STUB });
    } finally { await srv.cerrar(); }
  });
});

/* ══════════════════════════ REPORTES DE KM ════════════════════════════════ */

describe('reportes: orden', () => {
  test('REGRESIÓN: los reportes con fecha ISO se ordenan con el resto y no caen al final', async () => {
    const m = cargar(); sembrar(m.db, 'reportes', MEZCLADOS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/reportes');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(ids(r), ORDEN_ESPERADO);
    } finally { await srv.cerrar(); }
  });

  test('a igual fecha, el cargado más tarde va primero', async () => {
    const m = cargar();
    sembrar(m.db, 'reportes', {
      temprano: { fecha: '05/11/2026', creadoEn: new Date('2026-11-05T09:00:00Z') },
      tarde:    { fecha: '2026-11-05', creadoEn: new Date('2026-11-05T18:00:00Z') },
      medio:    { fecha: '5/11/26',    creadoEn: new Date('2026-11-05T12:00:00Z') },
    });
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/reportes')), ['tarde', 'medio', 'temprano']);
    } finally { await srv.cerrar(); }
  });

  test('un chofer ve solo lo suyo, y también ordenado', async () => {
    const m = cargar();
    sembrar(m.db, 'reportes', {
      mio_viejo: { fecha: '01/11/2026', chofer: 'juan@empresa.com' },
      mio_iso:   { fecha: '2026-11-08', chofer: 'juan@empresa.com' },
      ajeno:     { fecha: '2026-11-09', chofer: 'ana@empresa.com' },
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/reportes', null, { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.deepStrictEqual(ids(r), ['mio_iso', 'mio_viejo']);
    } finally { await srv.cerrar(); }
  });
});

describe('reportes: filtro por mes', () => {
  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'reportes', {
      r1: { fecha: '2026-11-10', kmRecorridos: 100, combustibleImporte: 1000 },         // ISO
      r2: { fecha: '09/11/2026', kmRecorridos: 50 },
      r3: { fecha: '2026-10-31', kmRecorridos: 999 },                                   // otro mes: afuera
      r4: { fecha: 'basura',     kmRecorridos: 888 },                                   // no se entiende: afuera
      r5: { FECHA: '07/11/2026', 'KM RECORRIDOS': 25 },                                 // migrado de Sheets
    });
    return m;
  };

  test('REGRESIÓN: GET /?mes&anio incluye los guardados en ISO', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/reportes?mes=11&anio=2026')), ['r1', 'r2', 'r5']);
    } finally { await srv.cerrar(); }
  });

  test('/mensual suma los km de los tres formatos y deja afuera otros meses y fechas rotas', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/reportes/mensual?mes=11&anio=2026');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.filas.map(x => x.id).sort(), ['r1', 'r2', 'r5']);
      assert.strictEqual(r.json.resumen.kmTotal, 175);
      assert.strictEqual(r.json.resumen.diasTrab, 3);
      assert.strictEqual(r.json.resumen.costoTotal, 1000);
      assert.strictEqual(r.json.resumen.mes, 'Noviembre');
    } finally { await srv.cerrar(); }
  });

  test('un chofer solo suma lo suyo en /mensual', async () => {
    const m = cargar();
    sembrar(m.db, 'reportes', {
      mio:   { fecha: '2026-11-10', kmRecorridos: 80, chofer: 'juan@empresa.com' },
      ajeno: { fecha: '2026-11-11', kmRecorridos: 70, chofer: 'ana@empresa.com' },
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/reportes/mensual?mes=11&anio=2026', null, { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.strictEqual(r.json.resumen.kmTotal, 80);
    } finally { await srv.cerrar(); }
  });
});

describe('reportes: /diario', () => {
  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'reportes', {
      d1_iso:   { fecha: '2026-11-05' },
      d2_dmy:   { fecha: '05/11/2026' },
      d3_otro:  { fecha: '06/11/2026' },
      d4_sin:   {},                                      // sin fecha
      d5_rota:  { fecha: 'basura' },
      d6_hoy:   { fecha: '2026-11-15' },                 // "hoy" (15/11/2026) guardado en ISO
      d7_ajeno: { fecha: '05/11/2026', chofer: 'ana@empresa.com' },
    });
    return m;
  };
  const dia = async (srv, query, headers) => (await srv.llamar('GET', '/api/reportes/diario' + query, null, headers)).json;

  test('compara por día, sin importar el formato en que llegó o quedó guardada cada fecha', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      for (const q of ['?fecha=2026-11-05', '?fecha=05/11/2026', '?fecha=5/11/26']) {
        const r = await dia(srv, q);
        assert.deepStrictEqual(r.filas.map(x => x.id).sort(), ['d1_iso', 'd2_dmy', 'd7_ajeno'], q);
        assert.strictEqual(r.fecha, '05/11/2026', 'devuelve la fecha normalizada');
      }
    } finally { await srv.cerrar(); }
  });

  test('sin ?fecha usa hoy (en Argentina), también para los guardados en ISO', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const r = await dia(srv, '');
      assert.deepStrictEqual(r.filas.map(x => x.id), ['d6_hoy']);
      assert.strictEqual(r.fecha, HOY_STUB);
    } finally { await srv.cerrar(); }
  });

  test('una fecha inválida no encuentra nada: NO se iguala con los documentos sin fecha o con fecha rota', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      for (const q of ['?fecha=basura', '?fecha=31/02/2026']) {
        const r = await dia(srv, q);
        assert.deepStrictEqual({ ok: r.ok, datos: r.datos, filas: r.filas }, { ok: true, datos: null, filas: [] }, q);
      }
    } finally { await srv.cerrar(); }
  });

  test('un chofer ve solo sus reportes del día', async () => {
    const m = cargar();
    sembrar(m.db, 'reportes', {
      mio:   { fecha: '2026-11-05', chofer: 'juan@empresa.com' },
      ajeno: { fecha: '05/11/2026', chofer: 'ana@empresa.com' },
    });
    const srv = await levantar(m);
    try {
      const r = await dia(srv, '?fecha=05/11/2026', { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.deepStrictEqual(r.filas.map(x => x.id), ['mio']);
    } finally { await srv.cerrar(); }
  });
});

describe('reportes: guardado', () => {
  const cuerpo = (extra = {}) => ({ kmInicial: 100, kmFinal: 180, vehiculo: 'Kangoo', ...extra });

  test('POST con fecha ISO (input date) guarda dd/MM/yyyy; sigue calculando los km y asignando al chofer', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/reportes', cuerpo({ fecha: '2026-11-05', chofer: 'otro@x.com' }), { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.kmRecorridos, 80);
      const doc = guardados(m.db, 'reportes')[0];
      assert.strictEqual(doc.fecha, '05/11/2026');
      assert.strictEqual(doc.chofer, 'juan@empresa.com', 'el chofer sale del usuario, no del cuerpo');
      assert.ok(doc.creadoEn, 'sigue guardando creadoEn');
    } finally { await srv.cerrar(); }
  });

  test('POST normaliza otros formatos y acepta FECHA en mayúsculas (se guarda como `fecha`)', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const extra of [{ fecha: '5/11/26' }, { fecha: '05/11/2026' }, { fecha: '2026-11-06T01:30:00.000Z' }, { FECHA: '2026-11-05' }]) {
        assert.strictEqual((await srv.llamar('POST', '/api/reportes', cuerpo(extra))).status, 200, JSON.stringify(extra));
      }
      const docs = guardados(m.db, 'reportes');
      assert.deepStrictEqual(docs.map(x => x.fecha), ['05/11/2026', '05/11/2026', '05/11/2026', '05/11/2026']);
      assert.ok(docs.every(x => x.FECHA === undefined));
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha o con fecha inválida: 400 y no se guarda nada', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const extra of [{}, { fecha: '' }, { fecha: null }, { fecha: '   ' }]) {
        const r = await srv.llamar('POST', '/api/reportes', cuerpo(extra));
        assert.strictEqual(r.status, 400, JSON.stringify(extra));
        assert.match(r.json.mensaje, /Falta la fecha del reporte/);
      }
      for (const fecha of ['basura', '31/02/2026', '2026-13-45']) {
        const r = await srv.llamar('POST', '/api/reportes', cuerpo({ fecha }));
        assert.strictEqual(r.status, 400, fecha);
        assert.match(r.json.mensaje, /fecha no es válida.*dd\/MM\/yyyy/);
      }
      assert.strictEqual(guardados(m.db, 'reportes').length, 0);
    } finally { await srv.cerrar(); }
  });

  test('un reporte rechazado por la fecha NO sube sus fotos a Storage (no deja archivos huérfanos)', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/reportes', cuerpo({ fecha: 'basura', fotoIniBase64: 'AAAA', fotoFinBase64: 'BBBB' }));
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual(m.fotos, []);
      // y con una fecha buena las fotos sí se suben
      const ok = await srv.llamar('POST', '/api/reportes', cuerpo({ fecha: '2026-11-05', fotoIniBase64: 'AAAA' }));
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(m.fotos.length, 1);
      assert.match(guardados(m.db, 'reportes')[0].fotoIniUrl, /^https:\/\/storage\.test\/reportes\/t1\//);
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha que llega y no toca el resto', async () => {
    const m = cargar(); sembrar(m.db, 'reportes', { p1: { fecha: '01/11/2026', observaciones: 'original', vehiculo: 'Kangoo' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/reportes/p1', { fecha: '2026-11-06', observaciones: 'corregido' })).status, 200);
      const doc = guardados(m.db, 'reportes')[0];
      assert.deepStrictEqual({ f: doc.fecha, o: doc.observaciones, v: doc.vehiculo }, { f: '06/11/2026', o: 'corregido', v: 'Kangoo' });
    } finally { await srv.cerrar(); }
  });

  test('PUT con fecha inválida o vacía: 400 y el documento queda como estaba', async () => {
    const m = cargar(); sembrar(m.db, 'reportes', { p1: { fecha: '01/11/2026', observaciones: 'original' } });
    const srv = await levantar(m);
    try {
      for (const fecha of ['basura', '31/02/2026', '', null]) {
        const r = await srv.llamar('PUT', '/api/reportes/p1', { fecha, observaciones: 'no debería guardarse' });
        assert.strictEqual(r.status, 400, JSON.stringify(fecha));
        assert.match(r.json.mensaje, /fecha no es válida/);
      }
      assert.deepStrictEqual({ f: guardados(m.db, 'reportes')[0].fecha, o: guardados(m.db, 'reportes')[0].observaciones }, { f: '01/11/2026', o: 'original' });
    } finally { await srv.cerrar(); }
  });

  test('PUT sin fecha en el cuerpo no la toca', async () => {
    const m = cargar(); sembrar(m.db, 'reportes', { p1: { fecha: '2026-11-03', observaciones: 'a' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/reportes/p1', { observaciones: 'b' })).status, 200);
      assert.strictEqual(guardados(m.db, 'reportes')[0].fecha, '2026-11-03');
    } finally { await srv.cerrar(); }
  });

  test('un chofer sigue sin poder editar el reporte de otro (403) y la fecha no cambia', async () => {
    const m = cargar(); sembrar(m.db, 'reportes', { ajeno: { fecha: '01/11/2026', chofer: 'ana@empresa.com' } });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('PUT', '/api/reportes/ajeno', { fecha: '2026-11-06' }, { 'x-rol': 'chofer', 'x-email': 'juan@empresa.com' });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(guardados(m.db, 'reportes')[0].fecha, '01/11/2026');
    } finally { await srv.cerrar(); }
  });
});
