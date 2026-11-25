/**
 * Correo con varias carpetas (no solo INBOX).
 *
 * Usa un servidor IMAP de prueba con 2 carpetas (test/helpers/fakeImap.js) y un
 * Firestore en memoria (test/helpers/fakeFirestore.js): sin red y sin credenciales.
 *
 * Verifica, sobre todo, lo que se rompe en silencio:
 *  - que las configs que ya existen (un solo ultimoUid/uidValidity) sigan andando como
 *    el estado de INBOX y NO dupliquen los mails que ya estaban guardados;
 *  - que dos carpetas con el mismo UID no se pisen, ni en los ids ni en la IA;
 *  - que el tope de 300 mails sea del sync completo y no se pierda nada;
 *  - que todo siga siendo de solo lectura.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');

const { ServidorImapFalso } = require('./helpers/fakeImap');
const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');

const RAIZ = path.join(__dirname, '..');
const T = 't1';
const RUTA_CONFIG = `empresas/${T}/correo_config/principal`;

/** Carga correoSync con utils interceptado, para que use el Firestore en memoria. */
function cargar() {
  const db = fakeDb();
  const utils = fakeUtils(db);
  const rutaSync = require.resolve(path.join(RAIZ, 'services/correoSync.js'));
  const rutaClasif = require.resolve(path.join(RAIZ, 'services/correoClasificador.js'));
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (pedido === '../utils' && padre && (padre.filename === rutaSync || padre.filename === rutaClasif)) return utils;
    return original.call(this, pedido, padre, esMain);
  };
  try {
    delete require.cache[rutaSync];
    delete require.cache[rutaClasif];
    return { S: require(rutaSync), db };
  } finally {
    Module._load = original;
  }
}

/** Config de una casilla con contraseña, con las reglas que dejan pasar los mails de la obra social. */
function sembrar(db, extra = {}) {
  db.docs.set(RUTA_CONFIG, {
    host: 'imap.test', port: 993, secure: true, user: 'trabajo@empresa.com', passEnc: 'clave',
    proveedor: 'otro', tipo: 'password', activo: true, usarIA: false,
    reglas: { trabajo: ['@osprera.org.ar'], ignorar: [], palabrasClave: [] },
    ...extra,
  });
}
const config = db => db.docs.get(RUTA_CONFIG);

/** Un servidor con INBOX y "trabajo", como el de Outlook del caso real. */
function servidor() {
  return new ServidorImapFalso()
    .crearCarpeta('INBOX', { uidValidity: 1000 })
    .crearCarpeta('trabajo', { uidValidity: 2000 })
    .crearCarpeta('Spam', { uidValidity: 3000, especial: '\\Junk' })
    .crearCarpeta('[Gmail]', { noselect: true });
}

const sync = (S, srv, extra = {}) =>
  S.sincronizarEmpresa(T, { factory: srv.factory(), parse: srv.parseFalso(), llamarIA: null, desencriptar: x => x, ...extra });
const deps = (srv, extra = {}) => ({ factory: srv.factory(), desencriptar: x => x, ...extra });

// Ids como los generaba el código anterior a las carpetas (para probar compatibilidad).
const idViejo = base => createHash('sha1').update(base).digest('hex').slice(0, 24);
const mailViejo = (db, base, extra = {}) =>
  db.docs.set(`empresas/${T}/correo_mails/${idViejo(base)}`, { id: idViejo(base), estado: 'NUEVO', ...extra });

/* ── Migración de configs existentes ─────────────────────────────────────── */

