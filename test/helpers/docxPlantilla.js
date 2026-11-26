// Plantilla .docx SINTÉTICA con la misma estructura que el formulario "Servicio de Traslados Programados":
// tablas de una fila (etiqueta + celda vacía), dos copias separadas por un salto de página. Sin datos reales.
const JSZip = require('jszip');

const celda = t => `<w:tc><w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p></w:tc>`;
const tabla = (...textos) => `<w:tbl><w:tr>${textos.map(celda).join('')}</w:tr></w:tbl>`;
const par = (txt = '') => `<w:p><w:r><w:t xml:space="preserve">${txt}</w:t></w:r></w:p>`;

const copia = () => [
  tabla('Servicio de Traslados Programados', 'PRESUPUESTO', ''),
  par('Datos del Transportista:'),
  tabla('Razón Social:', 'EMPRESA DE EJEMPLO ANTERIOR'),
  tabla('Nombre del Responsable:', 'RESPONSABLE ANTERIOR'),
  tabla('C.U.I.T.:', '00-00000000-0'),
  tabla('Domicilio:', 'XXXXXXXXXXXXXXX'),
  tabla('Cel.:', '0000', 'Mail:', 'viejo@example.com'),
  tabla('Datos del Beneficiado', 'Obra Social', '☐', 'Particular', '☐', ''),
  tabla('Prestadora: OBRA SOCIAL FIJA', 'N° de Afiliado:'),
  tabla('Apellido y Nombre:', ''), tabla('D.N.I.:', ''), tabla('Domicilio de Origen:', ''), tabla('Localidad:', ''),
  tabla('Tutor o Encargado:', ''), tabla('N° de contacto:', ''),
  par('Beneficiado debe ser trasladado a:'),
  tabla('Domicilio de destino:', ''), tabla('Prestador:', ''), tabla('Código del prestador:', ''),
  tabla('Km. recorridos ida y vuelta diarios:', ''), tabla('Cantidad de viajes mensuales (ida y vuelta):', ''),
  tabla('Km. mensuales:', ''),
  par('RESFC-2023-1-APN-DE#AND'),
  tabla('Observaciones:', 'Sujeto a cambios en el valor mensual dependiendo de la legislación vigente'),
  tabla('Beneficiario con acompañante:', 'SI', '☐', 'NO', '☐', ''),
  tabla('Firma y aclaración beneficiario', 'Firma responsable'),
].join('');

async function plantillaSintetica({ copias = 2 } = {}) {
  const salto = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  const cuerpo = Array.from({ length: copias }, copia).join(salto) + sect;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${cuerpo}</w:body></w:document>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', doc);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Texto de las celdas de cada tabla del .docx, para las aserciones. */
async function leerTablas(buffer) {
  const xml = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
  return [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map(m =>
    [...m[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(c => [...c[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(t => t[1]).join('')));
}

module.exports = { plantillaSintetica, leerTablas };
