/**
 * services/pizarra.js: la respuesta única de la pizarra del Inicio, y las piezas del panel que
 * comparte con GET /panel (extraídas a services/agenda.js).
 *
 * Todo con Firestore en memoria, "ahora" inyectado y estadoGeneral falso (cuenta cuántas veces se lo
 * llama). Los números de los casos están calculados a mano en cada comentario.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const RAIZ = path.join(__dirname, '..');
const T = 't1';

function cargar() {
  const db = fakeDb();
  const utils = fakeUtils(db);
  const rutas = ['services/pizarra.js', 'services/kmPendientes.js', 'services/resumenDiario.js', 'services/agenda.js']
    .map(r => require.resolve(path.join(RAIZ, r)));
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (pedido === '../utils' && padre && rutas.includes(padre.filename)) return utils;
    return original.call(this, pedido, padre, esMain);
  };
  try {
    for (const r of rutas) delete require.cache[r];
    return { P: require(rutas[0]), A: require(rutas[3]), db, col: utils.col };
  } finally { Module._load = original; }
}

/* Miércoles 25/11/2026, 15:00 en Argentina. */
const AHORA = new Date('2026-11-25T18:00:00Z');
const set = (db, col, id, v) => db.docs.set(`empresas/${T}/${col}/${id}`, v);

/** estadoGeneral falso: devuelve lo que se le da y cuenta las llamadas. */
const generalFalso = (alertas = [], hayRequisitos = true) => {
  const f = async () => { f.llamadas++; return { carpetas: [], alertas, hayRequisitos }; };
  f.llamadas = 0;
  return f;
};

/* Alertas de documentos: P1 tiene 2 vencidos + 1 falta · P2 tiene 3 faltas · P3 tiene 1 por vencer ·
   P4 sin obra social · P5 sin fecha. */
const ALERTAS = [
  { tipo: 'FALTA', beneficiarioId: 'p2', beneficiario: 'Beto', obraSocial: 'OSPRERA', detalle: 'DNI', diffDias: null },
  { tipo: 'VENCIDO', beneficiarioId: 'p1', beneficiario: 'Alicia', obraSocial: 'PAMI', detalle: 'CUD', diffDias: -5 },
  { tipo: 'FALTA', beneficiarioId: 'p2', beneficiario: 'Beto', obraSocial: 'OSPRERA', detalle: 'FIM', diffDias: null },
  { tipo: 'PROXIMO', beneficiarioId: 'p3', beneficiario: 'Carla', obraSocial: 'PAMI', detalle: 'Pedido médico', diffDias: 9 },
  { tipo: 'VENCIDO', beneficiarioId: 'p1', beneficiario: 'Alicia', obraSocial: 'PAMI', detalle: 'FIM', diffDias: -20 },
  { tipo: 'FALTA', beneficiarioId: 'p1', beneficiario: 'Alicia', obraSocial: 'PAMI', detalle: 'Presupuesto', diffDias: null },
  { tipo: 'FALTA', beneficiarioId: 'p2', beneficiario: 'Beto', obraSocial: 'OSPRERA', detalle: 'CUD', diffDias: null },
  { tipo: 'SIN_OBRA_SOCIAL', beneficiarioId: 'p4', beneficiario: 'Diego', detalle: 'sin obra social', diffDias: null },
  { tipo: 'SIN_FECHA', beneficiarioId: 'p5', beneficiario: 'Eva', obraSocial: 'PAMI', detalle: 'CUD', diffDias: null },
];

