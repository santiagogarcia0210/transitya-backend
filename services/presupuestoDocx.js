// Rellena el formulario "Servicio de Traslados Programados" (.docx) respetando su diseño.
//
// El formulario es una serie de tablas de una fila: una celda con la etiqueta ("C.U.I.T.:") y otra vacía donde va el
// valor. Se rellena POR ETIQUETA, así sirve cualquier versión de la plantilla que conserve esos rótulos, y no se toca
// nada más (logo, bordes, tipografías). Los datos del transportista que la plantilla trae escritos se pisan con los
// de la configuración de la empresa. El archivo trae el formulario duplicado (página 1 y 2): por defecto se rellena
// una sola copia; con `duplicado` se rellenan las dos.
//
// Con más de un viaje se repite el bloque "Domicilio de destino … Cantidad de viajes mensuales" una vez por viaje.
const JSZip = require('jszip');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const esc = s => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MARCADO = '☒', VACIO = '☐';

/** 1234567.5 → "1.234.567,50" (el formato de los documentos). `dec` fija los decimales; sin `dec`, hasta 2 sin ceros de más. */
function fmt(n, dec) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  const [ent, d] = (dec === undefined ? String(Math.round(x * 100) / 100) : x.toFixed(dec)).split('.');
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return d ? `${miles},${d}` : miles;
}
const pesos = n => `$${fmt(n, 2)}`;

/* ── Tablas y celdas ─────────────────────────────────────────────────────── */

