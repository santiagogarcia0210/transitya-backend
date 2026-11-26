/**
 * Dashboard, planillas, facturación (ARCA / especial), paquetería, traslado y recorridos: fechas
 * en cualquier formato, contra las rutas REALES con un Firestore en memoria (sin red ni credenciales).
 *
 * El defecto (el mismo que ya se arregló en remitos, egresos, ingresos y reportes):
 *  - utils.esMesDMY parte por "/", así que un documento guardado en ISO (yyyy-MM-dd, lo que manda
 *    <input type="date">) quedaba afuera de los totales del Inicio y de los filtros por mes;
 *  - las facturas guardaban la fecha cruda (en ISO) y la copiaban tal cual a ingresos;
 *  - varios listados ordenaban con localeCompare sobre texto dd/MM/yyyy, que ordena por día y no por fecha;
 *  - varios filtros comparaban la fecha por igualdad exacta de texto.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const crypto = require('node:crypto');

const { fakeDb } = require('./helpers/fakeFirestore');

const RAIZ = path.join(__dirname, '..');
const T = 't1';
const HOY_STUB = '15/11/2026';   // lo que devuelve fechaHoyAR() en estas pruebas
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/* ── Carga de las rutas reales con sus dependencias reemplazadas ─────────────
 * El gancho de require queda instalado mientras corre este archivo (y no solo durante la carga): dashboard.js
 * hace require('../firebase') adentro del handler, o sea en cada request. Solo afecta a los archivos de abajo. */

const ARCHIVOS = ['routes/dashboard.js', 'routes/planillas.js', 'routes/facturacion.js', 'routes/paqueteria.js',
  'routes/traslado.js', 'routes/recorridos.js', 'routes/reportes.js', 'services/kmPendientes.js', 'services/resumenDiario.js']
  .map(r => require.resolve(path.join(RAIZ, r)));

let actual = null;   // { utils, auth, storage, db } de la prueba en curso
const original = Module._load;
Module._load = function (pedido, padre, esMain) {
  if (actual && padre && ARCHIVOS.includes(padre.filename)) {
    if (pedido === '../utils') return actual.utils;
    if (pedido === '../middleware/auth') return actual.auth;
    if (pedido === '../helpers/storage') return actual.storage;
    if (pedido === '../firebase') return { db: actual.db };
  }
  return original.call(this, pedido, padre, esMain);
};

function cargar() {
  const db = fakeDb();
  const correlativos = { llamadas: 0, valores: {} };
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const utils = {
    col: (t, sub) => db.coleccion(`empresas/${t}/${sub}`),
    normalizarText_: norm,
    parseMonto_: v => parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0,
    fechaHoyAR: () => HOY_STUB,
    randomUUID: () => crypto.randomUUID(),
    nombreUsuario: u => (u && u.email) || '',
    esMesISO: () => false,
    MESES,
    // Cuenta cuántas veces se pidió un número de factura: un 400 no debe gastar ninguno.
    generarCorrelativo: async (t, key) => {
      correlativos.llamadas++;
      correlativos.valores[key] = (correlativos.valores[key] || 0) + 1;
      return correlativos.valores[key];
    },
  };
  const pasa = (req, res, next) => next();
  const auth = {
    verifyToken: (req, res, next) => {
      req.user = { email: req.headers['x-email'] || 'admin@empresa.com', rol: req.headers['x-rol'] || 'admin' };
      next();
    },
    requireAdmin: pasa,
    requireModulo: () => pasa,
  };
  const storage = { subirFoto: async (b64, mime, ruta) => 'https://storage.test/' + ruta };
  actual = { utils, auth, storage, db };
  for (const r of ARCHIVOS) delete require.cache[r];
  const cargarRuta = r => require(require.resolve(path.join(RAIZ, r)));
  return {
    db, utils, correlativos,
    dashboard: cargarRuta('routes/dashboard.js'), planillas: cargarRuta('routes/planillas.js'),
    facturacion: cargarRuta('routes/facturacion.js'), paqueteria: cargarRuta('routes/paqueteria.js'),
    traslado: cargarRuta('routes/traslado.js'), recorridos: cargarRuta('routes/recorridos.js'),
    reportes: cargarRuta('routes/reportes.js'),
    kmPendientes: cargarRuta('services/kmPendientes.js'), resumenDiario: cargarRuta('services/resumenDiario.js'),
  };
}

async function levantar(m) {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.tenantId = T; next(); });
  app.use('/api/dashboard', m.dashboard);
  app.use('/api/planillas', m.planillas);
  app.use('/api/facturacion', m.facturacion);
  app.use('/api/paqueteria', m.paqueteria);
  app.use('/api/traslado', m.traslado);
  app.use('/api/recorridos', m.recorridos);
  app.use('/api/reportes', m.reportes);
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

const sembrar = (db, coleccion, docs) => {
  for (const [id, datos] of Object.entries(docs)) db.docs.set(`empresas/${T}/${coleccion}/${id}`, { ...datos });
};
const guardados = (db, coleccion) =>
  [...db.docs.entries()].filter(([k]) => k.startsWith(`empresas/${T}/${coleccion}/`)).map(([, v]) => v);
