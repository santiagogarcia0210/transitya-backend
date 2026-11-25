/**
 * GET /api/agenda-admin/pizarra: permisos y forma de la respuesta.
 * verifyToken se reemplaza por uno que lee el rol de un encabezado; requireAdmin es el REAL.
 *
 * Correr: npm test
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const RAIZ = path.join(__dirname, '..');
const T = 't1';

describe('GET /api/agenda-admin/pizarra', () => {
  let srv, base, general;

  before(async () => {
    const db = fakeDb();
    const utils = fakeUtils(db);
    db.docs.set(`empresas/${T}/usuarios/u1`, { rol: 'chofer', email: 'juan@x.com', nombre: 'Juan' });
    general = async () => { general.llamadas++; return { carpetas: [], alertas: [], hayRequisitos: true }; };
    general.llamadas = 0;

    // requireAdmin REAL; el módulo firebase se reemplaza para no inicializar nada de verdad.
    const rutaAuth = require.resolve(path.join(RAIZ, 'middleware/auth'));
    const prev = Module._load;
    Module._load = function (pedido, padre, esMain) {
      if (pedido === '../firebase' && padre && padre.filename === rutaAuth) return { auth: {}, db: {} };
      return prev.call(this, pedido, padre, esMain);
    };
    let real;
    try { delete require.cache[rutaAuth]; real = require(rutaAuth); } finally { Module._load = prev; }
    const verifyToken = (req, res, next) => {
      const rol = req.headers['x-rol'];
      if (!rol) return res.status(401).json({ ok: false });
      req.user = { rol, email: 'a@x.com' }; req.tenantId = T; next();
    };
    const rutas = ['routes/agenda-admin.js', 'services/pizarra.js', 'services/kmPendientes.js', 'services/resumenDiario.js', 'services/agenda.js']
      .map(r => require.resolve(path.join(RAIZ, r)));
    const original = Module._load;
    Module._load = function (pedido, padre, esMain) {
      if (padre && rutas.includes(padre.filename)) {
        if (pedido === '../middleware/auth') return { ...real, verifyToken };
        if (pedido === '../utils') return utils;
        if (pedido === './legajos') return { estadoGeneral: general };
      }
      return original.call(this, pedido, padre, esMain);
    };
    let router;
    try { for (const r of rutas) delete require.cache[r]; router = require(rutas[0]); }
    finally { Module._load = original; }

    const express = require(path.join(RAIZ, 'node_modules/express'));
    const app = express(); app.use(express.json());
    app.use('/api/agenda-admin', router);
    srv = app.listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    base = `http://127.0.0.1:${srv.address().port}/api/agenda-admin/pizarra`;
  });
  after(() => srv.close());

  const pedir = (rol, qs = '') => fetch(base + qs, { headers: rol ? { 'x-rol': rol } : {} });

  test('sin token: 401', async () => assert.strictEqual((await pedir(null)).status, 401));
  test('chofer: 403', async () => assert.strictEqual((await pedir('chofer')).status, 403));

  for (const rol of ['admin', 'administrador']) {
    test(`${rol}: 200 con todas las columnas`, async () => {
      const r = await pedir(rol);
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.ok, true);
      for (const k of ['hoy', 'generadoEn', 'resumen', 'km', 'tareas', 'documentacion', 'correo', 'comprobantes']) assert.ok(k in j, k);
      assert.strictEqual(j.km.sinChoferes, false);
    });
  }

  test('?refrescar=1 saltea el caché de las carpetas', async () => {
    await pedir('admin'); const antes = general.llamadas;
    await pedir('admin'); assert.strictEqual(general.llamadas, antes, 'sin refrescar usa el caché');
    await pedir('admin', '?refrescar=1'); assert.strictEqual(general.llamadas, antes + 1);
  });
});