function sembrarCompleto(db) {
  // Choferes: Juan cargó hoy y ayer; Ana no cargó hoy y ayer no cargó nada.
  set(db, 'usuarios', 'u1', { rol: 'chofer', email: 'juan@x.com', nombre: 'Juan' });
  set(db, 'usuarios', 'u2', { rol: 'chofer', email: 'ana@x.com', nombre: 'Ana' });
  set(db, 'reportes', 'r1', { chofer: 'juan@x.com', fecha: '2026-11-25', kmInicial: 1, kmFinal: 9 });
  set(db, 'reportes', 'r2', { chofer: 'juan@x.com', fecha: '2026-11-24', kmInicial: 1, kmFinal: 9 });

  // Tareas (todas creadas antes, salvo las de este mes para no generar el mes anterior):
  const mensual = (id, dia, extra = {}) => set(db, 'agenda_tareas', id, { id, titulo: id, frecuencia: 'MENSUAL', dia, diasAviso: 2, activo: true, creadoEn: '2026-11-01T00:00:00.000Z', ...extra });
  mensual('t1', 20, { creadoEn: '2026-01-01T00:00:00.000Z' });   // noviembre vencida (-5). octubre: hecha.
  mensual('t2', 28);                                            // +3 → PENDIENTE (diasAviso 2) pero entra: vence en ≤ 7 días
  mensual('t3', 30);                                            // +5
  mensual('t6', 25);                                            // hoy (0)
  mensual('t7', 22);                                            // hecha este mes → no aparece
  mensual('t8', 10, { activo: false });                         // inactiva → no aparece
  set(db, 'agenda_tareas', 't5', { id: 't5', titulo: 't5', frecuencia: 'UNICA', fecha: '26/11/2026', diasAviso: 5, activo: true, creadoEn: '2026-11-01T00:00:00.000Z' });   // +1
  set(db, 'agenda_tareas', 't9', { id: 't9', titulo: 't9', frecuencia: 'ANUAL', mes: 12, dia: 20, diasAviso: 5, activo: true, creadoEn: '2026-01-01T00:00:00.000Z' });          // 20/12: +25, afuera
  set(db, 'agenda_hechos', 't1_2026-10', { tareaId: 't1', periodo: '2026-10' });
  set(db, 'agenda_hechos', 't7_2026-11', { tareaId: 't7', periodo: '2026-11' });
  set(db, 'agenda_hechos', 't1_2024-03', { tareaId: 't1', periodo: '2024-03' });     // viejo: ni se consulta

  // Vencimientos: v1 vencido · v2 próximo · v3 lejano · v4 eliminado.
  set(db, 'vencimientos', 'v1', { ID: 'v1', descripcion: 'VTV', persona: 'Juan', tipo: 'VTV', fechaVenc: '20/11/2026', diasAviso: 30 });
  set(db, 'vencimientos', 'v2', { ID: 'v2', descripcion: 'Seguro', persona: 'Ana', tipo: 'Seguro', fechaVenc: '05/12/2026', diasAviso: 30 });
  set(db, 'vencimientos', 'v3', { ID: 'v3', descripcion: 'Lejano', persona: 'Ana', tipo: 'Seguro', fechaVenc: '05/09/2027', diasAviso: 30 });
  set(db, 'vencimientos', 'v4', { ID: 'v4', descripcion: 'Eliminado', fechaVenc: '01/01/2020', estado: 'ELIMINADO' });

  // Correo: m1 acción · m2 alta · m3 alta+acción · m4 resuelto · m5 baja sin acción (no se consulta).
  set(db, 'correo_config', 'principal', { user: 'x@y.com' });
  const mail = (id, extra) => set(db, 'correo_mails', id, { id, asunto: 'Asunto ' + id, de: id + '@x.com', estado: 'NUEVO', requiereAccion: false, urgencia: 'BAJA', fecha: '2026-11-20T10:00:00Z', ...extra });
  mail('m1', { requiereAccion: true, urgencia: 'MEDIA', accion: 'Responder' });
  mail('m2', { urgencia: 'ALTA' });
  mail('m3', { requiereAccion: true, urgencia: 'ALTA', accion: 'Pagar' });
  mail('m4', { estado: 'RESUELTO', requiereAccion: true, urgencia: 'ALTA' });
  mail('m5', {});

  // Comprobantes: sin foto → r1 (hoy) · r5 (ayer, clave FECHA) · r2 (hace 3 días) · e1 (ayer). Con foto, o fuera de los 7 días: no.
  set(db, 'remitos', 'r1', { fecha: '25/11/2026', nroRemito: '100', razonSocial: 'YPF' });
  set(db, 'remitos', 'r2', { fecha: '22/11/2026', nroRemito: '101', razonSocial: 'Shell' });
  set(db, 'remitos', 'r3', { fecha: '24/11/2026', nroRemito: '102', comprobanteUrl: 'https://x/f.jpg' });
  set(db, 'remitos', 'r4', { fecha: '10/11/2026', nroRemito: '103' });
  set(db, 'remitos', 'r5', { FECHA: '24/11/2026', nroRemito: '104', razonSocial: 'Axion' });
  set(db, 'egresos', 'e1', { fecha: '24/11/2026', concepto: 'Peaje', proveedor: 'Autopista' });
  set(db, 'egresos', 'e2', { fecha: '24/11/2026', concepto: 'Lavado', comprobante: 'https://x/g.jpg' });
}

