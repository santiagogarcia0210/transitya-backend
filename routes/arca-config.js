const router = require('express').Router();
const { db }                                                          = require('../firebase');
const { verifyToken, requireAdmin }                                   = require('../middleware/auth');
const { encriptar, desencriptar }                                     = require('../helpers/cripto');
const { conectarCuentaArca, autorizarWebService, listarPuntosVenta }  = require('../services/afip');

const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));
const arcaRef  = (tenantId) =>
  db.collection('empresas').doc(tenantId).collection('config').doc('arca');

// ── POST /api/arca/conectar ────────────────────────────────────────────────────
// Crea el cert en ARCA, autoriza wsfe, encripta y persiste.
// La claveFiscal se usa solo en este request y se descarta al terminar.
router.post('/conectar', verifyToken, requireAdmin, async (req, res) => {
  const { cuit, claveFiscal, condicionIva, ambiente } = req.body;

  if (!cuit || !claveFiscal || !condicionIva || !ambiente) {
    return res.status(400).json({
      ok: false,
      mensaje: 'cuit, claveFiscal, condicionIva y ambiente son requeridos.',
    });
  }
  if (!['produccion', 'homologacion'].includes(ambiente)) {
    return res.status(400).json({
      ok: false,
      mensaje: 'ambiente debe ser "produccion" o "homologacion".',
    });
  }

  const alias = `ty_${String(cuit).replace(/\D/g, '')}_${ambiente}`;

  try {
    // 1. Crear certificado en ARCA
    const { cert, key } = await conectarCuentaArca({ cuit, claveFiscal, alias, ambiente });

    // 2. Esperar propagación antes de autorizar (ARCA puede tardar en registrar el cert)
    await sleep(15000);

    // 3. Autorizar web service wsfe (con retry interno)
    await autorizarWebService({ cuit, claveFiscal, alias, ambiente });

    // claveFiscal ya no se referencia a partir de acá

    // 4. Encriptar antes de persistir
    const certEncriptado = encriptar(cert);
    const keyEncriptada  = encriptar(key);

    // 5. Calcular vencimiento estimado (2 años, ARCA no lo devuelve en la automation)
    const certVencimiento = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString();

    // 6. Guardar en /empresas/{tenantId}/config/arca
    await arcaRef(req.tenantId).set({
      cuit:                   String(cuit),
      condicionIva,
      ambiente,
      alias,
      certEncriptado,
      keyEncriptada,
      wsAutorizado:           true,
      certVencimiento,
      certVencimientoEstimado: true,
      creadoEn:               new Date().toISOString(),
      actualizadoEn:          new Date().toISOString(),
    });

    res.json({
      ok: true,
      mensaje: 'Cuenta ARCA conectada y wsfe autorizado.',
      cuit: String(cuit),
      ambiente,
    });
  } catch (err) {
    console.error('[ARCA] /conectar error:', err.message);
    res.status(500).json({ ok: false, mensaje: err.message || 'Error al conectar con ARCA.' });
  }
});

// ── GET /api/arca/puntos-venta ────────────────────────────────────────────────
router.get('/puntos-venta', verifyToken, requireAdmin, async (req, res) => {
  try {
    const doc = await arcaRef(req.tenantId).get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, mensaje: 'La empresa no tiene ARCA configurado.' });
    }

    const { cuit, certEncriptado, keyEncriptada, ambiente } = doc.data();
    const cert      = desencriptar(certEncriptado);
    const key       = desencriptar(keyEncriptada);
    const produccion = ambiente === 'produccion';

    const puntosVenta = await listarPuntosVenta({ cuit, cert, key, produccion });

    res.json({ ok: true, puntosVenta });
  } catch (err) {
    console.error('[ARCA] /puntos-venta error:', err.message);
    res.status(500).json({ ok: false, mensaje: err.message });
  }
});

// ── POST /api/arca/punto-venta ────────────────────────────────────────────────
router.post('/punto-venta', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { puntoVenta } = req.body;
    if (!puntoVenta) {
      return res.status(400).json({ ok: false, mensaje: 'puntoVenta es requerido.' });
    }

    await arcaRef(req.tenantId).set(
      { puntoVenta: Number(puntoVenta), actualizadoEn: new Date().toISOString() },
      { merge: true }
    );

    res.json({ ok: true, puntoVenta: Number(puntoVenta) });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: err.message });
  }
});

// ── GET /api/arca/estado ──────────────────────────────────────────────────────
// Devuelve el estado de configuración sin exponer datos sensibles.
router.get('/estado', verifyToken, async (req, res) => {
  try {
    const doc = await arcaRef(req.tenantId).get();
    if (!doc.exists) {
      return res.json({ ok: true, configurado: false });
    }

    const { cuit, condicionIva, puntoVenta, ambiente, certVencimiento, certVencimientoEstimado, wsAutorizado } =
      doc.data();

    res.json({
      ok: true,
      configurado: true,
      cuit,
      condicionIva,
      puntoVenta:              puntoVenta ?? null,
      ambiente,
      certVencimiento,
      certVencimientoEstimado: certVencimientoEstimado ?? false,
      wsAutorizado:            wsAutorizado ?? false,
    });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: err.message });
  }
});

module.exports = router;
