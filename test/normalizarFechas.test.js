/**
 * scripts/normalizarFechas.js: migración de las fechas ya guardadas de remitos y egresos.
 *
 * Todo contra un Firestore en memoria: estas pruebas nunca tocan una base real, ni siquiera en
 * dry-run. Lo que importa verificar:
 *  - el dry-run (el modo por defecto) NO escribe nada;
 *  - --apply convierte y guarda el valor anterior en fechaOriginal;
 *  - los que no se pueden interpretar no se tocan, solo se listan;
 *  - es idempotente, escribe en batches de 400 y respeta --tenant.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { fakeDb } = require('./helpers/fakeFirestore');
const M = require('../scripts/normalizarFechas');

const RAIZ = path.join(__dirname, '..');
const ruta = (t, col, id) => `empresas/${t}/${col}/${id}`;
const doc = (db, t, col, id) => db.docs.get(ruta(t, col, id));
const foto = db => JSON.stringify([...db.docs.entries()]);

/** Dos empresas con de todo un poco. */
function armar() {
  const db = fakeDb();
  const set = (t, col, id, datos) => db.docs.set(ruta(t, col, id), { ID: id, monto: 100, ...datos });
  db.docs.set('empresas/t1', { nombre: 'Uno' });
  db.docs.set('empresas/t2', { nombre: 'Dos' });

  set('t1', 'remitos', 'r_ok',        { fecha: '05/11/2026' });                              // ya está bien
  set('t1', 'remitos', 'r_iso',       { fecha: '2026-11-05' });                              // el caso del bug
  set('t1', 'remitos', 'r_corta',     { fecha: '5/11/26' });
  set('t1', 'remitos', 'r_iso_hora',  { fecha: '2026-11-06T01:30:00.000Z' });                // en Argentina todavía es el 5
  set('t1', 'remitos', 'r_date',      { fecha: new Date('2026-11-06T01:30:00Z') });
  set('t1', 'remitos', 'r_mayus',     { FECHA: '2026-11-07' });                              // migrado de Sheets
  set('t1', 'remitos', 'r_basura',    { fecha: 'basura' });                                  // no se entiende
  set('t1', 'remitos', 'r_imposible', { fecha: '31/02/2026' });                              // no se entiende
  set('t1', 'remitos', 'r_sin',       {});                                                   // sin fecha
  set('t1', 'egresos', 'e_iso',       { fecha: '2026-10-20' });
  set('t1', 'egresos', 'e_ok',        { fecha: '20/10/2026' });
  set('t2', 'remitos', 'x_iso',       { fecha: '2026-09-01' });
  set('t1', 'ingresos', 'i_iso',      { fecha: '2026-11-05' });                              // otra colección: no se toca
  return db;
}

/** Corre main() capturando lo que imprime. */
async function correr(db, opciones = {}) {
  const lineas = [];
  const resumen = await M.main({ db, log: l => lineas.push(String(l)), ...opciones });
  return { resumen, salida: lineas.join('\n') };
}

describe('dry-run (el modo por defecto)', () => {
  test('NO escribe nada: ni documentos ni batches', async () => {
    const db = armar();
    const antes = foto(db);
    const { resumen } = await correr(db);                 // sin apply: dry-run
    assert.strictEqual(foto(db), antes, 'la base quedó byte a byte igual');
    assert.deepStrictEqual(db.commits, [], 'no se confirmó ningún batch');
    assert.strictEqual(resumen.apply, false);
    assert.strictEqual(resumen.escritos, 0);
  });

  test('cuenta por empresa y colección cuántos documentos cambiaría', async () => {
    const { resumen } = await correr(armar());
    const r1 = resumen.detalle.find(x => x.tenantId === 't1' && x.coleccion === 'remitos');
    assert.deepStrictEqual(
      { total: r1.total, ok: r1.ok, cambian: r1.cambian, sinFecha: r1.sinFecha, noInterpretables: r1.noInterpretables.length },
      { total: 9, ok: 1, cambian: 5, sinFecha: 1, noInterpretables: 2 });
    const e1 = resumen.detalle.find(x => x.tenantId === 't1' && x.coleccion === 'egresos');
    assert.deepStrictEqual({ total: e1.total, ok: e1.ok, cambian: e1.cambian }, { total: 2, ok: 1, cambian: 1 });
    const x2 = resumen.detalle.find(x => x.tenantId === 't2' && x.coleccion === 'remitos');
    assert.strictEqual(x2.cambian, 1);
    assert.deepStrictEqual({ docs: resumen.docs, cambian: resumen.cambian, noInterpretables: resumen.noInterpretables },
      { docs: 12, cambian: 7, noInterpretables: 2 });
  });

  test('lista los que no puede interpretar, con empresa, colección, id y valor', async () => {
    const { salida } = await correr(armar());
    assert.match(salida, /DRY-RUN/);
    assert.match(salida, /NO SE PUEDE INTERPRETAR\s+t1\/remitos\/r_basura\s+fecha="basura"/);
    assert.match(salida, /NO SE PUEDE INTERPRETAR\s+t1\/remitos\/r_imposible\s+fecha="31\/02\/2026"/);
    assert.match(salida, /t1\/remitos: 9 docs/);
    assert.match(salida, /cambiaría/, 'en dry-run habla en condicional');
    assert.doesNotMatch(salida, /escritos/);
  });

  test('solo mira remitos y egresos', async () => {
    const { resumen } = await correr(armar());
    assert.ok(resumen.detalle.every(x => ['remitos', 'egresos'].includes(x.coleccion)));
  });
});