const pizarra = (m, extra = {}) => m.P.calcularPizarra(T, { col: m.col, estadoGeneral: generalFalso(ALERTAS), ahora: AHORA, cache: new Map(), ...extra });

/* ── La respuesta completa ───────────────────────────────────────────────── */

describe('respuesta de la pizarra', () => {
  test('km: Ana no cargó hoy (pendiente) ni ayer (urgente)', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const r = await pizarra(m);
    assert.strictEqual(r.hoy, '25/11/2026');
    assert.deepStrictEqual(r.km.hoy.faltan.map(f => f.nombre), ['Ana']);
    assert.deepStrictEqual(r.km.anterior.faltan.map(f => [f.nombre, f.motivo]), [['Ana', 'SIN_REPORTE']]);
    assert.strictEqual(r.km.anterior.esAyer, true);
    assert.deepStrictEqual([r.km.urgentes, r.km.pendientes], [1, 1]);
  });

  test('tareas: la vencida y las que vencen en los próximos 7 días; sin las hechas, las inactivas ni las lejanas', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const r = await pizarra(m);
    // t1 (vencida) y después por cercanía: t6 (hoy), t5 (+1), t2 (+3), t3 (+5)
    assert.deepStrictEqual(r.tareas.items.map(t => t.titulo), ['t1', 't6', 't5', 't2', 't3']);
    assert.deepStrictEqual(r.tareas.items.map(t => t.nivel), ['ALTA', 'MEDIA', 'MEDIA', 'MEDIA', 'MEDIA']);
    assert.deepStrictEqual([r.tareas.total, r.tareas.vencidas, r.tareas.proximas], [5, 1, 4]);
    assert.strictEqual(r.tareas.configuradas, 8);
    assert.ok(!r.tareas.items.some(t => ['t7', 't8', 't9'].includes(t.titulo)));
  });

  test('una tarea que vence en 3 días entra aunque su aviso sea de solo 2 (el límite es de 7 días)', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const t2 = (await pizarra(m)).tareas.items.find(t => t.titulo === 't2');
    assert.strictEqual(t2.estado, 'PENDIENTE');
    assert.strictEqual(t2.diffDias, 3);
  });

  test('documentación: vencimientos y pacientes, con una línea por paciente', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const d = (await pizarra(m)).documentacion;
    assert.deepStrictEqual(d.vencimientos.items.map(v => [v.descripcion, v.estado, v.nivel]), [['VTV', 'VENCIDO', 'ALTA'], ['Seguro', 'PROXIMO', 'MEDIA']]);
    assert.deepStrictEqual([d.vencimientos.total, d.vencimientos.vencidos, d.vencimientos.proximos], [2, 1, 1]);
    assert.deepStrictEqual(d.pacientes.items.map(p => [p.beneficiario, p.vencidos, p.faltantes, p.porVencer, p.nivel]),
      [['Alicia', 2, 1, 0, 'ALTA'], ['Beto', 0, 3, 0, 'MEDIA'], ['Carla', 0, 0, 1, 'MEDIA']]);
    assert.strictEqual(d.pacientes.total, 3, 'pacientes, no documentos');
    assert.deepStrictEqual(
      { v: d.pacientes.docsVencidos, f: d.pacientes.docsFaltantes, p: d.pacientes.docsPorVencer, sf: d.pacientes.sinFecha, so: d.pacientes.sinObraSocial },
      { v: 2, f: 4, p: 1, sf: 1, so: 1 });
    assert.deepStrictEqual([d.urgentes, d.pendientes], [2, 3], 'urgentes: VTV + Alicia · pendientes: Seguro + Beto + Carla');
  });

  test('correo: los que piden acción o son urgentes, sin los resueltos ni los comunes', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const c = (await pizarra(m)).correo;
    assert.strictEqual(c.conectado, true);
    assert.deepStrictEqual(c.items.map(x => x.id).sort(), ['m1', 'm2', 'm3']);
    assert.deepStrictEqual([c.total, c.conAccion], [3, 2]);
    assert.deepStrictEqual([c.urgentes, c.pendientes], [2, 1], 'urgentes: m2 y m3 (altas) · pendiente: m1');
    assert.strictEqual(c.alerta, null);
  });

  test('comprobantes: remitos y egresos de los últimos 7 días sin foto', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const c = (await pizarra(m)).comprobantes;
    assert.deepStrictEqual(c.items.map(x => x.id), ['r1', 'r5', 'e1', 'r2'], 'más reciente primero');
    assert.deepStrictEqual([c.total, c.remitos, c.egresos], [4, 3, 1]);
    assert.ok(c.items.every(x => x.nivel === 'MEDIA'));
    assert.strictEqual(c.items.find(x => x.id === 'r5').fecha, '24/11/2026', 'una fecha en FECHA mayúscula también se lee');
    assert.match(c.items.find(x => x.id === 'e1').detalle, /Peaje/);
  });

  test('el resumen suma las columnas: 6 urgentes y 13 pendientes', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const r = await pizarra(m);
    // urgentes: km 1 + tareas 1 + documentación 2 + correo 2 + comprobantes 0
    // pendientes: km 1 + tareas 4 + documentación 3 + correo 1 + comprobantes 4
    assert.deepStrictEqual([r.resumen.urgentes, r.resumen.pendientes], [6, 13]);
    assert.deepStrictEqual(r.resumen.errores, []);
  });

  test('una empresa vacía devuelve todo en cero, sin fallar', async () => {
    const m = cargar();
    const r = await m.P.calcularPizarra(T, { col: m.col, estadoGeneral: generalFalso([], false), ahora: AHORA, cache: new Map() });
    assert.deepStrictEqual([r.resumen.urgentes, r.resumen.pendientes], [0, 0]);
    assert.strictEqual(r.km.sinChoferes, true);
    assert.strictEqual(r.correo.conectado, false);
    assert.deepStrictEqual([r.tareas.total, r.tareas.configuradas], [0, 0]);
    assert.strictEqual(r.documentacion.pacientes.hayRequisitos, false);
  });

  test('sin col o sin estadoGeneral falla con un mensaje claro', async () => {
    const m = cargar();
    await assert.rejects(() => m.P.calcularPizarra(T, {}), /necesita col y estadoGeneral/);
  });
});

