/**
 * Cálculo del presupuesto de transporte (services/presupuestoCalculo.js).
 * Datos inventados salvo los números del presupuesto de referencia (km, valor del km y montos), que se verifican al centavo.
 *
 * Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { calcularPresupuesto, valorKmFinal, r2 } = require('../services/presupuestoCalculo');

const L = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
const viajesReferencia = () => [
  { id: '1', origen: 'Domicilio A', destino: 'Centro B', km: 5.6, dias: L },
  { id: '2', origen: 'Centro B', destino: 'Domicilio A', tramos: [2.9, 5.7], dias: ['martes', 'viernes'] },
  { id: '2B', origen: 'Centro B', destino: 'Domicilio A', tramos: [8.7, 9], dias: ['lunes', 'miercoles', 'jueves'] },
  { id: '3', origen: 'Domicilio A', destino: 'Domicilio A', tramos: [8.8, 9], dias: L },
];

describe('presupuesto de referencia (4 viajes), al centavo', () => {
  const r = calcularPresupuesto({ viajes: viajesReferencia(), valorKmBase: 1215.01 });
  test('km por viaje (suma de tramos) e importe diario', () => {
    assert.deepStrictEqual(r.viajes.map(v => v.kmReales), [5.6, 8.6, 17.7, 17.8]);
    assert.deepStrictEqual(r.viajes.map(v => v.importeDiario), [6804.06, 10449.09, 21505.68, 21627.18]);
  });
  test('importe mensual por viaje (días × 4,4, sin redondear antes)', () => {
    assert.deepStrictEqual(r.viajes.map(v => v.importeMensual), [149689.23, 91951.96, 283874.94, 475797.92]);
    assert.deepStrictEqual(r.viajes.map(v => v.viajesMes), [22, 8.8, 13.2, 22]);
  });
  test('total de km mensuales y monto mensual', () => {
    assert.strictEqual(r.kmMensuales, 824.12);
    assert.strictEqual(r.total, 1001314.05);
  });
  test('el total es la suma de los importes mensuales ya redondeados (no el redondeo del total)', () => {
    assert.strictEqual(r2(824.12 * 1215.01), 1001314.04);   // si se redondeara el total daría 1 centavo menos
    assert.strictEqual(r.total, 1001314.05);
  });
  test('sin tramo corto configurado usa los km reales', () => {
    assert.strictEqual(r.tramoCorto.activo, false);
    assert.ok(r.viajes.every(v => v.kmFacturables === v.kmReales && !v.llevadoAlMinimo));
  });
  test('semanas por mes configurable', () => {
    assert.strictEqual(calcularPresupuesto({ viajes: [{ id: '1', km: 10, dias: L }], valorKmBase: 100, semanasPorMes: 4 }).total, 20000);
    assert.strictEqual(calcularPresupuesto({ viajes: [{ id: '1', km: 10, dias: L }], valorKmBase: 100 }).total, 22000);
  });
});

describe('adicional por dependencia', () => {
  test('valor base, adicional y valor final (35%)', () => {
    const v = valorKmFinal(847.27, { activa: true, porcentaje: 35 });
    assert.deepStrictEqual(v, { base: 847.27, adicional: 296.54, porcentaje: 35, aplicado: true, final: 1143.81 });
  });
  test('porcentaje configurable y sin dependencia no suma nada', () => {
    assert.strictEqual(valorKmFinal(1000, { activa: true, porcentaje: 20 }).final, 1200);
    assert.deepStrictEqual(valorKmFinal(847.27, { activa: false }), { base: 847.27, adicional: 0, porcentaje: 0, aplicado: false, final: 847.27 });
    assert.strictEqual(valorKmFinal(1000, { activa: true }).porcentaje, 35);   // por defecto 35%
  });
  test('el presupuesto usa el valor final', () => {
    const r = calcularPresupuesto({ viajes: [{ id: '1', km: 10, dias: ['lunes'] }], valorKmBase: 847.27, dependencia: { activa: true, porcentaje: 35 } });
    assert.strictEqual(r.valorKm.final, 1143.81);
    assert.strictEqual(r.viajes[0].importeDiario, 11438.1);
  });
});

describe('ida y vuelta: nunca se duplica un recorrido que ya es ida y vuelta', () => {
  const calc = viaje => calcularPresupuesto({ viajes: [{ id: '1', dias: ['lunes'], ...viaje }], valorKmBase: 100, semanasPorMes: 4 }).viajes[0];
  test('"ida y vuelta (total)": los km leídos son el total', () => {
    const v = calc({ modalidad: 'ida_vuelta_total', km: 18 });
    assert.strictEqual(v.kmReales, 18);
    assert.deepStrictEqual(v.sentidos, [9, 9]);
  });
  test('"solo ida": los km son los leídos; la vuelta se duplica solo si se pide', () => {
    assert.strictEqual(calc({ modalidad: 'solo_ida', km: 18 }).kmReales, 18);
    assert.strictEqual(calc({ modalidad: 'solo_ida', km: 18, incluyeVuelta: true }).kmReales, 36);
  });
  test('"dos recorridos separados": se suman, cada uno con sus km', () => {
    const v = calc({ modalidad: 'dos_recorridos', kmIda: 9, kmVuelta: 11 });
    assert.strictEqual(v.kmReales, 20);
    assert.deepStrictEqual(v.sentidos, [9, 11]);
  });
});

describe('tramo corto: apagado por defecto y sin unidad asumida', () => {
  const base = { valorKmBase: 100, semanasPorMes: 4 };
  test('activo sin unidad: se rechaza (no se asume ninguna)', () => {
    assert.throws(() => calcularPresupuesto({ ...base, viajes: [{ id: '1', km: 5, dias: ['lunes'] }], tramoCorto: { activo: true, kmMinimo: 12 } }), e => /unidad/.test(e.mensaje));
  });
  test('inactivo: km reales aunque sean menores a 12', () => {
    const r = calcularPresupuesto({ ...base, viajes: [{ id: '1', km: 5, dias: ['lunes'] }], tramoCorto: { activo: false, kmMinimo: 12, unidad: 'sentido' } });
    assert.strictEqual(r.viajes[0].kmFacturables, 5);
  });

  describe('unidad "sentido"', () => {
    const tc = { activo: true, kmMinimo: 12, unidad: 'sentido' };
    test('ida y vuelta de 18 km totales = 9 por sentido → cada sentido se cobra como 12 = 24 km', () => {
      const r = calcularPresupuesto({ ...base, tramoCorto: tc, viajes: [{ id: '1', modalidad: 'ida_vuelta_total', km: 18, dias: ['lunes'] }] });
      assert.strictEqual(r.viajes[0].kmReales, 18);
      assert.strictEqual(r.viajes[0].kmFacturables, 24);
      assert.strictEqual(r.viajes[0].llevadoAlMinimo, true);
      assert.deepStrictEqual(r.tramoCorto.viajesLlevadosAlMinimo, ['1']);
      assert.strictEqual(r.tramoCorto.unidad, 'sentido');
    });
    test('solo un sentido corto: ese sentido sube; ida y vuelta de más de 24 km no cambia', () => {
      const r = calcularPresupuesto({ ...base, tramoCorto: tc, viajes: [
        { id: 'A', modalidad: 'dos_recorridos', kmIda: 9, kmVuelta: 20, dias: ['lunes'] },
        { id: 'B', modalidad: 'ida_vuelta_total', km: 30, dias: ['martes'] },
        { id: 'C', modalidad: 'solo_ida', km: 5.6, dias: ['jueves'] },
      ] });
      assert.deepStrictEqual(r.viajes.map(v => v.kmFacturables), [32, 30, 12]);
      assert.deepStrictEqual(r.viajes.map(v => v.llevadoAlMinimo), [true, false, true]);
    });
    test('ambos sentidos cortos', () => {
      const r = calcularPresupuesto({ ...base, tramoCorto: tc, viajes: [{ id: '1', modalidad: 'dos_recorridos', kmIda: 5, kmVuelta: 7, dias: ['lunes'] }] });
      assert.strictEqual(r.viajes[0].kmFacturables, 24);
    });
  });

  describe('unidad "viaje" (ida y vuelta completo)', () => {
    const tc = { activo: true, kmMinimo: 12, unidad: 'viaje' };
    test('se mira el total del viaje: 18 km ida y vuelta no se toca; 9 km sube a 12', () => {
      const r = calcularPresupuesto({ ...base, tramoCorto: tc, viajes: [
        { id: '1', modalidad: 'ida_vuelta_total', km: 18, dias: ['lunes'] },
        { id: '2', modalidad: 'ida_vuelta_total', km: 9, dias: ['martes'] },
        { id: '3', modalidad: 'dos_recorridos', kmIda: 4, kmVuelta: 5, dias: ['jueves'] },
      ] });
      assert.deepStrictEqual(r.viajes.map(v => v.kmFacturables), [18, 12, 12]);
      assert.deepStrictEqual(r.tramoCorto.viajesLlevadosAlMinimo, ['2', '3']);
    });
  });

  describe('unidad "dia"', () => {
    const tc = { activo: true, kmMinimo: 12, unidad: 'dia' };
    test('el mínimo se aplica al total del día; el faltante queda como ajuste aparte', () => {
      const r = calcularPresupuesto({ ...base, tramoCorto: tc, viajes: [
        { id: '1', km: 5.6, dias: ['lunes', 'martes'] },
        { id: '2', km: 4, dias: ['lunes'] },
      ] });
      // lunes: 5,6 + 4 = 9,6 → 12 (faltan 2,4); martes: 5,6 → 12 (faltan 6,4)
      assert.deepStrictEqual(r.ajusteDiario.dias.map(d => [d.dia, d.kmReales, d.kmFacturables]), [['lunes', 9.6, 12], ['martes', 5.6, 12]]);
      assert.strictEqual(r.ajusteDiario.kmMes, r2((2.4 + 6.4) * 4));
      assert.strictEqual(r.kmMensuales, r2((5.6 * 2 + 4) * 4 + (2.4 + 6.4) * 4));
      assert.strictEqual(r.total, r2(r.viajes.reduce((a, v) => a + v.importeMensual, 0) + r.ajusteDiario.importeMensual));
    });
    test('si todos los días alcanzan el mínimo no hay ajuste', () => {
      const r = calcularPresupuesto({ ...base, tramoCorto: tc, viajes: [{ id: '1', km: 20, dias: ['lunes'] }] });
      assert.strictEqual(r.ajusteDiario, null);
    });
    test('pide los días de la semana (no alcanza con una cantidad)', () => {
      assert.throws(() => calcularPresupuesto({ ...base, tramoCorto: tc, viajes: [{ id: '1', km: 5, diasPorSemana: 3 }] }), e => /días de la semana/.test(e.mensaje));
    });
  });
});

describe('validaciones', () => {
  test('sin viajes, sin valor del km, sin días o con km inválidos', () => {
    assert.throws(() => calcularPresupuesto({ viajes: [], valorKmBase: 100 }), e => /al menos un viaje/.test(e.mensaje));
    assert.throws(() => calcularPresupuesto({ viajes: [{ km: 5, dias: ['lunes'] }], valorKmBase: 0 }), e => /valor del km/.test(e.mensaje));
    assert.throws(() => calcularPresupuesto({ viajes: [{ id: 'x', km: 5, dias: [] }], valorKmBase: 100 }), e => /días de traslado/.test(e.mensaje));
    assert.throws(() => calcularPresupuesto({ viajes: [{ id: 'x', km: -3, dias: ['lunes'] }], valorKmBase: 100 }), e => /km válidos/.test(e.mensaje));
    assert.throws(() => calcularPresupuesto({ viajes: [{ id: 'x', km: 3, dias: ['lunes'] }], valorKmBase: 100, semanasPorMes: 9 }), e => /semanas/.test(e.mensaje));
  });
});
