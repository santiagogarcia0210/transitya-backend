// Lectura de la impresión de Google Maps de un viaje (un archivo por pedido, por el límite del proxy de Vercel):
//   POST /api/presupuestos/leer-recorrido   { beneficiarioId, centro?, archivo: { base64, mimeType, nombre }, forzar? }
// Sube el original a Storage (respaldo del presupuesto), lo lee con la IA y devuelve la PROPUESTA con la verificación
// contra el domicilio del paciente y el centro. NO guarda nada en el presupuesto: lo confirma el administrativo.
// Mismo esquema que la lectura de documentos del legajo: cliente inyectable, caché por sha256 (no se paga dos veces),
// límite por empresa, 503 sin clave, logs solo con cantidades y tokens.
//   caché: empresas/{t}/recorrido_lecturas/{beneficiarioId}_{sha256}
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, randomUUID, nombreUsuario } = require('../utils');
const S = require('../services/legajoIA');
const R = require('../services/recorridoIA');

const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

module.exports = function crearRouterRecorrido({ llamador = () => S.llamadorAnthropic(), limitador, subirArchivo, ahora = () => new Date() } = {}) {
  const router = require('express').Router();
  const limite = limitador || S.crearLimitador({ max: Number(process.env.RECORRIDO_IA_MAX_POR_HORA) || 60 });
  const subir = subirArchivo || ((...a) => require('../helpers/storage').subirFoto(...a));

  const explicar = e => {
    if (e.codigo === 'incompleta') return 'La IA no alcanzó a terminar de leer el recorrido. Probá de nuevo o con una captura más clara.';
    if (e.codigo === 'rechazo') return 'La IA no pudo leer este archivo.';
    if (e.codigo === 'sin_json') return 'La IA devolvió una respuesta que no se pudo interpretar. Probá de nuevo.';
    if ([429, 502, 503, 529].includes(e.status)) return 'La IA está ocupada en este momento. Probá de nuevo en un minuto.';
    if (e.status === 400) return 'No se pudo leer ese archivo (¿está dañado o protegido con contraseña?).';
    if (e.status === 401 || e.status === 403) return 'La lectura con IA no está disponible por un problema de configuración. Avisá a soporte.';
    return 'No se pudo leer el recorrido. Probá de nuevo o cargá los km a mano.';
  };

  router.post('/leer-recorrido', verifyToken, requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      const llamar = llamador();
      if (!llamar) return res.status(503).json({ ok: false, mensaje: 'La lectura con IA no está configurada en el servidor (falta la clave de la IA). Cargá los km a mano o avisá a soporte.' });
      const t = req.tenantId, b = req.body || {}, a = b.archivo;
      if (!a || !a.base64) return res.status(400).json({ ok: false, mensaje: 'Falta el archivo.' });
      const mime = String(a.mimeType || a.mime || '').toLowerCase();
      if (mime === 'image/heic' || mime === 'image/heif') return res.status(400).json({ ok: false, mensaje: 'Las fotos HEIC de iPhone no se pueden leer: pasala a JPEG.' });
      if (!MIMES.has(mime)) return res.status(400).json({ ok: false, mensaje: 'Formato no permitido. Subí una imagen (JPG, PNG o WebP) o un PDF.' });
      const base64 = String(a.base64).replace(/^data:[^,]+,/, '');
      const bytes = Buffer.byteLength(base64, 'base64');
      if (!bytes) return res.status(400).json({ ok: false, mensaje: 'El archivo está vacío.' });
      if (bytes > S.MAX_BYTES) return res.status(400).json({ ok: false, mensaje: 'El archivo supera 8 MB.' });

      let reg = await col(t, 'registro').doc(String(b.beneficiarioId || '')).get();
      if (!reg.exists) reg = await col(t, 'BENEFICIARIOS').doc(String(b.beneficiarioId || '')).get();
      if (!reg.exists) return res.status(404).json({ ok: false, mensaje: 'Paciente no encontrado.' });
      const raw = reg.data();
      const domicilioPaciente = String(raw.DOMICILIO || raw.domicilio || '');
      const centro = String(b.centro || '').slice(0, 200);
      const verificar = p => R.verificarRecorrido({ origen: p.origen.texto, destino: p.destino.texto }, { domicilioPaciente, centro });

      const hash = S.hashArchivo(base64);
      const ref = col(t, 'recorrido_lecturas').doc(`${reg.id}_${hash}`);
      if (b.forzar !== true) {
        const c = await ref.get();
        if (c.exists) {
          const l = c.data();
          console.log('[RECORRIDO-IA] lectura', JSON.stringify({ tenant: t, deCache: 1, ms: Date.now() - t0 }));
          return res.json({ ok: true, hash, archivoUrl: l.archivoUrl, archivoNombre: l.archivoNombre, repetido: true, propuesta: l.propuesta, verificacion: verificar(l.propuesta) });
        }
      }
      const cupo = limite.reservar(t, 1);
      if (!cupo.ok) {
        const min = Math.max(1, Math.ceil(cupo.reintentarEnMs / 60000));
        return res.status(429).json({ ok: false, mensaje: `Llegaste al límite de lecturas con IA por hora (${limite.max}). Probá de nuevo en ${min} minuto${min === 1 ? '' : 's'}.` });
      }
      let leido;
      try { leido = await R.leerRecorrido({ archivo: { base64, mime }, llamar }); }
      catch (e) {
        limite.devolver(t, 1);
        console.error('[RECORRIDO-IA] error al leer', { estado: e.status || null, tipo: e.codigo || e.name });
        return res.status(502).json({ ok: false, mensaje: explicar(e) });
      }
      // Recién ahora se sube el original: si la IA falló no queda un archivo huérfano.
      const nombre = String(a.nombre || 'recorrido').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
      const ruta = `presupuestos-recorridos/${t}/${reg.id}/${randomUUID()}-${nombre}`;
      const archivoUrl = await subir(base64, mime, ruta);
      await ref.set({ beneficiarioId: reg.id, hash, archivoUrl, archivoNombre: nombre, archivoRuta: ruta, mime, tamano: bytes, propuesta: leido.propuesta, modelo: leido.modelo, uso: leido.uso, leidoEn: ahora().toISOString(), leidoPor: nombreUsuario(req.user) });
      console.log('[RECORRIDO-IA] lectura', JSON.stringify({ tenant: t, leidos: 1, tokensEntrada: leido.uso.entrada || 0, tokensSalida: leido.uso.salida || 0, ms: Date.now() - t0 }));
      res.json({ ok: true, hash, archivoUrl, archivoNombre: nombre, repetido: false, propuesta: leido.propuesta, verificacion: verificar(leido.propuesta) });
    } catch (e) {
      console.error('[RECORRIDO-IA] error', { tipo: e.codigo || e.name });
      res.status(500).json({ ok: false, mensaje: 'No se pudo leer el recorrido. Probá de nuevo.' });
    }
  });

  return router;
};
