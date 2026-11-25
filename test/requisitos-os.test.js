/**
 * Requisitos por obra social cargados desde documentos oficiales (nov 2026).
 *
 * Qué se verifica:
 *  - los datos: Incluir Salud, OSPRERA y Subsidio IPSST con lo que dicen los documentos;
 *  - que PAMI, los requisitos mensuales y los de prestador de Incluir Salud NO cambiaron
 *    (se comparan contra test/fixtures/requisitosBorradorAnterior.js, una copia congelada);
 *  - que el formato es el de siempre (lo valida limpiarRequisitos, el validador real de la ruta)
 *    y que la carpeta del paciente (services/legajos.js) los lee bien;
 *  - que los documentos ya subidos a las carpetas siguen enlazados (las `key` se conservaron);
 *  - la semilla contra los endpoints reales, con un Firestore en memoria: una empresa vacía
 *    queda con todo, una empresa con el borrador viejo recibe lo nuevo, y lo que alguien
 *    editó nunca se pisa.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const { fakeDb, fakeUtils } = require('./helpers/fakeFirestore');
const NUEVO = require('../data/requisitosBorrador');
const VIEJO = require('./fixtures/requisitosBorradorAnterior');

const RAIZ = path.join(__dirname, '..');
const T = 't1';
const RUTA_COL = `empresas/${T}/requisitos_os`;
const SIN_VIGENCIA = 'Vigencia no especificada: confirmar con la obra social';

const N = id => NUEVO.find(o => o.id === id);
const V = id => VIEJO.find(o => o.id === id);
const cat = (obra, c) => obra.requisitos.filter(r => r.categoria === c);
const porKey = (obra, key) => obra.requisitos.find(r => r.key === key);
const sinTocar = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

/* ── Carga de módulos con Firestore en memoria ───────────────────────────── */

function cargarRuta() {
  const db = fakeDb();
  const utils = fakeUtils(db);
  const rutaRuta = require.resolve(path.join(RAIZ, 'routes/requisitos-os.js'));
  const rutaLeg = require.resolve(path.join(RAIZ, 'services/legajos.js'));
  const pasa = (req, res, next) => next();
  const original = Module._load;
  Module._load = function (pedido, padre, esMain) {
    if (padre && (padre.filename === rutaRuta || padre.filename === rutaLeg)) {
      if (pedido === '../utils') return utils;
      if (pedido === '../middleware/auth') return { verifyToken: pasa, requireAdmin: pasa };
    }
    return original.call(this, pedido, padre, esMain);
  };
  try {
    delete require.cache[rutaRuta];
    delete require.cache[rutaLeg];
    return { ruta: require(rutaRuta), legajos: require(rutaLeg), db };
  } finally {
    Module._load = original;
  }
}

