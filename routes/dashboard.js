const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, parseMonto_, esMesDMY, fechaHoyAR, normalizarText_ } = require('../utils');

router.get('/resumen', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tenantId } = req;
    const now = new Date();
    const mes  = now.getMonth() + 1;
    const anio = now.getFullYear();
    const hoy  = fechaHoyAR();

    const [
      snapRegistro,
      snapEgresos,
      snapIngresos,
      snapReportes,
      snapBajas,
      snapUsuarios,
    ] = await Promise.all([
      col(tenantId, 'registro').get(),
      col(tenantId, 'egresos').get(),
      col(tenantId, 'ingresos').get(),
      col(tenantId, 'reportes').get(),
      col(tenantId, 'bajas').get(),
      col(tenantId, 'usuarios').get(),
    ]);

    const beneficiariosActivos = snapRegistro.size;

    let bajasMes = 0;
    snapBajas.forEach(d => {
      const fecha = d.data()['FECHA DE BAJA'] || d.data().fechaDeBaja || '';
      if (esMesDMY(fecha, mes, anio)) bajasMes++;
    });

    let egresosMesCount = 0, egresosMesTotal = 0;
    snapEgresos.forEach(d => {
      const doc = d.data();
      const fecha = doc.fecha || doc.FECHA || '';
      if (!esMesDMY(fecha, mes, anio)) return;
      egresosMesCount++;
      egresosMesTotal += parseMonto_(doc.monto || doc.MONTO || 0);
    });

    let ingresosMesCount = 0, ingresosMesTotal = 0;
    let totalPagadoMes = 0, totalPresentadoMes = 0;
    snapIngresos.forEach(d => {
      const doc = d.data();
      const fecha = doc.fecha || doc.FECHA || '';
      if (!esMesDMY(fecha, mes, anio)) return;
      ingresosMesCount++;
      const monto = parseMonto_(doc.monto || doc.MONTO || 0);
      ingresosMesTotal += monto;
      const estado = String(doc.estado || doc.ESTADO || '').toUpperCase();
      if (estado === 'PAGADO')     totalPagadoMes     += monto;
      if (estado === 'PRESENTADO') totalPresentadoMes += monto;
    });

    let kmMes = 0, combustibleMes = 0;
    snapReportes.forEach(d => {
      const doc = d.data();
      const fecha = doc.fecha || doc.FECHA || '';
      if (!esMesDMY(fecha, mes, anio)) return;
      kmMes         += Number(doc['KM RECORRIDOS'] || doc.kmRecorridos || 0);
      combustibleMes += parseMonto_(doc['COMBUSTIBLE ($)'] || doc.combustiblePesos || 0);
    });

    // Choferes activos con flag reporteHoy
    const reportesHoyChoferes = new Set();
    snapReportes.forEach(d => {
      const doc = d.data();
      if ((doc.fecha || doc.FECHA || '') === hoy) {
        reportesHoyChoferes.add(normalizarText_(doc.chofer || doc.CHOFER || ''));
      }
    });

    const estadoChoferes = [];
    snapUsuarios.forEach(d => {
      const doc = d.data();
      const rol = String(doc.rol || doc.ROL || '').toLowerCase();
      if (rol !== 'chofer') return;
      if (doc.activo === false) return;
      const nombre = doc.nombre || doc.NOMBRE || doc.email || '';
      estadoChoferes.push({
        uid: d.id,
        nombre,
        reporteHoy: reportesHoyChoferes.has(normalizarText_(nombre)),
      });
    });

    res.json({
      ok: true,
      mes,
      anio,
      beneficiariosActivos,
      bajasMes,
      egresosMes:         { count: egresosMesCount,   total: egresosMesTotal },
      ingresosMes:        { count: ingresosMesCount,  total: ingresosMesTotal },
      totalPagadoMes,
      totalPresentadoMes,
      kmMes,
      combustibleMes,
      estadoChoferes,
    });
  } catch (e) {
    console.error('[DASHBOARD] resumen error:', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
