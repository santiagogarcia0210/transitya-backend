const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, fechaHoyAR, col, randomUUID } = require('../utils');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const errHandler = (res, req, e) => {
  console.error('[REMITOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const fechaSort = (f) => {
  const p = String(f || '').split('/');
  if (p.length < 3) return 0;
  const y = p[2].length === 2 ? '20' + p[2] : p[2];
  return Number(`${y}${p[1].padStart(2, '0')}${p[0].padStart(2, '0')}`);
};

// ISO yyyy-MM-dd → dd/MM/yyyy
const isoToDMY = (f) => {
  if (!f || !f.includes('-')) return f;
  const [y, m, d] = f.split('-');
  return `${d}/${m}/${y}`;
};

// GET /duplicado must be before GET /:id
router.get('/duplicado', verifyToken, async (req, res) => {
  try {
    const { nroRemito, cuit } = req.query;
    if (!nroRemito) return res.json({ ok: true, duplicado: false });
    const snap = await col(req.tenantId, 'remitos').get();
    const nroNorm  = normalizarText_(String(nroRemito).trim());
    const cuitNorm = normalizarText_(String(cuit || '').replace(/[\s-]/g, ''));
    const duplicado = snap.docs.some(d => {
      const doc = d.data();
      const rNro  = normalizarText_(String(doc.nroRemito || doc['N° REMITO'] || '').trim());
      const rCuit = normalizarText_(String(doc.cuit || doc.CUIT || '').replace(/[\s-]/g, ''));
      return rNro === nroNorm && (!cuitNorm || rCuit === cuitNorm);
    });
    res.json({ ok: true, duplicado });
  } catch (e) { res.json({ ok: true, duplicado: false }); }
});

router.get('/', verifyToken, async (req, res) => {
  try {
    const { q, page, limit, desde, hasta } = req.query;
    const snap = await col(req.tenantId, 'remitos').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador';
    if (!isAdmin) {
      todos = todos.filter(doc =>
        normalizarText_(doc.chofer || doc.CHOFER || '') ===
        normalizarText_(req.user.email)
      );
    }

    if (q) {
      const qn = normalizarText_(q);
      todos = todos.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(qn));
    }
    if (desde || hasta) {
      const d = desde ? new Date(desde) : null;
      const h = hasta ? new Date(hasta) : null;
      todos = todos.filter(doc => {
        const p = String(doc.fecha || doc.FECHA || '').split('/');
        if (p.length < 3) return false;
        const y  = Number(p[2].length === 2 ? '20' + p[2] : p[2]);
        const df = new Date(y, Number(p[1]) - 1, Number(p[0]));
        if (d && df < d) return false;
        if (h && df > h) return false;
        return true;
      });
    }

    todos.sort((a, b) => fechaSort(b.fecha || b.FECHA) - fechaSort(a.fecha || a.FECHA));

    const pp    = Math.max(1, parseInt(limit) || 50);
    const pg    = Math.max(1, parseInt(page) || 1);
    const total = todos.length;
    res.json({
      ok: true,
      resultados: todos.slice((pg - 1) * pp, pg * pp),
      total, pagina: pg,
      totalPaginas: Math.max(1, Math.ceil(total / pp)),
    });
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
            text: 'Extraé los datos de este remito de combustible. Respondé SOLO con JSON válido sin markdown:\n{"nroRemito":"","razonSocial":"","cuit":"","fecha":"dd/MM/yyyy","combustible":número,"monto":número,"tipoCombustible":""}',
          },
        ],
      }],
    });
    const datos = JSON.parse(msg.content[0].text);
    res.json({ ok: true, datos });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, async (req, res) => {
  try {
    const data = { ...req.body };
    const id = randomUUID();
    const fecha = isoToDMY(data.fecha || '') || fechaHoyAR();
    const doc = {
      ID:            id,
      fecha,
      nroRemito:     data.nroRemito     || '',
      razonSocial:   data.razonSocial   || '',
      cuit:          data.cuit          || '',
      combustible:   data.combustible   || '',
      monto:         data.monto         || '',
      observaciones: data.observaciones || '',
      comprobante:   data.comprobante   || '',
      chofer:        req.user.email,
      CHOFER:        req.user.email,
      creadoEn:      new Date(),
    };
    await col(req.tenantId, 'remitos').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Remito guardado correctamente.', id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, async (req, res) => {
  try {
    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador';
    if (!isAdmin) {
      const snap = await col(req.tenantId, 'remitos').doc(req.params.id).get();
      if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
      const chofer = snap.data().chofer || snap.data().CHOFER || '';
      if (normalizarText_(chofer) !== normalizarText_(req.user.email))
        return res.status(403).json({ ok: false, mensaje: 'Sin permisos' });
    }
    await col(req.tenantId, 'remitos').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await col(req.tenantId, 'remitos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── PDF DATA ─────────────────────────────────────────────────────────────────

router.get('/pdf-data', verifyToken, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    let { chofer } = req.query;
    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador';
    if (!isAdmin) chofer = req.user.email;

    const snap = await col(req.tenantId, 'remitos').get();
    let remitos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (chofer) {
      const cn = normalizarText_(chofer);
      remitos = remitos.filter(r => normalizarText_(r.chofer || r.CHOFER || '') === cn);
    }
    if (desde || hasta) {
      const dDesde = desde ? new Date(desde) : null;
      const dHasta = hasta ? new Date(hasta) : null;
      remitos = remitos.filter(r => {
        const p = String(r.fecha || r.FECHA || '').split('/');
        if (p.length < 3) return false;
        const y  = Number(p[2].length === 2 ? '20' + p[2] : p[2]);
        const fd = new Date(y, Number(p[1]) - 1, Number(p[0]));
        if (dDesde && fd < dDesde) return false;
        if (dHasta && fd > dHasta) return false;
        return true;
      });
    }
    remitos.sort((a, b) => fechaSort(b.fecha || b.FECHA) - fechaSort(a.fecha || a.FECHA));

    const totalLitros = remitos.reduce((s, r) => s + (Number(r.combustible || r.COMBUSTIBLE || 0)), 0);
    const totalMonto  = remitos.reduce((s, r) => {
      const m = String(r.monto || r.MONTO || '0').replace(/[^0-9.,]/g, '').replace(',', '.');
      return s + (parseFloat(m) || 0);
    }, 0);

    res.json({
      ok: true, remitos,
      totales: { totalLitros, totalMonto, cantRemitos: remitos.length },
      chofer: chofer || 'Todos',
      desde: desde || '', hasta: hasta || '',
      generado: fechaHoyAR(),
    });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