describe('migración de configs existentes', () => {
  test('una config vieja (un solo ultimoUid/uidValidity) pasa a ser el estado de INBOX', () => {
    const { S } = cargar();
    const { carpetas, estado } = S.leerCarpetas({ ultimoUid: 42, uidValidity: '1000' });
    assert.deepStrictEqual(carpetas, ['INBOX']);
    assert.deepStrictEqual(estado.get('INBOX'), { uidValidity: '1000', ultimoUid: 42 });
    assert.strictEqual(estado.size, 1);
  });

  test('una config vieja sin ningún progreso arranca vacía, y INBOX queda pendiente', () => {
    const { S } = cargar();
    const { estado } = S.leerCarpetas({});
    assert.deepStrictEqual(estado.get('INBOX'), { uidValidity: '', ultimoUid: 0 });
    assert.deepStrictEqual(S.carpetasPendientes({}), ['INBOX']);
  });

  test('con estadoCarpetas presente, los campos viejos se ignoran', () => {
    const { S } = cargar();
    const cfg = { ultimoUid: 99, uidValidity: 'viejo', carpetas: ['INBOX'], estadoCarpetas: [{ carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 7 }] };
    assert.deepStrictEqual(S.leerCarpetas(cfg).estado.get('INBOX'), { uidValidity: '1000', ultimoUid: 7 });
  });

  test('el primer sync de una config vieja sigue desde su ultimoUid y la deja guardada en el formato nuevo', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    for (let i = 1; i <= 5; i++) srv.agregarMail('INBOX', { messageId: `<m${i}@x>` });
    // Mails 1 a 3 ya guardados por la versión anterior; la config guardaba ultimoUid 3.
    for (let i = 1; i <= 3; i++) mailViejo(db, `<m${i}@x>`);
    sembrar(db, { ultimoUid: 3, uidValidity: '1000' });

    const r = await sync(S, srv);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(srv.registro.fetches, [{ carpeta: 'INBOX', uids: [4, 5] }], 'solo lee lo posterior al ultimoUid heredado');
    assert.strictEqual(r.guardados, 2);
    assert.deepStrictEqual(config(db).carpetas, ['INBOX']);
    assert.deepStrictEqual(config(db).estadoCarpetas, [{ carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 5 }]);
  });

  test('re-escanear una config migrada NO duplica los mails que ya estaban (con Message-ID)', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    for (let i = 1; i <= 5; i++) srv.agregarMail('INBOX', { messageId: `<m${i}@x>` });
    for (let i = 1; i <= 3; i++) mailViejo(db, `<m${i}@x>`);
    sembrar(db, { ultimoUid: 3, uidValidity: '1000' });
    await sync(S, srv);
    assert.strictEqual(db.mails(T).length, 5);

    // "Revisar últimos 30 días": vuelve a leer todo desde el principio.
    await db.ref(RUTA_CONFIG).update({ estadoCarpetas: S.estadoParaReescanear(config(db)) });
    const r = await sync(S, srv);
    assert.strictEqual(r.guardados, 0, 'todo ya estaba: ni los viejos ni los nuevos se repiten');
    assert.strictEqual(db.mails(T).length, 5);
  });

  test('los mails viejos SIN Message-ID tampoco se duplican: INBOX conserva la fórmula de antes', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', {});          // uid 1, sin Message-ID
    srv.agregarMail('INBOX', {});          // uid 2
    // La versión anterior los guardó con sha1(`${uidValidity}:${uid}`).
    mailViejo(db, '1000:1');
    mailViejo(db, '1000:2');
    sembrar(db, {});                        // sin progreso: lee todo

    const r = await sync(S, srv);
    assert.strictEqual(r.guardados, 0, 'los dos ya estaban con ese id');
    assert.strictEqual(db.mails(T).length, 2);
  });
});

/* ── Recorrido de dos carpetas ───────────────────────────────────────────── */

