/**
 * Planilla Incluir y DJ ESC 107: todo paciente ACTIVO de Incluir sale en las dos, sin importar con qué
 * clave se guardó el N° de afiliado ni en qué colección vive. Datos 100 % ficticios, rutas REALES,
 * Firestore en memoria.
 *
 * El defecto que se arregló: el formulario de Registro guardaba el N° solo en `nroAfiliado` y las planillas
 * leían solo 'N° AFILIADO'; los pacientes de BENEFICIARIOS no se podían editar ni salían en las planillas;
 * y las planillas listaban a todas las obras sociales.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { fakeDb } = require('./helpers/fakeFirestore');
const B = require('../utils/beneficiarios');
const R = require('../scripts/reparar-incluir');

const RAIZ = path.join(__dirname, '..');
const T = 't1';
const ARCHIVOS = ['routes/beneficiarios.js', 'routes/planillas.js'].map(r => require.resolve(path.join(RAIZ, r)));

let actual = null;
const original = Module._load;
Module._load = function (pedido, padre, esMain) {
  if (actual && padre && ARCHIVOS.includes(padre.filename)) {
    if (pedido === '../utils') return actual.utils;
    if (pedido === '../middleware/auth') return actual.auth;
    if (pedido === '../firebase') return { db: actual.db };
  }
  return original.call(this, pedido, padre, esMain);
};

function montar() {
  const db = fakeDb();
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const col = (t, sub) => {
    const ruta = `empresas/${t}/${sub}`;
    return { ...db.coleccion(ruta), add: async v => { const id = crypto.randomUUID(); await db.ref(`${ruta}/${id}`).set(v); return { id }; } };
  };
  const utils = {
    col, normalizarText_: norm, fechaHoyAR: () => '15/11/2026', randomUUID: () => crypto.randomUUID(),
    MESES: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
  };
  const pasa = (req, res, next) => next();
  const auth = { verifyToken: (req, res, next) => { req.user = { email: 'admin@empresa.com', rol: 'admin' }; next(); }, requireAdmin: pasa };
  actual = { utils, auth, db };
  for (const r of ARCHIVOS) delete require.cache[r];
  return { db, beneficiarios: require(ARCHIVOS[0]), planillas: require(ARCHIVOS[1]) };
}

async function levantar(m) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.tenantId = T; next(); });
  app.use('/api/beneficiarios', m.beneficiarios);
  app.use('/api/planillas', m.planillas);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const llamar = async (metodo, ruta, body) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { llamar, cerrar: () => new Promise(r => server.close(r)) };
}

const sembrar = (m, coleccion, id, datos) => m.db.docs.set(`empresas/${T}/${coleccion}/${id}`, { ...datos });
const guardado = (m, coleccion, id) => m.db.docs.get(`empresas/${T}/${coleccion}/${id}`);
const existe = (m, coleccion, id) => m.db.docs.has(`empresas/${T}/${coleccion}/${id}`);
const planillas = async s => ({
  inc: (await s.llamar('GET', '/api/planillas/incluir?mes=11&anio=2026')).json,
  dj: (await s.llamar('GET', '/api/planillas/dj107?mes=11&anio=2026')).json,
});
const conServidor = async (fn) => { const m = montar(); const s = await levantar(m); try { await fn(m, s); } finally { await s.cerrar(); } };

// Lo que manda el formulario de Registro: el N° solo en `nroAfiliado`, `id` vacío y campos del sistema.
const altaRegistro = (o = {}) => ({
  id: '', apellidoYNombre: 'Paciente Uno Ficticio', dni: '10000001', nroAfiliado: '9000001', obraSocial: 'INCLUIR SALUD',
  'APELLIDO Y NOMBRE': 'Paciente Uno Ficticio', NOMBRE: 'Paciente Uno Ficticio', DNI: '10000001', 'OBRA SOCIAL': 'INCLUIR SALUD', activo: true, ...o,
});

/* ═══════════════════════════ helper ═══════════════════════════ */