/* ── Hora de Argentina ───────────────────────────────────────────────────── */

describe('hora de Argentina en las tareas', () => {
  test('a las 22:30 en Argentina una tarea de hoy sigue siendo de hoy y no está vencida', async () => {
    const m = cargar();
    set(m.db, 'agenda_tareas', 'hoy', { id: 'hoy', titulo: 'De hoy', frecuencia: 'MENSUAL', dia: 25, diasAviso: 3, activo: true, creadoEn: '2026-11-01T00:00:00.000Z' });
    const NOCHE = new Date('2026-11-26T01:30:00Z');           // 01:30 UTC del jueves = 22:30 del miércoles
    const r = await m.P.calcularPizarra(T, { col: m.col, estadoGeneral: generalFalso(), ahora: NOCHE, cache: new Map() });
    const t = r.tareas.items.find(x => x.titulo === 'De hoy');
    assert.strictEqual(t.diffDias, 0, 'con la fecha del servidor (UTC) daría -1 y figuraría vencida');
    assert.strictEqual(t.estado, 'PROXIMO');
    assert.strictEqual(r.tareas.vencidas, 0);
  });
});

/* ── Liviana ─────────────────────────────────────────────────────────────── */

describe('respuesta liviana', () => {
  test('cada columna se recorta al límite, pero el contador es el total real', async () => {
    const m = cargar();
    for (let i = 0; i < 12; i++) set(m.db, 'vencimientos', 'v' + i, { ID: 'v' + i, descripcion: 'Doc ' + i, fechaVenc: '01/11/2026', diasAviso: 30 });
    const r = await pizarra(m);
    assert.strictEqual(r.documentacion.vencimientos.items.length, m.P.LIMITE_ITEMS);
    assert.strictEqual(r.documentacion.vencimientos.total, 12);
    assert.strictEqual(r.documentacion.urgentes, 13, '12 vencimientos + Alicia (vencida) cuentan aunque se muestren 8');
  });

  test('la lista de choferes sin km también se recorta, con el total aparte', async () => {
    const m = cargar();
    for (let i = 0; i < 12; i++) set(m.db, 'usuarios', 'c' + i, { rol: 'chofer', email: `c${i}@x.com`, nombre: 'Chofer ' + String(i).padStart(2, '0') });
    const r = await pizarra(m);
    assert.strictEqual(r.km.hoy.faltan.length, m.P.LIMITE_ITEMS);
    assert.strictEqual(r.km.hoy.faltanTotal, 12);
    assert.strictEqual(r.km.pendientes, 12);
  });

  test('no lee colecciones enteras de las que crecen: reportes, ASISTENCIA, mails, remitos, egresos, hechos', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    m.db.lecturas.length = 0;
    await pizarra(m);
    const crecen = ['reportes', 'ASISTENCIA', 'correo_mails', 'remitos', 'egresos', 'agenda_hechos'];
    const gets = m.db.lecturas.filter(l => l.tipo === 'get' && crecen.some(c => l.base.endsWith('/' + c)));
    assert.deepStrictEqual(gets, [], 'solo consultas con where');
    assert.ok(m.db.lecturas.filter(l => l.tipo === 'where').every(l => l.cantidad <= 10));
  });

  test('los mails se consultan por igualdad (sin índices compuestos que podrían no existir)', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    m.db.lecturas.length = 0;
    await pizarra(m);
    const deMails = m.db.lecturas.filter(l => l.base.endsWith('/correo_mails'));
    assert.deepStrictEqual(deMails.map(l => `${l.campo}${l.op}`).sort(), ['requiereAccion==', 'urgencia==']);
  });

  test('si el correo no está conectado, ni se consultan los mails', async () => {
    const m = cargar();
    m.db.lecturas.length = 0;
    const r = await pizarra(m);
    assert.strictEqual(r.correo.conectado, false);
    assert.deepStrictEqual(m.db.lecturas.filter(l => l.base.endsWith('/correo_mails')), []);
  });
});

