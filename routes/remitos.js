const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { normalizarText_, esAdmin, nombreUsuario, fechaHoyAR, col, randomUUID } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR remitos]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', auth, async (req, res) => {
  try {
    const filtros = req.query;
    const snap = await col(req.tenantId, 'remitos').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const admin = esAdmin(req.user);
    const usuario = nombreUsuario(req.user);

    todos = todos.filter(doc => {
      if (!admin) {
        const chofer  = normalizarText_(doc['CHOFER'] || doc.chofer || '');
        if (chofer && !chofer.includes(normalizarText_(usuario))) return false;
      }
      const q = filtros.texto ? normalizarText_(filtros.texto) : '';
      if (q) {
        const razon  = doc.razonSocial  || doc['RAZON SOCIAL']  || '';
        const nro    = doc.nroRemito    || doc['N° REMITO']     || '';
        const cuit   = doc.cuit         || doc['CUIT']          || '';
        const chofer = doc['CHOFER']    || doc.chofer           || '';
        const fecha  = doc.fecha        || doc['FECHA']         || '';
        if (![razon, nro, cuit, chofer, fecha].join(' ').toLowerCase().includes(normalizarText_(filtros.texto || ''))) return false;
      }
      if (filtros.desde || filtros.hasta) {
        const fechaDoc = doc.fecha || doc['FECHA'] || '';
        const p = String(fechaDoc).split('/');
        if (p.length >= 3) {
          const df = new Date(Number(p[2].length === 2 ? '20' + p[2] : p[2]), Number(p[1]) - 1, Number(p[0]));
          if (filtros.desde && df < new Date(filtros.desde)) return false;
          if (filtros.hasta && df > new Date(filtros.hasta)) return false;
        }
      }
      return true;
    });

    todos = todos.map(doc => ({
      id:           doc.ID          || doc.id          || doc._fsId || '',
      fecha:        doc.fecha        || doc['FECHA']    || '',
      nroRemito:    doc.nroRemito    || doc['N° REMITO']|| '',
      razonSocial:  doc.razonSocial  || doc['RAZON SOCIAL']   || '',
      cuit:         doc.cuit         || doc['CUIT']            || '',
      combustible:  doc.combustible  || doc['COMBUSTIBLE (L)'] || '',
      monto:        doc.monto        || doc['MONTO']           || '',
      observaciones:doc.observaciones|| doc['OBSERVACIONES']   || '',
      comprobante:  doc.comprobante  || doc['COMPROBANTE']     || '',
      chofer:       doc['CHOFER']    || doc.chofer             || ''
    }));

    todos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    const pp = Number(filtros.porPagina) || 50;
    const pg = Math.max(1, Number(filtros.pagina) || 1);
    res.json({
      ok: true,
      resultados: todos.slice((pg - 1) * pp, pg * pp),
      total: todos.length, pagina: pg,
      paginas: Math.max(1, Math.ceil(todos.length / pp))
    });
  } catch (e) { err(res, req, e); }
});

router.get('/verificar-duplicado', auth, async (req, res) => {
  try {
    const { nroRemito, cuit } = req.query;
    if (!nroRemito) return res.json({ ok: true, duplicado: false });
    const snap = await col(req.tenantId, 'remitos').get();
    const todos = snap.docs.map(d => d.data());
    const nroNorm  = normalizarText_(String(nroRemito).trim());
    const cuitNorm = normalizarText_(String(cuit || '').replace(/[\s-]/g, ''));
    const dup = todos.some(doc => {
      const rNro  = normalizarText_(String(doc.nroRemito || '').trim());
      const rCuit = normalizarText_(String(doc.cuit || '').replace(/[\s-]/g, ''));
      return rNro === nroNorm && (!cuitNorm || rCuit === cuitNorm);
    });
    res.json({ ok: true, duplicado: dup });
  } catch (e) { res.json({ ok: true, duplicado: false }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const data = req.body;
    const id     = randomUUID();
    const chofer = nombreUsuario(req.user);

    let fecha = data.fecha || '';
    if (fecha && fecha.indexOf('-') > 0) {
      const p = fecha.split('-');
      fecha = p[2] + '/' + p[1] + '/' + p[0];
    }
    fecha = fecha || fechaHoyAR();

    const doc = {
      ID: id, fecha, nroRemito: data.nroRemito || '',
      razonSocial: data.razonSocial || '', cuit: data.cuit || '',
      combustible: data.combustible || '', monto: data.monto || '',
      observaciones: data.observaciones || '', comprobante: data.comprobante || '',
      CHOFER: chofer, timestamp: new Date().toISOString(), creadoEn: new Date()
    };
    await col(req.tenantId, 'remitos').doc(id).set(doc);
    res.json({ ok: true, mensaje: 'Remito guardado correctamente.', id });
  } catch (e) { err(res, req, e); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'remitos').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'remitos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
