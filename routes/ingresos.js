const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { parseMonto_, normalizarText_, fechaHoyAR, col, MESES, randomUUID } = require('../utils');
const { normalizarFecha, fechaToDate, fechaDoc, esMesFecha, ordenarPorFechaDesc } = require('../utils/fechas');

const errHandler = (res, req, e) => {
  console.error('[INGRESOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const MSG_FECHA = 'La fecha no es válida. Usá el formato dd/MM/yyyy (por ejemplo 05/11/2026).';

// GET /reporte-mensual must be before GET /:id
router.get('/reporte-mensual', verifyToken, requireAdmin, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const snap = await col(req.tenantId, 'ingresos').get();
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const filas = todos.filter(doc => {
      const estado = normalizarText_(doc.estado || doc.ESTADO || '');
      if (estado === 'presentado') return true;
      return esMesFecha(fechaDoc(doc), m, y);
    });
    const total     = filas.reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0);
    const pagado    = filas.filter(r => normalizarText_(r.estado || r.ESTADO || '') === 'pagado')
                           .reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0);
    res.json({
      ok: true,
      filas,
      resumen: { mes: MESES[m - 1], anio: y, total, pagado, presentado: total - pagado, cantidad: filas.length },
    });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { q, page, limit, mes, anio, estado, desde, hasta } = req.query;
    const snap = await col(req.tenantId, 'ingresos').get();
    let todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Always include PRESENTADO regardless of date; filter rest by mes/anio if given
    if (mes || anio) {
      const m = Number(mes)  || (new Date().getMonth() + 1);
      const y = Number(anio) || new Date().getFullYear();
      todos = todos.filter(doc => {
        const est = normalizarText_(doc.estado || doc.ESTADO || '');
        if (est === 'presentado') return true;
        return esMesFecha(fechaDoc(doc), m, y);
      });
    }

    if (desde || hasta) {
      // desde/hasta llegan en ISO (input type=date); fechaToDate entiende ISO y dd/MM/yyyy.
      // Un límite que no se entiende se ignora; los documentos sin fecha válida quedan afuera.
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

    if (estado) {
      const en = normalizarText_(estado);
      todos = todos.filter(doc => normalizarText_(doc.estado || doc.ESTADO || '') === en);
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
    const resumen = {
      total:      todos.reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0),
      pagado:     todos.filter(r => normalizarText_(r.estado || r.ESTADO || '') === 'pagado')
                       .reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0),
      presentado: todos.filter(r => normalizarText_(r.estado || r.ESTADO || '') === 'presentado')
                       .reduce((s, r) => s + parseMonto_(r.monto || r.MONTO || 0), 0),
    };

    res.json({
      ok: true,
      resultados: todos.slice((pg - 1) * pp, pg * pp).map(d => ({
        ...d,
        monto: Number(d.monto || d.MONTO || 0),
      })),
      total,
      pagina: pg,
      totalPaginas: Math.max(1, Math.ceil(total / pp)),
      resumen,
    });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = { ...req.body };
    // La fecha es obligatoria y se guarda siempre como dd/MM/yyyy (el input type=date manda ISO).
    // Se sigue aceptando la clave en mayúsculas (FECHA); se guarda como `fecha`.
    const cruda = [data.fecha, data.FECHA].find(v => v !== undefined && v !== null && String(v).trim() !== '');
    const fecha = normalizarFecha(cruda);
    if (!fecha) return res.status(400).json({ ok: false, mensaje: cruda === undefined ? 'Falta la fecha del ingreso.' : MSG_FECHA });
    data.fecha = fecha;
    delete data.FECHA;
    const id = String(data.ID || data.id || '').trim() || randomUUID();
    data.ID     = id;
    data.ESTADO = String(data.estado || data.ESTADO || 'PRESENTADO').trim().toUpperCase();
    await col(req.tenantId, 'ingresos').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'INGRESO GUARDADO', id });
  } catch (e) { errHandler(res, req, e); }
});

// PATCH /:id/pagar must be before PUT /:id to avoid Express conflicts
router.patch('/:id/pagar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref  = col(req.tenantId, 'ingresos').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Factura no encontrada.' });
    await ref.update({ ESTADO: 'PAGADO', estado: 'PAGADO', fechaPago: fechaHoyAR() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = { ...req.body };
    // Si la fecha viene en el cuerpo se normaliza; si no se entiende (o viene vacía), 400 y no se toca nada.
    // Sin fecha en el cuerpo no se la toca: lo ya guardado en otro formato lo arregla el script de migración.
    for (const k of ['fecha', 'FECHA']) {
      if (data[k] === undefined) continue;
      const fecha = normalizarFecha(data[k]);
      if (!fecha) return res.status(400).json({ ok: false, mensaje: MSG_FECHA });
      data[k] = fecha;
    }
    await col(req.tenantId, 'ingresos').doc(req.params.id).update(data);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await col(req.tenantId, 'ingresos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