const guardadoPor = (db, coleccion, id) => db.docs.get(`empresas/${T}/${coleccion}/${id}`);

/* ═══════════════════════════ dashboard.js (los números del Inicio) ═══════════ */

describe('dashboard: los totales del mes incluyen documentos en cualquier formato de fecha', () => {
  // Igual que la ruta: el mes y el año salen de new Date() (hora del servidor).
  const AHORA = new Date();
  const MES = AHORA.getMonth() + 1, ANIO = AHORA.getFullYear();
  const MES_ANT = MES === 1 ? 12 : MES - 1, ANIO_ANT = MES === 1 ? ANIO - 1 : ANIO;
  const p2 = n => String(n).padStart(2, '0');
  const iso = (a, m, d) => `${a}-${p2(m)}-${p2(d)}`;
  const dmy = (a, m, d) => `${p2(d)}/${p2(m)}/${a}`;
  const ESTE_ISO = iso(ANIO, MES, 10), ESTE_DMY = dmy(ANIO, MES, 9), ESTE_CORTA = `8/${MES}/${String(ANIO).slice(2)}`;
  const ANT_ISO = iso(ANIO_ANT, MES_ANT, 28);

  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'registro', { b1: {}, b2: {}, b3: {} });
    sembrar(m.db, 'bajas', {
      b1: { 'FECHA DE BAJA': ESTE_ISO }, b2: { fechaDeBaja: ESTE_DMY },
      b3: { 'FECHA DE BAJA': ANT_ISO }, b4: { 'FECHA DE BAJA': 'basura' },
    });
    sembrar(m.db, 'egresos', {
      e1: { fecha: ESTE_ISO, monto: 100 }, e2: { fecha: ESTE_DMY, monto: 200 },
      e3: { FECHA: ESTE_CORTA, monto: 300 },                       // migrado de Sheets, con año de 2 dígitos
      e4: { fecha: ANT_ISO, monto: 1000 },                         // otro mes: afuera
      e5: { fecha: 'basura', monto: 5000 },                        // no se entiende: afuera
    });
    sembrar(m.db, 'ingresos', {
      i1: { fecha: ESTE_ISO, estado: 'PAGADO', monto: 1000, fechaPago: '' },
      i2: { fecha: ESTE_DMY, estado: 'PRESENTADO', monto: 500 },
      i3: { fecha: ANT_ISO, estado: 'PAGADO', monto: 200, fechaPago: ESTE_ISO },   // facturada antes, cobrada este mes
      i4: { fecha: 'basura', estado: 'PRESENTADO', monto: 9999 },
    });
    sembrar(m.db, 'reportes', {
      r1: { fecha: ESTE_ISO, kmRecorridos: 100 }, r2: { fecha: ESTE_DMY, kmRecorridos: 50 },
      r3: { fecha: ANT_ISO, kmRecorridos: 999 }, r4: { fecha: 'basura', kmRecorridos: 888 },
    });
    return m;
  };

  test('REGRESIÓN: bajas, gasto, facturado, cobrado y km cuentan los guardados en ISO (esMesDMY los dejaba afuera)', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/dashboard/resumen');
      assert.strictEqual(r.status, 200);
      const j = r.json;
      assert.strictEqual(j.beneficiariosActivos, 3);
      assert.strictEqual(j.bajasMes, 2, 'ISO y dd/MM/yyyy; no cuenta otro mes ni lo que no se entiende');
      assert.deepStrictEqual({ n: j.egresosMes, total: j.totalEgresosMes }, { n: 3, total: 600 });
      assert.deepStrictEqual({ n: j.ingresosMes, total: j.totalIngresosMes }, { n: 2, total: 1500 });
      assert.strictEqual(j.totalPagadoMes, 1200, 'la facturada este mes (ISO) + la cobrada este mes con fechaPago en ISO');
      assert.strictEqual(j.totalPresentadoMes, 500);
      assert.strictEqual(j.kmMes, 150);
    } finally { await srv.cerrar(); }
  });
});

