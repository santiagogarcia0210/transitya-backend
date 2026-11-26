/**
 * utils/fechas.js: normalizarFecha, fechaSort, fechaToDate y el orden con formatos mezclados.
 *
 * El bug que cubre: las rutas guardaban la fecha en ISO (yyyy-MM-dd, lo que manda el
 * <input type="date">) y fechaSort() solo entendía dd/MM/yyyy, así que esos documentos valían 0
 * y caían al final de la lista, y quedaban fuera de los filtros por fecha.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const F = require('../utils/fechas');
const { normalizarFecha: n, fechaSort, fechaToDate, fechaDoc, timestampMs, ordenarPorFechaDesc } = F;

const RAIZ = path.join(__dirname, '..');

describe('normalizarFecha: formatos de texto', () => {
  const casos = [
    ['05/11/2026', '05/11/2026', 'dd/MM/yyyy'],
    ['5/1/2026', '05/01/2026', 'd/M/yyyy'],
    ['05/11/26', '05/11/2026', 'dd/MM/yy: el año de 2 dígitos es 20yy'],
    ['01/01/99', '01/01/2099', 'dd/MM/yy siempre 20yy, nunca 19yy'],
    ['2026-11-05', '05/11/2026', 'ISO (lo que manda el input date)'],
    ['2026-1-5', '05/01/2026', 'ISO sin ceros'],
    ['2026/11/05', '05/11/2026', 'yyyy/MM/dd'],
    ['05-11-2026', '05/11/2026', 'dd-MM-yyyy'],
    ['05.11.2026', '05/11/2026', 'dd.MM.yyyy'],
    ['  05/11/2026  ', '05/11/2026', 'con espacios alrededor'],
    ['05/11/2026 14:30', '05/11/2026', 'dd/MM/yyyy con hora'],
    ['2026-11-05 14:30', '05/11/2026', 'ISO con hora, sin zona'],
    ['29/02/2028', '29/02/2028', 'año bisiesto'],
  ];
  for (const [entrada, esperado, nombre] of casos) {
    test(`${nombre}: "${entrada}" → "${esperado}"`, () => assert.strictEqual(n(entrada), esperado));
  }
});

describe('normalizarFecha: instantes (ISO con hora, Date, Timestamp)', () => {
  test('un ISO con hora y "Z" se pasa a hora de Argentina (UTC-3) antes de sacar el día', () => {
    assert.strictEqual(n('2026-11-05T14:30:00.000Z'), '05/11/2026');
    // 01:30 UTC del 6 = 22:30 del 5 en Argentina: es el día 5, no el 6.
    assert.strictEqual(n('2026-11-06T01:30:00.000Z'), '05/11/2026');
    assert.strictEqual(n('2026-11-06T02:59:59.000Z'), '05/11/2026');
    assert.strictEqual(n('2026-11-06T03:00:00.000Z'), '06/11/2026', 'a las 00:00 en Argentina empieza el día 6');
  });

  test('un ISO con offset explícito también se convierte', () => {
    assert.strictEqual(n('2026-11-05T23:30:00-03:00'), '05/11/2026');
    assert.strictEqual(n('2026-11-06T02:30:00+00:00'), '05/11/2026');
    assert.strictEqual(n('2026-11-05T22:00:00-05:00'), '06/11/2026', '22:00 en UTC-5 son las 00:00 del 6 en Argentina');
  });

  test('un ISO con hora y SIN zona es hora de pared: se toma el día tal cual', () => {
    assert.strictEqual(n('2026-11-05T22:00:00'), '05/11/2026');
    assert.strictEqual(n('2026-11-05T23:59:59'), '05/11/2026');
  });

  test('un Date es un instante: se toma el día en Argentina, no el del servidor', () => {
    assert.strictEqual(n(new Date('2026-11-06T01:30:00Z')), '05/11/2026');
    assert.strictEqual(n(new Date('2026-11-06T03:00:00Z')), '06/11/2026');
  });

  test('Timestamp de Firestore: instancia con toDate(), y el objeto { seconds, nanoseconds }', () => {
    const instante = new Date('2026-11-06T01:30:00Z');
    assert.strictEqual(n({ toDate: () => instante }), '05/11/2026');
    const seconds = Math.floor(instante.getTime() / 1000);
    assert.strictEqual(n({ seconds, nanoseconds: 0 }), '05/11/2026');
    assert.strictEqual(n({ _seconds: seconds, _nanoseconds: 500000000 }), '05/11/2026');
  });

  test('un Timestamp cuyo toDate() falla da vacío, no lanza', () => {
    assert.strictEqual(n({ toDate: () => { throw new Error('roto'); } }), '');
  });
});

describe('normalizarFecha: lo que no se puede interpretar da ""', () => {
  const invalidos = [
    ['', 'vacío'], [null, 'null'], [undefined, 'undefined'], ['   ', 'solo espacios'],
    ['basura', 'texto cualquiera'], ['sin fecha', 'texto con espacio'],
    ['31/02/2026', 'día imposible: febrero no tiene 31'], ['29/02/2025', '29 de febrero en año no bisiesto'],
    ['31/04/2026', 'abril tiene 30'], ['00/11/2026', 'día 0'], ['05/00/2026', 'mes 0'], ['05/13/2026', 'mes 13'],
    ['2026-13-01', 'ISO con mes 13'], ['2026-02-30', 'ISO con día imposible'],
    ['05/11/0206', 'año 206 (OCR defectuoso)'], ['05/11/3026', 'año fuera de rango'], ['05/11/226', 'año de 3 dígitos'],
    [20261105, 'un número'], [true, 'un booleano'], [{}, 'objeto vacío'], [[], 'arreglo'], [new Date('x'), 'Date inválida'],
    ['2026-11-05T25:00:00Z', 'hora imposible con zona'],
  ];
  for (const [entrada, nombre] of invalidos) {
    test(`${nombre} → ""`, () => assert.strictEqual(n(entrada), ''));
  }

  test('es idempotente: normalizar lo ya normalizado no cambia nada', () => {
    for (const x of ['05/11/2026', '2026-11-05', '5/1/26', new Date('2026-11-06T01:30:00Z')]) {
      assert.strictEqual(n(n(x)), n(x));
    }
  });
});

describe('fechaSort', () => {
  test('da YYYYMMDD sin importar el formato de entrada', () => {
    for (const x of ['05/11/2026', '2026-11-05', '5/11/26', '2026-11-05T14:30:00Z']) assert.strictEqual(fechaSort(x), 20261105, x);
  });

  test('0 para lo inválido', () => {
    for (const x of ['', null, undefined, 'basura', '31/02/2026']) assert.strictEqual(fechaSort(x), 0);
  });

  test('REGRESIÓN: una fecha ISO ya no vale 0 y se ordena igual que su equivalente dd/MM/yyyy', () => {
    // Antes: fechaSort('2026-11-05') === 0 → el documento caía al final de la lista.
    assert.ok(fechaSort('2026-11-05') > 0);
    assert.ok(fechaSort('2026-11-10') > fechaSort('09/11/2026'));
    assert.ok(fechaSort('2026-11-05') > fechaSort('31/10/2026'));
  });

  test('ordena bien entre meses y años distintos', () => {
    assert.ok(fechaSort('01/01/2027') > fechaSort('31/12/2026'));
    assert.ok(fechaSort('01/02/2026') > fechaSort('31/01/2026'));
  });
});

describe('fechaToDate', () => {
  test('medianoche local, igual para ISO y dd/MM/yyyy (para comparar rangos)', () => {
    const a = fechaToDate('2026-11-05'), b = fechaToDate('05/11/2026');
    assert.strictEqual(a.getTime(), b.getTime());
    assert.deepStrictEqual([a.getFullYear(), a.getMonth(), a.getDate(), a.getHours()], [2026, 10, 5, 0]);
  });

  test('null si no se puede interpretar (nunca una Date inválida)', () => {
    for (const x of ['', null, 'basura', '31/02/2026']) assert.strictEqual(fechaToDate(x), null);
  });

  test('un rango desde/hasta en ISO incluye los dos extremos', () => {
    const desde = fechaToDate('2026-11-01'), hasta = fechaToDate('2026-11-30');
    const dentro = d => { const x = fechaToDate(d); return x >= desde && x <= hasta; };
    assert.ok(dentro('01/11/2026') && dentro('30/11/2026') && dentro('2026-11-15'));
    assert.ok(!dentro('31/10/2026') && !dentro('01/12/2026'));
  });
});

describe('fechaDoc y timestampMs', () => {
  test('fechaDoc usa fecha, y FECHA (documentos viejos de Sheets) si fecha no sirve', () => {
    assert.strictEqual(fechaDoc({ fecha: '2026-11-05' }), '05/11/2026');
    assert.strictEqual(fechaDoc({ FECHA: '05/11/2026' }), '05/11/2026');
    assert.strictEqual(fechaDoc({ fecha: 'basura', FECHA: '05/11/2026' }), '05/11/2026');
    assert.strictEqual(fechaDoc({ fecha: 'basura' }), '');
    assert.strictEqual(fechaDoc({}), '');
    assert.strictEqual(fechaDoc(null), '');
  });

  test('timestampMs entiende Date, Timestamp, { seconds }, ISO, número, y da 0 si falta', () => {
    const ms = Date.parse('2026-11-05T12:00:00Z');
    assert.strictEqual(timestampMs(new Date(ms)), ms);
    assert.strictEqual(timestampMs({ toMillis: () => ms }), ms);
    assert.strictEqual(timestampMs({ toDate: () => new Date(ms) }), ms);
    assert.strictEqual(timestampMs({ seconds: ms / 1000, nanoseconds: 0 }), ms);
    assert.strictEqual(timestampMs({ _seconds: ms / 1000 }), ms);
    assert.strictEqual(timestampMs('2026-11-05T12:00:00Z'), ms);
    assert.strictEqual(timestampMs(ms), ms);
    for (const x of [undefined, null, '', 'basura', {}, new Date('x'), NaN]) assert.strictEqual(timestampMs(x), 0);
  });
});

describe('ordenarPorFechaDesc con formatos mezclados', () => {
  const ids = lista => lista.map(d => d.id);

  test('REGRESIÓN: los documentos en ISO ya no caen al final', () => {
    const lista = [
      { id: 'dmy-vieja', fecha: '01/11/2026' },
      { id: 'iso-nueva', fecha: '2026-11-10' },          // antes valía 0 y quedaba última
      { id: 'dmy-media', fecha: '05/11/2026' },
      { id: 'iso-vieja', fecha: '2026-10-20' },
    ];
    assert.deepStrictEqual(ids(ordenarPorFechaDesc(lista)), ['iso-nueva', 'dmy-media', 'dmy-vieja', 'iso-vieja']);
  });

  test('mezcla todos los formatos en un solo orden', () => {
    const lista = [
      { id: 'a', fecha: '1/11/26' },
      { id: 'b', fecha: '2026-11-09T10:00:00Z' },
      { id: 'c', fecha: '08/11/2026' },
      { id: 'd', fecha: new Date('2026-11-11T12:00:00Z') },
      { id: 'e', fecha: { seconds: Date.parse('2026-11-07T12:00:00Z') / 1000, nanoseconds: 0 } },
      { id: 'f', fecha: '2026-11-10' },
    ];
    assert.deepStrictEqual(ids(ordenarPorFechaDesc(lista)), ['d', 'f', 'b', 'c', 'e', 'a']);
  });

  test('a igual fecha, desempata por creadoEn descendente (Date, Timestamp, ISO, { seconds })', () => {
    const t = s => Date.parse(`2026-11-05T${s}Z`);
    const lista = [
      { id: 'a-date',      fecha: '05/11/2026', creadoEn: new Date(t('10:00:00')) },
      { id: 'b-timestamp', fecha: '2026-11-05', creadoEn: { toMillis: () => t('12:00:00') } },
      { id: 'c-iso',       fecha: '5/11/26',    creadoEn: '2026-11-05T11:00:00Z' },
      { id: 'd-seconds',   fecha: '05/11/2026', creadoEn: { seconds: t('13:00:00') / 1000, nanoseconds: 0 } },
      { id: 'e-sin',       fecha: '05/11/2026' },          // sin creadoEn: al final de su día
    ];
    assert.deepStrictEqual(ids(ordenarPorFechaDesc(lista)), ['d-seconds', 'b-timestamp', 'c-iso', 'a-date', 'e-sin']);
  });

  test('la fecha manda sobre creadoEn: un doc más nuevo de un día anterior va después', () => {
    const lista = [
      { id: 'ayer-cargado-hoy', fecha: '04/11/2026', creadoEn: new Date('2026-11-06T10:00:00Z') },
      { id: 'hoy-cargado-ayer', fecha: '05/11/2026', creadoEn: new Date('2026-11-04T10:00:00Z') },
    ];
    assert.deepStrictEqual(ids(ordenarPorFechaDesc(lista)), ['hoy-cargado-ayer', 'ayer-cargado-hoy']);
  });

  test('los que no tienen fecha válida quedan al final, entre sí por creadoEn descendente', () => {
    const lista = [
      { id: 'basura-vieja', fecha: 'basura', creadoEn: new Date('2026-01-01') },
      { id: 'valida', fecha: '01/01/2020' },
      { id: 'sin-fecha-nueva', creadoEn: new Date('2026-06-01') },
      { id: 'imposible', fecha: '31/02/2026', creadoEn: new Date('2026-03-01') },
      { id: 'vacia', fecha: '' },
    ];
    const orden = ids(ordenarPorFechaDesc(lista));
    assert.strictEqual(orden[0], 'valida', 'una fecha válida, aunque sea vieja, va antes que cualquier inválida');
    assert.deepStrictEqual(orden.slice(1, 4), ['sin-fecha-nueva', 'imposible', 'basura-vieja']);
    assert.strictEqual(orden[4], 'vacia');
  });

  test('usa FECHA (mayúsculas) de los documentos viejos', () => {
    const lista = [{ id: 'nueva-mayus', FECHA: '10/11/2026' }, { id: 'vieja', fecha: '01/11/2026' }];
    assert.deepStrictEqual(ids(ordenarPorFechaDesc(lista)), ['nueva-mayus', 'vieja']);
  });

  test('ordena en el lugar y devuelve la misma lista; una lista vacía no falla', () => {
    const lista = [{ id: 'a', fecha: '01/01/2026' }, { id: 'b', fecha: '02/01/2026' }];
    assert.strictEqual(ordenarPorFechaDesc(lista), lista);
    assert.strictEqual(lista[0].id, 'b');
    assert.deepStrictEqual(ordenarPorFechaDesc([]), []);
  });

  test('es estable: documentos idénticos conservan su orden original', () => {
    const lista = ['x', 'y', 'z'].map(id => ({ id, fecha: '05/11/2026' }));
    assert.deepStrictEqual(ids(ordenarPorFechaDesc(lista)), ['x', 'y', 'z']);
  });
});

describe('cómo se exporta', () => {
  test('utils.js re-exporta los helpers (las mismas funciones)', () => {
    // utils.js carga Firebase: se prueba en un proceso aparte con credenciales falsas.
    const salida = execFileSync(process.execPath, ['-e', `
      const U = require('./utils'), F = require('./utils/fechas');
      const nombres = ['normalizarFecha','fechaSort','fechaToDate','fechaDoc','timestampMs','ordenarPorFechaDesc'];
      console.log(JSON.stringify({
        mismas: nombres.every(k => typeof U[k] === 'function' && U[k] === F[k]),
        siguenLasViejas: ['normalizarText_','parseMonto_','fechaHoyAR','col','randomUUID'].every(k => typeof U[k] !== 'undefined'),
      }));`], {
      cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, FIREBASE_SA: '{"project_id":"fake"}' },
    });
    const r = JSON.parse(salida.trim().split('\n').pop());
    assert.deepStrictEqual(r, { mismas: true, siguenLasViejas: true });
  });

  test("require('../utils') sigue resolviendo a utils.js aunque ahora exista el directorio utils/", () => {
    assert.ok(path.basename(require.resolve('../utils')) === 'utils.js', require.resolve('../utils'));
    assert.ok(require.resolve('../utils/fechas').endsWith(path.join('utils', 'fechas.js')));
  });
});

describe('helpers de calendario (hoyAR, sumarDias, diaSemana, esDiaHabil, variantesFecha)', () => {
  const { hoyAR, sumarDias, diaSemana, nombreDiaSemana, esDiaHabil, variantesFecha } = F;

  test('hoyAR usa la hora de Argentina, no la del servidor', () => {
    assert.strictEqual(hoyAR(new Date('2026-11-26T01:00:00Z')), '25/11/2026', '01:00 UTC = 22:00 del día anterior en Argentina');
    assert.strictEqual(hoyAR(new Date('2026-11-26T04:00:00Z')), '26/11/2026');
  });

  test('sumarDias cruza meses, años y bisiestos', () => {
    assert.strictEqual(sumarDias('31/01/2026', 1), '01/02/2026');
    assert.strictEqual(sumarDias('01/01/2027', -1), '31/12/2026');
    assert.strictEqual(sumarDias('28/02/2028', 1), '29/02/2028');
    assert.strictEqual(sumarDias('2026-11-25', -5), '20/11/2026', 'acepta ISO');
  });

  test('día de la semana y día hábil', () => {
    assert.strictEqual(nombreDiaSemana('25/11/2026'), 'miércoles');
    assert.strictEqual(diaSemana('29/11/2026'), 0, 'domingo = 0');
    assert.strictEqual(esDiaHabil('27/11/2026'), true, 'viernes');
    assert.strictEqual(esDiaHabil('28/11/2026'), false, 'sábado');
    assert.strictEqual(esDiaHabil('29/11/2026'), false, 'domingo');
  });

  test('variantesFecha: ISO, dd/MM/yyyy y d/M/yyyy, sin repetidos', () => {
    assert.deepStrictEqual(variantesFecha('05/01/2026'), ['2026-01-05', '05/01/2026', '5/1/2026']);
    assert.deepStrictEqual(variantesFecha('25/11/2026'), ['2026-11-25', '25/11/2026'], 'sin ceros no hay variante extra');
  });
});

describe('esMesFecha: el reemplazo de esMesDMY que sí entiende ISO', () => {
  const { esMesFecha } = F;

  test('acepta todos los formatos que entiende normalizarFecha', () => {
    for (const f of ['05/11/2026', '5/11/26', '2026-11-05', '2026-11-05T14:30:00', '05-11-2026', new Date('2026-11-05T15:00:00Z')]) {
      assert.strictEqual(esMesFecha(f, 11, 2026), true, String(f));
    }
  });

  test('REGRESIÓN: una fecha ISO cae en su mes (esMesDMY partía por "/" y la dejaba afuera)', () => {
    // Copia de utils.esMesDMY (no se importa utils.js para no cargar Firebase en las pruebas).
    const esMesDMY = (fecha, m, y) => {
      const p = String(fecha || '').split('/');
      if (p.length < 3) return false;
      return Number(p[1]) === m && Number(p[2].length === 2 ? '20' + p[2] : p[2]) === y;
    };
    assert.strictEqual(esMesDMY('2026-11-05', 11, 2026), false, 'el defecto original');
    assert.strictEqual(esMesFecha('2026-11-05', 11, 2026), true);
  });

  test('otro mes u otro año da false; mes y año pueden venir como texto', () => {
    assert.strictEqual(esMesFecha('2026-10-31', 11, 2026), false);
    assert.strictEqual(esMesFecha('05/11/2025', 11, 2026), false);
    assert.strictEqual(esMesFecha('05/11/2026', '11', '2026'), true);
  });

  test('un instante cerca de medianoche se cuenta en el mes de Argentina, no en el de UTC', () => {
    // 01:30 UTC del 1/12 todavía es 30/11 en Argentina (UTC-3)
    assert.strictEqual(esMesFecha('2026-12-01T01:30:00.000Z', 11, 2026), true);
    assert.strictEqual(esMesFecha('2026-12-01T01:30:00.000Z', 12, 2026), false);
  });

  test('una fecha que no se entiende o vacía da false', () => {
    for (const f of ['basura', '31/02/2026', '', null, undefined, {}]) assert.strictEqual(esMesFecha(f, 11, 2026), false, String(f));
  });
});

describe('mismoDia, fechaOHoy e isoToDMY', () => {
  const { mismoDia, fechaOHoy, isoToDMY } = F;

  test('mismoDia: el mismo día en cualquier formato; días distintos no; Date e instantes se pasan a hora de Argentina', () => {
    assert.strictEqual(mismoDia('2026-11-05', '05/11/2026'), true);
    assert.strictEqual(mismoDia('5/11/26', '2026-11-05'), true);
    assert.strictEqual(mismoDia('2026-11-05', '2026-11-06'), false);
    assert.strictEqual(mismoDia('2026-11-06T01:30:00.000Z', '05/11/2026'), true, '01:30 UTC del 6 todavía es el 5 en Argentina');
    assert.strictEqual(mismoDia(new Date('2026-11-05T15:00:00Z'), '05/11/2026'), true);
  });

  test('mismoDia: una fecha que no se entiende nunca iguala a un día; solo a ese mismo texto; y dos vacías no son iguales', () => {
    assert.strictEqual(mismoDia('basura', '05/11/2026'), false);
    assert.strictEqual(mismoDia('basura', 'basura'), true, 'mismo texto (como la igualdad exacta de antes)');
    assert.strictEqual(mismoDia('basura', 'otra cosa'), false);
    for (const [a, b] of [['', ''], [null, undefined], [undefined, ''], ['  ', '  ']]) assert.strictEqual(mismoDia(a, b), false, JSON.stringify([a, b]));
  });

  test('fechaOHoy: sin fecha es hoy; con fecha se normaliza; inválida da vacío', () => {
    for (const v of [undefined, null, '', '   ']) assert.strictEqual(fechaOHoy(v, '15/11/2026'), '15/11/2026', JSON.stringify(v));
    assert.strictEqual(fechaOHoy('2026-11-05', '15/11/2026'), '05/11/2026');
    assert.strictEqual(fechaOHoy('5/11/26', '15/11/2026'), '05/11/2026');
    for (const v of ['basura', '31/02/2026', '2026-13-45', 0, {}]) assert.strictEqual(fechaOHoy(v, '15/11/2026'), '', JSON.stringify(v));
  });

  test('fechaOHoy sin segundo argumento usa el día de hoy en Argentina', () => {
    assert.strictEqual(fechaOHoy(undefined), F.hoyAR());
  });

  test('isoToDMY: solo convierte yyyy-MM-dd; todo lo demás vuelve tal cual (no inventa fechas)', () => {
    assert.strictEqual(isoToDMY('2026-11-05'), '05/11/2026');
    assert.strictEqual(isoToDMY(' 2026-11-05 '), '05/11/2026');
    for (const v of ['05/11/2026', '2026-11-05T14:30:00', '05-11-2026', 'basura', '', undefined, null, 20261105]) {
      assert.strictEqual(isoToDMY(v), v, JSON.stringify(v));
    }
  });
});
