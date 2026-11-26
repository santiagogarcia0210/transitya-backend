// Guardado de datos clínicos del legajo: cifrados en reposo y auditados.
//
//   empresas/{tenant}/legajo_clinico/{beneficiarioId}   { beneficiarioId, v, datos: "<iv:tag:cifrado>", actualizadoEn, actualizadoPor }
//   empresas/{tenant}/legajo_clinico_auditoria/{id}     { beneficiarioId, accion, uid, usuario, rol, en, campos? }
//
// Cifrado: AES-256-GCM con helpers/cripto.js → variable ENCRYPTION_KEY (la misma que usa el correo y ARCA). Todo el
// contenido clínico va dentro de `datos`; en claro queda solo quién/cuándo. Sin clave NO se guarda en texto plano:
// las operaciones fallan con codigo 'sin_cifrado'. Si la clave se pierde o cambia, `datos` no se puede descifrar
// (GCM lo detecta) y se pierde el contenido clínico guardado; los documentos originales siguen en la carpeta y se
// pueden volver a leer con la IA. Nunca se loguea un valor descifrado: los errores de acá no llevan contenido.
//
// La auditoría registra quién vio o editó y cuándo, con los NOMBRES de los campos tocados, nunca sus valores.
// Si no se puede escribir la auditoría, no se muestra el dato (falla cerrado).
const crypto = require('node:crypto');
const cripto = require('../helpers/cripto');

const VERSION = 1;
const err = (codigo, mensaje) => Object.assign(new Error(mensaje), { codigo });

/**
 * deps: { col(tenantId, nombre), ahora?(): Date, cifrado?: { encriptar, desencriptar, disponible } }
 */
function crearStore({ col, ahora = () => new Date(), cifrado = cripto }) {
  const colClinico = t => col(t, 'legajo_clinico');
  const colAudit = t => col(t, 'legajo_clinico_auditoria');

  const exigirCifrado = () => { if (!cifrado.disponible()) throw err('sin_cifrado', 'Falta la clave de cifrado en el servidor.'); };

  async function auditar(tenantId, usuario, beneficiarioId, accion, campos) {
    const id = crypto.randomUUID();
    await colAudit(tenantId).doc(id).set({
      id, beneficiarioId, accion, uid: usuario.uid || '', usuario: usuario.nombre || usuario.email || '', rol: usuario.rol || '',
      en: ahora().toISOString(), ...(campos && campos.length ? { campos } : {}),
    });
  }

  /** Datos descifrados de un paciente, o null si no hay. Lanza 'ilegible' si no se pueden descifrar. */
  async function leerSinAuditar(tenantId, beneficiarioId) {
    const snap = await colClinico(tenantId).doc(beneficiarioId).get();
    if (!snap.exists) return null;
    exigirCifrado();
    let datos;
    try { datos = JSON.parse(cifrado.desencriptar(snap.data().datos)); }
    catch { throw err('ilegible', 'No se pudieron descifrar los datos clínicos.'); }
    if (datos.beneficiarioId !== beneficiarioId) throw err('ilegible', 'No se pudieron descifrar los datos clínicos.');   // blob copiado de otro paciente
    return datos;
  }

  async function escribir(tenantId, usuario, beneficiarioId, datos) {
    exigirCifrado();
    await colClinico(tenantId).doc(beneficiarioId).set({
      beneficiarioId, v: VERSION, datos: cifrado.encriptar(JSON.stringify({ ...datos, beneficiarioId })),
      actualizadoEn: ahora().toISOString(), actualizadoPor: usuario.nombre || usuario.email || '',
    });
  }

  const seccionDe = documento => (documento === 'cud' ? 'cud' : 'ordenMedica');

  return {
    disponible: () => cifrado.disponible(),

    /** Lectura interna, sin registrar un "ver" (la usa la ruta para devolver el resultado de una edición ya auditada). */
    leerInterno: (tenantId, beneficiarioId) => leerSinAuditar(tenantId, beneficiarioId),

    /** Ver: audita ANTES de devolver el dato. */
    async ver(tenantId, usuario, beneficiarioId) {
      const datos = await leerSinAuditar(tenantId, beneficiarioId);
      await auditar(tenantId, usuario, beneficiarioId, 'ver');
      return datos;
    },

    /**
     * Guarda lo confirmado de un documento (cud | orden_medica), mezclándolo con lo que ya había.
     * `campos` = { k: { valor, confianza, editado } }; origen: 'ia' (confirmación de una lectura) o 'manual'.
     */
    async guardarSeccion(tenantId, usuario, beneficiarioId, documento, campos, origen = 'ia') {
      exigirCifrado();
      const datos = (await leerSinAuditar(tenantId, beneficiarioId)) || { v: VERSION, beneficiarioId };
      const sec = seccionDe(documento);
      const previa = (datos[sec] && datos[sec].campos) || {};
      const nuevos = {};
      for (const [k, c] of Object.entries(campos)) nuevos[k] = { valor: c.valor, confianza: c.confianza, origen, editado: c.editado === true || origen === 'manual' };
      const ts = ahora().toISOString();
      datos[sec] = { campos: { ...previa, ...nuevos }, confirmadoEn: ts, confirmadoPor: usuario.nombre || usuario.email || '' };
      await escribir(tenantId, usuario, beneficiarioId, datos);
      await auditar(tenantId, usuario, beneficiarioId, origen === 'ia' ? 'crear' : 'editar', Object.keys(nuevos).map(k => `${sec}.${k}`));
    },

    /** Edición manual: reemplaza campos (valor vacío = quitar) y/o la modalidad elegida. */
    async editar(tenantId, usuario, beneficiarioId, documento, campos, modalidadElegida) {
      exigirCifrado();
      const datos = (await leerSinAuditar(tenantId, beneficiarioId)) || { v: VERSION, beneficiarioId };
      const tocados = [];
      if (documento) {
        const sec = seccionDe(documento);
        const previa = { ...((datos[sec] && datos[sec].campos) || {}) };
        for (const [k, c] of Object.entries(campos)) { previa[k] = { valor: c.valor, confianza: 'alta', origen: 'manual', editado: true }; tocados.push(`${sec}.${k}`); }
        datos[sec] = { ...(datos[sec] || {}), campos: previa, confirmadoEn: ahora().toISOString(), confirmadoPor: usuario.nombre || usuario.email || '' };
      }
      if (modalidadElegida !== undefined) { datos.modalidadElegida = modalidadElegida; tocados.push('modalidadElegida'); }
      await escribir(tenantId, usuario, beneficiarioId, datos);
      await auditar(tenantId, usuario, beneficiarioId, 'editar', tocados);
    },

    /** Quitar un campo (la pantalla manda valor vacío). */
    async quitarCampos(tenantId, usuario, beneficiarioId, documento, claves) {
      const datos = await leerSinAuditar(tenantId, beneficiarioId);
      if (!datos) return;
      const sec = seccionDe(documento);
      if (!datos[sec]) return;
      for (const k of claves) delete datos[sec].campos[k];
      await escribir(tenantId, usuario, beneficiarioId, datos);
      await auditar(tenantId, usuario, beneficiarioId, 'editar', claves.map(k => `${sec}.${k}`));
    },

    async auditoria(tenantId, beneficiarioId, limite = 50) {
      const snap = await colAudit(tenantId).where('beneficiarioId', '==', beneficiarioId).get();
      return snap.docs.map(d => d.data()).sort((a, b) => String(b.en).localeCompare(String(a.en))).slice(0, limite);
    },
  };
}

module.exports = { crearStore };