describe('dashboard: "Reporte KM hoy" (reporteHoy)', () => {
  test('un reporte de hoy cuenta aunque esté guardado en ISO, en dd/MM/yyyy o con año de 2 dígitos', async () => {
    const m = cargar();
    sembrar(m.db, 'usuarios', {
      u1: { rol: 'chofer', nombre: 'Juan' }, u2: { rol: 'chofer', nombre: 'Ana' },
      u3: { rol: 'chofer', nombre: 'Luis' }, u4: { rol: 'chofer', nombre: 'Rosa' },
    });
    sembrar(m.db, 'reportes', {
      a: { fecha: '2026-11-15', chofer: 'Juan' },          // hoy, en ISO
      b: { fecha: '15/11/2026', chofer: 'Ana' },           // hoy, el formato de siempre
      c: { fecha: '14/11/2026', chofer: 'Luis' },          // ayer
      d: { fecha: 'basura', chofer: 'Rosa' },              // no se entiende
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/dashboard/resumen');
      const por = Object.fromEntries(r.json.estadoChoferes.map(c => [c.nombre, c.reporteHoy]));
      assert.deepStrictEqual(por, { Juan: true, Ana: true, Luis: false, Rosa: false });
    } finally { await srv.cerrar(); }
  });
});

/* ═══════════════════════════ planillas.js ═══════════════════════════════════ */

describe('planillas: la facturación del mes entra con cualquier formato de fecha', () => {
  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'registro', {
      r1: { 'APELLIDO Y NOMBRE': 'Ana', 'N° AFILIADO': '111' }, r2: { 'APELLIDO Y NOMBRE': 'Beto', 'N° AFILIADO': '222' },
      r3: { 'APELLIDO Y NOMBRE': 'Carla', 'N° AFILIADO': '333' }, r4: { 'APELLIDO Y NOMBRE': 'Dario', 'N° AFILIADO': '444' },
    });
    sembrar(m.db, 'facturacion', {
      f1: { afiliado: '111', monto: 100, fecha: '2026-11-05' },      // ISO
      f2: { afiliado: '222', monto: 200, FECHA: '07/11/2026' },      // migrado de Sheets
      f3: { afiliado: '333', monto: 300, fecha: '2026-10-31' },      // otro mes
      f4: { afiliado: '444', monto: 400, fecha: 'basura' },          // no se entiende
    });
    return m;
  };

  test('/incluir toma la factura del mes aunque esté en ISO, y deja afuera otros meses y fechas rotas', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/planillas/incluir?mes=11&anio=2026');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.filas.map(f => [f.nombre, f.monto]), [['Ana', 100], ['Beto', 200], ['Carla', ''], ['Dario', '']]);
    } finally { await srv.cerrar(); }
  });

  test('/dj107 usa el mismo filtro (no falla y mantiene a todos los beneficiarios)', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/planillas/dj107?mes=11&anio=2026');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
    } finally { await srv.cerrar(); }
  });
});

/* ═══════════════════════════ facturacion.js ═════════════════════════════════ */

describe('facturación especial: orden y guardado', () => {
  const cuerpo = (extra = {}) => ({ clienteNombre: 'Cliente', total: 100, tipoFactura: 'B', puntoVenta: 1, ...extra });

  test('POST con fecha ISO (input date) guarda dd/MM/yyyy y copia ESA fecha al ingreso', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/facturacion/esp/facturas', cuerpo({ fecha: '2026-11-05' }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(guardados(m.db, 'esp_facturas')[0].fecha, '05/11/2026');
      const ing = guardados(m.db, 'ingresos');
      assert.strictEqual(ing.length, 1);
      assert.strictEqual(ing[0].fecha, '05/11/2026', 'el ingreso no hereda la fecha cruda');
      assert.strictEqual(ing[0].facturaId, r.json.id);
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha sigue guardando la de hoy (comportamiento de siempre)', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const extra of [{}, { fecha: '' }, { fecha: null }, { fecha: '   ' }]) {
        assert.strictEqual((await srv.llamar('POST', '/api/facturacion/esp/facturas', cuerpo(extra))).status, 200);
      }
      assert.ok(guardados(m.db, 'esp_facturas').every(x => x.fecha === HOY_STUB));
      assert.ok(guardados(m.db, 'ingresos').every(x => x.fecha === HOY_STUB));
    } finally { await srv.cerrar(); }
  });

  test('POST con una fecha que no se entiende: 400, no se guarda nada y NO se gasta un número de factura', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const fecha of ['basura', '31/02/2026', '2026-13-45']) {
        const r = await srv.llamar('POST', '/api/facturacion/esp/facturas', cuerpo({ fecha }));
        assert.strictEqual(r.status, 400, fecha);
        assert.match(r.json.mensaje, /fecha no es válida.*dd\/MM\/yyyy/);
      }
      assert.strictEqual(guardados(m.db, 'esp_facturas').length, 0);
      assert.strictEqual(guardados(m.db, 'ingresos').length, 0);
      assert.strictEqual(m.correlativos.llamadas, 0, 'el rechazo no consumió un correlativo');
    } finally { await srv.cerrar(); }
  });

  test('editar una factura existente (POST con id) normaliza la fecha y no crea otro ingreso', async () => {
    const m = cargar();
    sembrar(m.db, 'esp_facturas', { f1: { id: 'f1', fecha: '01/11/2026', nroFactura: '0001-00000001' } });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/facturacion/esp/facturas', cuerpo({ id: 'f1', fecha: '2026-11-06' }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(guardadoPor(m.db, 'esp_facturas', 'f1').fecha, '06/11/2026');
      assert.strictEqual(guardados(m.db, 'ingresos').length, 0);
      assert.strictEqual(m.correlativos.llamadas, 0);
    } finally { await srv.cerrar(); }
  });

  test('REGRESIÓN: el listado ordena por fecha y no por texto ("10/12/2025" no va antes que "05/11/2026")', async () => {
    const m = cargar();
    sembrar(m.db, 'esp_facturas', {
      d_viejo: { fecha: '10/12/2025' }, c: { fecha: '25/10/2026' }, b: { fecha: '05/11/2026' },
      a_iso: { fecha: '2026-11-12' }, e_rota: { fecha: 'basura' }, f_sin: {},
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/facturacion/esp/facturas');
      assert.deepStrictEqual(r.json.facturas.map(f => f.id), ['a_iso', 'b', 'c', 'd_viejo', 'e_rota', 'f_sin']);
    } finally { await srv.cerrar(); }
  });
});