/** Monta el router real en un servidor de prueba (sin auth: la omite el stub). */
async function levantar(ruta) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.tenantId = T; next(); });
  app.use('/api/requisitos-os', ruta);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/requisitos-os`;
  const llamar = async (metodo, sub = '', body) => {
    const r = await fetch(base + sub, {
      method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  return { llamar, cerrar: () => new Promise(r => server.close(r)) };
}

/** Deja en la empresa lo que dejó la semilla anterior: el borrador viejo, sin editar. */
function sembrarViejo(db, ruta, ids = VIEJO.map(o => o.id)) {
  for (const os of VIEJO.filter(o => ids.includes(o.id))) {
    db.docs.set(`${RUTA_COL}/${os.id}`, { ...ruta.limpiarOS(os), id: os.id, borrador: true, creadoEn: '2026-06-01T00:00:00.000Z' });
  }
}
const doc = (db, id) => db.docs.get(`${RUTA_COL}/${id}`);

/* ── Datos: Incluir Salud ────────────────────────────────────────────────── */

describe('Incluir Salud', () => {
  const incluir = N('incluir-salud');
  const paciente = cat(incluir, 'paciente');

  test('tiene 10 requisitos de paciente: 9 obligatorios y 1 opcional', () => {
    assert.strictEqual(paciente.length, 10);
    assert.strictEqual(paciente.filter(r => r.obligatorio).length, 9);
    const opcionales = paciente.filter(r => !r.obligatorio);
    assert.strictEqual(opcionales.length, 1);
    assert.match(opcionales[0].nombre, /escolar/i, 'el opcional es el certificado escolar');
    assert.strictEqual(opcionales[0].condicion, 'Solo para escuelas públicas');
  });

  test('son los 10 del documento oficial, en orden', () => {
    const buscado = [
      /^Nota manuscrita original del beneficiario, padre o tutor, solicitando la prestación$/,
      /^Fotocopia DNI del titular de derecho y del apoderado/,
      /^Fotocopia del Certificado Único de Discapacidad vigente a la fecha de solicitud$/,
      /^Fotocopia de la última Orden de Pago Previsional \(boleta de cobro\)$/,
      /^Prescripción médica original, indicando modalidad y período, con historia clínica firmada/,
      /^Informe de Trabajador Social matriculado$/,
      /^Certificado de incorporación y\/o asistencia escolar$/,
      /^Presupuesto de prestador de transporte habilitado con mapa georreferenciado$/,
      /^Formulario de Medida de Independencia Funcional \(FIM\)$/,
      /^Autorización e-Gov del Plan de Trabajo al Centro$/,
    ];
    buscado.forEach((re, i) => assert.match(paciente[i].nombre, re, `requisito ${i + 1}`));
    assert.match(paciente[4].nombre, /diagnóstico, estado clínico actual y pronóstico/);
  });

  test('solo el CUD vence por fecha del documento; el resto, vencimiento "no" con la nota de vigencia', () => {
    for (const r of paciente) {
      if (r.key === 'cud') {
        assert.strictEqual(r.vencimiento, 'fecha_doc');
        assert.ok(!r.notas.includes(SIN_VIGENCIA));
      } else {
        assert.strictEqual(r.vencimiento, 'no', r.nombre);
        assert.ok(r.notas.includes(SIN_VIGENCIA), `${r.nombre} debe aclarar que la vigencia no está especificada`);
      }
    }
  });

  test('conserva tal cual los requisitos de prestador y los mensuales de antes', () => {
    sinTocar(cat(incluir, 'prestador'), cat(V('incluir-salud'), 'prestador'));
    sinTocar(cat(incluir, 'mensual'), cat(V('incluir-salud'), 'mensual'));
  });

  test('marca la fuente en las notas y conserva el resto de los datos de la obra social', () => {
    assert.match(incluir.notas, /Documento oficial recibido, nov 2026/);
    assert.match(incluir.notas, /Incluir Salud/);
    sinTocar(incluir.alias, V('incluir-salud').alias);
    sinTocar(incluir.presentacion, V('incluir-salud').presentacion);
  });
});

/* ── Datos: OSPRERA ──────────────────────────────────────────────────────── */

describe('OSPRERA', () => {
  const osprera = N('osprera');
  const paciente = cat(osprera, 'paciente');
  const prestador = cat(osprera, 'prestador');

  test('paciente: 10 obligatorios y los dos condicionales como opcionales', () => {
    assert.strictEqual(paciente.filter(r => r.obligatorio).length, 10);
    const opc = paciente.filter(r => !r.obligatorio);
    assert.deepStrictEqual(opc.map(r => r.key).sort(), ['certificado_policial', 'fim']);
    const fim = porKey(osprera, 'fim');
    assert.strictEqual(fim.condicion, 'Solo si hay dependencia');
    assert.match(fim.notas, /35%/);
    assert.match(fim.notas, /Terapia Ocupacional/);
    const pol = porKey(osprera, 'certificado_policial');
    assert.strictEqual(pol.condicion, 'Solo si los traslados superan 1500 km mensuales');
  });

  test('el recibo de sueldo vence a los 3 meses y el certificado de discapacidad por fecha del documento', () => {
    const recibo = porKey(osprera, 'recibos_titular');
    assert.strictEqual(recibo.vencimiento, 'meses');
    assert.strictEqual(recibo.vigenciaMeses, 3);
    assert.strictEqual(porKey(osprera, 'cud').vencimiento, 'fecha_doc');
  });

  test('la prescripción pide justificar la imposibilidad de usar transporte público; la conformidad lleva la DJ de la Ley 19.279', () => {
    assert.match(porKey(osprera, 'pedido_medico').notas, /imposibilidad de usar transporte público/);
    assert.match(porKey(osprera, 'pedido_medico').notas, /sin tachaduras/i);
    assert.match(porKey(osprera, 'conformidad_diagrama').notas, /Ley 19\.279/);
  });

  test('prestador: 5 obligatorios (4 con vencimiento por fecha) y el CBU opcional solo para prestador nuevo', () => {
    assert.strictEqual(prestador.filter(r => r.obligatorio).length, 5);
    assert.deepStrictEqual(prestador.filter(r => r.vencimiento === 'fecha_doc').map(r => r.key).sort(),
      ['p_habilitacion', 'p_licencia', 'p_seguro', 'p_vtv']);
    const cbu = porKey(osprera, 'p_cbu');
    assert.strictEqual(cbu.obligatorio, false);
    assert.strictEqual(cbu.condicion, 'Solo prestador nuevo');
    assert.ok(porKey(osprera, 'p_cuit').obligatorio);
  });

  test('NO carga los requisitos que son solo de terapias', () => {
    const terapias = /evaluaci[oó]n inicial|informe evolutivo|abordaje individual|presupuesto prestacional|seguimiento semestral/i;
    for (const r of osprera.requisitos) assert.doesNotMatch(r.nombre, terapias, r.nombre);
  });

  test('los datos de presentación están completos', () => {
    const n = osprera.presentacion.notas;
    for (const dato of [
      'lunes, martes y miércoles de 08:00 a 12:00', 'delegación Tucumán de OSPRERA', 'agencia Concepción',
      'hasta Monteros', 'responsable del afiliado', 'correcciones', '25 afiliados por prestador individual',
      'hasta que OSPRERA la autorice', 'auditoría administrativa y médica', 'mayor anticipación posible',
      'discapacidad.tucuman@osprera.org.ar', '0381-4300768 interno 10',
    ]) assert.ok(n.includes(dato), `falta: ${dato}`);
  });

  test('la fuente y el aviso de vigencia 2026 están en las notas', () => {
    assert.match(osprera.notas, /Expedientes discapacidad 2025/);
    assert.match(osprera.notas, /Requisitos 2025: confirmar vigencia para 2026/);
    assert.match(osprera.notas, /Documento oficial recibido, nov 2026/);
  });

  test('los requisitos mensuales no cambiaron', () => {
    sinTocar(cat(osprera, 'mensual'), cat(V('osprera'), 'mensual'));
  });
});

/* ── Datos: Subsidio IPSST (nuevo) ───────────────────────────────────────── */

describe('Subsidio IPSST', () => {
  const ipsst = N('subsidio-ipsst');

  test('existe, con su id y alias', () => {
    assert.ok(ipsst, 'tiene que estar en el borrador');
    assert.strictEqual(ipsst.nombre, 'Subsidio IPSST');
    assert.deepStrictEqual(ipsst.alias, ['SUBSIDIO', 'IPSST']);
  });

  test('se presenta por nota, sin día fijo', () => {
    assert.match(ipsst.presentacion.notas, /^Se presenta por nota dirigida al IPSST adjuntando la documentación\./);
    assert.match(ipsst.presentacion.notas, /Sin día de presentación fijo/);
  });

  test('paciente: 7 obligatorios; prestador: 6 obligatorios; sin requisitos mensuales', () => {
    assert.strictEqual(cat(ipsst, 'paciente').length, 7);
    assert.strictEqual(cat(ipsst, 'prestador').length, 6);
    assert.strictEqual(cat(ipsst, 'mensual').length, 0);
    assert.ok(ipsst.requisitos.every(r => r.obligatorio && r.condicion === ''));
  });

  test('vencimiento por fecha en los documentos que lo indican; el resto "no" con la nota de vigencia', () => {
    const conFecha = ipsst.requisitos.filter(r => r.vencimiento === 'fecha_doc').map(r => r.key).sort();
    assert.deepStrictEqual(conFecha, ['cud', 'p_habilitacion', 'p_licencia', 'p_seguro', 'p_vtv']);
    for (const r of ipsst.requisitos.filter(r => r.vencimiento === 'no')) assert.ok(r.notas.includes(SIN_VIGENCIA), r.nombre);
  });

  test('marca la fuente', () => {
    assert.match(ipsst.notas, /Documento oficial recibido, nov 2026/);
    assert.match(ipsst.notas, /Instituto de Previsión y Seguridad Social de Tucumán/);
  });

  test('el id coincide con lo que generaría la app al crearla a mano (slug del nombre)', () => {
    const { ruta } = cargarRuta();
    const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    assert.strictEqual(slug(ipsst.nombre), ipsst.id);
    assert.ok(ruta);
  });
});

/* ── PAMI no se toca; formato intacto ────────────────────────────────────── */

describe('lo que no debía cambiar, y el formato', () => {
  test('PAMI es idéntico al de antes, completo', () => {
    sinTocar(N('pami'), V('pami'));
  });

  test('todas las obras sociales pasan por el validador real sin que cambie nada', () => {
    const { ruta } = cargarRuta();
    for (const os of NUEVO) {
      sinTocar(ruta.limpiarRequisitos(os.requisitos), os.requisitos);
    }
  });

  test('las key son únicas dentro de cada obra social y los campos son exactamente los de siempre', () => {
    const CAMPOS = ['categoria', 'condicion', 'key', 'nombre', 'notas', 'obligatorio', 'vencimiento', 'vigenciaMeses'];
    for (const os of NUEVO) {
      const keys = os.requisitos.map(r => r.key);
      assert.strictEqual(new Set(keys).size, keys.length, `key repetida en ${os.id}`);
      for (const r of os.requisitos) assert.deepStrictEqual(Object.keys(r).sort(), CAMPOS, `${os.id}/${r.key}`);
    }
  });

  test('vigenciaMeses solo tiene valor cuando el vencimiento es "meses"', () => {
    for (const os of NUEVO) {
      for (const r of os.requisitos) {
        if (r.vencimiento === 'meses') assert.ok(r.vigenciaMeses >= 1, `${os.id}/${r.key}`);
        else assert.strictEqual(r.vigenciaMeses, 0, `${os.id}/${r.key}`);
      }
    }
  });

  test('un requisito opcional siempre dice cuándo corresponde (condicion)', () => {
    for (const os of NUEVO.filter(o => o.id !== 'pami')) {
      for (const r of os.requisitos.filter(r => !r.obligatorio)) assert.ok(r.condicion, `${os.id}/${r.key}`);
    }
  });
});

/* ── La carpeta del paciente los lee bien ────────────────────────────────── */

describe('carpeta del paciente (services/legajos.js)', () => {
  test('Incluir Salud, sin documentos: faltan los 9 obligatorios y el opcional no cuenta', () => {
    const { legajos, ruta } = cargarRuta();
    const obra = { ...ruta.limpiarOS(N('incluir-salud')), id: 'incluir-salud' };
    const items = legajos.checklist(obra, []);
    assert.strictEqual(items.length, 10, 'la carpeta solo muestra los de paciente');
    assert.strictEqual(items.filter(i => i.estado === 'FALTA').length, 9);
    assert.strictEqual(items.filter(i => i.estado === 'OPCIONAL').length, 1);
    const r = legajos.resumenChecklist(items);
    assert.strictEqual(r.total, 9);
    assert.strictEqual(r.FALTA, 9);
    assert.strictEqual(r.completo, false);
  });

  test('con los 9 obligatorios cargados la carpeta queda completa, sin el opcional', () => {
    const { legajos, ruta } = cargarRuta();
    const obra = { ...ruta.limpiarOS(N('incluir-salud')), id: 'incluir-salud' };
    const docs = cat(N('incluir-salud'), 'paciente').filter(r => r.obligatorio)
      .map(r => ({ requisitoKey: r.key, fechaVenc: r.vencimiento === 'fecha_doc' ? '31/12/2099' : '', creadoEn: '2026-11-01' }));
    const r = legajos.resumenChecklist(legajos.checklist(obra, docs));
    assert.strictEqual(r.completo, true);
    assert.strictEqual(r.OK, 9);
  });

  test('los documentos ya subidos con las key de antes siguen enlazados al requisito equivalente', () => {
    const { legajos, ruta } = cargarRuta();
    // Key que tenía el borrador anterior y que el requisito nuevo conserva.
    const conservadas = ['nota_solicitud', 'dni', 'cud', 'boleta_haberes', 'pedido_medico', 'informe_social', 'presupuesto', 'fim', 'consolidado_egov'];
    const viejas = new Set(cat(V('incluir-salud'), 'paciente').map(r => r.key));
    for (const k of conservadas) assert.ok(viejas.has(k), `${k} existía en el borrador anterior`);

    const obra = { ...ruta.limpiarOS(N('incluir-salud')), id: 'incluir-salud' };
    const docs = conservadas.map(k => ({ requisitoKey: k, fechaVenc: '31/12/2099', creadoEn: '2026-06-01' }));
    const items = legajos.checklist(obra, docs);
    for (const k of conservadas) {
      const it = items.find(i => i.requisito.key === k);
      assert.ok(it && it.documento, `el documento subido como "${k}" quedó huérfano`);
    }
  });

  test('OSPRERA e IPSST también arman su checklist (solo categoría paciente)', () => {
    const { legajos, ruta } = cargarRuta();
    const osprera = { ...ruta.limpiarOS(N('osprera')), id: 'osprera' };
    const ipsst = { ...ruta.limpiarOS(N('subsidio-ipsst')), id: 'subsidio-ipsst' };
    const r1 = legajos.resumenChecklist(legajos.checklist(osprera, []));
    const r2 = legajos.resumenChecklist(legajos.checklist(ipsst, []));
    assert.strictEqual(r1.total, 10, 'OSPRERA: 10 obligatorios, los 2 condicionales no cuentan');
    assert.strictEqual(r2.total, 7);
  });
});

/* ── La semilla, contra los endpoints reales ─────────────────────────────── */

describe('semilla (POST /semilla)', () => {
  test('una empresa sin requisitos queda con las 4 obras sociales y los datos nuevos', async () => {
    const { ruta, db } = cargarRuta();
    const srv = await levantar(ruta);
    try {
      const r = await srv.llamar('POST', '/semilla');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual({ creadas: r.json.creadas, actualizadas: r.json.actualizadas }, { creadas: 4, actualizadas: 0 });
      for (const os of NUEVO) {
        const d = doc(db, os.id);
        assert.ok(d, `falta ${os.id}`);
        assert.strictEqual(d.borrador, true);
        sinTocar(d.requisitos, ruta.limpiarOS(os).requisitos);
        assert.strictEqual(d.notas, os.notas);
      }
      assert.ok(doc(db, 'subsidio-ipsst'), 'la obra social nueva se carga');
      assert.strictEqual(cat(doc(db, 'incluir-salud'), 'paciente').length, 10);
    } finally { await srv.cerrar(); }
  });

  test('apretarla de nuevo no cambia nada', async () => {
    const { ruta, db } = cargarRuta();
    const srv = await levantar(ruta);
    try {
      await srv.llamar('POST', '/semilla');
      const antes = JSON.stringify([...db.docs.entries()]);
      const r = await srv.llamar('POST', '/semilla');
      assert.deepStrictEqual({ creadas: r.json.creadas, actualizadas: r.json.actualizadas }, { creadas: 0, actualizadas: 0 });
      assert.strictEqual(r.json.mensaje, 'Ya estaban cargadas.');
      assert.strictEqual(JSON.stringify([...db.docs.entries()]), antes);
    } finally { await srv.cerrar(); }
  });

  test('empresa con el borrador viejo sin editar: carga Subsidio IPSST, actualiza Incluir y OSPRERA, y no toca PAMI', async () => {
    const { ruta, db } = cargarRuta();
    sembrarViejo(db, ruta);
    const pamiAntes = JSON.stringify(doc(db, 'pami'));
    const srv = await levantar(ruta);
    try {
      const r = await srv.llamar('POST', '/semilla');
      assert.deepStrictEqual({ creadas: r.json.creadas, actualizadas: r.json.actualizadas }, { creadas: 1, actualizadas: 2 });
      assert.ok(doc(db, 'subsidio-ipsst'));
      assert.strictEqual(cat(doc(db, 'incluir-salud'), 'paciente').length, 10);
      assert.strictEqual(cat(doc(db, 'osprera'), 'paciente').filter(x => x.obligatorio).length, 10);
      assert.strictEqual(JSON.stringify(doc(db, 'pami')), pamiAntes, 'PAMI quedó byte a byte igual');
    } finally { await srv.cerrar(); }
  });

  test('al actualizar se conserva la fecha de creación y no queda ningún campo de la versión anterior', async () => {
    const { ruta, db } = cargarRuta();
    sembrarViejo(db, ruta, ['incluir-salud']);
    db.docs.set(`${RUTA_COL}/incluir-salud`, { ...doc(db, 'incluir-salud'), campoViejo: 'sobra' });
    const srv = await levantar(ruta);
    try {
      await srv.llamar('POST', '/semilla');
      const d = doc(db, 'incluir-salud');
      assert.strictEqual(d.creadoEn, '2026-06-01T00:00:00.000Z');
      assert.strictEqual(d.campoViejo, undefined);
      assert.strictEqual(d.actualizadoEn, undefined, 'sigue figurando como sin editar por una persona');
    } finally { await srv.cerrar(); }
  });

  test('NUNCA pisa lo que alguien revisó: borrador marcado como revisado', async () => {
    const { ruta, db } = cargarRuta();
    sembrarViejo(db, ruta);
    db.docs.set(`${RUTA_COL}/osprera`, { ...doc(db, 'osprera'), borrador: false });
    const antes = JSON.stringify(doc(db, 'osprera'));
    const srv = await levantar(ruta);
    try {
      const r = await srv.llamar('POST', '/semilla');
      assert.strictEqual(r.json.actualizadas, 1, 'solo Incluir Salud');
      assert.strictEqual(JSON.stringify(doc(db, 'osprera')), antes);
    } finally { await srv.cerrar(); }
  });

  test('NUNCA pisa lo que alguien editó desde la app (el PUT real lo protege)', async () => {
    const { ruta, db } = cargarRuta();
    sembrarViejo(db, ruta);
    const srv = await levantar(ruta);
    try {
      // La persona abre Incluir Salud, cambia una nota y guarda, con el borrador todavía marcado.
      const editada = { ...doc(db, 'incluir-salud'), notas: 'Nota propia de la empresa', borrador: true };
      const put = await srv.llamar('PUT', '/incluir-salud', editada);
      assert.strictEqual(put.status, 200);
      assert.ok(doc(db, 'incluir-salud').actualizadoEn, 'el PUT deja registro de la edición');

      const r = await srv.llamar('POST', '/semilla');
      assert.strictEqual(r.json.actualizadas, 1, 'solo OSPRERA');
      assert.strictEqual(doc(db, 'incluir-salud').notas, 'Nota propia de la empresa');
      assert.strictEqual(cat(doc(db, 'incluir-salud'), 'paciente').length, cat(V('incluir-salud'), 'paciente').length,
        'sus requisitos siguen siendo los suyos');
    } finally { await srv.cerrar(); }
  });

  test('las obras sociales que la empresa creó a mano nunca se tocan', async () => {
    const { ruta, db } = cargarRuta();
    db.docs.set(`${RUTA_COL}/mi-obra`, { id: 'mi-obra', nombre: 'Mi obra', alias: [], presentacion: { dia: 5, canal: '', notas: '' }, requisitos: [], notas: '', creadoEn: 'x' });
    const antes = JSON.stringify(doc(db, 'mi-obra'));
    const srv = await levantar(ruta);
    try {
      await srv.llamar('POST', '/semilla');
      assert.strictEqual(JSON.stringify(doc(db, 'mi-obra')), antes);
    } finally { await srv.cerrar(); }
  });
});

describe('GET / informa qué hay para cargar (para que la pantalla ofrezca el botón)', () => {
  test('empresa vacía: las 4 son nuevas', async () => {
    const { ruta } = cargarRuta();
    const srv = await levantar(ruta);
    try {
      const r = await srv.llamar('GET');
      assert.deepStrictEqual(r.json.semilla.nuevas.map(o => o.id), NUEVO.map(o => o.id));
      assert.deepStrictEqual(r.json.semilla.actualizables, []);
      assert.strictEqual(r.json.semilla.nuevas.find(o => o.id === 'subsidio-ipsst').nombre, 'Subsidio IPSST');
    } finally { await srv.cerrar(); }
  });

  test('empresa con el borrador viejo: Subsidio IPSST es nueva y Incluir y OSPRERA son actualizables', async () => {
    const { ruta, db } = cargarRuta();
    sembrarViejo(db, ruta);
    const srv = await levantar(ruta);
    try {
      const r = await srv.llamar('GET');
      assert.deepStrictEqual(r.json.semilla.nuevas.map(o => o.id), ['subsidio-ipsst']);
      assert.deepStrictEqual(r.json.semilla.actualizables.map(o => o.id), ['incluir-salud', 'osprera']);
    } finally { await srv.cerrar(); }
  });

  test('empresa al día: no hay nada para cargar, y el botón desaparece', async () => {
    const { ruta } = cargarRuta();
    const srv = await levantar(ruta);
    try {
      await srv.llamar('POST', '/semilla');
      const r = await srv.llamar('GET');
      assert.deepStrictEqual(r.json.semilla, { nuevas: [], actualizables: [] });
      assert.strictEqual(r.json.obras.length, 4);
    } finally { await srv.cerrar(); }
  });

  test('Firestore guarda los mapas con otro orden de claves y eso no cuenta como "distinto"', async () => {
    const { ruta, db } = cargarRuta();
    await (async () => {
      const srv = await levantar(ruta);
      try { await srv.llamar('POST', '/semilla'); } finally { await srv.cerrar(); }
    })();
    // Se reescribe cada documento con las claves en orden alfabético inverso, como podría devolverlas Firestore.
    for (const os of NUEVO) {
      const d = doc(db, os.id);
      const invertido = Object.fromEntries(Object.keys(d).sort().reverse().map(k => [k, d[k]]));
      invertido.presentacion = Object.fromEntries(Object.keys(d.presentacion).sort().reverse().map(k => [k, d.presentacion[k]]));
      db.docs.set(`${RUTA_COL}/${os.id}`, invertido);
    }
    const srv = await levantar(ruta);
    try {
      const r = await srv.llamar('GET');
      assert.deepStrictEqual(r.json.semilla, { nuevas: [], actualizables: [] });
    } finally { await srv.cerrar(); }
  });
});
