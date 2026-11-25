/**
 * services/kmPendientes.js: "choferes que todavía no cargaron los km".
 *
 * La definición está explicada arriba del servicio. Estas pruebas la fijan caso por caso, con un
 * Firestore en memoria (sin red) y con el "ahora" inyectado, así no dependen de la fecha en que
 * se corran. Los casos que más importan: el día de la semana, los feriados, el km final recién
 * a la tarde, los dos formatos de fecha que conviven en la base y la hora de Argentina.
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

/** Carga kmPendientes (y resumenDiario, del que reutiliza cargarChoferes) con Firestore en memoria. */
function cargar() {
  const db = fakeDb();
  const utils = fakeUtils(db);
  const rutas = ['services/kmPendientes.js', 'services/resumenDiario.js'].map(r => require.resolve(path.join(RAIZ, r)));
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (pedido === '../utils' && padre && rutas.includes(padre.filename)) return utils;
    return original.call(this, pedido, padre, esMain);
  };
  try {
    for (const r of rutas) delete require.cache[r];
    return { K: require(rutas[0]), db, col: utils.col };
  } finally { Module._load = original; }
}

/* Un miércoles 25/11/2026 a las 15:00 en Argentina (UTC-3). */
const MIERCOLES = new Date('2026-11-25T18:00:00Z');
const en = (iso, hora = '15:00:00') => new Date(`${iso}T${hora}-03:00`);

const usuario = (db, id, datos) => db.docs.set(`empresas/${T}/usuarios/${id}`, datos);
const reporte = (db, id, datos) => db.docs.set(`empresas/${T}/reportes/${id}`, { ID: id, ...datos });
const asignacion = (db, fechaISO, uid, beneficiarios = [{ nombre: 'Chico' }]) =>
  db.docs.set(`empresas/${T}/ASISTENCIA/${fechaISO}_${uid}`, { fecha: fechaISO, choferId: uid, choferNombre: uid, beneficiarios });

function empresa() {
  const { K, db, col } = cargar();
  usuario(db, 'u1', { rol: 'chofer', email: 'juan@x.com', nombre: 'Juan Pérez', vehiculo: 'AB123CD' });
  usuario(db, 'u2', { rol: 'chofer', email: 'ana@x.com', nombre: 'Ana Gómez', vehiculo: 'EF456GH' });
  usuario(db, 'u3', { rol: 'chofer', email: 'luis@x.com', nombre: 'Luis Díaz' });
  usuario(db, 'u4', { rol: 'chofer', email: 'baja@x.com', nombre: 'Chofer de baja', activo: false });
  usuario(db, 'u5', { rol: 'admin', email: 'admin@x.com', nombre: 'Admin' });
  return { K, db, col };
}
const calcular = (m, ahora, extra = {}) => m.K.calcularKmPendientes(T, { col: m.col, ahora, ...extra });
const nombres = lista => lista.map(f => f.nombre);

/* ── Hoy ─────────────────────────────────────────────────────────────────── */

