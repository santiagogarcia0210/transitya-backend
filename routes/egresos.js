const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { verifyToken, requireAdmin, requireModulo } = require('../middleware/auth');
const { normalizarText_, parseMonto_, esMesDMY, col, randomUUID } = require('../utils');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const errHandler = (res, req, e) => {
  console.error('[EGRESOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

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

    res.json({ ok: true, resultados, total, pagina: pg, totalPaginas: Math.max(1, Math.ceil(total / pp)) });
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

router.post('/escanear', verifyToken, async (req, res) => {
  try {
    const { fotoBase64, mimeType } = req.body;
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: fotoBase64 },
          },
          {
            type: 'text',
            text: 'Extraé los datos de este comprobante fiscal. Respondé SOLO con JSON válido sin markdown:\n{"fecha":"dd/MM/yyyy","monto":número,"proveedor":"","cuit":"","nroFactura":"","tipoComprobante":"","concepto":"","categoria":""}',
          },
        ],
      }],
    });
    const raw   = msg.content[0].text.replace(/```json?|```/g, '').trim();
    const datos = JSON.parse(raw);
    res.json({ ok: true, datos });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireModulo('egresos'), async (req, res) => {
  try {
    const data = { ...req.body };
    data.chofer  = req.user.email;
    data.CHOFER  = req.user.email;
    const id = String(data.ID || data.id || '').trim() || randomUUID();
    data.ID = id;
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
    await col(req.tenantId, 'egresos').doc(req.params.id).update(req.body);
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
