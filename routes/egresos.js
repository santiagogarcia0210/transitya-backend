const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { verifyToken, requireAdmin, requireModulo } = require('../middleware/auth');
const { normalizarText_, parseMonto_, esMesDMY, col, randomUUID } = require('../utils');
const { subirFoto } = require('../helpers/storage');

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

// Parsear dd/MM/yyyy → número YYYYMMDD para ordenar
const fechaSort = (f) => {
  const p = String(f || '').split('/');
  if (p.length < 3) return 0;
  const y = p[2].length === 2 ? '20' + p[2] : p[2];
  return Number(`${y}${p[1].padStart(2, '0')}${p[0].padStart(2, '0')}`);
};

// Parsear dd/MM/yyyy → Date para comparar rangos
const fechaToDate = (f) => {
  const p = String(f || '').split('/');
  if (p.length < 3) return null;
  const y = Number(p[2].length === 2 ? '20' + p[2] : p[2]);
  return new Date(y, Number(p[1]) - 1, Number(p[0]));
};

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
      const d = desde ? new Date(desde) : null;
      const h = hasta ? new Date(hasta) : null;
      todos = todos.filter(doc => {
        const df = fechaToDate(doc.fecha || doc.FECHA || '');
        if (!df) return false;
        if (d && df < d) return false;
        if (h && df > h) return false;
        return true;
      });
    }

    // Sort by FECHA desc
    todos.sort((a, b) => fechaSort(b.fecha || b.FECHA) - fechaSort(a.fecha || a.FECHA));

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
    const snap = await col(req.tenantId, 'egresos').get();
    const df = normalizarText_(String(fecha || ''));
    const dm = String(monto || '').trim();
    const encontrados = snap.docs.filter(d => {
      const doc = d.data();
      return normalizarText_(doc.fecha || doc.FECHA || '') === df &&
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

const PROMPT_EGRESOS =
  'Sos un asistente contable. Analizá el comprobante y extraé los datos.\n' +
  'Respondé ÚNICAMENTE con JSON válido. Sin texto antes ni después. Sin markdown.\n' +
  'Schema (usá null si no podés leer el valor con certeza):\n' +
  '{"fecha":"dd/MM/yyyy o null","monto":número positivo o null,"proveedor":"string o null",' +
  '"cuit":"solo dígitos o null","nroFactura":"string o null",' +
  '"tipoComprobante":"Factura A|Factura B|Ticket|Remito|Otro|null",' +
  '"concepto":"string descriptivo o null",' +
  '"categoria":"Combustible|Repuesto|Mantenimiento|Seguro|Peaje|Limpieza|Otro",' +
  '"requiere_revision":true si foto ilegible o datos dudosos, false si son claros}';

async function llamarIAEgresos(fotoBase64, mimeType, modelo) {
  const msg = await anthropic.messages.create({
    model: modelo, max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: fotoBase64 } },
      { type: 'text', text: PROMPT_EGRESOS },
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
    }

    const requiere_revision = datos.requiere_revision === true || advertencias.length > 0;
    res.json({ ok: true, datos, advertencias, requiere_revision });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireModulo('egresos'), async (req, res) => {
  try {
    const data = { ...req.body };
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