/** Tablas de primer nivel de un trozo de XML: [{ ini, fin }]. */
function tablas(xml) {
  const out = []; let i = 0;
  while ((i = xml.indexOf('<w:tbl>', i)) >= 0) {
    let prof = 0, j = i;
    for (;;) {
      const a = xml.indexOf('<w:tbl>', j), b = xml.indexOf('</w:tbl>', j);
      if (b < 0) throw new Error('docx inválido: tabla sin cerrar');
      if (a >= 0 && a < b) { prof++; j = a + 7; } else { prof--; j = b + 8; if (prof === 0) break; }
    }
    out.push({ ini: i, fin: j }); i = j;
  }
  return out;
}
const celdas = t => [...t.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(m => ({ xml: m[0], ini: m.index, fin: m.index + m[0].length }));
const textoDe = x => [...x.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

/** Pone `texto` en una celda: reemplaza el primer texto (conserva su formato) y vacía los demás. */
function ponerEnCelda(tc, texto) {
  let primero = true, hubo = false;
  let out = tc.replace(/<w:t(\s[^>]*)?>[^<]*<\/w:t>/g, () => {
    hubo = true;
    if (primero) { primero = false; return `<w:t xml:space="preserve">${esc(texto)}</w:t>`; }
    return '<w:t xml:space="preserve"></w:t>';
  });
  if (!hubo) out = out.replace('</w:p>', `<w:r><w:t xml:space="preserve">${esc(texto)}</w:t></w:r></w:p>`);
  return out;
}

/** Reemplaza las celdas indicadas ({ índice: texto }) dentro de una tabla. */
function ponerCeldas(tabla, valores) {
  const cs = celdas(tabla);
  let out = '', pos = 0;
  cs.forEach((c, k) => {
    out += tabla.slice(pos, c.ini);
    out += valores[k] !== undefined ? ponerEnCelda(c.xml, valores[k]) : c.xml;
    pos = c.fin;
  });
  return out + tabla.slice(pos);
}
const etiquetaDe = tabla => { const c = celdas(tabla)[0]; return c ? norm(textoDe(c.xml)) : ''; };

/** Rellena todas las tablas de un trozo según su etiqueta. `reglas`: [[prefijoNormalizado, tabla => tablaNueva]]. */
function aplicarReglas(xml, reglas) {
  let out = '', pos = 0;
  for (const t of tablas(xml)) {
    const tabla = xml.slice(t.ini, t.fin);
    const et = etiquetaDe(tabla);
    const regla = reglas.find(([pre]) => et.startsWith(pre));
    out += xml.slice(pos, t.ini) + (regla ? regla[1](tabla) : tabla);
    pos = t.fin;
  }
  return out + xml.slice(pos);
}

/** Rellena el trozo de una copia del formulario con los datos. */
function rellenarCopia(xml, d) {
  const tr = d.transportista || {}, be = d.beneficiario || {}, os = d.obraSocial || {};
  const par = v => t => ponerCeldas(t, { 1: v });
  const casillas = (idxSi, idxNo, si) => t => ponerCeldas(t, { [idxSi]: si ? MARCADO : VACIO, [idxNo]: si ? VACIO : MARCADO });

  // Bloque de viajes: de "Domicilio de destino" a "Cantidad de viajes mensuales", repetido por cada viaje.
  const ts = tablas(xml);
  const posDe = pre => ts.findIndex(t => etiquetaDe(xml.slice(t.ini, t.fin)).startsWith(pre));
  const a = posDe('domicilio de destino'), b = posDe('cantidad de viajes mensuales');
  const viajes = d.viajes && d.viajes.length ? d.viajes : [{}];
  const reglasViaje = v => [
    ['domicilio de destino', par(v.destino ?? '')],
    ['prestador:', par(v.prestador ?? '')],
    ['codigo del prestador', par(v.codigoPrestador ?? '')],
    ['km. recorridos ida y vuelta', par(v.kmDiarios !== undefined ? fmt(v.kmDiarios) : '')],
    ['cantidad de viajes mensuales', par(v.viajesMes !== undefined ? fmt(v.viajesMes) : '')],
  ];
  if (a >= 0 && b > a) {
    const ini = ts[a].ini, fin = ts[b].fin;
    const bloque = xml.slice(ini, fin);
    const nuevo = viajes.map(v => aplicarReglas(bloque, reglasViaje(v))).join('');
    xml = xml.slice(0, ini) + nuevo + xml.slice(fin);
  }

  const totales = d.totales || {};
  const filaValor = (tabla, etiqueta, valor) => ponerCeldas(tabla, { 0: etiqueta, 1: valor });
  const reglas = [
    ['razon social', par(tr.razonSocial ?? '')],
    ['nombre del responsable', par(tr.responsable ?? '')],
    ['c.u.i.t', par(tr.cuit ?? '')],
    ['domicilio:', par(tr.domicilio ?? '')],
    ['cel.', t => ponerCeldas(t, { 1: tr.telefono ?? '', 3: tr.mail ?? '' })],
    ['datos del beneficiado', casillas(2, 4, os.esObraSocial !== false)],
    ['prestadora', t => ponerCeldas(t, { 0: `Prestadora: ${os.prestadora ?? ''}`, 1: `N° de Afiliado: ${os.nroAfiliado ?? ''}` })],
    ['apellido y nombre', par(be.nombre ?? '')],
    ['d.n.i', par(be.dni ?? '')],
    ['domicilio de origen', par(be.domicilio ?? '')],
    ['localidad', par(be.localidad ?? '')],
    ['tutor o encargado', par(be.tutor ?? '')],
    ['n° de contacto', par(be.contacto ?? '')],
    ['km. mensuales', t => {
      let out = ponerCeldas(t, { 1: totales.kmMensuales !== undefined ? fmt(totales.kmMensuales) : '' });
      if (d.incluirValores && totales.valorKm !== undefined) {
        out += filaValor(t, 'Valor del km:', pesos(totales.valorKm));
        out += filaValor(t, 'Valor mensual del traslado:', pesos(totales.importeMensual));
      }
      return out;
    }],
    ['observaciones', t => (d.observaciones ? ponerCeldas(t, { 1: `${textoDe(celdas(t)[1] ? celdas(t)[1].xml : '')} ${d.observaciones}`.trim() }) : t)],
    ['beneficiario con acompanante', casillas(2, 4, d.acompanante === true)],
  ];
  return aplicarReglas(xml, reglas);
}

const SALTO = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/**
 * buffer: el .docx de la plantilla. datos: ver rellenarCopia + { duplicado }.
 * Devuelve el .docx rellenado (Buffer).
 */
async function rellenarTraslados(buffer, datos) {
  const zip = await JSZip.loadAsync(buffer);
  const arch = zip.file('word/document.xml');
  if (!arch) throw new Error('El archivo no es un .docx válido.');
  const xml = await arch.async('string');
  const ini = xml.indexOf('<w:body>') + 8, fin = xml.lastIndexOf('</w:body>');
  const cuerpo = xml.slice(ini, fin);
  const sect = (cuerpo.match(/<w:sectPr[\s\S]*<\/w:sectPr>\s*$/) || [''])[0];
  const sinSect = sect ? cuerpo.slice(0, cuerpo.length - sect.length) : cuerpo;
  const copias = sinSect.split(SALTO);
  const usar = datos.duplicado ? copias : copias.slice(0, 1);
  const nuevo = usar.map(c => rellenarCopia(c, datos)).join(SALTO) + sect;
  zip.file('word/document.xml', xml.slice(0, ini) + nuevo + xml.slice(fin));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Comprueba que un .docx sirve de plantilla: es un zip con document.xml y tiene los rótulos mínimos. */
async function validarPlantillaTraslados(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { return { ok: false, mensaje: 'El archivo no es un .docx válido.' }; }
  const arch = zip.file('word/document.xml');
  if (!arch) return { ok: false, mensaje: 'El archivo no es un .docx válido (falta word/document.xml).' };
  const xml = await arch.async('string');
  const et = new Set(tablas(xml).map(t => etiquetaDe(xml.slice(t.ini, t.fin))));
  const tiene = pre => [...et].some(e => e.startsWith(pre));
  const faltan = ['razon social', 'c.u.i.t', 'apellido y nombre', 'domicilio de destino', 'km. mensuales'].filter(p => !tiene(p));
  if (faltan.length) return { ok: false, mensaje: `A la plantilla le faltan estos rótulos: ${faltan.join(', ')}. Tiene que ser el formulario "Servicio de Traslados Programados".` };
  return { ok: true, copias: xml.split(SALTO).length };
}

module.exports = { rellenarTraslados, validarPlantillaTraslados, fmt, pesos, norm };