describe('sincronización con dos carpetas', () => {
  test('lee las dos y cada mail guarda de qué carpeta viene', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', { messageId: '<a@x>', asunto: 'En la bandeja' });
    srv.agregarMail('trabajo', { messageId: '<b@x>', asunto: 'En trabajo' });
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });

    const r = await sync(S, srv);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.guardados, 2);
    const porAsunto = Object.fromEntries(db.mails(T).map(m => [m.asunto, m.carpeta]));
    assert.deepStrictEqual(porAsunto, { 'En la bandeja': 'INBOX', 'En trabajo': 'trabajo' });
  });

  test('el mismo UID en dos carpetas no choca (mails sin Message-ID)', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    // Peor caso real: las dos carpetas coinciden también en uidValidity (el servidor no
    // lo garantiza distinto). Sin la carpeta en el id, UID + uidValidity serían iguales.
    srv.carpetas.get('trabajo').uidValidity = 1000;
    const u1 = srv.agregarMail('INBOX', { asunto: 'uno de INBOX' });
    const u2 = srv.agregarMail('trabajo', { asunto: 'uno de trabajo' });
    assert.strictEqual(u1, u2, 'el escenario tiene que tener el mismo UID en las dos');
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });

    const r = await sync(S, srv);
    assert.strictEqual(r.guardados, 2, 'si chocaran los ids, el segundo se descartaría como repetido');
    const mails = db.mails(T);
    assert.strictEqual(new Set(mails.map(m => m.id)).size, 2);
    assert.deepStrictEqual(mails.map(m => m.asunto).sort(), ['uno de INBOX', 'uno de trabajo']);
  });

  test('cada carpeta lleva su propio progreso y un segundo sync no repite nada', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', { messageId: '<a@x>' });
    srv.agregarMail('trabajo', { messageId: '<b@x>' });
    srv.agregarMail('trabajo', { messageId: '<c@x>' });
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });
    await sync(S, srv);
    assert.deepStrictEqual(config(db).estadoCarpetas, [
      { carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 1 },
      { carpeta: 'trabajo', uidValidity: '2000', ultimoUid: 2 },
    ]);

    srv.registro.fetches.length = 0;
    const r = await sync(S, srv);
    assert.strictEqual(r.guardados, 0);
    assert.deepStrictEqual(srv.registro.fetches, [], 'sin novedades no se descarga ningún mail');
    assert.strictEqual(db.mails(T).length, 3);
  });

  test('un mail nuevo en "trabajo" solo descarga ese, y no toca el progreso de INBOX', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', { messageId: '<a@x>' });
    srv.agregarMail('trabajo', { messageId: '<b@x>' });
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });
    await sync(S, srv);

    srv.agregarMail('trabajo', { messageId: '<c@x>' });
    srv.registro.fetches.length = 0;
    const r = await sync(S, srv);
    assert.strictEqual(r.guardados, 1);
    assert.deepStrictEqual(srv.registro.fetches, [{ carpeta: 'trabajo', uids: [2] }]);
    assert.strictEqual(config(db).estadoCarpetas.find(e => e.carpeta === 'INBOX').ultimoUid, 1);
  });

  test('un mail que una regla mueve de INBOX a "trabajo" no se duplica', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    const uid = srv.agregarMail('INBOX', { messageId: '<movido@x>', asunto: 'Se mueve' });
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });
    await sync(S, srv);
    assert.strictEqual(db.mails(T).length, 1);

    srv.moverMail('INBOX', 'trabajo', uid);          // en "trabajo" llega con UID nuevo
    const r = await sync(S, srv);
    assert.strictEqual(r.guardados, 0, 'es el mismo mail: mismo Message-ID');
    assert.strictEqual(db.mails(T).length, 1);
  });

  test('si una carpeta reinicia sus UIDs, solo esa se vuelve a leer, sin duplicar', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', { messageId: '<a@x>' });
    srv.agregarMail('trabajo', { messageId: '<b@x>' });
    srv.agregarMail('trabajo', { messageId: '<c@x>' });
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });
    await sync(S, srv);

    srv.reiniciarUids('trabajo', 9999);
    srv.registro.fetches.length = 0;
    const r = await sync(S, srv);
    assert.deepStrictEqual(srv.registro.fetches, [{ carpeta: 'trabajo', uids: [1, 2] }], 'INBOX no se relee');
    assert.strictEqual(r.guardados, 0, 'los mails ya estaban');
    assert.strictEqual(db.mails(T).length, 3);
    assert.strictEqual(config(db).estadoCarpetas.find(e => e.carpeta === 'trabajo').uidValidity, '9999');
  });

  test('una config OAuth (Outlook) también recorre todas las carpetas, con access token', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('trabajo', { messageId: '<ms@x>' });
    sembrar(db, { tipo: 'oauth', proveedor: 'microsoft', passEnc: '', refreshTokenEnc: 'rt', carpetas: ['trabajo'], estadoCarpetas: [] });
    const oauth = {
      estaHabilitado: () => true,
      refrescarAccessToken: async () => ({ ok: true, datos: { accessToken: 'token-ok', refreshToken: '' } }),
    };
    const r = await sync(S, srv, { oauth });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.guardados, 1);
  });
});

/* ── Clasificación con IA: el UID solo no alcanza ────────────────────────── */

