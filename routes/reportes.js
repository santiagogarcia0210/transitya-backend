const router = require('express').Router();
const { verifyToken, requireAdmin, requireModulo } = require('../middleware/auth');
const { normalizarText_, parseMonto_, fechaHoyAR, col, MESES, randomUUID } = require('../utils');
const { normalizarFecha, fechaDoc, esMesFecha, ordenarPorFechaDesc } = require('../utils/fechas');
const { subirFoto } = require('../helpers/storage');

const errHandler = (res, req, e) => {
  console.error('[REPORTES]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const MSG_FECHA = 'La fecha no es válida. Usá el formato dd/MM/yyyy (por ejemplo 05/11/2026).';

const isAdmin = (user) => user.rol === 'admin' || user.rol === 'administrador';

// Named sub-routes must be before /:id
router.get('/diario', verifyToken, requireModulo('reportes'), async (req, res) => {
  try {
    const fechaBuscar = req.query.fecha || fechaHoyAR();
    // Se compara por día, sin importar en qué formato llegó o quedó guardada cada fecha (2026-11-05 y
    // 05/11/2026 son el mismo día). Si la pedida no se entiende no hay nada que comparar: '' no puede
    // igualarse con los documentos sin fecha válida.
    const buscada = normalizarFecha(fechaBuscar);
    const snap = await col(req.tenantId, 'reportes').get();
    let filas = !buscada ? [] : snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(doc => fechaDoc(doc) === buscada);

    if (!isAdmin(req.user)) {
      filas = filas.filter(doc =>
        normalizarText_(doc.chofer || doc.CHOFER || '') === normalizarText_(req.user.email)
      );
    }

    if (!filas.length) return res.json({ ok: true, datos: null, filas: [], fecha: buscada || fechaBuscar });
    res.json({ ok: true, datos: filas[0], filas, fecha: buscada });
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
      if (!esMesFecha(fechaDoc(doc), m, y)) return false;
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
      todos = todos.filter(doc => esMesFecha(fechaDoc(doc), m, y));
    }

    if (q) {
      const qn = normalizarText_(q);
      todos = todos.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(qn));
    }

    // Fecha desc; a igual fecha, el cargado más tarde primero. Sin fecha válida, al final.
    ordenarPorFechaDesc(todos);

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

    // La fecha del reporte es obligatoria y se guarda siempre como dd/MM/yyyy (el input type=date manda
    // ISO). Se valida ANTES de subir las fotos: un reporte rechazado no deja archivos huérfanos.
    // Se sigue aceptando la clave en mayúsculas (FECHA); se guarda como `fecha`.
    const cruda = [data.fecha, data.FECHA].find(v => v !== undefined && v !== null && String(v).trim() !== '');
    const fecha = normalizarFecha(cruda);
    if (!fecha) return res.status(400).json({ ok: false, mensaje: cruda === undefined ? 'Falta la fecha del reporte.' : MSG_FECHA });
    data.fecha = fecha;
    delete data.FECHA;

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
    // Si la fecha viene en el cuerpo se normaliza; si no se entiende (o viene vacía), 400 y no se toca
    // nada. Sin fecha en el cuerpo no se la toca: lo ya guardado en otro formato lo arregla el script.
    for (const k of ['fecha', 'FECHA']) {
      if (data[k] === undefined) continue;
      const fecha = normalizarFecha(data[k]);
      if (!fecha) return res.status(400).json({ ok: false, mensaje: MSG_FECHA });
      data[k] = fecha;
    }
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