describe('facturación ARCA: orden, rango y guardado', () => {
  const cuerpo = (extra = {}) => ({ tipoComprobante: 'Factura B', cliente: 'Cliente', monto: 100, ...extra });

  test('POST con fecha ISO guarda dd/MM/yyyy en la factura y en el ingreso', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      const r = await srv.llamar('POST', '/api/facturacion/arca', cuerpo({ fecha: '2026-11-05' }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(guardados(m.db, 'arca_facturas')[0].fecha, '05/11/2026');
      assert.strictEqual(guardados(m.db, 'ingresos')[0].fecha, '05/11/2026');
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha usa hoy; con fecha inválida da 400 y no guarda nada', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/facturacion/arca', cuerpo())).status, 200);
      assert.strictEqual(guardados(m.db, 'arca_facturas')[0].fecha, HOY_STUB);
      for (const fecha of ['basura', '31/02/2026']) {
        const r = await srv.llamar('POST', '/api/facturacion/arca', cuerpo({ fecha }));
        assert.strictEqual(r.status, 400, fecha);
        assert.match(r.json.mensaje, /fecha no es válida/);
      }
      assert.strictEqual(guardados(m.db, 'arca_facturas').length, 1);
      assert.strictEqual(guardados(m.db, 'ingresos').length, 1);
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha; inválida o vacía da 400 y no cambia nada; sin fecha en el cuerpo no la toca', async () => {
    const m = cargar();
    sembrar(m.db, 'arca_facturas', { a1: { id: 'a1', fecha: '01/11/2026', cliente: 'X' }, a2: { id: 'a2', fecha: '2026-11-03', cliente: 'Z' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/facturacion/arca/a1', { fecha: '2026-11-06', cliente: 'Y' })).status, 200);
      assert.deepStrictEqual({ f: guardadoPor(m.db, 'arca_facturas', 'a1').fecha, c: guardadoPor(m.db, 'arca_facturas', 'a1').cliente }, { f: '06/11/2026', c: 'Y' });
      for (const fecha of ['basura', '31/02/2026', '']) {
        assert.strictEqual((await srv.llamar('PUT', '/api/facturacion/arca/a1', { fecha, cliente: 'NO' })).status, 400, JSON.stringify(fecha));
      }
      assert.strictEqual(guardadoPor(m.db, 'arca_facturas', 'a1').cliente, 'Y');
      assert.strictEqual((await srv.llamar('PUT', '/api/facturacion/arca/a2', { cliente: 'W' })).status, 200);
      assert.strictEqual(guardadoPor(m.db, 'arca_facturas', 'a2').fecha, '2026-11-03', 'eso lo arregla el script de migración');
    } finally { await srv.cerrar(); }
  });

  const MEZCLADAS = {
    a_iso12: { fecha: '2026-11-12' }, b_dmy09: { fecha: '09/11/2026' }, c_corta05: { fecha: '5/11/26' },
    d_oct: { fecha: '2026-10-01' }, e_rota: { fecha: 'basura' }, f_sin: {},
  };

  test('desde/hasta (ISO, como los manda el input) alcanzan a todos los formatos; sin fecha interpretable NO se descarta (como siempre)', async () => {
    const m = cargar(); sembrar(m.db, 'arca_facturas', MEZCLADAS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/facturacion/arca?desde=2026-11-05&hasta=2026-11-10');
      assert.deepStrictEqual(r.json.facturas.map(f => f.id), ['b_dmy09', 'c_corta05', 'e_rota', 'f_sin']);
      assert.deepStrictEqual((await srv.llamar('GET', '/api/facturacion/arca?desde=2026-11-10')).json.facturas.map(f => f.id), ['a_iso12', 'e_rota', 'f_sin']);
    } finally { await srv.cerrar(); }
  });

  test('un límite que no se entiende se ignora y el listado sale ordenado por fecha', async () => {
    const m = cargar(); sembrar(m.db, 'arca_facturas', MEZCLADAS);
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/facturacion/arca?desde=cualquier-cosa');
      assert.deepStrictEqual(r.json.facturas.map(f => f.id), ['a_iso12', 'b_dmy09', 'c_corta05', 'd_oct', 'e_rota', 'f_sin']);
    } finally { await srv.cerrar(); }
  });
});

