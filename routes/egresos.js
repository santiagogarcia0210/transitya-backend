const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { normalizarText_, parseMonto_, esAdmin, nombreUsuario, esMesDMY, col, randomUUID } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR egresos]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'egresos').get();
    console.log('[EGRESOS] docs found:', snap.size, 'tenantId:', req.tenantId);
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const admin = esAdmin(req.user);
    const usuario = nombreUsuario(req.user);

    if (!admin) {
      todos = todos.filter(doc => {
        const ch = normalizarText_(doc['CHOFER'] || doc['USUARIO'] || '');
        return ch.includes(normalizarText_(usuario));
      });
    }

    res.json(todos);
  } catch (e) { err(res, req, e); }
});

router.post('/buscar', auth, async (req, res) => {
  try {
    const filtros = req.body || {};
    const snap = await col(req.tenantId, 'egresos').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const admin = esAdmin(req.user);
    const usuario = nombreUsuario(req.user);

    const q        = normalizarText_(filtros.texto || '');
    const desde    = filtros.desde ? new Date(filtros.desde) : null;
    const hasta    = filtros.hasta ? new Date(filtros.hasta) : null;
    const montoMin = filtros.montoMin ? parseFloat(filtros.montoMin) : null;
    const montoMax = filtros.montoMax ? parseFloat(filtros.montoMax) : null;
    const categ    = filtros.categoria ? normalizarText_(filtros.categoria) : null;
    const filtroCh = filtros.chofer ? normalizarText_(filtros.chofer) : null;

    todos = todos.filter(doc => {
      const texto = Object.values(doc).join(' ');
      if (q && !normalizarText_(texto).includes(q)) return false;
      if (!admin) {
        const ch = normalizarText_(doc['CHOFER'] || doc['USUARIO'] || '');
        if (!ch.includes(normalizarText_(usuario))) return false;
      }
      if (admin && filtroCh) {
        if (!normalizarText_(doc['CHOFER'] || '').includes(filtroCh)) return false;
      }
      if (montoMin !== null || montoMax !== null) {
        const m = parseMonto_(doc['MONTO'] || doc['IMPORTE'] || 0);
        if (montoMin !== null && m < montoMin) return false;
        if (montoMax !== null && m > montoMax) return false;
      }
      if (categ) {
        if (!normalizarText_(doc['CATEGORIA'] || doc['TIPO'] || '').includes(categ)) return false;
      }
      if (desde || hasta) {
        const p = String(doc['FECHA'] || '').split('/');
        if (p.length >= 3) {
          const df = new Date(Number(p[2].length === 2 ? '20' + p[2] : p[2]), Number(p[1]) - 1, Number(p[0]));
          if (desde && df < desde) return false;
          if (hasta && df > hasta) return false;
        }
      }
      return true;
    });

    const pp = filtros.porPagina || 50;
    const pg = Math.max(1, filtros.pagina || 1);
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
    const { fecha, monto } = req.query;
    const snap = await col(req.tenantId, 'egresos').get();
    const todos = snap.docs.map(d => d.data());
    const dF = normalizarText_(String(fecha || ''));
    const dM = String(monto || '').trim();
    const encontrados = todos.filter(doc =>
      normalizarText_(doc['FECHA'] || '') === dF &&
      String(doc['MONTO'] || '').trim() === dM
    );
    res.json({ ok: true, duplicado: encontrados.length > 0, cantidad: encontrados.length });
  } catch (e) { res.json({ ok: true, duplicado: false }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const data = { ...req.body };
    data['CHOFER'] = nombreUsuario(req.user);
    const id = String(data['ID'] || '').trim() || randomUUID();
    data['ID'] = id;
    await col(req.tenantId, 'egresos').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'EGRESO GUARDADO', id });
  } catch (e) { err(res, req, e); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'egresos').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'egresos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