/* ── Caché ───────────────────────────────────────────────────────────────── */

describe('caché del estado de las carpetas', () => {
  test('dentro del minuto no se vuelve a calcular; pasado el minuto, sí', async () => {
    const m = cargar(); const cache = new Map(); const general = generalFalso(ALERTAS);
    const llamar = (ahora, extra = {}) => m.P.calcularPizarra(T, { col: m.col, estadoGeneral: general, ahora, cache, ...extra });
    await llamar(AHORA);
    await llamar(new Date(AHORA.getTime() + 30_000));
    assert.strictEqual(general.llamadas, 1, 'a los 30 s sigue valiendo');
    await llamar(new Date(AHORA.getTime() + 61_000));
    assert.strictEqual(general.llamadas, 2, 'a los 61 s se recalcula');
  });

  test('"refrescar" (el botón Actualizar) saltea el caché', async () => {
    const m = cargar(); const cache = new Map(); const general = generalFalso(ALERTAS);
    const llamar = extra => m.P.calcularPizarra(T, { col: m.col, estadoGeneral: general, ahora: AHORA, cache, ...extra });
    await llamar({}); await llamar({});
    assert.strictEqual(general.llamadas, 1);
    await llamar({ refrescar: true });
    assert.strictEqual(general.llamadas, 2);
  });

  test('cada empresa tiene su propia entrada', async () => {
    const m = cargar(); const cache = new Map(); const general = generalFalso(ALERTAS);
    for (const t of ['empresa-a', 'empresa-b', 'empresa-a']) await m.P.calcularPizarra(t, { col: m.col, estadoGeneral: general, ahora: AHORA, cache });
    assert.strictEqual(general.llamadas, 2);
  });

  test('ordenar las alertas no deja mutada la copia que está en el caché', async () => {
    const m = cargar(); const cache = new Map(); const original = [...ALERTAS];
    const general = async () => ({ carpetas: [], alertas: original, hayRequisitos: true });
    await m.P.calcularPizarra(T, { col: m.col, estadoGeneral: general, ahora: AHORA, cache });
    assert.deepStrictEqual(original.map(a => a.detalle), ALERTAS.map(a => a.detalle), 'el arreglo de origen conserva su orden');
  });
});