describe('facturación: facturas emitidas', () => {
  test('POST normaliza la fecha si viene, la deja ausente si no viene, y da 400 si no se entiende', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/facturacion/emitidas', { numero: '1', fecha: '2026-11-05' })).status, 200);
      assert.strictEqual((await srv.llamar('POST', '/api/facturacion/emitidas', { numero: '2' })).status, 200);
      const r = await srv.llamar('POST', '/api/facturacion/emitidas', { numero: '3', fecha: 'basura' });
      assert.strictEqual(r.status, 400);
      const docs = guardados(m.db, 'facturas_emitidas');
      assert.strictEqual(docs.length, 2);
      assert.strictEqual(docs.find(d => d.numero === '1').fecha, '05/11/2026');
      assert.strictEqual(docs.find(d => d.numero === '2').fecha, undefined, 'esta ruta nunca puso fecha por defecto');
    } finally { await srv.cerrar(); }
  });

  test('el listado ordena por fecha y no por texto', async () => {
    const m = cargar();
    sembrar(m.db, 'facturas_emitidas', { viejo: { fecha: '10/12/2025' }, nuevo: { fecha: '05/11/2026' }, iso: { fecha: '2026-11-12' } });
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual((await srv.llamar('GET', '/api/facturacion/emitidas')).json.facturas.map(f => f.id), ['iso', 'nuevo', 'viejo']);
    } finally { await srv.cerrar(); }
  });
});

/* ═══════════════════════════ paqueteria.js ══════════════════════════════════ */

describe('paquetería: rutas de reparto', () => {
  const ids = r => r.json.rutas.map(x => x._fsId);

  test('?fecha= encuentra la ruta del día sin importar el formato en que quedó guardada (o en que se pidió)', async () => {
    const m = cargar();
    sembrar(m.db, 'paq_rutas', {
      r_iso: { fecha: '2026-11-05' }, r_dmy: { fecha: '05/11/2026' }, r_corta: { fecha: '5/11/26' },
      r_otro: { fecha: '06/11/2026' }, r_sin: {}, r_rota: { fecha: 'basura' },
    });
    const srv = await levantar(m);
    try {
      for (const q of ['2026-11-05', '05/11/2026', '5/11/26']) {
        assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/paqueteria/rutas?fecha=' + encodeURIComponent(q))), ['r_iso', 'r_dmy', 'r_corta'], q);
      }
      assert.strictEqual((await srv.llamar('GET', '/api/paqueteria/rutas')).json.rutas.length, 6, 'sin ?fecha trae todas');
    } finally { await srv.cerrar(); }
  });

  test('una fecha pedida que no se entiende solo encuentra lo que tiene exactamente ese texto (nunca las sin fecha)', async () => {
    const m = cargar();
    sembrar(m.db, 'paq_rutas', { r_rota: { fecha: 'basura' }, r_sin: {}, r_ok: { fecha: '05/11/2026' } });
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual(ids(await srv.llamar('GET', '/api/paqueteria/rutas?fecha=basura')), ['r_rota']);
    } finally { await srv.cerrar(); }
  });

  test('POST: ISO → dd/MM/yyyy; sin fecha → hoy; inválida → 400 y no se guarda', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/paqueteria/rutas', { fecha: '2026-11-05' })).status, 200);
      assert.strictEqual((await srv.llamar('POST', '/api/paqueteria/rutas', {})).status, 200);
      const r = await srv.llamar('POST', '/api/paqueteria/rutas', { fecha: 'basura' });
      assert.strictEqual(r.status, 400);
      assert.match(r.json.mensaje, /fecha no es válida/);
      assert.deepStrictEqual(guardados(m.db, 'paq_rutas').map(x => x.fecha), ['05/11/2026', HOY_STUB]);
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha; inválida o vacía da 400 sin tocar nada; sin fecha en el cuerpo no la toca', async () => {
    const m = cargar(); sembrar(m.db, 'paq_rutas', { r1: { fecha: '01/11/2026', notas: 'a' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/paqueteria/rutas/r1', { fecha: '2026-11-06', notas: 'b' })).status, 200);
      assert.deepStrictEqual({ f: guardadoPor(m.db, 'paq_rutas', 'r1').fecha, n: guardadoPor(m.db, 'paq_rutas', 'r1').notas }, { f: '06/11/2026', n: 'b' });
      for (const fecha of ['basura', '']) assert.strictEqual((await srv.llamar('PUT', '/api/paqueteria/rutas/r1', { fecha, notas: 'NO' })).status, 400);
      assert.strictEqual(guardadoPor(m.db, 'paq_rutas', 'r1').notas, 'b');
      assert.strictEqual((await srv.llamar('PUT', '/api/paqueteria/rutas/r1', { notas: 'c' })).status, 200);
      assert.strictEqual(guardadoPor(m.db, 'paq_rutas', 'r1').fecha, '06/11/2026');
    } finally { await srv.cerrar(); }
  });
});