describe('utils/beneficiarios: obra social', () => {
  test('todas las grafías de Incluir pasan al valor canónico; el resto se conserva', () => {
    for (const v of ['incluir', 'Incluir Salud', 'INCLUIR SALUD', '  incluir   salud ', 'Íncluir Salud', 'INCLUIR-SALUD', 'Programa Incluir Salud']) {
      assert.strictEqual(B.normalizarObraSocial(v), 'INCLUIR SALUD', v);
      assert.ok(B.esIncluir(v), v);
    }
    assert.strictEqual(B.normalizarObraSocial('OSPRERA'), 'OSPRERA');
    assert.strictEqual(B.normalizarObraSocial('  PNC '), 'PNC');
    assert.strictEqual(B.normalizarObraSocial('EXCLUIR'), 'EXCLUIR');
    for (const v of ['', '   ', null, undefined]) assert.strictEqual(B.normalizarObraSocial(v), '');
  });
});

describe('utils/beneficiarios: nombres de campo', () => {
  test('el N° de afiliado se lee de cualquier variante', () => {
    for (const k of ['N° AFILIADO', 'Nº AFILIADO', 'nroAfiliado', 'NRO_AFILIADO', 'nro_afiliado', 'afiliado', 'AFILIADO']) {
      const b = B.normalizarBeneficiario('x', { 'APELLIDO Y NOMBRE': 'P F', [k]: ' 123 ' });
      assert.strictEqual(b.afiliado, '123', k);
      assert.strictEqual(b.faltaAfiliado, false, k);
    }
    assert.strictEqual(B.normalizarBeneficiario('x', { 'APELLIDO Y NOMBRE': 'P F' }).faltaAfiliado, true);
  });
  test('nombre, obra social, chofer y demás desde cualquier variante', () => {
    const b = B.normalizarBeneficiario('x', { apellido: 'Ficticia', nombre: 'Ana', OS: 'incluir', chofer: 'Chofer Uno', DNI: '1' }, 'BENEFICIARIOS');
    assert.strictEqual(b.nombre, 'Ficticia Ana');
    assert.strictEqual(b.obraSocial, 'INCLUIR SALUD');
    assert.strictEqual(b.esIncluir, true);
    assert.strictEqual(b.chofer, 'Chofer Uno');
    assert.strictEqual(b.coleccion, 'BENEFICIARIOS');
  });
  test('activo: solo `activo: false` lo desactiva', () => {
    assert.strictEqual(B.normalizarBeneficiario('x', {}).activo, true);
    assert.strictEqual(B.normalizarBeneficiario('x', { activo: false }).activo, false);
  });
});

describe('utils/beneficiarios: limpiarPayload', () => {
  test('saca id y campos internos y los undefined', () => {
    const l = B.limpiarPayload({ id: 'a', ID: 'b', _id: 'c', creadoEn: 1, actualizadoEn: 2, _updatedAt: 3, DNI: '1', nada: undefined, vacio: '' });
    assert.deepStrictEqual(Object.keys(l).sort(), ['DNI', 'vacio']);
  });
  test('el N° de afiliado queda igual en N° AFILIADO y nroAfiliado, venga de la clave que venga', () => {
    for (const k of ['nroAfiliado', 'N° AFILIADO', 'NRO_AFILIADO']) {
      const l = B.limpiarPayload({ [k]: ' 55 ' });
      assert.strictEqual(l['N° AFILIADO'], '55', k);
      assert.strictEqual(l.nroAfiliado, '55', k);
    }
    // Un formulario con una clave vacía y otra llena (el de Registro): gana la llena.
    assert.strictEqual(B.limpiarPayload({ 'N° AFILIADO': '', nroAfiliado: '77' })['N° AFILIADO'], '77');
    // Si no vino ninguna clave de afiliado, no se inventa una.
    assert.ok(!('N° AFILIADO' in B.limpiarPayload({ DNI: '1' })));
    // Si el usuario lo borra a propósito (todas vacías), queda vacío.
    assert.strictEqual(B.limpiarPayload({ 'N° AFILIADO': '', nroAfiliado: '' })['N° AFILIADO'], '');
  });
  test('la obra social se guarda canónica en las dos claves', () => {
    const l = B.limpiarPayload({ obraSocial: 'incluir salud ' });
    assert.strictEqual(l['OBRA SOCIAL'], 'INCLUIR SALUD');
    assert.strictEqual(l.obraSocial, 'INCLUIR SALUD');
    assert.strictEqual(B.limpiarPayload({ 'OBRA SOCIAL': 'OSPRERA' }).obraSocial, 'OSPRERA');
  });
});

