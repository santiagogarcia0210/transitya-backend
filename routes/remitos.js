const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, fechaHoyAR, col, randomUUID } = require('../utils');
const { subirFoto } = require('../helpers/storage');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const errHandler = (res, req, e) => {
  console.error('[REMITOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

async function procesarComprobante(data, tenantId, id) {
  const raw = data.comprobante;
  if (!raw || !String(raw).startsWith('data:')) return;

  const matches = String(raw).match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) { delete data.comprobante; return; }

  const mimeType = matches[1];
  const base64   = matches[2];
  const ext      = mimeType.split('/')[1] || 'jpg';
  const ruta     = `empresas/${tenantId}/remitos/${id}/comprobante.${ext}`;

  try {
    const url = await subirFoto(base64, mimeType, ruta);
    data.comprobanteUrl = url;
    data.comprobante    = url;
  } catch (e) {
    console.error('[REMITOS] Storage upload error:', e.message);
    delete data.comprobante;
    throw new Error('No se pudo subir el comprobante. Intentá de nuevo en unos segundos.');
  }
}

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

const HAIKU    = 'claude-haiku-4-5-20251001';
const SONNET   = 'claude-sonnet-4-6';
const MIMES_OK = new Set(['image/jpeg','image/png','image/gif','image/webp']);
const MAX_B64  = 6_000_000;

function buildPromptRemitos() {
  const anioActual = new Date().getFullYear();
  return (
    'Sos un asistente contable argentino. Analizá este remito de combustible y extraé los datos.\n' +
    `Hoy estamos en el año ${anioActual}. Los comprobantes son documentos recientes, normalmente del mismo mes o del mes anterior.\n` +
    `Si el año aparece con 2 dígitos (ej "25"), expandilo al siglo actual (→ "${anioActual}"), NUNCA a 1900s o 2000s tempranos.\n` +
    'Respondé ÚNICAMENTE con JSON válido. Sin texto antes ni después. Sin markdown.\n' +
    'Schema (usá null si no podés leer el valor con certeza):\n' +
    '{"nroRemito":"string o null","razonSocial":"string o null","cuit":"solo dígitos o null",' +
    '"fecha":"dd/MM/yyyy o null","combustible":número positivo o null,"monto":número positivo o null,' +
    '"tipoCombustible":"Nafta Super|Nafta Premium|Diesel|Gasoil|GNC|Otro|null",' +
    '"requiere_revision":true si foto ilegible o datos dudosos, false si son claros}'
  );
}

async function llamarIARemitos(fotoBase64, mimeType, modelo) {
  const msg = await anthropic.messages.create({
    model: modelo, max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: fotoBase64 } },
      { type: 'text', text: buildPromptRemitos() },
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
      datos = await llamarIARemitos(fotoBase64, mimeType, HAIKU);
    } catch {
      try { datos = await llamarIARemitos(fotoBase64, mimeType, SONNET); }
      catch { return res.status(422).json({ ok: false, mensaje: 'No se pudo leer el remito. Intentá con una foto más nítida.' }); }
    }

    const advertencias = [];
    const montoNum = Number(datos.monto);
    if (!datos.monto || isNaN(montoNum) || montoNum <= 0) {
      advertencias.push('Monto no detectado o inválido');
      datos.monto = null;
    } else {
      datos.monto = montoNum;
    }
    if (datos.combustible != null) {
      const litrosNum = Number(datos.combustible);
      if (isNaN(litrosNum) || litrosNum <= 0) {
        advertencias.push('Litros de combustible inválidos');
        datos.combustible = null;
      } else {
        datos.combustible = litrosNum;
      }
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

router.post('/', verifyToken, async (req, res) => {
  try {
    const data = { ...req.body };
    const id = randomUUID();
    const fecha = isoToDMY(data.fecha || '') || fechaHoyAR();
    await procesarComprobante(data, req.tenantId, id);
    const doc = {
      ID:              id,
      fecha,
      nroRemito:       data.nroRemito       || '',
      razonSocial:     data.razonSocial     || '',
      cuit:            data.cuit            || '',
      combustible:     data.combustible     || '',
      tipoCombustible: data.tipoCombustible || '',
      monto:           data.monto           || '',
      observaciones:   data.observaciones   || '',
      comprobante:     data.comprobante     || '',
      comprobanteUrl:  data.comprobanteUrl  || '',
      chofer:          req.user.email,
      CHOFER:          req.user.email,
      creadoEn:        new Date(),
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
    const data = { ...req.body };
    await procesarComprobante(data, req.tenantId, req.params.id);
    await col(req.tenantId, 'remitos').doc(req.params.id).update(data);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'remitos').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador' || req.user.rol === 'superadmin';
    if (!isAdmin) {
      const chofer = snap.data().chofer || snap.data().CHOFER || '';
      if (normalizarText_(chofer) !== normalizarText_(req.user.email))
        return res.status(403).json({ ok: false, mensaje: 'Solo podés borrar tus propios remitos' });
    }
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