/* ── Una columna que falla no tira abajo a las demás ─────────────────────── */

describe('aislamiento de fallos', () => {
  test('si falla el estado de las carpetas, esa columna viene con error y el resto llega completo', async () => {
    const m = cargar(); sembrarCompleto(m.db);
    const rota = async () => { throw new Error('Firestore caído'); };
    const errores = []; const original = console.error; console.error = (...a) => errores.push(a.join(' '));
    let r;
    try { r = await m.P.calcularPizarra(T, { col: m.col, estadoGeneral: rota, ahora: AHORA, cache: new Map() }); }
    finally { console.error = original; }
    assert.strictEqual(r.documentacion.error, true);
    assert.match(r.documentacion.mensaje, /No se pudo cargar/);
    assert.deepStrictEqual(r.resumen.errores, ['documentacion']);
    assert.strictEqual(r.tareas.total, 5, 'las demás columnas siguen intactas');
    assert.strictEqual(r.correo.total, 3);
    assert.strictEqual(r.km.urgentes, 1);
    assert.ok(errores.some(e => /\[PIZARRA\] documentacion/.test(e)), 'el error queda en el log del servidor');
    assert.doesNotMatch(JSON.stringify(r), /Firestore caído/, 'el detalle técnico no viaja al navegador');
  });
});

/* ── Correo: alertas de la casilla ───────────────────────────────────────── */

describe('alerta de la casilla de correo', () => {
  test('si hay que reautorizar la casilla, es lo más urgente de la columna', async () => {
    const m = cargar();
    set(m.db, 'correo_config', 'principal', { user: 'x@y.com', requiereReconexion: true, error: 'permiso cortado' });
    const c = (await pizarra(m)).correo;
    assert.strictEqual(c.alerta.tipo, 'RECONEXION');
    assert.strictEqual(c.urgentes, 1);
  });

  test('un error común de la casilla cuenta como pendiente, no como urgente', async () => {
    const m = cargar();
    set(m.db, 'correo_config', 'principal', { user: 'x@y.com', error: 'No se pudo conectar' });
    const c = (await pizarra(m)).correo;
    assert.strictEqual(c.alerta.tipo, 'ERROR');
    assert.deepStrictEqual([c.urgentes, c.pendientes], [0, 1]);
  });
});

/* ── Las piezas que comparte con el panel ────────────────────────────────── */

