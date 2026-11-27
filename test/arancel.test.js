/**
 * Arancel del nomenclador (services/arancel.js + routes/aranceles.js): valor vigente por fecha, valor por obra social
 * frente al general, aviso de valor desactualizado (más de 35 días), carga y cierre del valor anterior, y aislamiento
 * entre empresas. Firestore en memoria, datos inventados.
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const A = require('../services/arancel');

const base = (extra = {}) => ({ id: crypto.randomUUID(), vigenteDesde: '01/10/2026', valorKmTransporte: 900, resolucion: 'Res. de prueba', obraId: null, ...extra });
const lista = [
  base({ id: 'oct', vigenteDesde: '01/10/2026', vigenteHasta: '31/10/2026', valorKmTransporte: 900 }),
  base({ id: 'nov', vigenteDesde: '01/11/2026', valorKmTransporte: 953.22 }),
  base({ id: 'pami-nov', vigenteDesde: '01/11/2026', valorKmTransporte: 1100, obraId: 'pami' }),
];

describe('valorVigente', () => {
  test('toma el valor que rige a la fecha del presupuesto', () => {
    assert.strictEqual(A.valorVigente(lista, { fecha: '15/10/2026' }).arancel.id, 'oct');
    assert.strictEqual(A.valorVigente(lista, { fecha: '15/11/2026' }).arancel.id, 'nov');
    assert.strictEqual(A.valorVigente(lista, { fecha: '31/10/2026' }).arancel.id, 'oct');
    assert.strictEqual(A.valorVigente(lista, { fecha: '01/11/2026' }).arancel.id, 'nov');
  });
  test('sin valor para esa fecha: null', () => {
    assert.strictEqual(A.valorVigente(lista, { fecha: '15/09/2026' }), null);
    assert.strictEqual(A.valorVigente([], { fecha: '15/11/2026' }), null);
    assert.strictEqual(A.valorVigente(lista, { fecha: 'basura' }), null);
  });
  test('la obra social con valor propio usa el suyo; las demás, el del nomenclador', () => {
    const pami = A.valorVigente(lista, { fecha: '15/11/2026', obraId: 'pami' });
    assert.strictEqual(pami.arancel.valorKmTransporte, 1100);
    assert.strictEqual(pami.origen, 'obra_social');
    const otra = A.valorVigente(lista, { fecha: '15/11/2026', obraId: 'osprera' });
    assert.strictEqual(otra.arancel.valorKmTransporte, 953.22);
    assert.strictEqual(otra.origen, 'nomenclador');
  });
  test('si la obra social tiene valor propio pero no rige en esa fecha, cae al general', () => {
    assert.strictEqual(A.valorVigente(lista, { fecha: '15/10/2026', obraId: 'pami' }).origen, 'nomenclador');
  });
});

describe('estadoActualizacion (aviso a los 35 días)', () => {
  const hoy = d => new Date(2026, 10, d);
  test('reciente: sin aviso', () => assert.strictEqual(A.estadoActualizacion(lista, { hoy: hoy(20) }).desactualizado, false));
  test('justo a 35 días: sin aviso; a 36: con aviso', () => {
    assert.strictEqual(A.estadoActualizacion(lista, { hoy: new Date(2026, 11, 6) }).desactualizado, false);   // 35 días desde el 1/11
    const e = A.estadoActualizacion(lista, { hoy: new Date(2026, 11, 7) });
    assert.strictEqual(e.desactualizado, true);
    assert.match(e.mensaje, /36 días/);
  });
  test('sin ningún valor cargado: avisa', () => assert.strictEqual(A.estadoActualizacion([], { hoy: hoy(1) }).desactualizado, true));
  test('una obra con valor propio se mide con el suyo', () => {
    const l = [...lista, base({ id: 'pami-viejo', vigenteDesde: '01/08/2026', obraId: 'pami' })].filter(a => a.id !== 'pami-nov');
    assert.strictEqual(A.estadoActualizacion(l, { hoy: hoy(20), obraId: 'pami' }).desactualizado, true);
  });
});

describe('limpiarArancel y cierre del anterior', () => {
  test('valida fecha, valor y resolución; acepta coma decimal', () => {
    const ok = A.limpiarArancel({ vigenteDesde: '2026-12-01', valorKmTransporte: '1.010,50'.replace('.', ''), resolucion: 'Res X' });
    assert.strictEqual(ok.valorKmTransporte, 1010.5);
    assert.strictEqual(ok.vigenteDesde, '01/12/2026');
    assert.throws(() => A.limpiarArancel({ valorKmTransporte: 1, resolucion: 'x' }), e => /fecha/.test(e.mensaje));
    assert.throws(() => A.limpiarArancel({ vigenteDesde: '01/12/2026', valorKmTransporte: -1, resolucion: 'x' }), e => /valor/.test(e.mensaje));
    assert.throws(() => A.limpiarArancel({ vigenteDesde: '01/12/2026', valorKmTransporte: 5, resolucion: '' }), e => /resolución/.test(e.mensaje));
    assert.throws(() => A.limpiarArancel({ vigenteDesde: '01/12/2026', vigenteHasta: '01/11/2026', valorKmTransporte: 5, resolucion: 'x' }), e => /anterior/.test(e.mensaje));
  });
  test('un valor nuevo cierra el anterior de la misma obra, el día antes', () => {
    const c = A.cierresPorNuevo(lista, { id: 'dic', vigenteDesde: '01/12/2026', obraId: null });
    assert.deepStrictEqual(c, [{ id: 'nov', vigenteHasta: '30/11/2026' }]);
  });
  test('la semilla es el dato de prensa, marcado para verificar', () => {
    assert.strictEqual(A.SEMILLA_NOV_2026.valorKmTransporte, 953.22);
    assert.strictEqual(A.SEMILLA_NOV_2026.verificar, true);
    assert.match(A.SEMILLA_NOV_2026.resolucion, /3715\/2026/);
  });
});

/* ── Rutas ───────────────────────────────────────────────────────────────── */
const abiertos = new Set();
after(() => { for (const c of abiertos) c(); });