describe('hoy', () => {
  test('marca a los choferes activos que todavía no cargaron nada, y solo a ellos', async () => {
    const m = empresa();
    reporte(m.db, 'r1', { chofer: 'juan@x.com', fecha: '2026-11-25', kmInicial: 100, kmFinal: 160 });
    const r = await calcular(m, MIERCOLES);
    assert.strictEqual(r.hoy.fecha, '25/11/2026');
    assert.strictEqual(r.hoy.diaSemana, 'miércoles');
    assert.deepStrictEqual(nombres(r.hoy.faltan), ['Ana Gómez', 'Luis Díaz']);
    assert.ok(r.hoy.faltan.every(f => f.motivo === 'SIN_REPORTE'));
    assert.strictEqual(r.hoy.esperados, 3, 'el de baja y el admin no cuentan');
    assert.strictEqual(r.hoy.cargaron, 1);
  });

  test('trae el vehículo y el email, para mostrar quién es', async () => {
    const m = empresa();
    const r = await calcular(m, MIERCOLES);
    assert.deepStrictEqual(r.hoy.faltan.find(f => f.nombre === 'Ana Gómez'),
      { nombre: 'Ana Gómez', email: 'ana@x.com', vehiculo: 'EF456GH', motivo: 'SIN_REPORTE' });
  });

  test('un reporte con solo el km inicial NO se marca hoy: el final se carga a la tarde', async () => {
    const m = empresa();
    reporte(m.db, 'r1', { chofer: 'ana@x.com', fecha: '25/11/2026', kmInicial: 200, kmFinal: 0 });
    const r = await calcular(m, MIERCOLES);
    assert.ok(!nombres(r.hoy.faltan).includes('Ana Gómez'));
  });

  test('un fin de semana sin chicos asignados no se espera a nadie', async () => {
    const m = empresa();
    const SABADO = en('2026-11-28');
    const r = await calcular(m, SABADO);
    assert.strictEqual(r.hoy.diaSemana, 'sábado');
    assert.strictEqual(r.hoy.esperados, 0);
    assert.deepStrictEqual(r.hoy.faltan, []);
  });

  test('un sábado, solo se espera a quien tiene chicos asignados', async () => {
    const m = empresa();
    asignacion(m.db, '2026-11-28', 'u2');
    const r = await calcular(m, en('2026-11-28'));
    assert.deepStrictEqual(nombres(r.hoy.faltan), ['Ana Gómez']);
    assert.strictEqual(r.hoy.esperados, 1);
  });

  test('una asignación sin chicos no cuenta como que el chofer trabaja', async () => {
    const m = empresa();
    asignacion(m.db, '2026-11-28', 'u2', []);
    const r = await calcular(m, en('2026-11-28'));
    assert.strictEqual(r.hoy.esperados, 0);
  });
});

/* ── El último día de servicio ───────────────────────────────────────────── */

describe('último día de servicio anterior', () => {
  test('ayer: marca al que no cargó nada y al que dejó el km final sin cargar', async () => {
    const m = empresa();
    reporte(m.db, 'r1', { chofer: 'juan@x.com', fecha: '2026-11-24', kmInicial: 100, kmFinal: 170 });   // completo
    reporte(m.db, 'r2', { chofer: 'ana@x.com', fecha: '2026-11-24', kmInicial: 300, kmFinal: 0 });      // solo inicial
    const r = await calcular(m, MIERCOLES);
    assert.strictEqual(r.anterior.fecha, '24/11/2026');
    assert.strictEqual(r.anterior.esAyer, true);
    assert.strictEqual(r.anterior.diaSemana, 'martes');
    assert.deepStrictEqual(r.anterior.faltan.map(f => [f.nombre, f.motivo]),
      [['Ana Gómez', 'SIN_KM_FINAL'], ['Luis Díaz', 'SIN_REPORTE']]);
    assert.strictEqual(r.urgentes, 2, 'lo de ayer es lo urgente');
  });

  test('un reporte con los recorridos cargados cuenta como completo aunque no tenga kmFinal', async () => {
    const m = empresa();
    reporte(m.db, 'r1', { chofer: 'ana@x.com', fecha: '24/11/2026', kmInicial: 300, kmRecorridos: 45 });
    const r = await calcular(m, MIERCOLES);
    assert.ok(!nombres(r.anterior.faltan).includes('Ana Gómez'));
  });

  test('un lunes se mira el viernes y no el domingo', async () => {
    const m = empresa();
    reporte(m.db, 'r1', { chofer: 'juan@x.com', fecha: '2026-11-20', kmInicial: 1, kmFinal: 50 });   // viernes
    const r = await calcular(m, en('2026-11-23'));                                                    // lunes
    assert.strictEqual(r.anterior.fecha, '20/11/2026');
    assert.strictEqual(r.anterior.diaSemana, 'viernes');
    assert.strictEqual(r.anterior.esAyer, false);
    assert.deepStrictEqual(nombres(r.anterior.faltan), ['Ana Gómez', 'Luis Díaz']);
  });

  test('un feriado (día hábil en el que NADIE hizo nada) no llena la pizarra de falsas alarmas', async () => {
    const m = empresa();
    reporte(m.db, 'r1', { chofer: 'juan@x.com', fecha: '2026-11-20', kmInicial: 1, kmFinal: 50 });   // viernes con actividad
    // lunes 23 sin ninguna actividad (feriado); hoy martes 24
    const r = await calcular(m, en('2026-11-24'));
    assert.strictEqual(r.anterior.fecha, '20/11/2026', 'se saltea el lunes sin actividad');
    assert.ok(!r.anterior.faltan.some(f => f.nombre === 'Juan Pérez'));
  });

  test('un sábado trabajado: solo se marca a quien tenía chicos asignados', async () => {
    const m = empresa();
    asignacion(m.db, '2026-11-21', 'u1');                                   // sábado 21: solo Juan asignado
    const r = await calcular(m, en('2026-11-23'));                          // lunes
    assert.strictEqual(r.anterior.fecha, '21/11/2026');
    assert.strictEqual(r.anterior.diaSemana, 'sábado');
    assert.deepStrictEqual(nombres(r.anterior.faltan), ['Juan Pérez']);
    assert.strictEqual(r.anterior.esperados, 1);
  });

  test('si en los últimos días no hubo actividad de nadie, no hay día anterior que controlar', async () => {
    const m = empresa();
    const r = await calcular(m, MIERCOLES);
    assert.strictEqual(r.anterior, null);
    assert.strictEqual(r.urgentes, 0);
    assert.strictEqual(r.totalFaltan, r.hoy.faltan.length);
  });

  test('la actividad de hace más de 5 días no cuenta', async () => {
    const m = empresa();
    reporte(m.db, 'r1', { chofer: 'juan@x.com', fecha: '2026-11-10', kmInicial: 1, kmFinal: 50 });
    const r = await calcular(m, MIERCOLES);
    assert.strictEqual(r.anterior, null);
  });
});