/* ═══════════════════════════ planillas ═══════════════════════════ */

describe('planillas: un alta nueva de Incluir aparece en las dos sin pasos extra', () => {
  test('alta desde Registro (N° solo en nroAfiliado): sale en /incluir y /dj107 con su N°', () => conServidor(async (m, s) => {
    const alta = await s.llamar('POST', '/api/beneficiarios', altaRegistro());
    assert.strictEqual(alta.status, 200);
    const { inc, dj } = await planillas(s);
    assert.strictEqual(inc.filas.length, 1);
    assert.strictEqual(dj.filas.length, 1);
    assert.strictEqual(inc.filas[0].afiliado, '9000001');
    assert.strictEqual(dj.filas[0].nroAfiliado, '9000001');
    assert.strictEqual(inc.filas[0].faltaAfiliado, false);
    assert.strictEqual(inc.filas[0].id, alta.json.id, 'la fila trae el id del documento');
    // Y en la base quedó en la clave que lee todo el sistema.
    assert.strictEqual(guardado(m, 'registro', alta.json.id)['N° AFILIADO'], '9000001');
  }));

  test('sin N° de afiliado: la fila sale igual, con el N° vacío y faltaAfiliado', () => conServidor(async (m, s) => {
    await s.llamar('POST', '/api/beneficiarios', altaRegistro({ nroAfiliado: '' }));
    const { inc, dj } = await planillas(s);
    for (const f of [inc.filas[0], dj.filas[0]]) { assert.strictEqual(f.afiliado, ''); assert.strictEqual(f.faltaAfiliado, true); }
    assert.strictEqual(inc.sinAfiliado, 1);
    assert.strictEqual(dj.sinAfiliado, 1);
  }));

  test('un paciente guardado con la clave vieja (solo nroAfiliado en el documento) también sale con su N°', () => conServidor(async (m, s) => {
    sembrar(m, 'registro', 'viejo', { 'APELLIDO Y NOMBRE': 'Paciente Viejo Ficticio', DNI: '10000009', 'OBRA SOCIAL': 'INCLUIR SALUD', nroAfiliado: '8000009' });
    const { inc, dj } = await planillas(s);
    assert.strictEqual(inc.filas[0].afiliado, '8000009');
    assert.strictEqual(dj.filas[0].nroAfiliado, '8000009');
  }));

  test('cualquier grafía de Incluir entra', () => conServidor(async (m, s) => {
    ['incluir', 'Incluir Salud', 'INCLUIR SALUD', ' Íncluir  salud'].forEach((os, i) =>
      sembrar(m, 'registro', `g${i}`, { 'APELLIDO Y NOMBRE': `Paciente G${i}`, 'OBRA SOCIAL': os, 'N° AFILIADO': `7${i}` }));
    sembrar(m, 'registro', 'otra', { 'APELLIDO Y NOMBRE': 'Paciente Otra', OS: 'incluir', 'N° AFILIADO': '79' });   // clave OS
    const { inc, dj } = await planillas(s);
    assert.strictEqual(inc.filas.length, 5);
    assert.strictEqual(dj.filas.length, 5);
    assert.ok(inc.filas.every(f => f.obraSocial === 'INCLUIR SALUD'));
  }));
});

