/**
 * Presupuestos de transporte (routes/presupuestos.js + presupuestos-recorrido.js): configuración, cálculo con el valor
 * vigente, ciclo de vida (BORRADOR → EMITIDO → ACEPTADO/RECHAZADO/ANULADO), numeración, .docx, y lectura de la
 * impresión de Google Maps. Firestore en memoria, IA y Storage falsos. TODOS los datos son inventados (incluido el
 * CUIT, que es ficticio pero con dígito verificador válido).
 *
 * Correr: npm test
 */
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const { plantillaSintetica, leerTablas } = require('./helpers/docxPlantilla');
const S = require('../services/legajoIA');

const RAIZ = path.join(__dirname, '..');
const abiertos = new Set();
after(() => { for (const c of abiertos) c(); });

const CUIT_OK = '30-71234567-1', CUIT_MAL = '30-71234567-2';
const L = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
const viajesRef = () => [
  { id: '1', origen: 'Casa', destino: 'Centro', centro: 'Centro de Prueba', km: 5.6, dias: L },
  { id: '2', origen: 'Centro', destino: 'Casa', tramos: [2.9, 5.7], dias: ['martes', 'viernes'] },
  { id: '2B', origen: 'Centro', destino: 'Casa', tramos: [8.7, 9], dias: ['lunes', 'miercoles', 'jueves'] },
  { id: '3', origen: 'Casa', destino: 'Casa', tramos: [8.8, 9], dias: L },
];
const transportistaOk = { razonSocial: 'Transporte de Prueba', responsable: 'Responsable Ficticio', cuit: CUIT_OK, domicilio: 'Calle Inventada 100, Ciudad', telefono: '381 000-0000', mail: 'prueba@example.com', aseguradora: 'Aseguradora X', poliza: '123' };
const domicilioPaciente = 'Calle Uno 100, Ciudad';

function montar({ llamador, limitador, clinico } = {}) {
  const db = fakeDb();
  const utils = { ...fakeUtils(db), randomUUID: () => crypto.randomUUID(), nombreUsuario: u => u.nombre };
  const rutas = ['routes/presupuestos.js', 'routes/presupuestos-recorrido.js', 'services/legajos.js'].map(r => require.resolve(path.join(RAIZ, r)));
  const auth = { verifyToken: (req, res, next) => { const rol = req.headers['x-rol'] || 'admin'; req.tenantId = req.headers['x-tenant'] || 't1'; req.user = { nombre: 'Persona ' + rol, rol, tenantId: req.tenantId }; next(); }, requireAdmin: (req, res, next) => next() };
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (padre && rutas.includes(padre.filename)) {
      if (pedido === '../utils') return utils;
      if (pedido === '../middleware/auth') return auth;
      if (pedido === '../firebase') return { db };
    }
    return original.call(this, pedido, padre, esMain);
  };
  const subidas = [];
  const subirArchivo = async (b64, mime, ruta) => { subidas.push(ruta); return `https://almacen.test/${subidas.length}`; };
  const ahora = () => new Date(2026, 10, 25, 12);
  let plantillaBuf = null;
  let r1, r2;
  try {
    rutas.slice(0, 2).forEach(r => delete require.cache[r]);
    r2 = require(rutas[1])({ llamador, limitador: limitador || S.crearLimitador({ max: 100 }), subirArchivo, ahora });
    r1 = require(rutas[0])({ subirArchivo, ahora, almacenClinico: clinico, descargar: async () => plantillaBuf });
  } finally { Module._load = original; }
  const express = require('express'); const app = express();
  app.use(express.json({ limit: '30mb' })); app.use('/api/presupuestos', r2, r1);
  const server = app.listen(0, '127.0.0.1');
  return new Promise(r => server.once('listening', () => {
    const url = `http://127.0.0.1:${server.address().port}/api/presupuestos`;
    const llamar = async (m, p, body, { tenant = 't1', rol = 'admin' } = {}) => {
      const res = await fetch(url + p, { method: m, headers: { 'content-type': 'application/json', 'x-tenant': tenant, 'x-rol': rol }, body: body ? JSON.stringify(body) : undefined });
      const tipo = res.headers.get('content-type') || '';
      return { status: res.status, json: tipo.includes('json') ? await res.json() : null, buffer: tipo.includes('json') ? null : Buffer.from(await res.arrayBuffer()), headers: res.headers };
    };
    const cerrar = () => { server.closeAllConnections(); server.close(); }; abiertos.add(cerrar);
    r({ db, subidas, ponerPlantilla: b => { plantillaBuf = b; }, get: (...a) => llamar('GET', ...a), post: (...a) => llamar('POST', ...a), put: (...a) => llamar('PUT', ...a), del: (...a) => llamar('DELETE', ...a) });
  }));
}

