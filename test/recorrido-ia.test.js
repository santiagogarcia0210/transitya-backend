/**
 * Lectura de la impresión de Google Maps (services/recorridoIA.js): km con coma decimal, millas, rango plausible,
 * rutas alternativas (si no se sabe cuál es la elegida NO se elige), ida y vuelta sugerida, y comparación tolerante de
 * direcciones. Cliente de IA inyectado; direcciones inventadas.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const R = require('../services/recorridoIA');

const ruta = (km, extra = {}) => ({ km: { valor: km, unidad: 'km', confianza: 'alta' }, tiempo: { valor: '20 min', confianza: 'media' }, ...extra });
const resp = (extra = {}) => JSON.stringify({
  legible: true, origen: { valor: 'Calle Uno 100, Ciudad', confianza: 'alta' }, destino: { valor: 'Calle Dos 200, Ciudad', confianza: 'alta' },
  rutas: [ruta(12.4, { seleccionada: true })], sentidos: 'una_ruta', ...extra,
});

describe('normalizarKm', () => {
  test('coma decimal, punto decimal y miles', () => {
    assert.deepStrictEqual(R.normalizarKm('12,4 km'), { km: 12.4, original: 12.4 });
    assert.strictEqual(R.normalizarKm('12.4').km, 12.4);
    assert.strictEqual(R.normalizarKm('1.234,5 km').km, 1234.5);
    assert.strictEqual(R.normalizarKm(8).km, 8);
    assert.strictEqual(R.normalizarKm('2,3 km.').km, 2.3);
  });
  test('millas se convierten (y se marca); metros también', () => {
    const mi = R.normalizarKm('7,5 mi');
    assert.strictEqual(mi.convertido, 'mi');
    assert.strictEqual(mi.km, 12.07);
    assert.strictEqual(R.normalizarKm(5, 'millas').km, 8.05);
    assert.strictEqual(R.normalizarKm('850 m').km, 0.85);
    assert.strictEqual(R.normalizarKm('1.250 m').km, 1.25);
  });
  test('lo que no es un número da null', () => {
    for (const x of ['abc', '', null, undefined, -3, '--']) assert.strictEqual(R.normalizarKm(x), null);
  });
});

describe('parsearRecorrido', () => {
  test('una ruta: queda elegida; ida y vuelta por defecto si no se sabe', () => {
    const p = R.parsearRecorrido(resp({ sentidos: 'desconocido' }));
    assert.strictEqual(p.rutaElegida, 0);
    assert.strictEqual(p.requiereElegir, false);
    assert.strictEqual(p.modalidadSugerida, 'ida_vuelta_total');
    assert.strictEqual(p.rutas[0].km, 12.4);
  });
  test('sugiere la modalidad según la impresión', () => {
    assert.strictEqual(R.parsearRecorrido(resp({ sentidos: 'una_ruta' })).modalidadSugerida, 'solo_ida');
    assert.strictEqual(R.parsearRecorrido(resp({ sentidos: 'ida_y_vuelta' })).modalidadSugerida, 'ida_vuelta_total');
    assert.strictEqual(R.parsearRecorrido(resp({ sentidos: 'dos_rutas' })).modalidadSugerida, 'dos_recorridos');
  });
  test('varias rutas con una seleccionada: la toma', () => {
    const p = R.parsearRecorrido(resp({ rutas: [ruta(10, { seleccionada: false }), ruta(11.5, { seleccionada: true }), ruta(14, { seleccionada: false })] }));
    assert.strictEqual(p.rutaElegida, 1);
    assert.strictEqual(p.requiereElegir, false);
  });
  test('varias rutas SIN seleccionada: NO elige y pide que la marquen', () => {
    for (const rutas of [[ruta(10), ruta(11.5)], [ruta(10, { seleccionada: null }), ruta(11, { seleccionada: null })], [ruta(10, { seleccionada: true }), ruta(11, { seleccionada: true })]]) {
      const p = R.parsearRecorrido(resp({ rutas }));
      assert.strictEqual(p.rutaElegida, null);
      assert.strictEqual(p.requiereElegir, true);
      assert.strictEqual(p.rutas.length, 2);
      assert.ok(p.advertencias.some(a => /marcala/.test(a)));
    }
  });
  test('km con coma, en millas y fuera de rango', () => {
    assert.strictEqual(R.parsearRecorrido(resp({ rutas: [ruta('12,4 km', { seleccionada: true })] })).rutas[0].km, 12.4);
    const mi = R.parsearRecorrido(resp({ rutas: [{ km: { valor: 7.5, unidad: 'mi', confianza: 'alta' }, seleccionada: true }] }));
    assert.strictEqual(mi.rutas[0].km, 12.07);
    assert.ok(mi.advertencias.some(a => /millas/.test(a)));
    const lejos = R.parsearRecorrido(resp({ rutas: [ruta(450, { seleccionada: true }), ruta(0.2)] }));
    assert.strictEqual(lejos.rutas.length, 0);
    assert.strictEqual(lejos.advertencias.filter(a => /rango/.test(a)).length, 2);
  });
  test('ilegible, sin rutas, con fences o roto', () => {
    const il = R.parsearRecorrido('{"legible": false}');
    assert.strictEqual(il.legible, false);
    assert.strictEqual(il.confianzaGeneral, 'baja');
    assert.ok(R.parsearRecorrido(resp({ rutas: [] })).advertencias.some(a => /a mano/.test(a)));
    assert.strictEqual(R.parsearRecorrido('Va:\n```json\n' + resp() + '\n```').rutaElegida, 0);
    assert.throws(() => R.parsearRecorrido('{"legible": tru'));
    assert.throws(() => R.parsearRecorrido('sin json'));
  });
  test('la confianza general es la menor de las leídas', () => {
    const p = R.parsearRecorrido(resp({ origen: { valor: 'Calle Uno 100', confianza: 'baja' } }));
    assert.strictEqual(p.confianzaGeneral, 'baja');
  });
});

describe('direcciones: comparación tolerante', () => {
  const casos = [
    ['Av. Mate de Luna 1250, San Miguel de Tucumán, Tucumán', 'MATE DE LUNA 1250', true],
    ['B° Virgen del Huerto Mz F lote 1, Tucumán', 'Barrio Virgen del Huerto Mz F Lote 1', true],
    ['Pje. Luis Alvarez 1350', 'Pasaje Jorge Luis Alvarez 1350, San Miguel de Tucumán', true],
    ['Gral. Paz 124, S.M. de Tucumán', 'General Paz 124', true],
    ['Avda. Aconquija 1387', 'avenida aconquija 1387', true],
    ['Av. Aconquija 1387', 'Av. Aconquija 1500', false],
    ['Catamarca 112, San Miguel de Tucumán', 'Moreno 727', false],
    ['Calle Inventada 10', '', null],
  ];
  for (const [a, b, esperado] of casos) test(`"${a}" ~ "${b}" → ${esperado}`, () => assert.strictEqual(R.mismaDireccion(a, b), esperado));
});

describe('verificarRecorrido (paciente y centro)', () => {
  const paciente = 'Calle Uno 100, Ciudad', centro = 'Calle Dos 200';
  test('coinciden (en cualquier sentido)', () => {
    for (const [o, d] of [['Calle Uno 100, Ciudad', 'Calle Dos 200, Ciudad'], ['Calle Dos 200', 'Calle Uno 100']]) {
      const v = R.verificarRecorrido({ origen: o, destino: d }, { domicilioPaciente: paciente, centro });
      assert.deepStrictEqual([v.pacienteOk, v.centroOk, v.coincide, v.advertencias.length], [true, true, true, 0]);
    }
  });
  test('no coincide con el paciente o con el centro: advierte', () => {
    const a = R.verificarRecorrido({ origen: 'Otra Calle 999', destino: 'Calle Dos 200' }, { domicilioPaciente: paciente, centro });
    assert.strictEqual(a.pacienteOk, false);
    assert.strictEqual(a.coincide, false);
    assert.match(a.advertencias[0], /no parece corresponder a este paciente/);
    const b = R.verificarRecorrido({ origen: 'Calle Uno 100', destino: 'Otra Calle 999' }, { domicilioPaciente: paciente, centro });
    assert.match(b.advertencias[0], /no parece corresponder a este centro/);
  });
  test('sin domicilio o centro cargado no bloquea: solo no puede comprobar', () => {
    const v = R.verificarRecorrido({ origen: 'Calle Uno 100', destino: 'Calle Dos 200' }, { domicilioPaciente: '', centro: '' });
    assert.deepStrictEqual([v.pacienteOk, v.centroOk, v.coincide], [null, null, null]);
    assert.strictEqual(R.verificarRecorrido({ origen: 'Calle Uno 100', destino: 'X' }, { domicilioPaciente: paciente, centro: '' }).coincide, true);
  });
});

describe('leerRecorrido', () => {
  const archivo = { base64: Buffer.from('x').toString('base64'), mime: 'image/png' };
  test('usa el cliente inyectado y devuelve propuesta, tokens y modelo', async () => {
    const r = await R.leerRecorrido({ archivo, llamar: async a => { assert.ok(/Google Maps/.test(a.prompt)); return { texto: resp(), uso: { entrada: 1000, salida: 200 }, modelo: 'm', parada: 'end_turn' }; } });
    assert.strictEqual(r.propuesta.rutas[0].km, 12.4);
    assert.deepStrictEqual(r.uso, { entrada: 1000, salida: 200 });
  });
  test('el prompt no lleva datos de nadie', () => {
    assert.ok(!/DNI|paciente|domicilio del/i.test(R.construirPrompt().replace('Calle', '')));
  });
  test('respuesta cortada, rechazo o JSON roto: errores con código y sin citar el contenido', async () => {
    const con = parada => R.leerRecorrido({ archivo, llamar: async () => ({ texto: '{"origen": "Calle Secreta 1', uso: {}, parada }) });
    await assert.rejects(con('max_tokens'), e => e.codigo === 'incompleta');
    await assert.rejects(con('refusal'), e => e.codigo === 'rechazo');
    await assert.rejects(con('end_turn'), e => e.codigo === 'sin_json' && !JSON.stringify(e).includes('Secreta') && !String(e.message).includes('Secreta'));
  });
});