/* ── Cómo se reconoce un reporte ─────────────────────────────────────────── */

describe('reconocer reportes', () => {
  test('la fecha puede estar en ISO, dd/MM/yyyy o d/M/yyyy, y la clave en mayúsculas (FECHA)', async () => {
    const m = empresa();
    const MARTES_5 = en('2026-12-08');        // martes 8/12: ayer lunes 7/12
    reporte(m.db, 'a', { chofer: 'juan@x.com', fecha: '2026-12-08', kmInicial: 1, kmFinal: 9 });   // ISO
    reporte(m.db, 'b', { chofer: 'ana@x.com', fecha: '8/12/2026', kmInicial: 1, kmFinal: 9 });     // d/M/yyyy
    reporte(m.db, 'c', { chofer: 'luis@x.com', FECHA: '08/12/2026', kmInicial: 1, kmFinal: 9 });   // clave en mayúsculas
    const r = await calcular(m, MARTES_5);
    assert.deepStrictEqual(r.hoy.faltan, [], 'los tres se reconocen como cargados hoy');
    assert.strictEqual(r.hoy.cargaron, 3);
  });

  test('el chofer puede venir como email, como nombre o como la parte local del email', async () => {
    const m = empresa();
    reporte(m.db, 'a', { chofer: 'JUAN@x.com', fecha: '2026-11-25', kmInicial: 1, kmFinal: 9 });   // mayúsculas
    reporte(m.db, 'b', { chofer: 'Ana Gómez', fecha: '2026-11-25', kmInicial: 1, kmFinal: 9 });    // por nombre
    reporte(m.db, 'c', { CHOFER: 'luis', fecha: '2026-11-25', kmInicial: 1, kmFinal: 9 });         // parte local, clave en mayúsculas
    const r = await calcular(m, MIERCOLES);
    assert.deepStrictEqual(r.hoy.faltan, []);
  });

  test('el reporte de otro chofer o de otro día no cuenta', async () => {
    const m = empresa();
    reporte(m.db, 'a', { chofer: 'otro@x.com', fecha: '2026-11-25', kmInicial: 1, kmFinal: 9 });
    reporte(m.db, 'b', { chofer: 'juan@x.com', fecha: '2026-11-18', kmInicial: 1, kmFinal: 9 });   // una semana atrás
    const r = await calcular(m, MIERCOLES);
    assert.deepStrictEqual(nombres(r.hoy.faltan), ['Juan Pérez', 'Ana Gómez', 'Luis Díaz']);
  });

  test('varios reportes del mismo chofer en el día cuentan una sola vez, y basta que uno tenga el final', async () => {
    const m = empresa();
    reporte(m.db, 'a', { chofer: 'ana@x.com', fecha: '2026-11-24', kmInicial: 10, kmFinal: 0 });
    reporte(m.db, 'b', { chofer: 'ana@x.com', fecha: '2026-11-24', kmInicial: 0, kmFinal: 80 });
    reporte(m.db, 'c', { chofer: 'juan@x.com', fecha: '2026-11-24', kmInicial: 1, kmFinal: 9 });
    const r = await calcular(m, MIERCOLES);
    assert.deepStrictEqual(nombres(r.anterior.faltan), ['Luis Díaz']);
  });
});