function sembrar(db, t = 't1', { transportista = true, arancel = 1215.01 } = {}) {
  db.docs.set(`empresas/${t}/registro/b1`, { 'APELLIDO Y NOMBRE': 'Paciente Ficticio', DNI: '30111222', 'OBRA SOCIAL': 'OSPRERA', 'N° AFILIADO': '555', DOMICILIO: domicilioPaciente, LOCALIDAD: 'Ciudad' });
  db.docs.set(`empresas/${t}/requisitos_os/osprera`, { nombre: 'OSPRERA', alias: [], requisitos: [] });
  db.docs.set(`empresas/${t}/requisitos_os/pami`, { nombre: 'PAMI', alias: [], requisitos: [] });
  if (transportista) db.docs.set(`empresas/${t}/config/transportista`, transportistaOk);
  if (arancel) db.docs.set(`empresas/${t}/aranceles_nomenclador/a1`, { id: 'a1', vigenteDesde: '01/11/2026', valorKmTransporte: arancel, resolucion: 'Res. de prueba', mes: 'Noviembre 2026', obraId: null });
}
const borrador = (extra = {}) => ({ beneficiarioId: 'b1', periodoDesde: '2026-09', periodoHasta: '2026-12', viajes: viajesRef(), ...extra });

describe('configuración', () => {
  test('transportista: rechaza un CUIT con dígito verificador inválido y un domicilio de relleno', async () => {
    const c = await montar(); sembrar(c.db, 't1', { transportista: false });
    assert.match((await c.put('/transportista', { ...transportistaOk, cuit: CUIT_MAL })).json.mensaje, /CUIT/);
    assert.match((await c.put('/transportista', { ...transportistaOk, domicilio: 'XXXXXXXXXXXXXXX' })).json.mensaje, /relleno/);
    assert.match((await c.put('/transportista', { ...transportistaOk, mail: 'no-es-mail' })).json.mensaje, /mail/);
    assert.strictEqual((await c.put('/transportista', { ...transportistaOk, cuit: CUIT_OK.replace(/\D/g, '') })).json.transportista.cuit, CUIT_OK);
  });
  test('config: lista las obras sociales con su configuración por defecto (tramo corto apagado, multi-viaje)', async () => {
    const c = await montar(); sembrar(c.db, 't1', { transportista: false });
    const r = (await c.get('/config')).json;
    assert.ok(r.faltantes.faltan.includes('CUIT'));
    const o = r.obras.find(x => x.obraId === 'osprera');
    assert.deepStrictEqual([o.formato, o.tramoCorto.activo, o.tramoCorto.kmMinimo, o.tramoCorto.unidad, o.semanasPorMes, o.dependenciaPct], ['multi_viaje', false, 12, null, 4.4, 35]);
  });
  test('obra social: tramo corto activo exige elegir la unidad; guarda nombre y CUIT', async () => {
    const c = await montar(); sembrar(c.db);
    assert.match((await c.put('/obras/pami', { nombre: 'PAMI', tramoCorto: { activo: true, kmMinimo: 12 } })).json.mensaje, /unidad/);
    assert.strictEqual((await c.put('/obras/pami', { nombre: 'PAMI', cuit: CUIT_MAL })).status, 400);
    const ok = await c.put('/obras/pami', { nombre: 'PAMI', cuit: CUIT_OK, tramoCorto: { activo: true, kmMinimo: 12, unidad: 'sentido' }, semanasPorMes: 4 });
    assert.strictEqual(ok.status, 200);
    const o = (await c.get('/config')).json.obras.find(x => x.obraId === 'pami');
    assert.deepStrictEqual([o.tramoCorto.unidad, o.cuit, o.semanasPorMes], ['sentido', CUIT_OK, 4]);
  });
  test('plantilla: se sube el .docx del formulario (formato traslados); uno inválido se rechaza; sin plantilla vuelve a multi-viaje', async () => {
    const c = await montar(); sembrar(c.db);
    const buf = await plantillaSintetica();
    const ok = await c.post('/obras/osprera/plantilla', { archivo: { base64: buf.toString('base64'), nombre: 'form.docx' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.formato, 'traslados_programados');
    assert.strictEqual(c.subidas.length, 1);
    assert.strictEqual((await c.post('/obras/osprera/plantilla', { archivo: { base64: Buffer.from('no es docx').toString('base64'), nombre: 'x.docx' } })).status, 400);
    assert.strictEqual((await c.get('/config')).json.obras.find(x => x.obraId === 'osprera').plantilla.nombre, 'form.docx');
    assert.strictEqual((await c.del('/obras/osprera/plantilla')).json.formato, 'multi_viaje');
  });
});

describe('cálculo con el valor vigente', () => {
  test('el presupuesto de referencia da $1.001.314,05 y 824,12 km (con la resolución y el mes)', async () => {
    const c = await montar(); sembrar(c.db);
    const r = (await c.post('/calcular', { viajes: viajesRef(), fechaReferencia: '25/11/2026', obraId: 'osprera' })).json;
    assert.strictEqual(r.calculo.total, 1001314.05);
    assert.strictEqual(r.calculo.kmMensuales, 824.12);
    assert.strictEqual(r.arancel.resolucion, 'Res. de prueba');
    assert.strictEqual(r.arancel.mes, 'Noviembre 2026');
  });
  test('sin valor del km cargado para esa fecha: 409', async () => {
    const c = await montar(); sembrar(c.db, 't1', { arancel: null });
    assert.strictEqual((await c.post('/calcular', { viajes: viajesRef() })).status, 409);
    sembrar(c.db);
    assert.strictEqual((await c.post('/calcular', { viajes: viajesRef(), fechaReferencia: '15/10/2026' })).status, 409);   // antes de que rija
  });
  test('adicional por dependencia: valor base, adicional y final', async () => {
    const c = await montar(); sembrar(c.db, 't1', { arancel: 847.27 });
    const r = (await c.post('/calcular', { viajes: [{ id: '1', km: 10, dias: ['lunes'] }], dependencia: { activa: true } })).json;
    assert.deepStrictEqual([r.calculo.valorKm.base, r.calculo.valorKm.adicional, r.calculo.valorKm.final], [847.27, 296.54, 1143.81]);
  });
  test('valor por obra social vs. nomenclador', async () => {
    const c = await montar(); sembrar(c.db);
    c.db.docs.set('empresas/t1/aranceles_nomenclador/a2', { id: 'a2', vigenteDesde: '01/11/2026', valorKmTransporte: 1000, resolucion: 'Propio PAMI', obraId: 'pami' });
    const v = [{ id: '1', km: 10, dias: ['lunes'] }];
    assert.strictEqual((await c.post('/calcular', { viajes: v, obraId: 'pami' })).json.arancel.valorKmTransporte, 1000);
    assert.strictEqual((await c.post('/calcular', { viajes: v, obraId: 'osprera' })).json.arancel.valorKmTransporte, 1215.01);
  });
  test('avisa si el último valor cargado tiene más de 35 días', async () => {
    const c = await montar(); sembrar(c.db);
    c.db.docs.set('empresas/t1/aranceles_nomenclador/a1', { id: 'a1', vigenteDesde: '01/09/2026', valorKmTransporte: 1000, resolucion: 'Vieja', obraId: null });
    const r = (await c.post('/calcular', { viajes: [{ id: '1', km: 10, dias: ['lunes'] }] })).json;
    assert.strictEqual(r.aviso.desactualizado, true);
    assert.match(r.aviso.mensaje, /días/);
  });
  test('el tramo corto de la obra social se aplica (y apagado usa km reales)', async () => {
    const c = await montar(); sembrar(c.db);
    const v = [{ id: '1', km: 5, dias: ['lunes'] }];
    assert.strictEqual((await c.post('/calcular', { viajes: v, obraId: 'pami' })).json.calculo.viajes[0].kmFacturables, 5);
    await c.put('/obras/pami', { nombre: 'PAMI', tramoCorto: { activo: true, kmMinimo: 12, unidad: 'viaje' } });
    const r = (await c.post('/calcular', { viajes: v, obraId: 'pami' })).json.calculo;
    assert.strictEqual(r.viajes[0].kmFacturables, 12);
    assert.strictEqual(r.tramoCorto.unidad, 'viaje');
    assert.deepStrictEqual(r.tramoCorto.viajesLlevadosAlMinimo, ['1']);
  });
  test('viajes inválidos: 400', async () => {
    const c = await montar(); sembrar(c.db);
    assert.strictEqual((await c.post('/calcular', { viajes: [] })).status, 400);
    assert.strictEqual((await c.post('/calcular', { viajes: [{ id: '1', km: 500, dias: ['lunes'] }] })).status, 400);
    assert.strictEqual((await c.post('/calcular', { viajes: [{ id: '1', km: 5, dias: [] }] })).status, 400);
  });
});

describe('ciclo de vida', () => {
  test('borrador → emitido: numeración correlativa por empresa, desglose y resolución guardados', async () => {
    const c = await montar(); sembrar(c.db); sembrar(c.db, 't2');
    const a = (await c.post('/', borrador())).json.id, b = (await c.post('/', borrador())).json.id, otra = (await c.post('/', borrador(), { tenant: 't2' })).json.id;
    const e1 = (await c.post(`/${a}/emitir`)).json, e2 = (await c.post(`/${b}/emitir`)).json, e3 = (await c.post(`/${otra}/emitir`, undefined, { tenant: 't2' })).json;
    assert.deepStrictEqual([e1.numero, e2.numero, e3.numero], [1, 2, 1]);
    assert.strictEqual(e1.numeroTexto, '00001');
    assert.strictEqual(e1.total, 1001314.05);
    const p = (await c.get(`/${a}`)).json.presupuesto;
    assert.strictEqual(p.estado, 'EMITIDO');
    assert.strictEqual(p.arancel.resolucion, 'Res. de prueba');
    assert.strictEqual(p.calculo.viajes.length, 4);
    assert.strictEqual(p.transportista.cuit, CUIT_OK);
  });
  test('no se emite si faltan datos obligatorios (transportista, período)', async () => {
    const c = await montar(); sembrar(c.db, 't1', { transportista: false });
    const id = (await c.post('/', borrador())).json.id;
    assert.match((await c.post(`/${id}/emitir`)).json.mensaje, /transportista/);
    c.db.docs.set('empresas/t1/config/transportista', transportistaOk);
    const sinPeriodo = (await c.post('/', borrador({ periodoDesde: '', periodoHasta: '' }))).json.id;
    assert.match((await c.post(`/${sinPeriodo}/emitir`)).json.mensaje, /período/);
  });
  test('un presupuesto emitido no se edita ni se borra: se anula y se genera otro', async () => {
    const c = await montar(); sembrar(c.db);
    const id = (await c.post('/', borrador())).json.id;
    await c.post(`/${id}/emitir`);
    assert.strictEqual((await c.put(`/${id}`, borrador({ vehiculo: 'otro' }))).status, 409);
    assert.strictEqual((await c.del(`/${id}`)).status, 409);
    assert.strictEqual((await c.post(`/${id}/emitir`)).status, 409);
    assert.strictEqual((await c.post(`/${id}/anular`, {})).status, 400);                        // pide el motivo
    assert.strictEqual((await c.post(`/${id}/anular`, { motivo: 'Cambió el domicilio' })).status, 200);
    const nuevo = (await c.post(`/${id}/duplicar`)).json.id;
    assert.strictEqual((await c.get(`/${nuevo}`)).json.presupuesto.estado, 'BORRADOR');
    assert.strictEqual((await c.put(`/${nuevo}`, borrador({ vehiculo: 'Utilitario' }))).status, 200);
    assert.strictEqual((await c.post(`/${nuevo}/emitir`)).json.numero, 2);
  });
  test('aceptado / rechazado solo desde emitido', async () => {
    const c = await montar(); sembrar(c.db);
    const id = (await c.post('/', borrador())).json.id;
    assert.strictEqual((await c.post(`/${id}/respuesta`, { estado: 'ACEPTADO' })).status, 409);   // todavía borrador
    await c.post(`/${id}/emitir`);
    assert.strictEqual((await c.post(`/${id}/respuesta`, { estado: 'cualquiera' })).status, 400);
    assert.strictEqual((await c.post(`/${id}/respuesta`, { estado: 'RECHAZADO' })).status, 200);
    assert.strictEqual((await c.get(`/${id}`)).json.presupuesto.estado, 'RECHAZADO');
    assert.strictEqual((await c.post(`/${id}/respuesta`, { estado: 'ACEPTADO' })).status, 409);
  });
  test('un recorrido que no coincide con el paciente exige confirmación para emitir', async () => {
    const c = await montar(); sembrar(c.db);
    const v = viajesRef(); v[0].mapa = { hashes: [], origen: 'impresion', confianza: 'alta', coincide: false, confirmadoManual: false };
    const id = (await c.post('/', borrador({ viajes: v }))).json.id;
    assert.match((await c.post(`/${id}/emitir`)).json.mensaje, /confirmalo/);
    v[0].mapa.confirmadoManual = true;
    await c.put(`/${id}`, borrador({ viajes: v }));
    assert.strictEqual((await c.post(`/${id}/emitir`)).status, 200);
  });
  test('listado liviano, sin datos clínicos, y filtro por estado', async () => {
    const c = await montar(); sembrar(c.db);
    const id = (await c.post('/', borrador())).json.id; await c.post('/', borrador()); await c.post(`/${id}/emitir`);
    const todos = (await c.get('/')).json.presupuestos;
    assert.strictEqual(todos.length, 2);
    assert.ok(!('calculo' in todos[0]) && !('viajes' in todos[0]));
    assert.strictEqual((await c.get('/?estado=EMITIDO')).json.presupuestos.length, 1);
    assert.ok(!JSON.stringify([...c.db.docs.values()]).match(/diagn[oó]stico/i));   // el presupuesto no guarda nada clínico
  });
  test('aislamiento entre empresas', async () => {
    const c = await montar(); sembrar(c.db); sembrar(c.db, 't2');
    const id = (await c.post('/', borrador())).json.id;
    assert.strictEqual((await c.get(`/${id}`, undefined, { tenant: 't2' })).status, 404);
    assert.strictEqual((await c.post(`/${id}/emitir`, undefined, { tenant: 't2' })).status, 404);
    assert.strictEqual((await c.get('/', undefined, { tenant: 't2' })).json.presupuestos.length, 0);
    assert.strictEqual((await c.post('/', { ...borrador(), beneficiarioId: 'b1' }, { tenant: 't3' })).status, 404);   // paciente de otra empresa
  });
});

describe('ajustes de la pizarra', () => {
  test('días sin respuesta: entre 1 y 60, y se guardan por empresa', async () => {
    const c = await montar(); sembrar(c.db);
    assert.strictEqual((await c.put('/ajustes', { diasSinRespuesta: 0 })).status, 400);
    assert.strictEqual((await c.put('/ajustes', { diasSinRespuesta: 61 })).status, 400);
    assert.strictEqual((await c.put('/ajustes', { diasSinRespuesta: 'x' })).status, 400);
    assert.strictEqual((await c.put('/ajustes', { diasSinRespuesta: 10 })).json.diasSinRespuesta, 10);
    assert.strictEqual((await c.get('/config')).json.diasSinRespuesta, 10);
    assert.strictEqual((await c.get('/config', undefined, { tenant: 't2' })).json.diasSinRespuesta, 7);
  });
});

describe('asistente (pre-completado)', () => {
  test('trae paciente, obra social, formato, valor vigente y qué falta del transportista', async () => {
    const c = await montar(); sembrar(c.db, 't1', { transportista: false });
    const r = (await c.get('/prefill/b1')).json;
    assert.strictEqual(r.beneficiario.domicilio, domicilioPaciente);
    assert.strictEqual(r.obra.nombre, 'OSPRERA');
    assert.strictEqual(r.obra.formato, 'multi_viaje');
    assert.strictEqual(r.arancel.valorKmTransporte, 1215.01);
    assert.ok(r.transportista.faltan.length > 0);
    assert.strictEqual((await c.get('/prefill/nadie')).status, 404);
  });
  test('los días por semana salen de la orden médica solo para quien puede ver datos clínicos; no se guarda diagnóstico', async () => {
    let vistas = 0;
    const clinico = { ver: async () => { vistas++; return { ordenMedica: { campos: { diasPorSemana: { valor: 4 }, diagnostico: { valor: 'SENTINELA diagnóstico inventado' } } } }; } };
    const c = await montar({ clinico }); sembrar(c.db);
    const admin = await c.get('/prefill/b1');
    assert.strictEqual(admin.json.pistas.diasPorSemana, 4);
    assert.deepStrictEqual((await c.get('/prefill/b1', undefined, { rol: 'chofer' })).json.pistas, {});
    assert.strictEqual(vistas, 1);
    assert.ok(!JSON.stringify(admin.json).includes('SENTINELA'));
  });
});

describe('.docx del formulario', () => {
  test('con plantilla propia: sale rellenado con los datos del transportista, el paciente y los totales', async () => {
    const c = await montar(); sembrar(c.db);
    const buf = await plantillaSintetica(); c.ponerPlantilla(buf);
    await c.post('/obras/osprera/plantilla', { archivo: { base64: buf.toString('base64'), nombre: 'form.docx' } });
    const id = (await c.post('/', borrador({ acompanante: true, dependencia: { activa: true, porcentaje: 35 } }))).json.id;
    await c.post(`/${id}/emitir`);
    const r = await c.get(`/${id}/docx`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /presupuesto-00001\.docx/);
    const t = await leerTablas(r.buffer);
    const val = e => (t.find(x => x[0].startsWith(e)) || [])[1];
    assert.strictEqual(val('C.U.I.T.'), CUIT_OK);
    assert.strictEqual(val('Apellido y Nombre'), 'Paciente Ficticio');
    assert.strictEqual(val('Domicilio de Origen'), domicilioPaciente);
    assert.deepStrictEqual(t.filter(x => x[0].startsWith('Km. recorridos')).map(x => x[1]), ['5,6', '8,6', '17,7', '17,8']);
    assert.match(val('Observaciones'), /Adicional por dependencia 35%/);
  });
  test('sin plantilla propia: 409 (usa el multi-viaje, en PDF)', async () => {
    const c = await montar(); sembrar(c.db);
    const id = (await c.post('/', borrador())).json.id; await c.post(`/${id}/emitir`);
    assert.match((await c.get(`/${id}/docx`)).json.mensaje, /multi-viaje/);
  });
});

describe('leer-recorrido (impresión de Google Maps)', () => {
  const mapa = (extra = {}) => JSON.stringify({ legible: true, origen: { valor: 'Calle Uno 100, Ciudad', confianza: 'alta' }, destino: { valor: 'Calle Dos 200, Ciudad', confianza: 'alta' }, rutas: [{ km: { valor: '12,4', unidad: 'km', confianza: 'alta' }, tiempo: { valor: '25 min' }, seleccionada: true }], sentidos: 'una_ruta', ...extra });
  const archivo = txt => ({ base64: Buffer.from(txt).toString('base64'), mimeType: 'image/png', nombre: 'mapa.png' });
  const iniciar = async (texto = mapa(), opts = {}) => { let n = 0; const c = await montar({ llamador: () => async () => { n++; return { texto, uso: { entrada: 1500, salida: 200 }, modelo: 'm', parada: 'end_turn' }; }, ...opts }); sembrar(c.db); c.llamadas = () => n; return c; };

  test('lee la ruta, sube el archivo como respaldo y verifica paciente y centro', async () => {
    const c = await iniciar();
    const r = (await c.post('/leer-recorrido', { beneficiarioId: 'b1', centro: 'Calle Dos 200', archivo: archivo('m1') })).json;
    assert.strictEqual(r.propuesta.rutas[0].km, 12.4);
    assert.strictEqual(r.propuesta.rutaElegida, 0);
    assert.strictEqual(r.verificacion.coincide, true);
    assert.ok(r.archivoUrl.startsWith('https://almacen.test/'));
    assert.strictEqual(c.subidas.length, 1);
    assert.ok(![...c.db.docs.keys()].some(k => k.includes('/presupuestos/')));       // no guardó nada en ningún presupuesto
  });
  test('origen o destino que no coinciden: advierte', async () => {
    const c = await iniciar(mapa({ origen: { valor: 'Otra Calle 999', confianza: 'alta' } }));
    const r = (await c.post('/leer-recorrido', { beneficiarioId: 'b1', centro: 'Calle Dos 200', archivo: archivo('m2') })).json;
    assert.strictEqual(r.verificacion.pacienteOk, false);
    assert.match(r.verificacion.advertencias[0], /no parece corresponder a este paciente/);
  });
  test('varias rutas sin la elegida: no elige; fuera de rango y millas', async () => {
    let c = await iniciar(mapa({ rutas: [{ km: { valor: 10, unidad: 'km' } }, { km: { valor: 11, unidad: 'km' } }] }));
    let r = (await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('m3') })).json;
    assert.strictEqual(r.propuesta.requiereElegir, true);
    assert.strictEqual(r.propuesta.rutaElegida, null);
    c = await iniciar(mapa({ rutas: [{ km: { valor: 7.5, unidad: 'mi' }, seleccionada: true }, { km: { valor: 900, unidad: 'km' } }] }));
    r = (await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('m4') })).json;
    assert.strictEqual(r.propuesta.rutas[0].km, 12.07);
    assert.strictEqual(r.propuesta.rutas.length, 1);
    assert.ok(r.propuesta.advertencias.some(a => /millas/.test(a)) && r.propuesta.advertencias.some(a => /rango/.test(a)));
  });
  test('ilegible: legible:false y se sigue pudiendo cargar a mano', async () => {
    const c = await iniciar('{"legible": false}');
    const r = (await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('m5') })).json;
    assert.strictEqual(r.propuesta.legible, false);
  });
  test('el mismo archivo no se vuelve a pagar (caché por sha256); "forzar" relee', async () => {
    const c = await iniciar();
    await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('m6') });
    const r2 = (await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('m6') })).json;
    assert.strictEqual(r2.repetido, true);
    assert.strictEqual(c.llamadas(), 1);
    assert.strictEqual(c.subidas.length, 1);
    await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('m6'), forzar: true });
    assert.strictEqual(c.llamadas(), 2);
  });
  test('sin clave de la IA: 503; archivo grande, HEIC, formato inválido y paciente ajeno', async () => {
    const sin = await montar({ llamador: () => null }); sembrar(sin.db);
    assert.strictEqual((await sin.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('x') })).status, 503);
    const c = await iniciar();
    const grande = { base64: Buffer.alloc(S.MAX_BYTES + 10, 1).toString('base64'), mimeType: 'image/png', nombre: 'g.png' };
    assert.match((await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: grande })).json.mensaje, /8 MB/);
    assert.match((await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: { ...archivo('h'), mimeType: 'image/heic' } })).json.mensaje, /HEIC/);
    assert.strictEqual((await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: { ...archivo('t'), mimeType: 'text/plain' } })).status, 400);
    assert.strictEqual((await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('a') }, { tenant: 't9' })).status, 404);
    assert.strictEqual(c.llamadas(), 0);
  });
  test('límite por empresa (429); el error de la IA devuelve el cupo y no sube el archivo', async () => {
    const limitador = S.crearLimitador({ max: 1 });
    const c = await iniciar(mapa(), { limitador });
    assert.strictEqual((await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('a1') })).status, 200);
    assert.strictEqual((await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('a2') })).status, 429);
    const roto = S.crearLimitador({ max: 2 });
    const d = await iniciar('{"origen": "Calle Secreta 1', { limitador: roto });
    const r = await d.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('a3') });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(roto.disponibles('t1'), 2);
    assert.strictEqual(d.subidas.length, 0);
  });
  test('los logs llevan solo cantidades: ni direcciones ni nombres', async () => {
    const lineas = [], orig = [console.log, console.error];
    console.log = console.error = (...a) => lineas.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    try {
      const c = await iniciar();
      await c.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('l1') });
      const d = await iniciar('{"origen": "Calle Secreta 1');
      await d.post('/leer-recorrido', { beneficiarioId: 'b1', archivo: archivo('l2') });
    } finally { [console.log, console.error] = orig; }
    const todo = lineas.join('\n');
    assert.ok(todo.includes('[RECORRIDO-IA]'));
    for (const s of ['Calle Uno', 'Calle Dos', 'Calle Secreta', 'Paciente Ficticio', '30111222']) assert.ok(!todo.includes(s), `"${s}" apareció en los logs`);
  });
});
