const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { verifyToken, requireAdmin, requireModulo } = require('../middleware/auth');
const { normalizarText_, parseMonto_, esMesDMY, col, randomUUID } = require('../utils');
const { subirFoto } = require('../helpers/storage');
const { normalizarFecha, fechaToDate, fechaDoc, ordenarPorFechaDesc } = require('../utils/fechas');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const errHandler = (res, req, e) => {
  console.error('[EGRESOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

async function procesarComprobante(data, tenantId, id) {
  const raw = data.comprobante;
  if (!raw || !String(raw).startsWith('data:')) return;

  const matches = String(raw).match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) {
    delete data.comprobante;
    return;
  }

  const mimeType = matches[1];
  const base64   = matches[2];
  const ext      = mimeType.split('/')[1] || 'jpg';
  const ruta     = `empresas/${tenantId}/egresos/${id}/comprobante.${ext}`;

  try {
    const url      = await subirFoto(base64, mimeType, ruta);
    data.comprobanteUrl = url;
    data.comprobante    = url;
  } catch (e) {
    console.error('[EGRESOS] Storage upload error:', e.message);
    delete data.comprobante;
    throw new Error('No se pudo subir el comprobante. Intentá de nuevo en unos segundos.');
  }
}

const MSG_FECHA = 'La fecha no es válida. Usá el formato dd/MM/yyyy (por ejemplo 05/11/2026).';

router.get('/', verifyToken, requireModulo('egresos'), async (req, res) => {
  try {
    const { q, page, limit, desde, hasta, categoria, chofer, montoMin, montoMax } = req.query;
    const snap = await col(req.tenantId, 'egresos').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador';

    // Non-admins only see their own
    if (!isAdmin) {
      todos = todos.filter(doc =>
        normalizarText_(doc.chofer || doc.CHOFER || doc.usuario || doc.USUARIO || '') ===
        normalizarText_(req.user.email)
      );
    }

    // Filters
    if (q) {
      const qn = normalizarText_(q);
      todos = todos.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(qn));
    }
    if (isAdmin && chofer) {
      const cn = normalizarText_(chofer);
      todos = todos.filter(doc => normalizarText_(doc.chofer || doc.CHOFER || '').includes(cn));
    }
    if (categoria) {
      const cn = normalizarText_(categoria);
      todos = todos.filter(doc => normalizarText_(doc.categoria || doc.CATEGORIA || doc.tipo || doc.TIPO || '').includes(cn));
    }
    if (montoMin !== undefined || montoMax !== undefined) {
      const min = montoMin !== undefined ? parseFloat(montoMin) : null;
      const max = montoMax !== undefined ? parseFloat(montoMax) : null;
      todos = todos.filter(doc => {
        const m = parseMonto_(doc.monto || doc.MONTO || 0);
        if (min !== null && m < min) return false;
        if (max !== null && m > max) return false;
        return true;
      });
    }
    if (desde || hasta) {
      // desde/hasta llegan en ISO (input type=date); fechaToDate entiende ISO y dd/MM/yyyy.
      const d = fechaToDate(desde);
      const h = fechaToDate(hasta);
      todos = todos.filter(doc => {
        const df = fechaToDate(fechaDoc(doc));
        if (!df) return false;
        if (d && df < d) return false;
        if (h && df > h) return false;
        return true;
      });
    }

    // Fecha desc; a igual fecha, el cargado más tarde primero. Sin fecha válida, al final.
    ordenarPorFechaDesc(todos);

    // Pagination
    const pp  = Math.max(1, parseInt(limit) || 50);
    const pg  = Math.max(1, parseInt(page) || 1);
    const total = todos.length;
    const resultados = todos.slice((pg - 1) * pp, pg * pp);

    res.json({
      ok: true,
      resultados: resultados.map(d => ({
        ...d,
        monto: Number(d.monto || d.MONTO || 0),
        comprobante: d.comprobanteUrl || d.comprobante || '',
      })),
      total, pagina: pg, totalPaginas: Math.max(1, Math.ceil(total / pp)),
    });
  } catch (e) { errHandler(res, req, e); }
});

// GET /duplicado must be before GET /:id
router.get('/duplicado', verifyToken, requireModulo('egresos'), async (req, res) => {
  try {
    const { fecha, monto } = req.query;
    // Las dos fechas se normalizan antes de comparar: 2026-11-05 y 05/11/2026 son el mismo día.
    // Si la recibida no se entiende no hay nada que comparar: dos fechas inválidas darían ''
    // y se igualarían (falso duplicado).
    const df = normalizarFecha(fecha);
    if (!df) return res.json({ ok: true, duplicado: false, cantidad: 0 });
    const snap = await col(req.tenantId, 'egresos').get();
    const dm = String(monto || '').trim();
    const encontrados = snap.docs.filter(d => {
      const doc = d.data();
      return fechaDoc(doc) === df &&
             String(doc.monto || doc.MONTO || '').trim() === dm;
    });
    res.json({ ok: true, duplicado: encontrados.length > 0, cantidad: encontrados.length });
  } catch (e) { res.json({ ok: true, duplicado: false }); }
});

router.get('/:id', verifyToken, requireModulo('egresos'), async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'egresos').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
    res.json({ ok: true, egreso: { id: doc.id, ...doc.data() } });
  } catch (e) { errHandler(res, req, e); }
});

const HAIKU  = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const MIMES_OK = new Set(['image/jpeg','image/png','image/gif','image/webp']);
const MAX_B64  = 6_000_000; // ~4.5 MB imagen original