describe('--apply', () => {
  test('convierte a dd/MM/yyyy y guarda el valor anterior en fechaOriginal', async () => {
    const db = armar();
    const { resumen } = await correr(db, { apply: true });
    assert.strictEqual(resumen.escritos, 7);

    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso').fecha, '05/11/2026');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso').fechaOriginal, '2026-11-05');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_corta').fecha, '05/11/2026');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_corta').fechaOriginal, '5/11/26');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso_hora').fecha, '05/11/2026', 'se pasa a hora de Argentina');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso_hora').fechaOriginal, '2026-11-06T01:30:00.000Z');
    assert.strictEqual(doc(db, 't1', 'egresos', 'e_iso').fecha, '20/10/2026');
    assert.strictEqual(doc(db, 't2', 'remitos', 'x_iso').fecha, '01/09/2026');
  });

  test('un Date queda como texto dd/MM/yyyy y el original se conserva como estaba', async () => {
    const db = armar();
    await correr(db, { apply: true });
    const r = doc(db, 't1', 'remitos', 'r_date');
    assert.strictEqual(r.fecha, '05/11/2026');
    assert.ok(r.fechaOriginal instanceof Date);
    assert.strictEqual(r.fechaOriginal.toISOString(), '2026-11-06T01:30:00.000Z');
  });

  test('los documentos viejos con FECHA en mayúsculas se corrigen en ese mismo campo', async () => {
    const db = armar();
    await correr(db, { apply: true });
    const r = doc(db, 't1', 'remitos', 'r_mayus');
    assert.strictEqual(r.FECHA, '07/11/2026');
    assert.strictEqual(r.fechaOriginal, '2026-11-07');
    assert.strictEqual(r.fecha, undefined, 'no inventa un campo fecha');
  });

  test('NO toca lo que ya estaba bien, lo que no se entiende, lo que no tiene fecha ni otras colecciones', async () => {
    const db = armar();
    const intactos = [['t1', 'remitos', 'r_ok'], ['t1', 'remitos', 'r_basura'], ['t1', 'remitos', 'r_imposible'],
      ['t1', 'remitos', 'r_sin'], ['t1', 'egresos', 'e_ok'], ['t1', 'ingresos', 'i_iso']];
    const antes = intactos.map(a => JSON.stringify(doc(db, ...a)));
    await correr(db, { apply: true });
    intactos.forEach((a, i) => assert.strictEqual(JSON.stringify(doc(db, ...a)), antes[i], a.join('/')));
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_ok').fechaOriginal, undefined, 'ni siquiera se le agrega fechaOriginal');
  });

  test('conserva el resto de los campos del documento', async () => {
    const db = armar();
    db.docs.set(ruta('t1', 'remitos', 'r_iso'), { ID: 'r_iso', fecha: '2026-11-05', nroRemito: '0001-123', monto: 4500, chofer: 'juan@x.com', creadoEn: new Date('2026-11-05T15:00:00Z') });
    await correr(db, { apply: true });
    const r = doc(db, 't1', 'remitos', 'r_iso');
    assert.deepStrictEqual({ n: r.nroRemito, m: r.monto, c: r.chofer, ID: r.ID }, { n: '0001-123', m: 4500, c: 'juan@x.com', ID: 'r_iso' });
    assert.strictEqual(r.creadoEn.toISOString(), '2026-11-05T15:00:00.000Z');
  });

  test('los que no se pueden interpretar se siguen listando después de aplicar', async () => {
    const { salida } = await correr(armar(), { apply: true });
    assert.match(salida, /MODO --apply/);
    assert.match(salida, /NO SE PUEDE INTERPRETAR\s+t1\/remitos\/r_basura/);
    assert.match(salida, /corregirlos a mano/);
  });
});

