/**
 * Pizarra del Inicio: presupuestos emitidos sin respuesta (dentro de la columna de Administración).
 * Se muestran pasados X días (7 por defecto, configurable), solo con número, paciente y obra social: sin datos clínicos.
 * Firestore en memoria, datos inventados.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const { columnaTareas } = require('../services/pizarra');

const ahora = new Date(2026, 10, 25, 12);
const haceDias = n => new Date(ahora.getTime() - n * 86400000).toISOString();
const pres = (id, estado, dias, extra = {}) => ({ id, estado, numeroTexto: id.padStart(5, '0'), emitidoEn: haceDias(dias), fechaEmision: '01/11/2026', obraNombre: 'OSPRERA', beneficiario: { nombre: 'Paciente ' + id, dni: '1', domicilio: 'Calle 1' }, calculo: { total: 1000 }, ...extra });
const montar = (t = 't1') => { const db = fakeDb(); return { db, col: fakeUtils(db).col, set: (id, p, tenant = t) => db.docs.set(`empresas/${tenant}/presupuestos/${id}`, p) }; };
const correr = ({ col }, tenant = 't1') => columnaTareas(tenant, { col, hoyDMY: '25/11/2026', ahoraLocal: new Date(2026, 10, 25), limite: 8, ahora });

describe('presupuestos sin respuesta en la pizarra', () => {
  test('aparecen los emitidos con 7 días o más; no los recientes, ni los respondidos, anulados o borradores', async () => {
    const m = montar();
    m.set('1', pres('1', 'EMITIDO', 8)); m.set('2', pres('2', 'EMITIDO', 3)); m.set('3', pres('3', 'ACEPTADO', 30));
    m.set('4', pres('4', 'RECHAZADO', 30)); m.set('5', pres('5', 'ANULADO', 30)); m.set('6', pres('6', 'BORRADOR', 30)); m.set('7', pres('7', 'EMITIDO', 7));
    const r = (await correr(m)).presupuestos;
    assert.deepStrictEqual(r.items.map(i => i.id), ['1', '7']);      // el más viejo primero
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.dias, 7);
    assert.strictEqual(r.items[0].diasSinRespuesta, 8);
  });
  test('los días son configurables por empresa', async () => {
    const m = montar();
    m.set('1', pres('1', 'EMITIDO', 3));
    assert.strictEqual((await correr(m)).presupuestos.total, 0);
    m.db.docs.set('empresas/t1/config/presupuestos', { diasSinRespuesta: 2 });
    const r = await correr(m);
    assert.strictEqual(r.presupuestos.total, 1);
    assert.strictEqual(r.presupuestos.dias, 2);
  });
  test('suma a los pendientes de la columna (no a los urgentes)', async () => {
    const m = montar(); m.set('1', pres('1', 'EMITIDO', 10));
    const r = await correr(m);
    assert.strictEqual(r.pendientes, 1);
    assert.strictEqual(r.urgentes, 0);
  });
  test('sin datos clínicos ni de contacto: solo número, paciente, obra social y días', async () => {
    const m = montar(); m.set('1', pres('1', 'EMITIDO', 10, { diagnostico: 'SENTINELA', cud: 'SENTINELA' }));
    const item = (await correr(m)).presupuestos.items[0];
    assert.deepStrictEqual(Object.keys(item).sort(), ['beneficiario', 'diasSinRespuesta', 'fechaEmision', 'id', 'nivel', 'numeroTexto', 'obraSocial']);
    assert.ok(!JSON.stringify(item).includes('SENTINELA'));
  });
  test('aislamiento entre empresas', async () => {
    const m = montar(); m.set('1', pres('1', 'EMITIDO', 10), 't1');
    assert.strictEqual((await correr(m, 't2')).presupuestos.total, 0);
  });
  test('si falla la lectura de presupuestos, las tareas igual llegan', async () => {
    const m = montar();
    const col = (t, n) => { if (n === 'presupuestos') throw new Error('falla'); return m.col(t, n); };
    const r = await columnaTareas('t1', { col, hoyDMY: '25/11/2026', ahoraLocal: new Date(2026, 10, 25), limite: 8, ahora });
    assert.strictEqual(r.presupuestos.error, true);
    assert.strictEqual(r.configuradas, 0);
  });
});
