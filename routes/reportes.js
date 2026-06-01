const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { normalizarText_, parseMonto_, esAdmin, nombreUsuario, fechaHoyAR, esMesDMY, col, MESES, randomUUID } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR reportes]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.get('/', auth, async (req, res) => {
  try {
    console.log('[REPORTES] tenantId:', req.tenantId);
    const { fecha } = req.query;
    const snap = await col(req.tenantId, 'reportes').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const admin = esAdmin(req.user);
    const usuario = nombreUsuario(req.user);
    if (!admin) {
      todos = todos.filter(doc => normalizarText_(doc['CHOFER'] || '').includes(normalizarText_(usuario)));
    }
    if (fecha) todos = todos.filter(doc => String(doc['FECHA'] || '').trim() === fecha);
    res.json(todos);
  } catch (e) { err(res, req, e); }
});

router.post('/', auth, async (req, res) => {
  try {
    const data = { ...req.body };
    const kmI = Number(data['KM INICIAL'] || 0);
    const kmF = Number(data['KM FINAL']   || 0);
    data['KM RECORRIDOS'] = kmF > kmI ? kmF - kmI : 0;
    data['CHOFER']   = nombreUsuario(req.user);
    const id = data['ID'] || randomUUID();
    data['ID'] = id;
    delete data['FOTO_INI_B64']; delete data['FOTO_FIN_B64'];
    delete data['_sessionToken']; delete data['sessionToken'];
    await col(req.tenantId, 'reportes').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'REPORTE GUARDADO', kmRecorridos: data['KM RECORRIDOS'], id });
  } catch (e) { err(res, req, e); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'reportes').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'reportes').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

router.get('/diario', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    const fechaBuscar = fecha || fechaHoyAR();
    const snap = await col(req.tenantId, 'reportes').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const admin = esAdmin(req.user);
    const usuario = nombreUsuario(req.user);
    let filasDia = todos.filter(doc => String(doc['FECHA'] || '').trim() === fechaBuscar);
    if (!admin) {
      filasDia = filasDia.filter(doc => normalizarText_(doc['CHOFER'] || '').includes(normalizarText_(usuario)));
    }
    if (!filasDia.length) return res.json({ ok: true, datos: null, filas: [], fecha: fechaBuscar });
    res.json({ ok: true, datos: filasDia[0], filas: filasDia, fecha: fechaBuscar });
  } catch (e) { err(res, req, e); }
});

router.get('/mensual', auth, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const snap = await col(req.tenantId, 'reportes').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const admin = esAdmin(req.user);
    const usuario = nombreUsuario(req.user);
    let kmTotal = 0, costoTotal = 0, litrosTotal = 0, diasTrab = 0;
    const filas = todos.filter(doc => {
      if (!esMesDMY(doc['FECHA'] || '', m, y)) return false;
      if (!admin && !normalizarText_(doc['CHOFER'] || '').includes(normalizarText_(usuario))) return false;
      return true;
    }).map(doc => {
      kmTotal     += Number(doc['KM RECORRIDOS'] || 0);
      costoTotal  += parseMonto_(doc['COMBUSTIBLE ($)'] || 0);
      litrosTotal += Number(doc['COMBUSTIBLE (L)'] || 0);
      diasTrab++;
      return doc;
    });
    const kmProm    = diasTrab > 0 ? Math.round(kmTotal / diasTrab) : 0;
    const costoPorKm = kmTotal > 0 ? (costoTotal / kmTotal).toFixed(2) : 0;
    res.json({
      ok: true, filas,
      resumen: { kmTotal, costoTotal, litrosTotal, diasTrab, kmProm, costoPorKm, mes: MESES[m - 1], anio: y }
    });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