describe('planillas: quién NO entra', () => {
  test('los de otras obras sociales no salen en ninguna planilla', () => conServidor(async (m, s) => {
    sembrar(m, 'registro', 'a', { 'APELLIDO Y NOMBRE': 'Paciente Incluir', 'OBRA SOCIAL': 'INCLUIR SALUD', 'N° AFILIADO': '1' });
    sembrar(m, 'registro', 'b', { 'APELLIDO Y NOMBRE': 'Paciente Osprera', 'OBRA SOCIAL': 'OSPRERA', 'N° AFILIADO': '2' });
    sembrar(m, 'registro', 'c', { 'APELLIDO Y NOMBRE': 'Paciente Pnc', 'OBRA SOCIAL': 'PNC', 'N° AFILIADO': '3' });
    const { inc, dj } = await planillas(s);
    assert.deepStrictEqual(inc.filas.map(f => f.id), ['a']);
    assert.deepStrictEqual(dj.filas.map(f => f.id), ['a']);
    assert.deepStrictEqual(dj.porObraSocial.map(g => g.obraSocial), ['INCLUIR SALUD']);
  }));

  test('sin obra social: no entran solos, pero se avisan (con id y nombre para el link a la ficha)', () => conServidor(async (m, s) => {
    sembrar(m, 'registro', 'sin1', { 'APELLIDO Y NOMBRE': 'Paciente Sin Os', 'N° AFILIADO': '5' });
    sembrar(m, 'registro', 'sin2', { 'APELLIDO Y NOMBRE': 'Otro Sin Os', 'OBRA SOCIAL': '  ' });
    sembrar(m, 'registro', 'ok', { 'APELLIDO Y NOMBRE': 'Paciente Incluir', 'OBRA SOCIAL': 'INCLUIR SALUD' });
    const { inc, dj } = await planillas(s);
    for (const p of [inc, dj]) {
      assert.deepStrictEqual(p.filas.map(f => f.id), ['ok']);
      assert.deepStrictEqual(p.sinObraSocial.map(x => x.id).sort(), ['sin1', 'sin2']);
      assert.ok(p.sinObraSocial.every(x => x.nombre));
    }
  }));

  test('un paciente inactivo no sale (ni se avisa)', () => conServidor(async (m, s) => {
    sembrar(m, 'registro', 'x', { 'APELLIDO Y NOMBRE': 'Paciente Inactivo', 'OBRA SOCIAL': 'INCLUIR SALUD', 'N° AFILIADO': '1', activo: false });
    sembrar(m, 'registro', 'y', { 'APELLIDO Y NOMBRE': 'Inactivo Sin Os', activo: false });
    const { inc, dj } = await planillas(s);
    for (const p of [inc, dj]) { assert.strictEqual(p.filas.length, 0); assert.strictEqual(p.sinObraSocial.length, 0); }
  }));

  test('un documento sin nombre no sale', () => conServidor(async (m, s) => {
    sembrar(m, 'registro', 'z', { 'OBRA SOCIAL': 'INCLUIR SALUD', 'N° AFILIADO': '1' });
    const { inc } = await planillas(s);
    assert.strictEqual(inc.filas.length, 0);
  }));
});

/* ═══════════════════════════ BENEFICIARIOS ═══════════════════════════ */

