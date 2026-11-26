// Lectura de documentos del legajo con IA: dos pasos, y recién el segundo guarda.
//
//   POST /api/legajos/:beneficiarioId/leer-ia            sube el archivo y devuelve una PROPUESTA. No toca el legajo.
//   POST /api/legajos/:beneficiarioId/confirmar-lectura  guarda lo que el administrativo revisó y editó.
//
// Colección nueva: empresas/{tenantId}/legajo_lecturas/{beneficiarioId}_{sha256}
//   { beneficiarioId, hash, archivoUrl, archivoNombre, archivoRuta, mime, tamano, resultado (la propuesta de la IA),
//     modelo, uso {entrada, salida}, leidoEn, leidoPor, confirmada, docId, confirmadaEn, confirmadaPor }
// Sirve para dos cosas: no pagar dos veces por leer el mismo archivo del mismo paciente, y auditar qué propuso la IA.
//
// En legajo_docs, los documentos confirmados llevan además: origen "ia", confianzaIA, archivoHash, leidoEn,
// modelo, camposEditados, pacienteConfirmadoManual y datosIA (importe/concepto/validez de un presupuesto).
// NUNCA se escribe nada en el registro del paciente. Los datos de vencimiento no van a la colección `vencimientos`:
// en este sistema los de un paciente se derivan de legajo_docs (checklist), y escribirlos ahí duplicaría la alerta.
//
// Privacidad: a la IA solo le llega el archivo, la obra social y la lista de requisitos. Los logs cuentan archivos y
// tokens; nunca el contenido de un documento ni datos personales.
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, randomUUID, nombreUsuario } = require('../utils');
const { normalizarFecha, fechaToDate } = require('../utils/fechas');
const L = require('../services/legajos');
const S = require('../services/legajoIA');

const ESTADOS_TRAMITE = new Set(['CARGADO', 'PRESENTADO', 'APROBADO', 'OBSERVADO']);
const MAX_ITEMS_CONFIRMAR = 20;
const recortar = (v, max) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));