describe('paquetería: facturas', () => {
  const cuerpo = (extra = {}) => ({ clienteNombre: 'Cliente', total: 100, tipoFactura: 'B', puntoVenta: 1, ...extra });

  test('POST con fecha ISO guarda dd/MM/yyyy y copia esa fecha al ingreso', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/paqueteria/facturas', cuerpo({ fecha: '2026-11-05' }))).status, 200);
      assert.strictEqual(guardados(m.db, 'paq_facturas')[0].fecha, '05/11/2026');
      assert.strictEqual(guardados(m.db, 'ingresos')[0].fecha, '05/11/2026');
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha usa hoy; con fecha inválida da 400, no guarda y NO gasta un número de factura', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/paqueteria/facturas', cuerpo())).status, 200);
      assert.strictEqual(guardados(m.db, 'paq_facturas')[0].fecha, HOY_STUB);
      const antes = m.correlativos.llamadas;
      for (const fecha of ['basura', '31/02/2026']) assert.strictEqual((await srv.llamar('POST', '/api/paqueteria/facturas', cuerpo({ fecha }))).status, 400, fecha);
      assert.strictEqual(guardados(m.db, 'paq_facturas').length, 1);
      assert.strictEqual(m.correlativos.llamadas, antes, 'los rechazos no consumieron correlativos');
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha; inválida da 400', async () => {
    const m = cargar(); sembrar(m.db, 'paq_facturas', { p1: { fecha: '01/11/2026', observaciones: 'a' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/paqueteria/facturas/p1', { fecha: '2026-11-06' })).status, 200);
      assert.strictEqual(guardadoPor(m.db, 'paq_facturas', 'p1').fecha, '06/11/2026');
      assert.strictEqual((await srv.llamar('PUT', '/api/paqueteria/facturas/p1', { fecha: 'basura', observaciones: 'NO' })).status, 400);
      assert.strictEqual(guardadoPor(m.db, 'paq_facturas', 'p1').observaciones, 'a');
    } finally { await srv.cerrar(); }
  });

  test('REGRESIÓN: el listado ordena por fecha y no por texto', async () => {
    const m = cargar();
    sembrar(m.db, 'paq_facturas', { viejo: { fecha: '10/12/2025' }, nuevo: { fecha: '05/11/2026' }, iso: { fecha: '2026-11-12' }, rota: { fecha: 'basura' } });
    const srv = await levantar(m);
    try {
      assert.deepStrictEqual((await srv.llamar('GET', '/api/paqueteria/facturas')).json.facturas.map(f => f._fsId), ['iso', 'nuevo', 'viejo', 'rota']);
    } finally { await srv.cerrar(); }
  });
});

/* ═══════════════════════════ traslado.js ════════════════════════════════════ */

describe('traslado: viajes del día del chofer', () => {
  test('encuentra los viajes de hoy sin importar el formato en que quedó guardada la fecha; incluye los sin fecha; excluye otros días, ajenos y cancelados', async () => {
    const m = cargar();
    sembrar(m.db, 'tras_choferes', { c1: { id: 'c1', nombre: 'Juan', email: 'juan@x.com' } });
    sembrar(m.db, 'tras_viajes', {
      v_iso:    { id: 'v_iso',    choferId: 'c1', fecha: '2026-11-15', hora: '10:00', estado: 'pendiente' },   // hoy, ISO
      v_dmy:    { id: 'v_dmy',    choferId: 'c1', fecha: '15/11/2026', hora: '09:00', estado: 'pendiente' },
      v_corta:  { id: 'v_corta',  choferId: 'c1', fecha: '15/11/26',   hora: '08:00', estado: 'pendiente' },
      v_sin:    { id: 'v_sin',    choferId: 'c1',                       hora: '11:00', estado: 'pendiente' },   // sin fecha: va igual
      v_otro:   { id: 'v_otro',   choferId: 'c1', fecha: '16/11/2026', hora: '07:00', estado: 'pendiente' },
      v_ajeno:  { id: 'v_ajeno',  choferId: 'c2', fecha: '15/11/2026', hora: '06:00', estado: 'pendiente' },
      v_cancel: { id: 'v_cancel', choferId: 'c1', fecha: '2026-11-15', hora: '05:00', estado: 'cancelado' },
    });
    const srv = await levantar(m);
    try {
      const r = await srv.llamar('GET', '/api/traslado/viajes-chofer', null, { 'x-rol': 'chofer', 'x-email': 'juan@x.com' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.viajes.map(v => v.id), ['v_corta', 'v_dmy', 'v_iso', 'v_sin']);
    } finally { await srv.cerrar(); }
  });
});

describe('traslado: viajes y reservas (la fecha puede faltar; lo que no se entiende no se rechaza)', () => {
  test('POST de viaje y de reserva: ISO → dd/MM/yyyy; vacío queda vacío; lo que no se entiende queda como vino', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      for (const [fecha, esperada] of [['2026-11-05', '05/11/2026'], ['5/11/26', '05/11/2026'], ['', ''], ['basura', 'basura']]) {
        assert.strictEqual((await srv.llamar('POST', '/api/traslado/viajes', { pasajeroNombre: 'P', fecha })).status, 200, fecha);
        assert.strictEqual((await srv.llamar('POST', '/api/traslado/reservas', { pasajeroNombre: 'P', fecha })).status, 200, fecha);
        void esperada;
      }
      assert.deepStrictEqual(guardados(m.db, 'tras_viajes').map(x => x.fecha), ['05/11/2026', '05/11/2026', '', 'basura']);
      assert.deepStrictEqual(guardados(m.db, 'tras_reservas').map(x => x.fecha), ['05/11/2026', '05/11/2026', '', 'basura']);
    } finally { await srv.cerrar(); }
  });

  test('PUT de viaje y de reserva normaliza la fecha si se entiende, como el POST', async () => {
    const m = cargar();
    sembrar(m.db, 'tras_viajes', { v1: { fecha: '01/11/2026' } });
    sembrar(m.db, 'tras_reservas', { s1: { fecha: '01/11/2026' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/traslado/viajes/v1', { fecha: '2026-11-06' })).status, 200);
      assert.strictEqual((await srv.llamar('PUT', '/api/traslado/reservas/s1', { fecha: '2026-11-07' })).status, 200);
      assert.strictEqual(guardadoPor(m.db, 'tras_viajes', 'v1').fecha, '06/11/2026');
      assert.strictEqual(guardadoPor(m.db, 'tras_reservas', 's1').fecha, '07/11/2026');
    } finally { await srv.cerrar(); }
  });
});

describe('traslado: facturas', () => {
  const cuerpo = (extra = {}) => ({ pasajeroNombre: 'Pasajero', total: 50, tipoFactura: 'B', puntoVenta: 1, ...extra });

  test('POST con fecha ISO guarda dd/MM/yyyy y copia esa fecha al ingreso', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/traslado/facturas', cuerpo({ fecha: '2026-11-05' }))).status, 200);
      assert.strictEqual(guardados(m.db, 'tras_facturas')[0].fecha, '05/11/2026');
      assert.strictEqual(guardados(m.db, 'ingresos')[0].fecha, '05/11/2026');
    } finally { await srv.cerrar(); }
  });

  test('POST sin fecha usa hoy; inválida da 400, no guarda y NO gasta un número de factura', async () => {
    const m = cargar(); const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('POST', '/api/traslado/facturas', cuerpo())).status, 200);
      assert.strictEqual(guardados(m.db, 'tras_facturas')[0].fecha, HOY_STUB);
      const antes = m.correlativos.llamadas;
      for (const fecha of ['basura', '2026-13-45']) assert.strictEqual((await srv.llamar('POST', '/api/traslado/facturas', cuerpo({ fecha }))).status, 400, fecha);
      assert.strictEqual(guardados(m.db, 'tras_facturas').length, 1);
      assert.strictEqual(m.correlativos.llamadas, antes);
    } finally { await srv.cerrar(); }
  });

  test('PUT normaliza la fecha; inválida da 400 y no cambia nada', async () => {
    const m = cargar(); sembrar(m.db, 'tras_facturas', { t1: { fecha: '01/11/2026', observaciones: 'a' } });
    const srv = await levantar(m);
    try {
      assert.strictEqual((await srv.llamar('PUT', '/api/traslado/facturas/t1', { fecha: '2026-11-06' })).status, 200);
      assert.strictEqual(guardadoPor(m.db, 'tras_facturas', 't1').fecha, '06/11/2026');
      assert.strictEqual((await srv.llamar('PUT', '/api/traslado/facturas/t1', { fecha: 'basura', observaciones: 'NO' })).status, 400);
      assert.strictEqual(guardadoPor(m.db, 'tras_facturas', 't1').observaciones, 'a');
    } finally { await srv.cerrar(); }
  });
});