function montar() {
  const db = fakeDb();
  const utils = { ...fakeUtils(db), randomUUID: () => crypto.randomUUID(), nombreUsuario: u => u.nombre };
  const ruta = require.resolve(path.join(__dirname, '..', 'routes/aranceles.js'));
  const auth = { verifyToken: (req, res, next) => { req.tenantId = req.headers['x-tenant'] || 't1'; req.user = { nombre: 'Admin Prueba', rol: 'admin', tenantId: req.tenantId }; next(); }, requireAdmin: (q, s, n) => n() };
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (padre && padre.filename === ruta) { if (pedido === '../utils') return utils; if (pedido === '../middleware/auth') return auth; }
    return original.call(this, pedido, padre, esMain);
  };
  let router; try { delete require.cache[ruta]; router = require(ruta); } finally { Module._load = original; }
  const express = require('express'); const app = express(); app.use(express.json()); app.use('/api/aranceles', router);
  const server = app.listen(0, '127.0.0.1');
  return new Promise(r => server.once('listening', () => {
    const url = `http://127.0.0.1:${server.address().port}/api/aranceles`;
    const llamar = async (m, p, body, tenant = 't1') => { const res = await fetch(url + p, { method: m, headers: { 'content-type': 'application/json', 'x-tenant': tenant }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json() }; };
    const cerrar = () => { server.closeAllConnections(); server.close(); }; abiertos.add(cerrar);
    r({ db, llamar });
  }));
}

describe('rutas', () => {
  test('sembrar carga el valor de noviembre una sola vez, marcado para verificar', async () => {
    const { llamar } = await montar();
    assert.strictEqual((await llamar('POST', '/sembrar')).json.yaExistia, false);
    assert.strictEqual((await llamar('POST', '/sembrar')).json.yaExistia, true);
    const l = (await llamar('GET', '/')).json;
    assert.strictEqual(l.aranceles.length, 1);
    assert.strictEqual(l.aranceles[0].verificar, true);
  });
  test('cargar un valor nuevo cierra el anterior y el vigente cambia con la fecha', async () => {
    const { llamar } = await montar();
    await llamar('POST', '/sembrar');
    const n = await llamar('POST', '/', { vigenteDesde: '01/12/2026', valorKmTransporte: 1000, resolucion: 'Res. diciembre', mes: 'Diciembre 2026' });
    assert.strictEqual(n.status, 200);
    assert.strictEqual((await llamar('GET', '/vigente?fecha=15/11/2026')).json.vigente.arancel.valorKmTransporte, 953.22);
    assert.strictEqual((await llamar('GET', '/vigente?fecha=15/12/2026')).json.vigente.arancel.valorKmTransporte, 1000);
    const l = (await llamar('GET', '/')).json.aranceles;
    assert.strictEqual(l.find(a => a.valorKmTransporte === 953.22).vigenteHasta, '30/11/2026');
  });
  test('valor por obra social en la ruta de vigente', async () => {
    const { llamar } = await montar();
    await llamar('POST', '/sembrar');
    await llamar('POST', '/', { vigenteDesde: '01/11/2026', valorKmTransporte: 1100, resolucion: 'Propio', obraId: 'pami' });
    assert.strictEqual((await llamar('GET', '/vigente?fecha=10/11/2026&obraId=pami')).json.vigente.origen, 'obra_social');
    assert.strictEqual((await llamar('GET', '/vigente?fecha=10/11/2026&obraId=otra')).json.vigente.origen, 'nomenclador');
  });
  test('datos inválidos: 400; inexistente: 404', async () => {
    const { llamar } = await montar();
    assert.strictEqual((await llamar('POST', '/', { vigenteDesde: '01/12/2026', valorKmTransporte: 0, resolucion: 'x' })).status, 400);
    assert.strictEqual((await llamar('PUT', '/nada', { valorKmTransporte: 5 })).status, 404);
    assert.strictEqual((await llamar('DELETE', '/nada')).status, 404);
  });
  test('aislamiento: los valores de una empresa no se ven en otra', async () => {
    const { llamar } = await montar();
    await llamar('POST', '/sembrar', undefined, 't1');
    assert.strictEqual((await llamar('GET', '/', undefined, 't2')).json.aranceles.length, 0);
    assert.strictEqual((await llamar('GET', '/vigente?fecha=15/11/2026', undefined, 't2')).json.vigente, null);
  });
});
