// Datos clínicos del legajo (diagnóstico, orientación prestacional…): ver, editar y auditoría.
//
//   GET /api/legajos/:beneficiarioId/clinico              datos + sugerencia de modalidad (audita el acceso)
//   PUT /api/legajos/:beneficiarioId/clinico              corrige datos y/o elige modalidad (audita la edición)
//   GET /api/legajos/:beneficiarioId/clinico/auditoria    quién vio o editó, y cuándo (sin valores)
//
// Solo quien pasa puedeVerClinico (middleware/permisos.js). Los datos viven cifrados en legajo_clinico y NO salen
// por ningún listado, exportación ni la pizarra: solo por estas rutas y la respuesta de leer-ia. Sin caché en el
// navegador ni en proxies. Nunca se loguean valores.
const { verifyToken } = require('../middleware/auth');
const { requireClinico } = require('../middleware/permisos');
const { col, nombreUsuario } = require('../utils');
const C = require('../services/legajoClinico');
const { crearStore } = require('../services/legajoClinicoStore');

module.exports = function crearRouterLegajosClinico({ almacenClinico, ahora = () => new Date() } = {}) {
  const router = require('express').Router();
  const store = almacenClinico || crearStore({ col, ahora });

  const usuarioDe = req => ({ ...req.user, nombre: nombreUsuario(req.user) });
  const sinCache = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  async function existePaciente(tenantId, id) {
    const a = await col(tenantId, 'registro').doc(id).get();
    if (a.exists) return true;
    return (await col(tenantId, 'BENEFICIARIOS').doc(id).get()).exists;
  }

  function responderError(res, e, accion) {
    // Solo el código: el mensaje de un error de descifrado o de Firestore no debe llegar a un log con contenido.
    console.error('[LEGAJO-CLINICO]', accion, { codigo: e.codigo || e.name });
    if (e.codigo === 'sin_cifrado') return res.status(503).json({ ok: false, mensaje: 'Los datos clínicos no están disponibles: falta la clave de cifrado en el servidor. Avisá a soporte.' });
    if (e.codigo === 'ilegible') return res.status(500).json({ ok: false, codigo: 'clinico_ilegible', mensaje: 'No se pudieron descifrar los datos clínicos de este paciente. Los documentos originales siguen en la carpeta: se pueden volver a leer con la IA.' });
    return res.status(500).json({ ok: false, mensaje: 'No se pudieron procesar los datos clínicos.' });
  }

  /** Vista para la pantalla + sugerencia de modalidad. */
  function armarVista(datos) {
    if (!datos) return { clinico: null, recomendacion: C.recomendarCentro({}) };
    const v = k => (datos.cud && datos.cud.campos[k] && datos.cud.campos[k].valor) || '';
    const o = k => (datos.ordenMedica && datos.ordenMedica.campos[k] && datos.ordenMedica.campos[k].valor) || '';
    const recomendacion = C.recomendarCentro({
      diagnostico: v('diagnostico') || o('diagnostico'), tipoDiscapacidad: v('tipoDiscapacidad'),
      orientacionPrestaciones: (datos.cud && datos.cud.campos.orientacionPrestaciones && datos.cud.campos.orientacionPrestaciones.valor) || [],
      orientacionTexto: v('orientacionTexto'), prestacionIndicada: o('prestacionIndicada'),
    });
    return {
      clinico: { cud: datos.cud || null, ordenMedica: datos.ordenMedica || null, modalidadElegida: datos.modalidadElegida || null },
      recomendacion,
    };
  }

  router.get('/:beneficiarioId/clinico', verifyToken, requireClinico, sinCache, async (req, res) => {
    try {
      const { beneficiarioId } = req.params;
      if (!(await existePaciente(req.tenantId, beneficiarioId))) return res.status(404).json({ ok: false, mensaje: 'Paciente no encontrado.' });
      const datos = await store.ver(req.tenantId, usuarioDe(req), beneficiarioId);
      res.json({ ok: true, modalidades: C.MODALIDADES, ...armarVista(datos) });
    } catch (e) { responderError(res, e, 'ver'); }
  });

  router.put('/:beneficiarioId/clinico', verifyToken, requireClinico, sinCache, async (req, res) => {
    try {
      const { beneficiarioId } = req.params;
      if (!(await existePaciente(req.tenantId, beneficiarioId))) return res.status(404).json({ ok: false, mensaje: 'Paciente no encontrado.' });
      const body = req.body || {};
      let modalidades;
      try { modalidades = body.modalidadElegida === undefined ? undefined : C.sanitizarModalidades(body.modalidadElegida); }
      catch (e) { return res.status(400).json({ ok: false, mensaje: e.mensaje || 'Datos inválidos.' }); }

      let documento = null, campos = {}, quitar = [];
      if (body.documento !== undefined) {
        // Lo vacío se interpreta como "quitar este dato".
        const entrada = body.campos && typeof body.campos === 'object' ? body.campos : {};
        const conValor = {};
        for (const k of Object.keys(entrada)) {
          const x = entrada[k] && typeof entrada[k] === 'object' && !Array.isArray(entrada[k]) ? entrada[k].valor : entrada[k];
          if (x === '' || x === null || (Array.isArray(x) && !x.length)) quitar.push(k); else conValor[k] = entrada[k];
        }
        try {
          const s = C.sanitizarClinicoConfirmado({ documento: body.documento, campos: conValor });
          documento = s.documento; campos = s.campos;
          if (quitar.some(k => !C.camposDe(documento).includes(k))) throw Object.assign(new Error('x'), { mensaje: 'Campo clínico desconocido.' });
        } catch (e) { return res.status(400).json({ ok: false, mensaje: e.mensaje || 'Datos clínicos inválidos.' }); }
      }
      if (!documento && modalidades === undefined) return res.status(400).json({ ok: false, mensaje: 'No hay nada para guardar.' });

      const usuario = usuarioDe(req);
      if (quitar.length) await store.quitarCampos(req.tenantId, usuario, beneficiarioId, documento, quitar);
      if (Object.keys(campos).length || modalidades !== undefined) await store.editar(req.tenantId, usuario, beneficiarioId, Object.keys(campos).length ? documento : null, campos, modalidades);
      const datos = await store.leerInterno(req.tenantId, beneficiarioId);
      res.json({ ok: true, modalidades: C.MODALIDADES, ...armarVista(datos) });
    } catch (e) { responderError(res, e, 'editar'); }
  });

  router.get('/:beneficiarioId/clinico/auditoria', verifyToken, requireClinico, sinCache, async (req, res) => {
    try {
      const { beneficiarioId } = req.params;
      if (!(await existePaciente(req.tenantId, beneficiarioId))) return res.status(404).json({ ok: false, mensaje: 'Paciente no encontrado.' });
      res.json({ ok: true, eventos: await store.auditoria(req.tenantId, beneficiarioId) });
    } catch (e) { responderError(res, e, 'auditoria'); }
  });

  return router;
};