describe('piezas compartidas con GET /panel (services/agenda.js)', () => {
  const AHORA_LOCAL = new Date(2026, 10, 25);       // 25/11/2026 a medianoche local

  test('vencimientosCriticos: solo vencidos y próximos, el más urgente primero, sin eliminados', () => {
    const { A } = cargar();
    const lista = [
      { id: 'a', ID: 'a', descripcion: 'lejano', fechaVenc: '01/01/2027', diasAviso: 30 },
      { id: 'b', ID: 'b', descripcion: 'próximo', fechaVenc: '10/12/2026', diasAviso: 30 },
      { id: 'c', ID: 'c', descripcion: 'vencido', fechaVenc: '20/11/2026', diasAviso: 30 },
      { id: 'd', ID: 'd', descripcion: 'eliminado', fechaVenc: '01/01/2020', estado: 'ELIMINADO' },
      { id: 'e', descripcion: 'sin fecha', fechaVenc: '' },
    ];
    const r = A.vencimientosCriticos(lista, AHORA_LOCAL);
    assert.deepStrictEqual(r.map(v => [v.descripcion, v.estado, v.diffDias]), [['vencido', 'VENCIDO', -5], ['próximo', 'PROXIMO', 15]]);
  });

  test('ordenarAlertasDocs: vencidos, faltantes, por vencer, y dentro de cada uno los de menos días', () => {
    const { A } = cargar();
    const r = A.ordenarAlertasDocs([
      { tipo: 'SIN_OBRA_SOCIAL' }, { tipo: 'PROXIMO', diffDias: 3 }, { tipo: 'FALTA' }, { tipo: 'VENCIDO', diffDias: -1 }, { tipo: 'VENCIDO', diffDias: -9 },
    ]);
    assert.deepStrictEqual(r.map(a => a.tipo + (a.diffDias ?? '')), ['VENCIDO-9', 'VENCIDO-1', 'FALTA', 'PROXIMO3', 'SIN_OBRA_SOCIAL']);
  });

  test('correoDestacados: acción o urgencia alta, la más urgente y reciente primero, con tope', () => {
    const { A } = cargar();
    const mails = [
      { id: '1', requiereAccion: true, urgencia: 'MEDIA', fecha: '2026-11-03' },
      { id: '2', urgencia: 'ALTA', fecha: '2026-11-01' },
      { id: '3', urgencia: 'ALTA', fecha: '2026-11-05' },
      { id: '4', urgencia: 'BAJA', fecha: '2026-11-09' },        // ni acción ni alta: no
      { id: '5', requiereAccion: true, urgencia: 'BAJA', fecha: '2026-11-02' },
    ];
    const r = A.correoDestacados(mails, 3);
    assert.deepStrictEqual(r.destacados.map(m => m.id), ['3', '2', '1']);
    assert.deepStrictEqual([r.total, r.conAccion], [4, 2]);
  });

  test('correoDestacados: el nombre cae al remitente si falta, y paciente en vacío', () => {
    const { A } = cargar();
    const [m] = A.correoDestacados([{ id: '1', urgencia: 'ALTA', de: 'x@y.com' }]).destacados;
    assert.deepStrictEqual([m.deNombre, m.pacienteNombre], ['x@y.com', '']);
  });
});

describe('agruparPorPaciente', () => {
  test('una línea por paciente, con el detalle recortado a 3 documentos y los contadores por tipo', () => {
    const { P } = cargar();
    const muchas = Array.from({ length: 6 }, (_, i) => ({ tipo: 'FALTA', beneficiarioId: 'p', beneficiario: 'Zeta', detalle: 'Doc ' + i }));
    const { pacientes, cuentas } = P.agruparPorPaciente(muchas);
    assert.strictEqual(pacientes.length, 1);
    assert.strictEqual(pacientes[0].faltantes, 6);
    assert.strictEqual(pacientes[0].detalle.length, 3);
    assert.strictEqual(cuentas.docsFaltantes, 6);
  });

  test('ordena: con vencidos primero, después más faltantes, después alfabético', () => {
    const { P } = cargar();
    const { pacientes } = P.agruparPorPaciente([
      { tipo: 'FALTA', beneficiarioId: 'b', beneficiario: 'Beto', detalle: 'x' },
      { tipo: 'VENCIDO', beneficiarioId: 'z', beneficiario: 'Zoe', detalle: 'x', diffDias: -1 },
      { tipo: 'FALTA', beneficiarioId: 'a', beneficiario: 'Ana', detalle: 'x' },
      { tipo: 'FALTA', beneficiarioId: 'a', beneficiario: 'Ana', detalle: 'y' },
    ]);
    assert.deepStrictEqual(pacientes.map(p => p.beneficiario), ['Zoe', 'Ana', 'Beto']);
  });

  test('un tipo de alerta desconocido se ignora sin romper', () => {
    const { P } = cargar();
    assert.deepStrictEqual(P.agruparPorPaciente([{ tipo: 'RARO', beneficiarioId: 'x', beneficiario: 'X' }]).pacientes, []);
  });
});
