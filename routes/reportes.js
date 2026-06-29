const router = require('express').Router();
const { verifyToken, requireAdmin, requireModulo } = require('../middleware/auth');
const { normalizarText_, parseMonto_, fechaHoyAR, esMesDMY, col, MESES, randomUUID } = require('../utils');
const { subirFoto } = require('../helpers/storage');

const errHandler = (res, req, e) => {
  console.error('[REPORTES]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const fechaSort = (f) => {
  const p = String(f || '').split('/');
  if (p.length < 3) return 0;
  const y = p[2].length === 2 ? '20' + p[2] : p[2];
  return Number(`${y}${p[1].padStart(2, '0')}${p[0].padStart(2, '0')}`);
};

const isAdmin = (user) => user.rol === 'admin' || user.rol === 'administrador';

// Named sub-routes must be before /:id
router.get('/diario', verifyToken, requireModulo('reportes'), async (req, res) => {
  try {
    const fechaBuscar = req.query.fecha || fechaHoyAR();
    const snap = await col(req.tenantId, 'reportes').get();
    let filas = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(doc => String(doc.fecha || doc.FECHA || '').trim() === fechaBuscar);

    if (!isAdmin(req.user)) {
      filas = filas.filter(doc =>
        normalizarText_(doc.chofer || doc.CHOFER || '') === normalizarText_(req.user.email)
      );
    }

    if (!filas.length) return res.json({ ok: true, datos: null, filas: [], fecha: fechaBuscar });
    res.json({ ok: true, datos: filas[0], filas, fecha: fechaBuscar });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/mensual', verifyToken, requireModulo('reportes'), async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const snap = await col(req.tenantId, 'reportes').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    let kmTotal = 0, costoTotal = 0, litrosTotal = 0, diasTrab = 0;
    const filas = todos.filter(doc => {
      if (!esMesDMY(doc.fecha || doc.FECHA || '', m, y)) return false;
      if (!isAdmin(req.user) &&
          normalizarText_(doc.chofer || doc.CHOFER || '') !== normalizarText_(req.user.email)) return false;
      return true;
    }).map(doc => {
      kmTotal     += Number(doc['KM RECORRIDOS'] || doc.kmRecorridos || 0);
      costoTotal  += parseMonto_(doc.combustibleImporte || doc['COMBUSTIBLE ($)'] || doc.combustiblePesos || 0);
      litrosTotal += Number(doc['COMBUSTIBLE (L)'] || doc.combustibleLitros || 0);
      diasTrab++;
      return doc;
    });

    const kmProm    = diasTrab > 0 ? Math.round(kmTotal / diasTrab) : 0;
    const costoPorKm = kmTotal > 0 ? (costoTotal / kmTotal).toFixed(2) : 0;
    res.json({
      ok: true, filas,
      resumen: { kmTotal, costoTotal, litrosTotal, diasTrab, kmProm, costoPorKm, mes: MESES[m - 1], anio: y },
    });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/', verifyToken, requireModulo('reportes'), async (req, res) => {
  try {
    const { q, page, limit, mes, anio } = req.query;
    const snap = await col(req.tenantId, 'reportes').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!isAdmin(req.user)) {
      todos = todos.filter(doc =>
        normalizarText_(doc.chofer || doc.CHOFER || '') === normalizarText_(req.user.email)
      );
    }

    if (mes || anio) {
      const m = Number(mes)  || (new Date().getMonth() + 1);
      const y = Number(anio) || new Date().getFullYear();
      todos = todos.filter(doc => esMesDMY(doc.fecha || doc.FECHA || '', m, y));
    }

    if (q) {
      const qn = normalizarText_(q);
      todos = todos.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(qn));
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

router.post('/', verifyToken, requireModulo('reportes'), async (req, res) => {
  try {
    const data = { ...req.body };

    const fotoIni = data.fotoIniBase64 || data.FOTO_INI_B64;
    const fotoFin = data.fotoFinBase64 || data.FOTO_FIN_B64;
    const mime    = data.mimeTypeFotos || 'image/jpeg';
    delete data.fotoIniBase64; delete data.FOTO_INI_B64;
    delete data.fotoFinBase64; delete data.FOTO_FIN_B64;
    delete data.mimeTypeFotos;
    delete data._sessionToken; delete data.sessionToken;

    const kmI = Number(data['KM INICIAL'] || data.kmInicial || 0);
    const kmF = Number(data['KM FINAL']   || data.kmFinal   || 0);
    data['KM RECORRIDOS'] = kmF > kmI ? kmF - kmI : 0;
    data.chofer  = req.user.email;
    data.CHOFER  = req.user.email;

    const id = String(data.ID || data.id || '').trim() || randomUUID();
    data.ID = id;

    if (fotoIni) {
      data.fotoIniUrl = await subirFoto(
        fotoIni, mime,
        `reportes/${req.tenantId}/${id}_ini.jpg`
      );
    }
    if (fotoFin) {
      data.fotoFinUrl = await subirFoto(
        fotoFin, mime,
        `reportes/${req.tenantId}/${id}_fin.jpg`
      );
    }

    data.combustibleImporte = parseMonto_(data.combustibleImporte || data['COMBUSTIBLE ($)'] || data.combustiblePesos || 0);
    await col(req.tenantId, 'reportes').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'REPORTE GUARDADO', kmRecorridos: data['KM RECORRIDOS'], id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireModulo('reportes'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      const snap = await col(req.tenantId, 'reportes').doc(req.params.id).get();
      if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
      const chofer = snap.data().chofer || snap.data().CHOFER || '';
      if (normalizarText_(chofer) !== normalizarText_(req.user.email))
        return res.status(403).json({ ok: false, mensaje: 'Sin permisos' });
    }
    const data = { ...req.body };
    const fotoIni = data.fotoIniBase64 || data.FOTO_INI_B64;
    const fotoFin = data.fotoFinBase64 || data.FOTO_FIN_B64;
    const mime    = data.mimeTypeFotos || 'image/jpeg';
    delete data.fotoIniBase64; delete data.FOTO_INI_B64;
    delete data.fotoFinBase64; delete data.FOTO_FIN_B64;
    delete data.mimeTypeFotos;
    if (fotoIni) {
      data.fotoIniUrl = await subirFoto(fotoIni, mime, `reportes/${req.tenantId}/${req.params.id}_ini.jpg`);
    }
    if (fotoFin) {
      data.fotoFinUrl = await subirFoto(fotoFin, mime, `reportes/${req.tenantId}/${req.params.id}_fin.jpg`);
    }
    await col(req.tenantId, 'reportes').doc(req.params.id).update(data);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await col(req.tenantId, 'reportes').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