describe('un paciente que vive en BENEFICIARIOS', () => {
  const sembrarBen = m => sembrar(m, 'BENEFICIARIOS', 'bf1', { 'APELLIDO Y NOMBRE': 'Paciente Dos Ficticio', DNI: '10000002', 'OBRA SOCIAL': 'INCLUIR', 'N° AFILIADO': '9000002' });

  test('sale en las dos planillas', () => conServidor(async (m, s) => {
    sembrarBen(m);
    const { inc, dj } = await planillas(s);
    assert.strictEqual(inc.filas[0].id, 'bf1');
    assert.strictEqual(dj.filas[0].id, 'bf1');
  }));

  test('se puede leer y editar, y se actualiza en la colección donde está (no se crea otro en registro)', () => conServidor(async (m, s) => {
    sembrarBen(m);
    const get = await s.llamar('GET', '/api/beneficiarios/bf1');
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.json.registro.id, 'bf1');
    const put = await s.llamar('PUT', '/api/beneficiarios/bf1', { id: 'bf1', nroAfiliado: '9111111', DOMICILIO: 'Calle Falsa 1' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.json.coleccion, 'BENEFICIARIOS');
    assert.strictEqual(guardado(m, 'BENEFICIARIOS', 'bf1')['N° AFILIADO'], '9111111');
    assert.strictEqual(guardado(m, 'BENEFICIARIOS', 'bf1').DOMICILIO, 'Calle Falsa 1');
    assert.ok(!existe(m, 'registro', 'bf1'));
    assert.ok(!('id' in guardado(m, 'BENEFICIARIOS', 'bf1')), 'el id del formulario no se guarda adentro');
  }));

  test('guarda la ubicación (gps) y se da de baja desde su colección', () => conServidor(async (m, s) => {
    sembrarBen(m);
    assert.strictEqual((await s.llamar('PUT', '/api/beneficiarios/bf1/gps', { lat: '-26.8', lng: '-65.2' })).status, 200);
    assert.strictEqual(guardado(m, 'BENEFICIARIOS', 'bf1').LAT, -26.8);
    const baja = await s.llamar('POST', '/api/beneficiarios/baja', { id: 'bf1', observaciones: 'prueba' });
    assert.strictEqual(baja.status, 200);
    assert.ok(!existe(m, 'BENEFICIARIOS', 'bf1'));
    const bajas = [...m.db.docs.keys()].filter(k => k.startsWith(`empresas/${T}/bajas/`));
    assert.strictEqual(bajas.length, 1);
  }));

  test('el listado lo trae una sola vez aunque el id esté en las dos colecciones', () => conServidor(async (m, s) => {
    sembrarBen(m);
    sembrar(m, 'registro', 'bf1', { 'APELLIDO Y NOMBRE': 'Paciente Dos Ficticio', 'OBRA SOCIAL': 'INCLUIR SALUD' });
    const lista = await s.llamar('GET', '/api/beneficiarios');
    assert.strictEqual(lista.json.length, 1);
    assert.strictEqual((await planillas(s)).inc.filas.length, 1);
  }));
});

