/**
 * scripts/normalizarFechas.js: migración de las fechas ya guardadas de remitos, egresos, ingresos y reportes.
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
const fs = require('node:fs');
const os = require('node:os');
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
  set('t1', 'ingresos', 'i_iso',      { fecha: '2026-11-05' });                              // ingresos: también se migra
  set('t1', 'ingresos', 'i_ok',       { fecha: '05/11/2026' });
  set('t1', 'reportes', 'p_iso',      { fecha: '2026-11-06', chofer: 'juan@x.com' });        // reportes de km: también se migra
  // Facturación, paquetería y traslado (los nombres de colección salen de las rutas)
  set('t1', 'esp_facturas', 'ef_iso',       { fecha: '2026-11-05' });
  set('t1', 'arca_facturas', 'af_ok',       { fecha: '05/11/2026' });
  set('t1', 'arca_facturas', 'af_corta',    { fecha: '5/11/26' });
  set('t1', 'facturas_emitidas', 'fe_iso',  { fecha: '2026-11-06' });
  set('t1', 'paq_facturas', 'pf_iso',       { fecha: '2026-11-07' });
  set('t1', 'paq_rutas', 'pr_iso',          { fecha: '2026-11-08' });
  set('t1', 'paq_rutas', 'pr_rota',         { fecha: 'basura' });                              // no se entiende
  set('t1', 'tras_facturas', 'tf_iso',      { fecha: '2026-11-09' });
  set('t1', 'tras_viajes', 'tv_iso',        { fecha: '2026-11-10', historial: [{ estado: 'pendiente', fecha: '2026-11-10T15:00:00.000Z' }] });
  set('t1', 'tras_viajes', 'tv_vacio',      { fecha: '' });                                    // un viaje puede no tener fecha
  set('t1', 'tras_reservas', 'trs_iso',     { fecha: '2026-11-11' });
  // Colecciones que el script NO mira, con una fecha ISO que no debe tocarse
  set('t2', 'facturacion', 'fv_iso',        { FECHA: '2026-11-05' });                           // la vieja de Sheets: solo se lee
  set('t1', 'paq_envios', 'pe_1',           { fechaEntrega: '2026-11-05', historial: [{ estado: 'pendiente', fecha: '2026-11-05T15:00:00.000Z' }] });
  set('t1', 'presentacion_docs', 'pd_1',    { fecha: '2026-11-05' });                           // tabla libre, sin esquema
  set('t1', 'ASISTENCIA', '2026-11-05_u1',  { fecha: '2026-11-05', choferId: 'u1' });           // guarda ISO a propósito
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
    const i1 = resumen.detalle.find(x => x.tenantId === 't1' && x.coleccion === 'ingresos');
    assert.deepStrictEqual({ total: i1.total, ok: i1.ok, cambian: i1.cambian }, { total: 2, ok: 1, cambian: 1 });
    const p1 = resumen.detalle.find(x => x.tenantId === 't1' && x.coleccion === 'reportes');
    assert.deepStrictEqual({ total: p1.total, ok: p1.ok, cambian: p1.cambian }, { total: 1, ok: 0, cambian: 1 });
    const cuenta = (c, t = 't1') => {
      const x = resumen.detalle.find(d => d.tenantId === t && d.coleccion === c);
      return { total: x.total, ok: x.ok, cambian: x.cambian, sin: x.sinFecha, raros: x.noInterpretables.length };
    };
    assert.deepStrictEqual(cuenta('esp_facturas'),      { total: 1, ok: 0, cambian: 1, sin: 0, raros: 0 });
    assert.deepStrictEqual(cuenta('arca_facturas'),     { total: 2, ok: 1, cambian: 1, sin: 0, raros: 0 });
    assert.deepStrictEqual(cuenta('facturas_emitidas'), { total: 1, ok: 0, cambian: 1, sin: 0, raros: 0 });
    assert.deepStrictEqual(cuenta('paq_facturas'),      { total: 1, ok: 0, cambian: 1, sin: 0, raros: 0 });
    assert.deepStrictEqual(cuenta('paq_rutas'),         { total: 2, ok: 0, cambian: 1, sin: 0, raros: 1 });
    assert.deepStrictEqual(cuenta('tras_facturas'),     { total: 1, ok: 0, cambian: 1, sin: 0, raros: 0 });
    assert.deepStrictEqual(cuenta('tras_viajes'),       { total: 2, ok: 0, cambian: 1, sin: 1, raros: 0 }, 'un viaje sin fecha se cuenta aparte y no se toca');
    assert.deepStrictEqual(cuenta('tras_reservas'),     { total: 1, ok: 0, cambian: 1, sin: 0, raros: 0 });
    assert.deepStrictEqual({ docs: resumen.docs, cambian: resumen.cambian, noInterpretables: resumen.noInterpretables },
      { docs: 26, cambian: 17, noInterpretables: 3 });
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

  const MIRADAS = ['remitos', 'egresos', 'ingresos', 'reportes', 'esp_facturas', 'arca_facturas', 'facturas_emitidas',
    'paq_facturas', 'paq_rutas', 'tras_facturas', 'tras_viajes', 'tras_reservas'];

  test('mira las 12 colecciones que guardan fechas (remitos, egresos, ingresos, reportes, facturación, paquetería y traslado) y ninguna otra', async () => {
    const { resumen } = await correr(armar());
    assert.deepStrictEqual([...new Set(resumen.detalle.map(x => x.coleccion))].sort(), [...MIRADAS].sort());
  });

  test('NO mira la colección vieja facturacion, paq_envios, las tablas libres ni ASISTENCIA', async () => {
    const { resumen, salida } = await correr(armar());
    for (const c of ['facturacion', 'paq_envios', 'presentacion_docs', 'altas_pres', 'cambio_transporte', 'ASISTENCIA']) {
      assert.ok(!resumen.detalle.some(x => x.coleccion === c), c);
      assert.doesNotMatch(salida, new RegExp('/' + c + '[:/]'), c);
    }
  });

  test('ingresos y reportes salen nombrados en la salida, por empresa', async () => {
    const { salida } = await correr(armar());
    assert.match(salida, /t1\/ingresos: 2 docs · 1 ya en dd\/MM\/yyyy · 1 cambiaría/);
    assert.match(salida, /t1\/reportes: 1 docs · 0 ya en dd\/MM\/yyyy · 1 cambiaría/);
    assert.match(salida, /ej: "2026-11-06"\s+→\s+"06\/11\/2026"/, 'el ejemplo de reportes');
  });
});

describe('--apply', () => {
  test('convierte a dd/MM/yyyy y guarda el valor anterior en fechaOriginal', async () => {
    const db = armar();
    const { resumen } = await correr(db, { apply: true });
    assert.strictEqual(resumen.escritos, 17);

    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso').fecha, '05/11/2026');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso').fechaOriginal, '2026-11-05');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_corta').fecha, '05/11/2026');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_corta').fechaOriginal, '5/11/26');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso_hora').fecha, '05/11/2026', 'se pasa a hora de Argentina');
    assert.strictEqual(doc(db, 't1', 'remitos', 'r_iso_hora').fechaOriginal, '2026-11-06T01:30:00.000Z');
    assert.strictEqual(doc(db, 't1', 'egresos', 'e_iso').fecha, '20/10/2026');
    assert.strictEqual(doc(db, 't2', 'remitos', 'x_iso').fecha, '01/09/2026');
  });

  test('ingresos y reportes se convierten igual y conservan el resto de sus campos', async () => {
    const db = armar();
    await correr(db, { apply: true });
    const i = doc(db, 't1', 'ingresos', 'i_iso');
    assert.strictEqual(i.fecha, '05/11/2026');
    assert.strictEqual(i.fechaOriginal, '2026-11-05');
    assert.strictEqual(i.monto, 100);
    const p = doc(db, 't1', 'reportes', 'p_iso');
    assert.strictEqual(p.fecha, '06/11/2026');
    assert.strictEqual(p.fechaOriginal, '2026-11-06');
    assert.strictEqual(p.chofer, 'juan@x.com');
  });

  test('facturación, paquetería y traslado se convierten igual, con fechaOriginal, y no tocan fechas anidadas como el historial', async () => {
    const db = armar();
    await correr(db, { apply: true });
    const esperado = [
      ['esp_facturas', 'ef_iso', '05/11/2026', '2026-11-05'], ['arca_facturas', 'af_corta', '05/11/2026', '5/11/26'],
      ['facturas_emitidas', 'fe_iso', '06/11/2026', '2026-11-06'], ['paq_facturas', 'pf_iso', '07/11/2026', '2026-11-07'],
      ['paq_rutas', 'pr_iso', '08/11/2026', '2026-11-08'], ['tras_facturas', 'tf_iso', '09/11/2026', '2026-11-09'],
      ['tras_viajes', 'tv_iso', '10/11/2026', '2026-11-10'], ['tras_reservas', 'trs_iso', '11/11/2026', '2026-11-11'],
    ];
    for (const [c, id, nueva, antes] of esperado) {
      const d = doc(db, 't1', c, id);
      assert.deepStrictEqual({ fecha: d.fecha, fechaOriginal: d.fechaOriginal }, { fecha: nueva, fechaOriginal: antes }, c + '/' + id);
    }
    // el historial del viaje es un instante ISO a propósito: no se toca
    assert.strictEqual(doc(db, 't1', 'tras_viajes', 'tv_iso').historial[0].fecha, '2026-11-10T15:00:00.000Z');
    // lo que no se entiende (una ruta con fecha basura) y un viaje sin fecha no cambian
    assert.strictEqual(doc(db, 't1', 'paq_rutas', 'pr_rota').fecha, 'basura');
    assert.strictEqual(doc(db, 't1', 'tras_viajes', 'tv_vacio').fecha, '');
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
      ['t1', 'remitos', 'r_sin'], ['t1', 'egresos', 'e_ok'], ['t1', 'ingresos', 'i_ok'],
      ['t1', 'arca_facturas', 'af_ok'], ['t1', 'paq_rutas', 'pr_rota'], ['t1', 'tras_viajes', 'tv_vacio'],
      // colecciones que el script no mira: siguen con su fecha ISO, sin fechaOriginal
      ['t2', 'facturacion', 'fv_iso'], ['t1', 'paq_envios', 'pe_1'], ['t1', 'presentacion_docs', 'pd_1'], ['t1', 'ASISTENCIA', '2026-11-05_u1']];
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
    assert.deepStrictEqual(M.COLECCIONES, ['remitos', 'egresos', 'ingresos', 'reportes', 'esp_facturas', 'arca_facturas', 'facturas_emitidas',
      'paq_facturas', 'paq_rutas', 'tras_facturas', 'tras_viajes', 'tras_reservas']);
  });
});

describe('dotenv: el comando normal (node scripts/normalizarFechas.js) lee el .env', () => {
  const SCRIPT = path.join(RAIZ, 'scripts', 'normalizarFechas.js');
  const MARCADOR = 'MARCADOR_DOTENV_123';

  /** Carpeta temporal con un .env adentro. */
  const conEnv = contenido => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-fechas-'));
    const archivo = path.join(dir, '.env');
    if (contenido !== null) fs.writeFileSync(archivo, contenido);
    return { dir, archivo, borrar: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };

  test('cargarEntorno() lee el archivo, no pisa lo que ya está definido y no falla si no existe', () => {
    const t = conEnv('NORM_PRUEBA_NUEVA=hola\nNORM_PRUEBA_EXISTENTE=desde-el-archivo\n');
    delete process.env.NORM_PRUEBA_NUEVA;
    process.env.NORM_PRUEBA_EXISTENTE = 'ya-estaba';
    try {
      const r = M.cargarEntorno(t.archivo);
      assert.strictEqual(r.error, undefined);
      assert.strictEqual(process.env.NORM_PRUEBA_NUEVA, 'hola', 'carga lo que no estaba');
      assert.strictEqual(process.env.NORM_PRUEBA_EXISTENTE, 'ya-estaba', 'no pisa una variable ya definida');
      assert.doesNotThrow(() => M.cargarEntorno(path.join(t.dir, 'no-existe.env')), 'sin archivo no falla');
    } finally {
      delete process.env.NORM_PRUEBA_NUEVA; delete process.env.NORM_PRUEBA_EXISTENTE; t.borrar();
    }
  });

  test('por defecto apunta al .env de la raíz del repo, no al del directorio actual', () => {
    assert.strictEqual(M.RUTA_ENV, path.join(RAIZ, '.env'));
  });

  test('el script cargado desde la terminal lee el .env ANTES de iniciar Firebase (probado desde otro directorio, sin tocar ninguna base)', () => {
    const t = conEnv(`FIREBASE_SA=${MARCADOR}\n`);
    const otroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-fechas-cwd-'));
    try {
      const env = { ...process.env, DOTENV_CONFIG_PATH: t.archivo };
      delete env.FIREBASE_SA;
      const r = spawnSync(process.execPath, [SCRIPT], { cwd: otroDir, encoding: 'utf8', env });
      // firebase.js muestra los primeros caracteres de FIREBASE_SA: si dotenv corrió antes, sale el marcador.
      assert.match(r.stdout, new RegExp(`SA first 50 chars: ${MARCADOR}`), 'firebase.js vio la variable del .env');
      // El marcador no es un JSON válido, así que no hay conexión: falla con un mensaje claro y sin escribir nada.
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /No hay conexión a Firestore/);
    } finally { t.borrar(); fs.rmSync(otroDir, { recursive: true, force: true }); }
  });

  test('control: sin ese .env, firebase.js no ve ninguna variable (el marcador salía del archivo)', () => {
    const t = conEnv(null);   // carpeta sin .env
    const otroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-fechas-cwd-'));
    try {
      const env = { ...process.env, DOTENV_CONFIG_PATH: t.archivo };   // apunta a un archivo que no existe
      delete env.FIREBASE_SA;
      const r = spawnSync(process.execPath, [SCRIPT], { cwd: otroDir, encoding: 'utf8', env });
      assert.match(r.stdout, /SA first 50 chars: MISSING/);
      assert.doesNotMatch(r.stdout, new RegExp(MARCADOR));
      assert.strictEqual(r.status, 1);
    } finally { t.borrar(); fs.rmSync(otroDir, { recursive: true, force: true }); }
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
