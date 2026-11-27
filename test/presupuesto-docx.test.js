/**
 * Relleno del formulario "Servicio de Traslados Programados" (.docx) con una plantilla sintética de la misma estructura.
 * Sin datos reales. Correr: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const D = require('../services/presupuestoDocx');
const { plantillaSintetica, leerTablas } = require('./helpers/docxPlantilla');

const datos = (extra = {}) => ({
  transportista: { razonSocial: 'Transporte de Prueba', responsable: 'Responsable & Cía <test>', cuit: '30-12345678-1', domicilio: 'Calle Inventada 100, Ciudad', telefono: '381 000-0000', mail: 'prueba@example.com' },
  obraSocial: { esObraSocial: true, prestadora: 'OBRA SOCIAL DE PRUEBA', nroAfiliado: '000111' },
  beneficiario: { nombre: 'Persona Ficticia', dni: '10.000.000', domicilio: 'Av. Falsa 1', localidad: 'Ciudad', tutor: 'Tutor Ficticio', contacto: '381 111-1111' },
  viajes: [{ destino: 'Centro Uno - Calle 1', prestador: 'Centro Uno', codigoPrestador: 'C-1', kmDiarios: 17.4, viajesMes: 22 }],
  totales: { kmMensuales: 382.8, valorKm: 1215.01, importeMensual: 465110.8 }, acompanante: false, ...extra,
});
const valor = (tablas, etiqueta) => (tablas.find(t => t[0].startsWith(etiqueta)) || [])[1];

describe('rellenarTraslados', () => {
  test('rellena por etiqueta y pisa los datos del transportista que traía la plantilla', async () => {
    const t = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos()));
    assert.strictEqual(valor(t, 'Razón Social'), 'Transporte de Prueba');
    assert.strictEqual(valor(t, 'C.U.I.T.'), '30-12345678-1');
    assert.strictEqual(valor(t, 'Domicilio:'), 'Calle Inventada 100, Ciudad');   // no queda "XXXXXXXXXXXXXXX"
    assert.ok(!JSON.stringify(t).includes('XXXXXXXX') && !JSON.stringify(t).includes('viejo@example.com'));
    assert.deepStrictEqual(t.find(t2 => t2[0] === 'Cel.:'), ['Cel.:', '381 000-0000', 'Mail:', 'prueba@example.com']);
    assert.strictEqual(valor(t, 'Apellido y Nombre'), 'Persona Ficticia');
    assert.strictEqual(valor(t, 'D.N.I.'), '10.000.000');
    assert.strictEqual(valor(t, 'Domicilio de Origen'), 'Av. Falsa 1');
    assert.strictEqual(valor(t, 'Domicilio de destino'), 'Centro Uno - Calle 1');
    assert.strictEqual(valor(t, 'Km. recorridos'), '17,4');
    assert.strictEqual(valor(t, 'Cantidad de viajes'), '22');
    assert.strictEqual(valor(t, 'Km. mensuales'), '382,8');
  });
  test('escapa los caracteres especiales del XML', async () => {
    const t = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos()));
    assert.strictEqual(valor(t, 'Nombre del Responsable'), 'Responsable &amp; Cía &lt;test&gt;');
  });
  test('casillas: obra social y acompañante', async () => {
    const t = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos({ acompanante: true })));
    assert.deepStrictEqual(t.find(x => x[0] === 'Datos del Beneficiado'), ['Datos del Beneficiado', 'Obra Social', '☒', 'Particular', '☐', '']);
    assert.deepStrictEqual(t.find(x => x[0].startsWith('Beneficiario con acomp')).slice(1, 5), ['SI', '☒', 'NO', '☐']);
    const p = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos({ obraSocial: { esObraSocial: false } })));
    assert.deepStrictEqual(p.find(x => x[0] === 'Datos del Beneficiado').slice(2, 5), ['☐', 'Particular', '☒']);
  });
  test('la obra social del paciente reemplaza a la "Prestadora" fija de la plantilla', async () => {
    const t = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos()));
    assert.deepStrictEqual(t.find(x => x[0].startsWith('Prestadora')), ['Prestadora: OBRA SOCIAL DE PRUEBA', 'N° de Afiliado: 000111']);
  });
  test('por defecto sale una sola copia; con "duplicado", las dos, idénticas', async () => {
    const una = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos()));
    const dos = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos({ duplicado: true })));
    assert.strictEqual(dos.length, una.length * 2);
    assert.deepStrictEqual(dos.slice(0, una.length), dos.slice(una.length));
    // y conserva la sección de página (el documento sigue siendo válido)
    const xml = await (await JSZip.loadAsync(await D.rellenarTraslados(await plantillaSintetica(), datos()))).file('word/document.xml').async('string');
    assert.match(xml, /<w:sectPr>/);
    assert.ok(!xml.includes('w:br w:type="page"'));
  });
  test('varios viajes: el bloque de destino se repite una vez por viaje y los totales quedan una vez', async () => {
    const d = datos({ viajes: [
      { destino: 'Centro Uno', prestador: 'Uno', kmDiarios: 17.4, viajesMes: 22 },
      { destino: 'Centro Dos', prestador: 'Dos', kmDiarios: 8.6, viajesMes: 8.8 },
    ] });
    const t = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), d));
    assert.deepStrictEqual(t.filter(x => x[0].startsWith('Domicilio de destino')).map(x => x[1]), ['Centro Uno', 'Centro Dos']);
    assert.deepStrictEqual(t.filter(x => x[0].startsWith('Km. recorridos')).map(x => x[1]), ['17,4', '8,6']);
    assert.deepStrictEqual(t.filter(x => x[0].startsWith('Cantidad de viajes')).map(x => x[1]), ['22', '8,8']);
    assert.strictEqual(t.filter(x => x[0].startsWith('Km. mensuales')).length, 1);
  });
  test('valor del km y monto solo si se piden (el formulario original no los trae)', async () => {
    const sin = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos()));
    assert.ok(!sin.some(x => x[0].startsWith('Valor')));
    const con = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos({ incluirValores: true })));
    assert.strictEqual(valor(con, 'Valor del km'), '$1.215,01');
    assert.strictEqual(valor(con, 'Valor mensual del traslado'), '$465.110,80');
  });
  test('observaciones: se agregan a la leyenda de la plantilla, sin borrarla', async () => {
    const t = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), datos({ observaciones: 'Adicional por dependencia: No.' })));
    assert.match(valor(t, 'Observaciones'), /^Sujeto a cambios.*Adicional por dependencia: No\.$/);
  });
  test('no inventa nada: sin datos deja vacío', async () => {
    const t = await leerTablas(await D.rellenarTraslados(await plantillaSintetica(), { transportista: {} }));
    assert.strictEqual(valor(t, 'Apellido y Nombre'), '');
    assert.strictEqual(valor(t, 'Razón Social'), '');
  });
});

describe('validarPlantillaTraslados', () => {
  test('acepta el formulario y avisa cuántas copias trae', async () => {
    assert.deepStrictEqual(await D.validarPlantillaTraslados(await plantillaSintetica()), { ok: true, copias: 2 });
  });
  test('rechaza lo que no es un .docx o no es este formulario', async () => {
    assert.strictEqual((await D.validarPlantillaTraslados(Buffer.from('no es un zip'))).ok, false);
    const zip = new JSZip(); zip.file('word/document.xml', '<w:document><w:body><w:p/></w:body></w:document>');
    const r = await D.validarPlantillaTraslados(await zip.generateAsync({ type: 'nodebuffer' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.mensaje, /rótulos/);
  });
});

describe('formato de números', () => {
  test('es-AR', () => {
    assert.strictEqual(D.fmt(1001314.05, 2), '1.001.314,05');
    assert.strictEqual(D.fmt(824.12), '824,12');
    assert.strictEqual(D.fmt(22), '22');
    assert.strictEqual(D.fmt(8.8), '8,8');
    assert.strictEqual(D.pesos(1215.01), '$1.215,01');
    assert.strictEqual(D.fmt('x'), '');
  });
});