describe('clasificación con dos carpetas', () => {
  test('dos mails con el mismo UID en carpetas distintas reciben cada uno SU resultado de IA', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', { messageId: '<i@x>', de: 'alguien@gmail.com', asunto: 'Asunto INBOX' });
    srv.agregarMail('trabajo', { messageId: '<t@x>', de: 'otro@gmail.com', asunto: 'Asunto TRABAJO' });
    // Sin reglas de remitente: decide la IA. El stub contesta según el asunto de cada mail.
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [], reglas: { trabajo: [], ignorar: [], palabrasClave: [] }, usarIA: true });
    const llamarIA = async prompt => {
      const bloques = prompt.split(/--- MAIL (\d+) ---/).slice(1);
      const salida = [];
      for (let k = 0; k < bloques.length; k += 2) {
        const asunto = (bloques[k + 1].match(/Asunto: (.+)/) || [])[1];
        salida.push({ i: Number(bloques[k]), trabajo: true, categoria: 'OTRO', resumen: `resumen de ${asunto}`, accion: '', urgencia: 'BAJA' });
      }
      return JSON.stringify(salida);
    };

    const r = await sync(S, srv, { llamarIA });
    assert.strictEqual(r.guardados, 2);
    const porAsunto = Object.fromEntries(db.mails(T).map(m => [m.asunto, m.resumen]));
    assert.deepStrictEqual(porAsunto, {
      'Asunto INBOX': 'resumen de Asunto INBOX',
      'Asunto TRABAJO': 'resumen de Asunto TRABAJO',
    });
  });
});

/* ── Tope de 300 en total ────────────────────────────────────────────────── */

describe('tope de 300 mails por sincronización', () => {
  test('el tope es del sync completo, no de cada carpeta, y lo que sobra entra en el siguiente', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMuchos('INBOX', 200, 'i');
    srv.agregarMuchos('trabajo', 200, 't');
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });

    const r1 = await sync(S, srv);
    assert.strictEqual(r1.guardados, 300, '200 de INBOX + 100 de trabajo');
    assert.match(r1.aviso, /tope de 300/);
    assert.strictEqual(config(db).estadoCarpetas.find(e => e.carpeta === 'trabajo').ultimoUid, 100, 'avanza solo hasta donde leyó');

    const r2 = await sync(S, srv);
    assert.strictEqual(r2.guardados, 100, 'lo que quedó');
    assert.strictEqual(r2.aviso, '');
    const mails = db.mails(T);
    assert.strictEqual(mails.length, 400, 'no se perdió ninguno');
    assert.strictEqual(new Set(mails.map(m => m.id)).size, 400, 'y ninguno se repite');
  });

  test('si INBOX agota el tope, "trabajo" ni se abre y queda para el próximo sync', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMuchos('INBOX', 300, 'i');
    srv.agregarMuchos('trabajo', 5, 't');
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });

    const r1 = await sync(S, srv);
    assert.strictEqual(r1.guardados, 300);
    assert.match(r1.aviso, /"trabajo"/, 'avisa qué carpeta quedó para después');
    assert.ok(!srv.registro.aperturas.some(a => a.path === 'trabajo'), 'no se abrió');
    assert.deepStrictEqual(config(db).estadoCarpetas.find(e => e.carpeta === 'trabajo'),
      { carpeta: 'trabajo', uidValidity: '', ultimoUid: 0 }, 'su progreso no avanza: sigue pendiente');

    const r2 = await sync(S, srv);
    assert.strictEqual(r2.guardados, 5);
    assert.strictEqual(db.mails(T).length, 305);
  });
});

/* ── Solo lectura y errores por carpeta ──────────────────────────────────── */

describe('solo lectura', () => {
  test('toda carpeta se abre en modo lectura, no se invoca nada que escriba y se cierra cada conexión', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', { messageId: '<a@x>' });
    srv.agregarMail('trabajo', { messageId: '<b@x>' });
    sembrar(db, { carpetas: ['INBOX', 'trabajo'], estadoCarpetas: [] });

    await sync(S, srv);
    await S.listarCarpetas(T, deps(srv));
    await S.guardarCarpetas(T, ['INBOX', 'trabajo'], deps(srv));

    assert.ok(srv.registro.aperturas.length >= 2);
    assert.ok(srv.registro.aperturas.every(a => a.readOnly === true), 'todas las aperturas son readOnly');
    assert.deepStrictEqual(srv.registro.prohibidas, [], 'no se llamó a ningún método de escritura');
    assert.strictEqual(srv.registro.logouts, srv.registro.conexiones, 'cada conexión se cerró');
  });
});

