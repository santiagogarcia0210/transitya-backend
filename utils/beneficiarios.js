// Fuente única de verdad de los pacientes (beneficiarios).
//
// Los pacientes pueden vivir en dos colecciones: `registro` (la de siempre) y `BENEFICIARIOS` (la que dejó
// una migración vieja). Además, distintos formularios guardaron el mismo dato con claves distintas
// ('N° AFILIADO' / nroAfiliado / NRO_AFILIADO, 'OBRA SOCIAL' / obraSocial / OS …). Este módulo:
//   · lee las dos colecciones sin repetir (por id de documento);
//   · normaliza nombres de campo y la obra social (todas las grafías de Incluir → 'INCLUIR SALUD');
//   · encuentra un documento en la colección donde está (para editar, dar de baja, guardar el GPS);
//   · limpia lo que manda un formulario antes de guardar (sin id ni campos internos, sin undefined).
//
// Las funciones que tocan Firestore reciben `col` (utils.col) para poder probarlas con una base en memoria.

const COLECCIONES = ['registro', 'BENEFICIARIOS'];
const INCLUIR = 'INCLUIR SALUD';

// Claves posibles de cada dato, en orden de preferencia. Los nombres con "°" (grado) y "º" (ordinal) se
// confunden fácil al tipear, por eso se aceptan los dos.
const CLAVES = {
  nombre:   ['APELLIDO Y NOMBRE', 'NOMBRE', 'apellidoYNombre', 'apellidoNombre'],
  dni:      ['DNI', 'dni'],
  afiliado: ['N° AFILIADO', 'Nº AFILIADO', 'nroAfiliado', 'NRO_AFILIADO', 'nro_afiliado', 'NRO AFILIADO', 'N AFILIADO', 'AFILIADO', 'afiliado'],
  os:       ['OBRA SOCIAL', 'OS', 'obraSocial', 'OBRASOCIAL', 'obra_social'],
  chofer:   ['CHOFER', 'chofer'],
  domicilio:['DOMICILIO', 'domicilio'],
  localidad:['LOCALIDAD', 'localidad'],
  cuil:     ['CUIL', 'cuil'],
  prestador:['PRESTADOR', 'DEPENDENCIA', 'prestador', 'dependencia'],
};

// Campos que son del sistema, no del paciente: nunca se guardan desde un formulario.
const INTERNOS = new Set(['id', 'ID', '_id', '_fsId', 'creadoEn', 'creadoPor', 'actualizadoEn', '_updatedAt']);

const sinAcentos = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const lleno = v => v !== undefined && v !== null && String(v).trim() !== '';

/** Primer valor no vacío entre las claves dadas, como texto recortado. */
function primero(doc, claves) {
  for (const k of claves) if (lleno(doc[k])) return String(doc[k]).trim();
  return '';
}

/** Obra social en su valor canónico: cualquier grafía de Incluir ("incluir", "Incluir Salud", "INCLUIR-SALUD"…)
 *  pasa a 'INCLUIR SALUD'; el resto se conserva tal cual (recortado). Vacío si no hay. */
function normalizarObraSocial(v) {
  if (!lleno(v)) return '';
  return /\bINCLUIR/.test(sinAcentos(v)) ? INCLUIR : String(v).trim();
}
const esIncluir = v => normalizarObraSocial(v) === INCLUIR;

/** Un paciente con los campos ya normalizados. `data` es el documento tal cual está guardado. */
function normalizarBeneficiario(id, data, coleccion = 'registro') {
  const d = data || {};
  let nombre = primero(d, CLAVES.nombre);
  if (!nombre) nombre = [d.apellido, d.nombre].filter(lleno).map(s => String(s).trim()).join(' ');
  const afiliado = primero(d, CLAVES.afiliado);
  const obraSocial = normalizarObraSocial(primero(d, CLAVES.os));
  return {
    id, coleccion, nombre,
    dni: primero(d, CLAVES.dni), afiliado, faltaAfiliado: !afiliado,
    obraSocial, esIncluir: obraSocial === INCLUIR, sinObraSocial: !obraSocial,
    activo: d.activo !== false,
    chofer: primero(d, CLAVES.chofer), domicilio: primero(d, CLAVES.domicilio), localidad: primero(d, CLAVES.localidad),
    cuil: primero(d, CLAVES.cuil), prestador: primero(d, CLAVES.prestador),
    data: d,
  };
}

/** Todos los pacientes de las dos colecciones, sin repetir por id de documento (gana `registro`). */
async function cargarBeneficiarios(col, tenantId) {
  const [reg, ben] = await Promise.all([
    col(tenantId, 'registro').get(),
    col(tenantId, 'BENEFICIARIOS').get().catch(() => null),
  ]);
  const vistos = new Set();
  const lista = [];
  const agregar = (docs, coleccion) => {
    for (const d of docs) {
      if (vistos.has(d.id)) continue;
      vistos.add(d.id);
      lista.push(normalizarBeneficiario(d.id, d.data(), coleccion));
    }
  };
  agregar(reg.docs, 'registro');
  if (ben) agregar(ben.docs, 'BENEFICIARIOS');
  return lista;
}

/** Busca un paciente por id de documento en las dos colecciones. { ref, snap, coleccion } o null. */
async function buscarDoc(col, tenantId, id) {
  if (!id) return null;
  for (const coleccion of COLECCIONES) {
    const ref = col(tenantId, coleccion).doc(String(id));
    const snap = await ref.get();
    if (snap.exists) return { ref, snap, coleccion };
  }
  return null;
}

/** Igual que buscarDoc, pero si no hay un documento con ese id mira también el campo `ID` (documentos migrados). */
async function buscarDocPorIdOCampo(col, tenantId, id) {
  const directo = await buscarDoc(col, tenantId, id);
  if (directo || !id) return directo;
  for (const coleccion of COLECCIONES) {
    const snap = await col(tenantId, coleccion).get().catch(() => null);
    const d = snap && snap.docs.find(x => x.data()['ID'] === id);
    if (d) return { ref: d.ref, snap: d, coleccion };
  }
  return null;
}

/** Lo que un formulario manda → lo que se guarda. Saca los campos del sistema y los `undefined`, y deja
 *  el N° de afiliado y la obra social en TODAS sus claves habituales con el mismo valor (así las planillas,
 *  la carpeta y el resto leen lo mismo sin importar qué pantalla lo cargó). */
function limpiarPayload(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (INTERNOS.has(k) || v === undefined || typeof v === 'function') continue;
    out[k] = v;
  }
  if (CLAVES.afiliado.some(k => k in out)) {
    const af = primero(out, CLAVES.afiliado);
    out['N° AFILIADO'] = af;
    out.nroAfiliado = af;
  }
  if (CLAVES.os.some(k => k in out)) {
    const os = normalizarObraSocial(primero(out, CLAVES.os));
    out['OBRA SOCIAL'] = os;
    out.obraSocial = os;
  }
  return out;
}

module.exports = {
  COLECCIONES, INCLUIR, CLAVES, INTERNOS,
  sinAcentos, primero, normalizarObraSocial, esIncluir, normalizarBeneficiario,
  cargarBeneficiarios, buscarDoc, buscarDocPorIdOCampo, limpiarPayload,
};