describe('guardado: errores claros y datos limpios', () => {
  test('editar uno que no existe: 404 con un mensaje que dice qué pasó', () => conServidor(async (m, s) => {
    const r = await s.llamar('PUT', '/api/beneficiarios/no-existe', { nombre: 'x' });
    assert.strictEqual(r.status, 404);
    assert.match(r.json.mensaje, /No se encontró al paciente/);
  }));
  test('alta sin nombre: 400 con mensaje', () => conServidor(async (m, s) => {
    const r = await s.llamar('POST', '/api/beneficiarios', { DNI: '1' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.mensaje, /nombre/i);
  }));
  test('editar sin ningún dato: 400', () => conServidor(async (m, s) => {
    sembrar(m, 'registro', 'p', { 'APELLIDO Y NOMBRE': 'Paciente P' });
    assert.strictEqual((await s.llamar('PUT', '/api/beneficiarios/p', { id: 'p', creadoEn: 'x' })).status, 400);
  }));
  test('una edición con la pantalla vieja (solo nroAfiliado y obraSocial en camelCase) llega a las claves que leen las planillas', () => conServidor(async (m, s) => {
    const alta = await s.llamar('POST', '/api/beneficiarios', altaRegistro({ nroAfiliado: '' }));
    assert.strictEqual((await planillas(s)).inc.filas[0].faltaAfiliado, true);
    const put = await s.llamar('PUT', `/api/beneficiarios/${alta.json.id}`, { id: alta.json.id, nroAfiliado: '9000005', obraSocial: 'incluir salud' });
    assert.strictEqual(put.status, 200);
    const { inc, dj } = await planillas(s);
    assert.strictEqual(inc.filas[0].afiliado, '9000005');
    assert.strictEqual(dj.filas[0].nroAfiliado, '9000005');
    assert.strictEqual(guardado(m, 'registro', alta.json.id)['OBRA SOCIAL'], 'INCLUIR SALUD');
  }));
  test('el id guardado adentro del documento no pisa el id real en el listado', () => conServidor(async (m, s) => {
    sembrar(m, 'registro', 'real', { id: '', ID: 'real', 'APELLIDO Y NOMBRE': 'Paciente R' });
    const lista = await s.llamar('GET', '/api/beneficiarios');
    assert.strictEqual(lista.json[0].id, 'real');
  }));
});

/* ═══════════════════════════ script de reparación ═══════════════════════════ */

describe('scripts/reparar-incluir: planificar', () => {
  const docs = [
    { id: 'a', coleccion: 'registro', data: { 'APELLIDO Y NOMBRE': 'P A', 'OBRA SOCIAL': 'INCLUIR SALUD', nroAfiliado: '11' } },                       // copiar N°
    { id: 'b', coleccion: 'registro', data: { 'APELLIDO Y NOMBRE': 'P B', 'OBRA SOCIAL': 'INCLUIR SALUD', 'N° AFILIADO': '22', nroAfiliado: '22' } },    // ya está
    { id: 'c', coleccion: 'registro', data: { 'APELLIDO Y NOMBRE': 'P C', 'OBRA SOCIAL': 'INCLUIR SALUD', 'N° AFILIADO': '' } },                          // falta: solo marcar
    { id: 'd', coleccion: 'registro', data: { 'APELLIDO Y NOMBRE': 'P D', nroAfiliado: '44' } },                                                          // sin OS: listar (y copia el N°)
    { id: 'e', coleccion: 'BENEFICIARIOS', data: { 'APELLIDO Y NOMBRE': 'P E', obraSocial: 'incluir', 'N° AFILIADO': '55' } },                          // copiar OS
    { id: 'f', coleccion: 'registro', data: { 'APELLIDO Y NOMBRE': 'P F', 'OBRA SOCIAL': 'OSPRERA' } },                                                  // otra OS sin N°: ni se marca
    { id: 'g', coleccion: 'registro', data: { 'APELLIDO Y NOMBRE': 'P G', 'OBRA SOCIAL': 'INCLUIR SALUD', activo: false } },                              // inactivo: ni se marca
  ];
  const plan = R.planificar(docs);

  test('copia el N° de la otra clave solo donde corresponde', () => {
    const a = plan.cambios.find(c => c.id === 'a');
    assert.deepStrictEqual(a.campos, { 'N° AFILIADO': { antes: R.AUSENTE, despues: '11' } });
    assert.ok(!plan.cambios.some(c => c.id === 'b'), 'el que ya lo tiene no se toca');
    assert.ok(!plan.cambios.some(c => c.id === 'c'), 'el que no tiene N° en ninguna clave no se toca (no se inventa)');
  });
  test('copia la obra social de la otra clave', () => {
    assert.deepStrictEqual(plan.cambios.find(c => c.id === 'e').campos, { 'OBRA SOCIAL': { antes: R.AUSENTE, despues: 'incluir' } });
  });
  test('solo marca a los de Incluir sin N° en ninguna clave, y solo lista a los sin obra social', () => {
    assert.deepStrictEqual(plan.faltaAfiliado, ['c']);
    assert.deepStrictEqual(plan.sinObraSocial, ['d']);
  });
  test('es idempotente: después de aplicar los cambios ya no hay nada para copiar', () => {
    const aplicados = docs.map(d => {
      const c = plan.cambios.find(x => x.id === d.id);
      return c ? { ...d, data: { ...d.data, ...Object.fromEntries(Object.entries(c.campos).map(([k, v]) => [k, v.despues])) } } : d;
    });
    assert.deepStrictEqual(R.planificar(aplicados).cambios, []);
  });
  test('la reversión devuelve el valor previo (o marca que no existía)', () => {
    const rev = R.planificarReversion({ cambios: [{ id: 'z', coleccion: 'registro', campos: { 'N° AFILIADO': { antes: '', despues: '9' }, 'OBRA SOCIAL': { antes: R.AUSENTE, despues: 'X' } } }] });
    assert.deepStrictEqual(rev[0].campos, { 'N° AFILIADO': '', 'OBRA SOCIAL': R.AUSENTE });
  });
});