/* ═══════════════════════════ recorridos.js ══════════════════════════════════ */

describe('recorridos: ?fecha= tolerante al formato', () => {
  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'asistencia', {
      a_iso: { fecha: '2026-06-04' }, a_dmy: { fecha: '04/06/2026' }, a_corta: { fecha: '4/6/2026' },
      a_otro: { fecha: '05/06/2026' }, a_sin: {}, a_rota: { fecha: 'basura' },
    });
    return m;
  };
  const pedir = async (srv, fecha) => (await srv.llamar('GET', '/api/recorridos' + (fecha === undefined ? '' : '?fecha=' + encodeURIComponent(fecha)))).json.map(x => x.id);

  test('encuentra el día en ISO, dd/MM/yyyy y d/M/yyyy, pida como pida la fecha', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      for (const q of ['2026-06-04', '04/06/2026', '4/6/2026']) assert.deepStrictEqual((await pedir(srv, q)).sort(), ['a_corta', 'a_dmy', 'a_iso'], q);
    } finally { await srv.cerrar(); }
  });

  test('sin ?fecha trae todo; una fecha que no se entiende solo encuentra lo que tiene exactamente ese texto', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      assert.strictEqual((await pedir(srv)).length, 6);
      assert.deepStrictEqual(await pedir(srv, 'basura'), ['a_rota'], 'nunca trae las que no tienen fecha');
    } finally { await srv.cerrar(); }
  });
});

/* ═══════════════════════════ un solo isoToDMY ═══════════════════════════════ */

