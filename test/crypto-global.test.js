/**
 * Reproduce y cubre el fallo al conectar una casilla en Railway con Node 18:
 *
 *   POST /api/correo/config -> "Cannot read properties of undefined (reading 'getRandomValues')"
 *
 * Causa: imapflow llama globalThis.crypto.getRandomValues() en su CONSTRUCTOR
 * (dist/cjs/imap-flow.js:233 -> getRandomId, linea 406). En Node 18 ese global no
 * existe, así que `new ImapFlow(...)` lanzaba dentro de crearCliente(), fuera del
 * try de probarConexion(), y el error crudo salía como 500 a la pantalla.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert  = require('node:assert');
const { execFileSync } = require('node:child_process');
const path    = require('node:path');
const fs      = require('node:fs');
const os      = require('node:os');

const RAIZ     = path.join(__dirname, '..');
const SIN_CRYPTO = path.join(__dirname, 'helpers', 'simular-node18.js');
const POLYFILL = "globalThis.crypto ??= require('node:crypto').webcrypto;";

/**
 * Corre código en un proceso aparte con globalThis.crypto borrado (como Node 18).
 * Tiene que ser un ARCHIVO de entrada, no 'node -e': con -e Node reexpone el global
 * después de los preloads y el escenario no se reproduce.
 * El archivo va fuera del repo, así que los require se arman con rutas absolutas.
 */
function comoNode18(codigo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ty-node18-'));
  const script = path.join(dir, 'caso.js');
  fs.writeFileSync(script, `const RAIZ = ${JSON.stringify(RAIZ)};
${codigo}`);
  try {
    return execFileSync(process.execPath, ['--require', SIN_CRYPTO, script], {
      cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('el fallo original (Node 18, sin el arreglo)', () => {
  test('el constructor de ImapFlow lanza el error exacto que se veía en pantalla', () => {
    const out = comoNode18(`
      console.log('cryptoGlobal=' + typeof globalThis.crypto);
      const { ImapFlow } = require(RAIZ + '/node_modules/imapflow');
      try {
        new ImapFlow({ host: 'imap.invalido.test', port: 993, secure: true, auth: { user: 'a@b.c', pass: 'x' }, logger: false });
        console.log('resultado=NO_LANZO');
      } catch (e) { console.log('resultado=' + e.message); }`);
    assert.match(out, /cryptoGlobal=undefined/, 'el preload tiene que dejar el global sin definir');
    assert.match(out, /resultado=Cannot read properties of undefined \(reading 'getRandomValues'\)/,
      'sin el arreglo, construir el cliente debe fallar con el mensaje reportado');
  });

  test('crearCliente lanza FUERA del try de probarConexion, por eso salía como 500 crudo', () => {
    // Confirma el diagnóstico: el throw ocurre al construir, no al conectar.
    const out = comoNode18(`
      const S = require(RAIZ + '/services/correoSync');
      S.probarConexion({ host: 'imap.invalido.test', port: 993, secure: true, user: 'a@b.c', pass: 'x' })
        .then(r => console.log('devolvio=' + JSON.stringify(r)))
        .catch(e => console.log('lanzo=' + e.message));`);
    assert.match(out, /lanzo=Cannot read properties of undefined \(reading 'getRandomValues'\)/,
      'probarConexion no lo atrapa porque crearCliente corre antes del try');
  });
});

describe('el arreglo', () => {
  test('con el polyfill, el constructor de ImapFlow funciona', () => {
    const out = comoNode18(`
      ${POLYFILL}
      console.log('cryptoGlobal=' + typeof globalThis.crypto);
      const { ImapFlow } = require(RAIZ + '/node_modules/imapflow');
      const c = new ImapFlow({ host: 'imap.invalido.test', port: 993, secure: true, auth: { user: 'a@b.c', pass: 'x' }, logger: false });
      console.log('idLargo=' + (typeof c.id === 'string' && c.id.length >= 20));`);
    assert.match(out, /cryptoGlobal=object/);
    assert.match(out, /idLargo=true/, 'getRandomId tiene que producir el id de 20 caracteres');
  });

  test('con el polyfill, probarConexion devuelve un mensaje claro en vez del error de crypto', async () => {
    const out = comoNode18(`
      ${POLYFILL}
      const S = require(RAIZ + '/services/correoSync');
      S.probarConexion({ host: 'imap.invalido.test', port: 993, secure: true, user: 'a@b.c', pass: 'x' })
        .then(r => console.log('devolvio=' + JSON.stringify(r)))
        .catch(e => console.log('lanzo=' + e.message));`);
    assert.match(out, /devolvio=/, 'ahora no debe lanzar: probarConexion atrapa y traduce');
    assert.doesNotMatch(out, /getRandomValues/, 'el error de crypto no debe aparecer más');
    const r = JSON.parse(out.match(/devolvio=(\{.*\})/)[1]);
    assert.strictEqual(r.ok, false);
    assert.match(r.mensaje, /No se encontró el servidor de correo|no responde/,
      'un host inexistente tiene que dar el mensaje traducido de servidor, no un stack');
  });

  test('index.js aplica el polyfill antes de cualquier require de la app', () => {
    const lineas = fs.readFileSync(path.join(RAIZ, 'index.js'), 'utf8').split(/\r?\n/);
    const iPoly = lineas.findIndex(l => l.includes('globalThis.crypto ??='));
    const iReq  = lineas.findIndex(l => /require\((?!'node:)/.test(l));
    assert.ok(iPoly >= 0, 'index.js tiene que tener el polyfill');
    assert.ok(iPoly < iReq, `el polyfill (linea ${iPoly + 1}) tiene que ir antes del primer require de la app (linea ${iReq + 1})`);
  });

  test('package.json exige Node >=20, que es lo que pide imapflow', () => {
    const p = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    assert.ok(p.engines?.node, 'falta el campo engines.node');
    const minimo = Number(String(p.engines.node).match(/(\d+)/)?.[1]);
    assert.ok(minimo >= 20, `engines.node pide ${p.engines.node}; imapflow necesita >=20`);

    const imap = JSON.parse(fs.readFileSync(path.join(RAIZ, 'node_modules/imapflow/package.json'), 'utf8'));
    const pide = Number(String(imap.engines?.node || '0').match(/(\d+)/)?.[1]);
    assert.ok(minimo >= pide, `imapflow pide node >=${pide} y engines.node dice ${p.engines.node}`);
  });
});
