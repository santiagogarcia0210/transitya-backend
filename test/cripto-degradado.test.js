/**
 * Verifica que una ENCRYPTION_KEY ausente o inválida NO tumbe el servidor:
 * el backend arranca completo y solo /api/correo queda deshabilitado con 503.
 *
 * Correr: npm test
 *
 * No necesita credenciales reales: firebase.js atrapa su propio error de init,
 * y ninguna de las rutas que se prueban acá llega a tocar Firestore.
 */
const { test, describe } = require('node:test');
const assert  = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const net     = require('node:net');
const path    = require('node:path');

const RAIZ = path.join(__dirname, '..');
const CLAVE_OK = 'a'.repeat(64); // 64 chars hex = 32 bytes

/** Env limpio: nunca hereda la ENCRYPTION_KEY ni el FIREBASE_SA reales de la máquina. */
function env(extra = {}) {
  // AFIPSDK_ACCESS_TOKEN va en falso solo para que services/afip.js cargue: ese módulo
  // también lanza al requerirse si falta, y es ajeno a lo que prueba este archivo.
  const e = {
    ...process.env,
    FIREBASE_SA: '{"project_id":"fake-test"}',
    AFIPSDK_ACCESS_TOKEN: 'token-falso-de-test',
    DOTENV_CONFIG_QUIET: 'true',
  };
  delete e.ENCRYPTION_KEY;
  return { ...e, ...extra };
}

/** Corre un snippet en un proceso aparte y devuelve su stdout. */
function correr(codigo, extraEnv) {
  return execFileSync(process.execPath, ['-e', codigo], {
    cwd: RAIZ, env: env(extraEnv), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('helpers/cripto sin clave válida', () => {
  test('cargar el módulo no lanza y queda no disponible', () => {
    const out = correr("const c=require('./helpers/cripto'); console.log('disp='+c.disponible())");
    assert.match(out, /disp=false/);
  });

  test('encriptar y desencriptar fallan con un motivo claro', () => {
    const out = correr(`
      const c = require('./helpers/cripto');
      for (const fn of ['encriptar','desencriptar']) {
        try { c[fn]('x'); console.log(fn+'=NO_LANZO'); }
        catch (e) { console.log(fn+'=lanzo:'+/ENCRYPTION_KEY/.test(e.message)); }
      }`);
    assert.match(out, /encriptar=lanzo:true/);
    assert.match(out, /desencriptar=lanzo:true/);
  });

  test('las claves inválidas se rechazan sin tumbar el proceso', () => {
    const malas = { vacia: '', corta: 'abcd', noHex: 'z'.repeat(64), largaDeMas: 'a'.repeat(66), conTexto: 'clave-secreta-de-32-caracteres!!' };
    for (const [nombre, valor] of Object.entries(malas)) {
      const out = correr("const c=require('./helpers/cripto'); console.log('disp='+c.disponible()+' motivo='+(c.motivoNoDisponible()!==''))", { ENCRYPTION_KEY: valor });
      assert.match(out, /disp=false motivo=true/, `la clave "${nombre}" debería quedar no disponible`);
    }
  });

  test('el programador de correo no se enciende', () => {
    const out = correr("console.log('timer='+require('./services/correoSync').iniciarProgramador(null))");
    assert.match(out, /timer=null/);
  });
});

describe('helpers/cripto con clave válida', () => {
  test('queda disponible y el round-trip devuelve el original', () => {
    const out = correr(`
      const c = require('./helpers/cripto');
      const original = 'abcd efgh ijkl mnop';
      const cifrado  = c.encriptar(original);
      console.log('disp='+c.disponible());
      console.log('formato='+(cifrado.split(':').length===3));
      console.log('noFiltra='+!cifrado.includes(original));
      console.log('vuelta='+(c.desencriptar(cifrado)===original));`, { ENCRYPTION_KEY: CLAVE_OK });
    assert.match(out, /disp=true/);
    assert.match(out, /formato=true/);
    assert.match(out, /noFiltra=true/);
    assert.match(out, /vuelta=true/);
  });
});

/** Pide al sistema un puerto libre y lo devuelve. */
function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Levanta el index.js real en un puerto libre y devuelve { base, cerrar, logs }. */
async function levantarServidor(extraEnv) {
  const puerto = await puertoLibre();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: RAIZ, env: env({ PORT: String(puerto), CORREO_SYNC_MINUTOS: '0', ...extraEnv }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });

  // Espera el log de arranque; si el proceso muere, el test falla con los logs completos.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('el servidor no arrancó en 25s. Logs: ' + logs)), 25_000);
    proc.on("exit", c => { clearTimeout(t); reject(new Error("el servidor murió con código " + c + ". Logs: " + logs)); });
    const buscar = () => {
      if (logs.includes('corriendo en puerto')) { clearTimeout(t); resolve(); } else setTimeout(buscar, 150);
    };
    buscar();
  });

  return {
    base: `http://127.0.0.1:${puerto}`,
    logs: () => logs,
    cerrar: () => new Promise(r => { proc.once('exit', r); proc.kill(); }),
  };
}

describe('el servidor completo sin ENCRYPTION_KEY', () => {
  test('arranca, /health responde 200 y /api/correo responde 503', async () => {
    const srv = await levantarServidor();
    try {
      const health = await fetch(`${srv.base}/health`);
      assert.strictEqual(health.status, 200, 'el resto del backend tiene que arrancar normal');
      assert.strictEqual((await health.json()).ok, true);

      // Todas las rutas de correo, no solo una.
      for (const [metodo, ruta] of [['GET', '/api/correo/config'], ['POST', '/api/correo/config'], ['GET', '/api/correo/mails'], ['POST', '/api/correo/sincronizar']]) {
        const r = await fetch(`${srv.base}${ruta}`, { method: metodo });
        assert.strictEqual(r.status, 503, `${metodo} ${ruta} debería dar 503`);
        const body = await r.json();
        assert.strictEqual(body.codigo, 'CORREO_DESHABILITADO');
        assert.strictEqual(body.ok, false);
        assert.ok(!/ENCRYPTION_KEY/.test(body.mensaje), 'el 503 no debe exponer el nombre de la variable al cliente');
      }

      // Una ruta hermana del mismo parche sigue pidiendo auth, no 503.
      const legajos = await fetch(`${srv.base}/api/legajos`);
      assert.strictEqual(legajos.status, 401, 'legajos no depende del cifrado: debe pedir token');

      assert.match(srv.logs(), /Cifrado DESHABILITADO/, 'tiene que quedar registrado en el log del servidor');
    } finally { await srv.cerrar(); }
  });
});

describe('el servidor completo CON ENCRYPTION_KEY', () => {
  test('/api/correo pide token (401) en vez de dar 503', async () => {
    const srv = await levantarServidor({ ENCRYPTION_KEY: CLAVE_OK });
    try {
      const r = await fetch(`${srv.base}/api/correo/config`);
      assert.strictEqual(r.status, 401, 'con clave válida el módulo queda habilitado');
      assert.strictEqual((await r.json()).ok, false);
    } finally { await srv.cerrar(); }
  });
});