const moneda = n => `$${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;

/**
 * deps (todas opcionales salvo prepararArchivo; se inyectan en las pruebas):
 *   prepararArchivo(tenantId, beneficiarioId, { base64, mimeType, nombre }) → { archivoUrl, archivoNombre, archivoRuta }
 *   llamador()  → función de IA o null si no hay clave
 *   limitador   → crearLimitador()
 *   ahora()     → Date
 */
module.exports = function crearRouterLegajosIA({ prepararArchivo, llamador = () => S.llamadorAnthropic(), limitador, ahora = () => new Date() }) {
  const router = require('express').Router();
  const limite = limitador || S.crearLimitador({ max: Number(process.env.LEGAJO_IA_MAX_POR_HORA) || 60 });

  async function buscarBeneficiario(tenantId, id) {
    let snap = await col(tenantId, 'registro').doc(id).get();
    if (!snap.exists) snap = await col(tenantId, 'BENEFICIARIOS').doc(id).get();
    return snap.exists ? L.datosBeneficiario({ id: snap.id, ...snap.data() }) : null;
  }

  async function contextoDe(tenantId, beneficiario) {
    const snap = await col(tenantId, 'requisitos_os').get();
    const obras = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const obra = L.matchObraSocial(beneficiario.obraSocial, obras);
    const requisitos = (obra?.requisitos || []).filter(r => r.categoria === 'paciente')
      .map(({ key, nombre, vencimiento, vigenciaMeses }) => ({ key, nombre, vencimiento, vigenciaMeses }));
    return { obra, contexto: { obraNombre: obra?.nombre || '', requisitos } };
  }

  function validarArchivo(a) {
    if (!a || !a.base64) return { error: 'Falta el archivo.' };
    const mime = String(a.mimeType || a.mime || '').toLowerCase();
    if (mime === 'image/heic' || mime === 'image/heif') return { error: 'La IA no lee fotos HEIC de iPhone: pasala a JPEG antes de subirla.' };
    if (!S.MIMES_IA.has(mime)) return { error: 'Formato no permitido. Subí una foto (JPG, PNG o WebP) o un PDF.' };
    const base64 = String(a.base64).replace(/^data:[^,]+,/, '');
    const bytes = Buffer.byteLength(base64, 'base64');
    if (bytes === 0) return { error: 'El archivo está vacío.' };
    if (bytes > S.MAX_BYTES) return { error: 'El archivo supera 8 MB.' };
    const nombre = String(a.nombre || 'documento').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    return { mime, base64, bytes, nombre };
  }

  /** Mensaje en castellano para un error de la IA (sin incluir nada del documento). */
  function explicarErrorIA(e) {
    const st = e.status;
    if (e.codigo === 'incompleta') return 'La IA no alcanzó a terminar de leer el documento. Probá de nuevo o con una foto más clara.';
    if (e.codigo === 'rechazo') return 'La IA no pudo leer este documento.';
    if (e.codigo === 'sin_json') return 'La IA devolvió una respuesta que no se pudo interpretar. Probá de nuevo.';
    if (st === 429 || st === 529 || st === 503 || st === 502) return 'La IA está ocupada en este momento. Probá de nuevo en un minuto.';
    if (st === 400) return 'No se pudo leer ese archivo (¿está dañado o protegido con contraseña?).';
    if (st === 401 || st === 403) return 'La lectura con IA no está disponible por un problema de configuración. Avisá a soporte.';
    if (/timeout/i.test(String(e.name)) || e.code === 'ETIMEDOUT') return 'La IA tardó demasiado. Probá de nuevo.';
    return 'No se pudo leer el documento. Probá de nuevo.';
  }

  const itemDeLectura = (lec, beneficiario, extra = {}) => {
    const v = S.verificarPaciente(lec.resultado, beneficiario);
    return { ok: true, hash: lec.hash, archivoUrl: lec.archivoUrl, archivoNombre: lec.archivoNombre, ...v, ...extra };
  };

  /* ── 1) Leer: devuelve propuestas, no guarda en el legajo ─────────────────── */
  router.post('/:beneficiarioId/leer-ia', verifyToken, requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      const llamar = llamador();
      if (!llamar) return res.status(503).json({ ok: false, mensaje: 'La lectura con IA no está configurada en el servidor (falta la clave de la IA). Avisá a soporte; mientras tanto podés cargar los documentos a mano.' });

      const { beneficiarioId } = req.params;
      const body = req.body || {};
      const archivos = Array.isArray(body.archivos) ? body.archivos : [];
      if (archivos.length < 1) return res.status(400).json({ ok: false, mensaje: 'Subí al menos un archivo.' });
      if (archivos.length > S.MAX_ARCHIVOS) return res.status(400).json({ ok: false, mensaje: `Subí hasta ${S.MAX_ARCHIVOS} archivos por vez.` });

      const beneficiario = await buscarBeneficiario(req.tenantId, beneficiarioId);
      if (!beneficiario) return res.status(404).json({ ok: false, mensaje: 'Paciente no encontrado.' });

      // Fase 1: validar, hashear y buscar en la caché (no cuesta nada).
      const lecturas = col(req.tenantId, 'legajo_lecturas');
      const vistos = new Set();
      const filas = [];
      for (let i = 0; i < archivos.length; i++) {
        const v = validarArchivo(archivos[i]);
        const base = { indice: i, nombreArchivo: v.nombre || String(archivos[i]?.nombre || '').slice(0, 80) };
        if (v.error) { filas.push({ ...base, ok: false, mensaje: v.error }); continue; }
        const hash = S.hashArchivo(v.base64);
        if (vistos.has(hash)) { filas.push({ ...base, ok: false, mensaje: 'Este archivo está repetido en la tanda.' }); continue; }
        vistos.add(hash);
        let lec = null;
        if (body.forzar !== true) {
          const snap = await lecturas.doc(`${beneficiarioId}_${hash}`).get();
          if (snap.exists) lec = snap.data();
        }
        filas.push({ ...base, v, hash, lec });
      }

      // Fase 2: el cupo por empresa se reserva solo para lo que va a la IA.
      const pendientes = filas.filter(f => f.v && !f.lec);
      if (pendientes.length) {
        const r = limite.reservar(req.tenantId, pendientes.length);
        if (!r.ok) {
          const min = Math.max(1, Math.ceil(r.reintentarEnMs / 60000));
          return res.status(429).json({ ok: false, mensaje: `Llegaste al límite de lecturas con IA por hora (${limite.max}). Quedan ${r.disponibles}; probá de nuevo en ${min} minuto${min === 1 ? '' : 's'}.` });
        }
      }

      // Fase 3: leer lo que no estaba en la caché, de a uno (más fácil de controlar el gasto).
      const { contexto } = pendientes.length ? await contextoDe(req.tenantId, beneficiario) : { contexto: null };
      const resultados = [];
      let tokensEntrada = 0, tokensSalida = 0, leidos = 0, deCache = 0;
      for (const f of filas) {
        if (!f.v) { resultados.push(f); continue; }
        if (f.lec) {
          deCache++;
          let yaCargado = null;
          if (f.lec.confirmada && f.lec.docId) {
            const d = await col(req.tenantId, 'legajo_docs').doc(f.lec.docId).get();
            if (d.exists) yaCargado = { docId: f.lec.docId };
          }
          resultados.push({ indice: f.indice, nombreArchivo: f.nombreArchivo, ...itemDeLectura(f.lec, beneficiario, { repetido: true, yaCargado }) });
          continue;
        }
        try {
          const { lectura, uso, modelo } = await S.leerDocumento({ archivo: { base64: f.v.base64, mime: f.v.mime }, contexto, beneficiario, llamar, ahora: ahora() });
          // Recién ahora se sube el original: si la IA falló no queda un archivo huérfano.
          const arch = await prepararArchivo(req.tenantId, beneficiarioId, { base64: f.v.base64, mimeType: f.v.mime, nombre: f.v.nombre });
          const lec = {
            beneficiarioId, hash: f.hash, archivoUrl: arch.archivoUrl, archivoNombre: arch.archivoNombre, archivoRuta: arch.archivoRuta,
            mime: f.v.mime, tamano: f.v.bytes, resultado: lectura, modelo, uso, leidoEn: ahora().toISOString(),
            leidoPor: nombreUsuario(req.user), confirmada: false, docId: null,
          };
          await lecturas.doc(`${beneficiarioId}_${f.hash}`).set(lec);
          tokensEntrada += uso.entrada || 0; tokensSalida += uso.salida || 0; leidos++;
          resultados.push({ indice: f.indice, nombreArchivo: f.nombreArchivo, ...itemDeLectura(lec, beneficiario, { repetido: false, yaCargado: null }) });
        } catch (e) {
          limite.devolver(req.tenantId, 1);   // si falló no se cobró: se devuelve el cupo
          console.error('[LEGAJO-IA] error al leer', { estado: e.status || null, tipo: e.codigo || e.name });
          resultados.push({ indice: f.indice, nombreArchivo: f.nombreArchivo, ok: false, mensaje: explicarErrorIA(e) });
        }
      }

      // Solo cantidades: nunca el contenido de un documento ni datos de pacientes.
      console.log('[LEGAJO-IA] lectura', JSON.stringify({ tenant: req.tenantId, archivos: archivos.length, leidos, deCache, tokensEntrada, tokensSalida, ms: Date.now() - t0 }));
      res.json({ ok: true, beneficiario: { id: beneficiario.id, nombre: beneficiario.nombre }, obraNombre: contexto?.obraNombre ?? null, resultados });
    } catch (e) {
      console.error('[LEGAJO-IA] error', e.message);
      res.status(500).json({ ok: false, mensaje: 'No se pudo leer los documentos. Probá de nuevo.' });
    }
  });

  /* ── 2) Confirmar: recién acá se guarda ───────────────────────────────────── */
  router.post('/:beneficiarioId/confirmar-lectura', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { beneficiarioId } = req.params;
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length < 1) return res.status(400).json({ ok: false, mensaje: 'No hay nada para confirmar.' });
      if (items.length > MAX_ITEMS_CONFIRMAR) return res.status(400).json({ ok: false, mensaje: `Confirmá hasta ${MAX_ITEMS_CONFIRMAR} documentos por vez.` });

      const beneficiario = await buscarBeneficiario(req.tenantId, beneficiarioId);
      if (!beneficiario) return res.status(404).json({ ok: false, mensaje: 'Paciente no encontrado.' });
      const { contexto } = await contextoDe(req.tenantId, beneficiario);

      const resultados = [];
      for (const item of items) {
        const hash = String(item?.hash || '');
        const fallo = (status, mensaje) => resultados.push({ hash, ok: false, status, mensaje });
        if (!/^[a-f0-9]{64}$/.test(hash)) { fallo(400, 'Falta identificar el archivo.'); continue; }

        // La URL del archivo y la propuesta salen del servidor (por hash), nunca de lo que mande el cliente.
        const lecRef = col(req.tenantId, 'legajo_lecturas').doc(`${beneficiarioId}_${hash}`);
        const lecSnap = await lecRef.get();
        if (!lecSnap.exists) { fallo(404, 'No encontramos esa lectura. Volvé a subir el archivo.'); continue; }
        const lec = lecSnap.data();

        // Idempotente: si ya se confirmó y el documento sigue en la carpeta, no se duplica.
        if (lec.confirmada && lec.docId && !item.docId) {
          const ya = await col(req.tenantId, 'legajo_docs').doc(lec.docId).get();
          if (ya.exists) { resultados.push({ hash, ok: true, id: lec.docId, yaExistia: true }); continue; }
        }

        const ver = S.verificarPaciente(lec.resultado, beneficiario);
        if (ver.posiblePacienteEquivocado && item.aceptarPacienteDistinto !== true) {
          fallo(409, 'Este documento parece ser de otra persona. Si igual querés guardarlo en esta carpeta, confirmalo de forma explícita.'); continue;
        }

        const key = String(item.requisitoKey || 'otro');
        const requisito = key === 'otro' ? null : contexto.requisitos.find(r => r.key === key);
        if (key !== 'otro' && !requisito) { fallo(400, 'Ese tipo de documento no existe en los requisitos de la obra social.'); continue; }
        const nombre = requisito ? requisito.nombre : recortar(item.nombre, 120);
        if (!nombre) { fallo(400, 'Poné el nombre del documento.'); continue; }

        const fechaEmision = item.fechaEmision ? normalizarFecha(item.fechaEmision) : '';
        const fechaVenc = item.fechaVenc ? normalizarFecha(item.fechaVenc) : '';
        if (item.fechaEmision && !fechaEmision) { fallo(400, 'La fecha de emisión no es válida.'); continue; }
        if (item.fechaVenc && !fechaVenc) { fallo(400, 'La fecha de vencimiento no es válida.'); continue; }
        if (fechaEmision && fechaVenc && fechaToDate(fechaVenc) < fechaToDate(fechaEmision)) { fallo(400, 'El vencimiento no puede ser anterior a la emisión.'); continue; }
        if (requisito && requisito.vencimiento === 'fecha_doc' && !fechaVenc) { fallo(400, 'Este documento necesita la fecha de vencimiento.'); continue; }
        const estadoTramite = ESTADOS_TRAMITE.has(item.estadoTramite) ? item.estadoTramite : 'CARGADO';

        // Datos de un presupuesto: no tienen campo propio en legajo_docs; van en notas (legible) y en datosIA.
        const d = item.datos && typeof item.datos === 'object' ? item.datos : {};
        const importe = S.parseImporte(d.importe);
        const datosIA = {};
        if (importe !== null) datosIA.importe = importe;
        if (recortar(d.concepto, 200)) datosIA.concepto = recortar(d.concepto, 200);
        if (recortar(d.validez, 100)) datosIA.validez = recortar(d.validez, 100);
        if (recortar(d.emisor, 120)) datosIA.emisor = recortar(d.emisor, 120);
        const partesNota = [];
        if (datosIA.importe !== undefined) partesNota.push(`Importe ${moneda(datosIA.importe)}`);
        if (datosIA.concepto) partesNota.push(`Concepto: ${datosIA.concepto}`);
        if (datosIA.validez) partesNota.push(`Validez: ${datosIA.validez}`);
        if (datosIA.emisor) partesNota.push(`Emite: ${datosIA.emisor}`);
        const notas = [recortar(item.notas, 500), partesNota.join(' · ')].filter(Boolean).join(' — ');

        const base = lec.resultado || {};
        const camposEditados = [
          ...(key !== (base.requisitoKey || 'otro') ? ['requisitoKey'] : []),
          ...(fechaEmision !== (base.fechaEmision || '') ? ['fechaEmision'] : []),
          ...(fechaVenc !== (base.fechaVenc || '') ? ['fechaVenc'] : []),
        ];
        const campos = {
          requisitoKey: key, nombre, fechaEmision, fechaVenc, estadoTramite, notas,
          archivoUrl: lec.archivoUrl, archivoNombre: lec.archivoNombre, archivoRuta: lec.archivoRuta,
          origen: 'ia', confianzaIA: base.confianzaGeneral || 'baja', archivoHash: hash, leidoEn: lec.leidoEn, modelo: lec.modelo || '',
          camposEditados, pacienteConfirmadoManual: ver.posiblePacienteEquivocado === true, datosIA,
          revisadoPor: nombreUsuario(req.user),
        };

        const ahoraIso = ahora().toISOString();
        let id;
        if (item.docId) {
          // Reemplazar un documento existente (en vez de sumar una versión nueva al historial).
          const ref = col(req.tenantId, 'legajo_docs').doc(String(item.docId));
          const prev = await ref.get();
          if (!prev.exists || prev.data().beneficiarioId !== beneficiarioId) { fallo(404, 'El documento a reemplazar no está en esta carpeta.'); continue; }
          await ref.update({ ...campos, actualizadoEn: ahoraIso, actualizadoPor: nombreUsuario(req.user) });
          id = String(item.docId);
        } else {
          id = randomUUID();
          await col(req.tenantId, 'legajo_docs').doc(id).set({
            ...campos, id, beneficiarioId, beneficiarioNombre: beneficiario.nombre, creadoEn: ahoraIso, creadoPor: nombreUsuario(req.user),
          });
        }
        await lecRef.update({ confirmada: true, docId: id, confirmadaEn: ahoraIso, confirmadaPor: nombreUsuario(req.user) });
        resultados.push({ hash, ok: true, id, yaExistia: false });
      }
      res.json({ ok: true, resultados });
    } catch (e) {
      console.error('[LEGAJO-IA] error al confirmar', e.message);
      res.status(500).json({ ok: false, mensaje: 'No se pudo guardar. Probá de nuevo.' });
    }
  });

  return router;
};