function buildPromptEgresos() {
  const anioActual = new Date().getFullYear();
  return (
    'Sos un asistente contable argentino. Analizá el comprobante y extraé los datos.\n' +
    `Hoy estamos en el año ${anioActual}. Los comprobantes son documentos recientes, normalmente del mismo mes o del mes anterior.\n` +
    `Si el año aparece con 2 dígitos (ej "25"), expandilo al siglo actual (→ "${anioActual}"), NUNCA a 1900s o 2000s tempranos.\n` +
    'Respondé ÚNICAMENTE con JSON válido. Sin texto antes ni después. Sin markdown.\n' +
    'Schema (usá null si no podés leer el valor con certeza):\n' +
    '{"fecha":"dd/MM/yyyy o null","monto":número positivo o null,"proveedor":"string o null",' +
    '"cuit":"solo dígitos o null","nroFactura":"string o null",' +
    '"tipoComprobante":"Factura A|Factura B|Ticket|Remito|Otro|null",' +
    '"concepto":"string descriptivo o null",' +
    '"categoria":"Combustible|Repuesto|Mantenimiento|Seguro|Peaje|Limpieza|Otro",' +
    '"requiere_revision":true si foto ilegible o datos dudosos, false si son claros}'
  );
}

async function llamarIAEgresos(fotoBase64, mimeType, modelo) {
  const msg = await anthropic.messages.create({
    model: modelo, max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: fotoBase64 } },
      { type: 'text', text: buildPromptEgresos() },
    ]}],
  });
  const raw = msg.content[0].text;
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i === -1 || j === -1) throw new Error('Sin JSON en la respuesta del modelo');
  return JSON.parse(raw.slice(i, j + 1));
}

router.post('/escanear', verifyToken, async (req, res) => {
  try {
    const { fotoBase64, mimeType } = req.body;
    if (!fotoBase64 || !mimeType)
      return res.status(400).json({ ok: false, mensaje: 'Falta imagen o tipo de archivo.' });
    if (!MIMES_OK.has(mimeType))
      return res.status(400).json({ ok: false, mensaje: `Formato no soportado (${mimeType}). Usá JPG o PNG.` });
    if (fotoBase64.length > MAX_B64)
      return res.status(400).json({ ok: false, mensaje: 'La imagen es demasiado grande. Tomá la foto con menor resolución.' });

    let datos;
    try {
      datos = await llamarIAEgresos(fotoBase64, mimeType, HAIKU);
    } catch {
      try { datos = await llamarIAEgresos(fotoBase64, mimeType, SONNET); }
      catch { return res.status(422).json({ ok: false, mensaje: 'No se pudo leer el comprobante. Intentá con una foto más nítida.' }); }
    }

    const advertencias = [];
    const montoNum = Number(datos.monto);
    if (!datos.monto || isNaN(montoNum) || montoNum <= 0) {
      advertencias.push('Monto no detectado o inválido');
      datos.monto = null;
    } else {
      datos.monto = montoNum;
    }
    if (datos.fecha && !/^\d{2}\/\d{2}\/\d{4}$/.test(String(datos.fecha))) {
      advertencias.push('Fecha en formato incorrecto');
      datos.fecha = null;
    } else if (datos.fecha) {
      const anioActual = new Date().getFullYear();
      const anio = parseInt(String(datos.fecha).split('/')[2]);
      if (anio < anioActual - 2 || anio > anioActual + 1) {
        advertencias.push(`Año ${anio} inverosímil — verificá la fecha`);
      }
    }

    const requiere_revision = datos.requiere_revision === true || advertencias.length > 0;
    res.json({ ok: true, datos, advertencias, requiere_revision });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireModulo('egresos'), async (req, res) => {
  try {
    const data = { ...req.body };
    // La fecha es obligatoria y se guarda siempre como dd/MM/yyyy (el input type=date manda ISO).
    const fecha = normalizarFecha(data.fecha);
    if (!fecha) {
      const falta = data.fecha === undefined || data.fecha === null || String(data.fecha).trim() === '';
      return res.status(400).json({ ok: false, mensaje: falta ? 'Falta la fecha del egreso.' : MSG_FECHA });
    }
    data.fecha = fecha;
    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador';
    // Choferes: siempre auto-asignados. Admins: respetar el chofer elegido; fallback a su email si no enviaron ninguno.
    if (!isAdmin || !data.chofer) {
      data.chofer = req.user.email;
      data.CHOFER = req.user.email;
    } else {
      data.CHOFER = data.chofer;
    }
    const id = String(data.ID || data.id || '').trim() || randomUUID();
    data.ID = id;
    await procesarComprobante(data, req.tenantId, id);
    await col(req.tenantId, 'egresos').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'EGRESO GUARDADO', id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireModulo('egresos'), async (req, res) => {
  try {
    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador';
    if (!isAdmin) {
      const doc = await col(req.tenantId, 'egresos').doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
      const chofer = doc.data().chofer || doc.data().CHOFER || '';
      if (normalizarText_(chofer) !== normalizarText_(req.user.email))
        return res.status(403).json({ ok: false, mensaje: 'Sin permisos' });
    }
    const data = { ...req.body };
    if (data.fecha !== undefined) {
      const fecha = normalizarFecha(data.fecha);
      if (!fecha) return res.status(400).json({ ok: false, mensaje: MSG_FECHA });
      data.fecha = fecha;
    }
    await procesarComprobante(data, req.tenantId, req.params.id);
    await col(req.tenantId, 'egresos').doc(req.params.id).update(data);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await col(req.tenantId, 'egresos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