describe('errores por carpeta', () => {
  test('una carpeta que ya no existe no tira abajo a las demás: se avisa y se sigue', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    srv.agregarMail('INBOX', { messageId: '<a@x>' });
    sembrar(db, { carpetas: ['INBOX', 'borrada'], estadoCarpetas: [] });

    const r = await sync(S, srv);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.guardados, 1, 'INBOX se leyó igual');
    assert.match(r.aviso, /"borrada".*ya no existe/);
    assert.strictEqual(config(db).error, '');
  });

  test('si fallan todas las carpetas, el sync informa el error', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { carpetas: ['no-esta', 'tampoco'], estadoCarpetas: [] });
    const r = await sync(S, srv);
    assert.strictEqual(r.ok, false);
    assert.ok(config(db).error, 'queda el error en la config para mostrarlo en pantalla');
  });
});

/* ── GET /carpetas y PUT /config/carpetas (la lógica que usan) ───────────── */

describe('listar y guardar carpetas', () => {
  test('lista solo carpetas que se pueden abrir, INBOX primero, marcando las elegidas', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { carpetas: ['INBOX'], estadoCarpetas: [{ carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 4 }] });
    const r = await S.listarCarpetas(T, deps(srv));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.carpetas.map(c => c.path), ['INBOX', 'Spam', 'trabajo'], '"[Gmail]" es \\Noselect: no aparece');
    assert.strictEqual(r.carpetas[0].seleccionada, true);
    assert.strictEqual(r.carpetas[1].especial, '\\Junk');
    assert.deepStrictEqual(r.carpetas.map(c => c.seleccionada), [true, false, false]);
    assert.deepStrictEqual(r.pendientes, [], 'INBOX ya tiene progreso');
  });

  test('guardar: valida, conserva el progreso de las que siguen y marca las nuevas', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { carpetas: ['INBOX'], estadoCarpetas: [{ carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 4 }] });
    const r = await S.guardarCarpetas(T, ['INBOX', 'trabajo'], deps(srv));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.nuevas, ['trabajo']);
    assert.deepStrictEqual(config(db).carpetas, ['INBOX', 'trabajo']);
    assert.deepStrictEqual(config(db).estadoCarpetas, [
      { carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 4 },
      { carpeta: 'trabajo', uidValidity: '', ultimoUid: 0 },
    ]);
    assert.deepStrictEqual(S.carpetasPendientes(config(db)), ['trabajo'], 'la nueva queda pendiente de revisar');
  });

  test('quitar una carpeta descarta su progreso: si se vuelve a agregar, se revisa de nuevo', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, {
      carpetas: ['INBOX', 'trabajo'],
      estadoCarpetas: [{ carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 4 }, { carpeta: 'trabajo', uidValidity: '2000', ultimoUid: 9 }],
    });
    await S.guardarCarpetas(T, ['INBOX'], deps(srv));
    assert.deepStrictEqual(config(db).estadoCarpetas, [{ carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 4 }]);
    const r = await S.guardarCarpetas(T, ['INBOX', 'trabajo'], deps(srv));
    assert.deepStrictEqual(r.nuevas, ['trabajo']);
    assert.strictEqual(config(db).estadoCarpetas.find(e => e.carpeta === 'trabajo').ultimoUid, 0);
  });

  test('una carpeta que no existe se rechaza y no se guarda nada', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { carpetas: ['INBOX'], estadoCarpetas: [] });
    const antes = JSON.stringify(config(db));
    const r = await S.guardarCarpetas(T, ['INBOX', 'inventada'], deps(srv));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
    assert.match(r.mensaje, /"inventada".*no existe/);
    assert.strictEqual(JSON.stringify(config(db)), antes, 'la config quedó igual');
  });

  test('tampoco se puede elegir una carpeta contenedora que no se abre', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { carpetas: ['INBOX'], estadoCarpetas: [] });
    const r = await S.guardarCarpetas(T, ['[Gmail]'], deps(srv));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
  });

  test('entradas inválidas: vacía, no es lista, no son textos, demasiadas', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { carpetas: ['INBOX'], estadoCarpetas: [] });
    for (const malo of [[], undefined, null, 'INBOX', { 0: 'INBOX' }, [1, 2], ['INBOX', null], ['   ']]) {
      const r = await S.guardarCarpetas(T, malo, deps(srv));
      assert.strictEqual(r.ok, false, 'debería rechazar ' + JSON.stringify(malo));
      assert.strictEqual(r.status, 400);
    }
    const muchas = Array.from({ length: 21 }, (_, i) => `c${i}`);
    assert.strictEqual((await S.guardarCarpetas(T, muchas, deps(srv))).status, 400);
    assert.strictEqual(srv.registro.conexiones, 0, 'las entradas inválidas ni siquiera abren una conexión');
  });

  test('"inbox" en cualquier mayúscula es INBOX, y los repetidos se juntan', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { carpetas: ['INBOX'], estadoCarpetas: [] });
    const r = await S.guardarCarpetas(T, ['inbox', 'INBOX', 'trabajo', 'trabajo'], deps(srv));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(config(db).carpetas, ['INBOX', 'trabajo']);
  });

  test('guardar sobre una config vieja conserva el progreso que tenía INBOX', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    sembrar(db, { ultimoUid: 3, uidValidity: '1000' });          // formato anterior, sin carpetas
    const r = await S.guardarCarpetas(T, ['INBOX', 'trabajo'], deps(srv));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(config(db).estadoCarpetas[0], { carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 3 });
  });

  test('sin casilla conectada: 404; con credenciales malas: 400 con mensaje claro', async () => {
    const { S, db } = cargar();
    const srv = servidor();
    const sinCasilla = await S.listarCarpetas(T, deps(srv));
    assert.strictEqual(sinCasilla.ok, false);
    assert.strictEqual(sinCasilla.status, 404);

    sembrar(db, { passEnc: 'clave-equivocada' });
    const mala = await S.listarCarpetas(T, deps(srv));
    assert.strictEqual(mala.ok, false);
    assert.strictEqual(mala.status, 400);
    assert.match(mala.mensaje, /Usuario o contraseña incorrectos/);
  });
});