describe('un solo isoToDMY en todo el sistema', () => {
  const definiciones = () => {
    const hallazgos = [];
    for (const dir of ['routes', 'services', 'utils', 'helpers', 'middleware']) {
      for (const f of fs.readdirSync(path.join(RAIZ, dir)).filter(x => x.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(RAIZ, dir, f), 'utf8');
        if (/(?:const|let|var|function)\s+isoToDMY\b/.test(src)) hallazgos.push(`${dir}/${f}`);
      }
    }
    return hallazgos;
  };

  test('solo utils/fechas.js la define: traslado.js y resumenDiario.js usan la compartida', () => {
    assert.deepStrictEqual(definiciones(), ['utils/fechas.js']);
  });

  test('resumenDiario ya no exporta su propia copia, y su resumen del día sigue funcionando', async () => {
    const m = cargar();
    assert.strictEqual(m.resumenDiario.isoToDMY, undefined);
    assert.deepStrictEqual(Object.keys(m.resumenDiario).sort(), ['calcularResumenDiario', 'calcularResumenMensual', 'cargarChoferes']);
    sembrar(m.db, 'usuarios', { u1: { rol: 'chofer', email: 'juan@x.com', nombre: 'Juan' } });
    sembrar(m.db, 'egresos', { e1: { fecha: '05/11/2026', chofer: 'juan@x.com', monto: 100 }, e2: { fecha: '2026-11-05', chofer: 'juan@x.com', monto: 50 } });
    // El día se pide en ISO y los egresos están guardados en dd/MM/yyyy y en ISO: salen los dos, o sea que
    // la conversión compartida (isoToDMY) sigue funcionando adentro del servicio.
    const r = await m.resumenDiario.calcularResumenDiario(T, '2026-11-05');
    assert.strictEqual(r.fecha, '2026-11-05');
    assert.strictEqual(r.choferes.length, 1);
    assert.strictEqual(r.choferes[0].egresos.length, 2);
  });
});

/* ═══════ La integración con kmPendientes (y con la asistencia ISO) no se rompe ═══════ */

describe('integración con kmPendientes y ASISTENCIA (que guarda ISO a propósito)', () => {
  const MIERCOLES = new Date('2026-11-25T18:00:00Z');   // miércoles 25/11/2026, 15:00 en Argentina
  const sembrado = () => {
    const m = cargar();
    sembrar(m.db, 'usuarios', {
      u1: { rol: 'chofer', email: 'juan@x.com', nombre: 'Juan Pérez' }, u2: { rol: 'chofer', email: 'ana@x.com', nombre: 'Ana Gómez' },
    });
    sembrar(m.db, 'ASISTENCIA', {
      '2026-11-24_u1': { fecha: '2026-11-24', choferId: 'u1', choferNombre: 'Juan Pérez', beneficiarios: [{ nombre: 'Chico' }] },
      '2026-11-25_u1': { fecha: '2026-11-25', choferId: 'u1', choferNombre: 'Juan Pérez', beneficiarios: [{ nombre: 'Chico' }] },
    });
    return m;
  };
  const calcular = m => m.kmPendientes.calcularKmPendientes(T, { col: m.utils.col, ahora: MIERCOLES });

  test('un reporte cargado hoy desde la pantalla (con fecha ISO) se guarda en dd/MM/yyyy y kmPendientes lo cuenta como cargado', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      let k = await calcular(m);
      assert.deepStrictEqual(k.hoy.faltan.map(f => f.nombre).sort(), ['Ana Gómez', 'Juan Pérez'], 'antes de cargar, faltan los dos');

      const r = await srv.llamar('POST', '/api/reportes', { fecha: '2026-11-25', kmInicial: 100 }, { 'x-rol': 'chofer', 'x-email': 'juan@x.com' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(guardados(m.db, 'reportes')[0].fecha, '25/11/2026');

      k = await calcular(m);
      assert.deepStrictEqual(k.hoy.faltan.map(f => f.nombre), ['Ana Gómez'], 'Juan ya cargó; el reporte quedó en dd/MM/yyyy y se lo encuentra igual');
    } finally { await srv.cerrar(); }
  });

  test('un reporte viejo guardado en ISO (todavía sin migrar) también lo cuenta kmPendientes', async () => {
    const m = sembrado();
    sembrar(m.db, 'reportes', { viejo: { fecha: '2026-11-25', chofer: 'ana@x.com', kmInicial: 10 } });
    const k = await calcular(m);
    assert.deepStrictEqual(k.hoy.faltan.map(f => f.nombre), ['Juan Pérez']);
  });

  test('NADA de lo anterior toca ASISTENCIA: sigue en ISO, y recorridos/dashboard no la modifican', async () => {
    const m = sembrado(); const srv = await levantar(m);
    try {
      const antes = JSON.stringify([...m.db.docs.entries()].filter(([k]) => k.includes('/ASISTENCIA/')));
      await srv.llamar('GET', '/api/recorridos?fecha=2026-11-25');
      await srv.llamar('GET', '/api/dashboard/resumen');
      await srv.llamar('POST', '/api/reportes', { fecha: '2026-11-25', kmInicial: 100 }, { 'x-rol': 'chofer', 'x-email': 'juan@x.com' });
      const despues = JSON.stringify([...m.db.docs.entries()].filter(([k]) => k.includes('/ASISTENCIA/')));
      assert.strictEqual(despues, antes, 'la colección ASISTENCIA quedó byte a byte igual');
      assert.ok(guardados(m.db, 'ASISTENCIA').every(a => /^\d{4}-\d{2}-\d{2}$/.test(a.fecha)), 'sigue guardando ISO');
    } finally { await srv.cerrar(); }
  });
});