/* ── Hora de Argentina ───────────────────────────────────────────────────── */

describe('hora de Argentina', () => {
  test('a las 22:30 en Argentina (01:30 UTC del día siguiente) todavía es el día de Argentina', async () => {
    const m = empresa();
    const NOCHE = new Date('2026-11-26T01:30:00Z');         // jueves 01:30 UTC = miércoles 22:30 en Argentina
    const r = await calcular(m, NOCHE);
    assert.strictEqual(r.hoy.fecha, '25/11/2026');
    assert.strictEqual(r.hoy.diaSemana, 'miércoles');
  });

  test('a las 00:30 en Argentina ya es el día nuevo', async () => {
    const m = empresa();
    const r = await calcular(m, new Date('2026-11-26T03:30:00Z'));
    assert.strictEqual(r.hoy.fecha, '26/11/2026');
  });
});

/* ── Casos de borde ──────────────────────────────────────────────────────── */

describe('casos de borde', () => {
  test('una empresa sin choferes activos no falla y lo dice', async () => {
    const { K, col } = cargar();
    const r = await K.calcularKmPendientes(T, { col, ahora: MIERCOLES });
    assert.strictEqual(r.sinChoferes, true);
    assert.strictEqual(r.hoy, null);
    assert.strictEqual(r.totalFaltan, 0);
  });

  test('sin Firestore inyectado falla con un mensaje claro', async () => {
    const { K } = cargar();
    await assert.rejects(() => K.calcularKmPendientes(T, {}), /necesita col/);
  });

  test('los choferes dados de baja no se marcan', async () => {
    const m = empresa();
    const r = await calcular(m, MIERCOLES);
    assert.ok(!nombres(r.hoy.faltan).includes('Chofer de baja'));
  });
});

/* ── No trae de más ──────────────────────────────────────────────────────── */

describe('no lee colecciones enteras', () => {
  test('reportes y ASISTENCIA se consultan solo por los días que importan, de a lo sumo 10 valores', async () => {
    const m = empresa();
    for (let i = 0; i < 200; i++) reporte(m.db, 'viejo' + i, { chofer: 'juan@x.com', fecha: '2025-01-01', kmInicial: 1, kmFinal: 2 });
    m.db.lecturas.length = 0;
    await calcular(m, MIERCOLES);

    const deReportes = m.db.lecturas.filter(l => l.base.endsWith('/reportes'));
    const deAsist = m.db.lecturas.filter(l => l.base.endsWith('/ASISTENCIA'));
    assert.ok(deReportes.length > 0 && deAsist.length > 0);
    assert.ok([...deReportes, ...deAsist].every(l => l.tipo === 'where' && l.op === 'in'),
      'nunca un get() de la colección entera: crece todos los días');
    assert.ok([...deReportes, ...deAsist].every(l => l.cantidad <= m.K.LOTE_IN), 'cada "in" lleva pocos valores');
    assert.deepStrictEqual([...new Set(deReportes.map(l => l.campo))].sort(), ['FECHA', 'fecha']);
  });
});