/* ── Piezas puras ────────────────────────────────────────────────────────── */

describe('piezas del estado por carpeta', () => {
  test('estadoParaReescanear reinicia solo las carpetas pedidas (o todas) y conserva el uidValidity', () => {
    const { S } = cargar();
    const cfg = {
      carpetas: ['INBOX', 'trabajo'],
      estadoCarpetas: [{ carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 8 }, { carpeta: 'trabajo', uidValidity: '2000', ultimoUid: 5 }],
    };
    assert.deepStrictEqual(S.estadoParaReescanear(cfg, ['trabajo']), [
      { carpeta: 'INBOX', uidValidity: '1000', ultimoUid: 8 },
      { carpeta: 'trabajo', uidValidity: '2000', ultimoUid: 0 },
    ]);
    assert.ok(S.estadoParaReescanear(cfg).every(e => e.ultimoUid === 0), 'sin indicar carpetas, todas');
  });

  test('reinicioCarpetas (casilla nueva) vuelve a INBOX y borra todo el progreso', () => {
    const { S } = cargar();
    assert.deepStrictEqual(S.reinicioCarpetas(), {
      carpetas: ['INBOX'], estadoCarpetas: [], ultimoUid: 0, uidValidity: '',
    });
  });

  test('ids: con Message-ID no dependen de la carpeta; sin Message-ID sí, e INBOX conserva la fórmula de antes', () => {
    const { S } = cargar();
    assert.strictEqual(S.idMail('<x@y>', 'INBOX', '1', 1), S.idMail('<x@y>', 'trabajo', '2', 7), 'el mismo mail movido no cambia de id');
    assert.notStrictEqual(S.idMail('', 'INBOX', '1', 1), S.idMail('', 'trabajo', '1', 1), 'mismo UID, otra carpeta: ids distintos');
    assert.strictEqual(S.idMail('', 'INBOX', '1000', 5), idViejo('1000:5'), 'compatible con lo ya guardado');
    assert.strictEqual(S.idMail('<x@y>', 'INBOX', '1000', 5), idViejo('<x@y>'));
  });

  test('un nombre de carpeta con puntos o barras no rompe el estado', () => {
    const { S } = cargar();
    const nombres = ['Clientes.2026', 'INBOX/trabajo', 'a.b.c'];
    const estado = new Map(nombres.map(n => [n, { uidValidity: '1', ultimoUid: 2 }]));
    const guardado = S.serializarEstado(estado, nombres);
    assert.deepStrictEqual(guardado.map(e => e.carpeta), nombres);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(guardado)), guardado, 'sobrevive a ir y volver de Firestore');
  });
});