describe('idempotencia', () => {
  test('correrlo dos veces con --apply: la segunda no cambia nada', async () => {
    const db = armar();
    await correr(db, { apply: true });
    const trasPrimera = foto(db);
    const commitsPrimera = db.commits.length;

    const { resumen } = await correr(db, { apply: true });
    assert.strictEqual(resumen.cambian, 0);
    assert.strictEqual(resumen.escritos, 0);
    assert.strictEqual(foto(db), trasPrimera, 'la base no cambió');
    assert.strictEqual(db.commits.length, commitsPrimera, 'ni siquiera se abrió un batch');
  });

  test('la segunda corrida no pisa fechaOriginal con la fecha ya convertida', async () => {
    const db = armar();
    await correr(db, { apply: true });
    await correr(db, { apply: true });
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso').fechaOriginal, '2026-11-05');
  });

  test('después de aplicar, un dry-run ya no encuentra nada para cambiar', async () => {
    const db = armar();
    await correr(db, { apply: true });
    const { resumen } = await correr(db);
    assert.strictEqual(resumen.cambian, 0);
  });
});

describe('batches de 400', () => {
  test('escribe en batches de a lo sumo 400 (1000 documentos → 400 + 400 + 200)', async () => {
    const db = fakeDb();
    db.docs.set('empresas/t1', { nombre: 'Uno' });
    for (let i = 0; i < 1000; i++) db.docs.set(ruta('t1', 'remitos', `r${i}`), { ID: `r${i}`, fecha: '2026-11-05' });

    const { resumen } = await correr(db, { apply: true });
    assert.strictEqual(M.TAMANO_BATCH, 400);
    assert.deepStrictEqual(db.commits, [400, 400, 200]);
    assert.strictEqual(resumen.escritos, 1000);
    assert.ok([...db.docs.entries()].filter(([k]) => k.includes('/remitos/')).every(([, v]) => v.fecha === '05/11/2026' && v.fechaOriginal === '2026-11-05'));
  });

  test('un volumen justo en el límite no abre un batch vacío', async () => {
    const db = fakeDb();
    db.docs.set('empresas/t1', {});
    for (let i = 0; i < 400; i++) db.docs.set(ruta('t1', 'egresos', `e${i}`), { fecha: '2026-11-05' });
    await correr(db, { apply: true });
    assert.deepStrictEqual(db.commits, [400]);
  });
});

describe('--tenant', () => {
  test('limita a una empresa', async () => {
    const db = armar();
    const { resumen } = await correr(db, { apply: true, tenant: 't2' });
    assert.strictEqual(resumen.empresas, 1);
    assert.strictEqual(doc(db, 't2', 'remitos', 'x_iso').fecha, '01/09/2026');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso').fecha, '2026-11-05', 'la otra empresa no se tocó');
  });
});

describe('seguridad de uso', () => {
  test('sin conexión a Firestore falla con un mensaje claro y no escribe', async () => {
    await assert.rejects(() => M.main({ db: null, log: () => {} }), /Firestore/);
  });

  test('un argumento desconocido corta con código 2 ANTES de conectarse a Firebase', () => {
    const r = spawnSync(process.execPath, ['scripts/normalizarFechas.js', '--aplicar'], {
      cwd: RAIZ, encoding: 'utf8', env: { ...process.env, FIREBASE_SA: '' },
    });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /Argumento desconocido: --aplicar/);
    assert.match(r.stderr, /Uso: node scripts\/normalizarFechas\.js \[--apply\] \[--tenant=<id>\]/);
    assert.doesNotMatch(r.stdout + r.stderr, /FIREBASE/, 'no llegó a inicializar Firebase');
  });

  test('importar el módulo no ejecuta nada (solo corre cuando se lo invoca desde la terminal)', () => {
    assert.strictEqual(typeof M.main, 'function');
    assert.deepStrictEqual(M.COLECCIONES, ['remitos', 'egresos']);
  });
});

describe('clasificar', () => {
  test('usa el mismo criterio que las rutas: el primer campo con fecha válida', () => {
    assert.deepStrictEqual(M.clasificar({ fecha: 'basura', FECHA: '2026-11-05' }), { tipo: 'cambia', campo: 'FECHA', valor: '2026-11-05', nueva: '05/11/2026' });
    assert.deepStrictEqual(M.clasificar({ fecha: '05/11/2026', FECHA: '2026-01-01' }), { tipo: 'ok' });
    assert.strictEqual(M.clasificar({ fecha: '' , FECHA: null }).tipo, 'sinFecha');
    assert.strictEqual(M.clasificar({ fecha: 'basura' }).tipo, 'noInterpretable');
  });
});
