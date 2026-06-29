const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, parseMonto_, esMesDMY, fechaHoyAR, normalizarText_ } = require('../utils');

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

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
      snapUbicaciones,
      snapEmpresa,
    ] = await Promise.all([
      col(tenantId, 'registro').get(),
      col(tenantId, 'egresos').get(),
      col(tenantId, 'ingresos').get(),
      col(tenantId, 'reportes').get(),
      col(tenantId, 'bajas').get(),
      col(tenantId, 'usuarios').get(),
      col(tenantId, 'ubicaciones').get(),
      require('../firebase').db.collection('empresas').doc(tenantId).get(),
    ]);

    // ── Empresa ──────────────────────────────────────────────────────
    const empData       = snapEmpresa.exists ? snapEmpresa.data() : {};
    const empresaNombre = empData.nombre || '';
    const empresaLogo   = empData.logo   || empData.logoUrl || empData.logoCircular || '';

    // ── Beneficiarios activos ─────────────────────────────────────────
    const beneficiariosActivos = snapRegistro.size;

    // ── Bajas del mes ─────────────────────────────────────────────────
    let bajasMes = 0;
    snapBajas.forEach(d => {
      const fecha = d.data()['FECHA DE BAJA'] || d.data().fechaDeBaja || '';
      if (esMesDMY(fecha, mes, anio)) bajasMes++;
    });

    // ── Egresos ───────────────────────────────────────────────────────
    let egresosMesCount = 0, egresosMesTotal = 0;
    snapEgresos.forEach(d => {
      const doc = d.data();
      const fecha = doc.fecha || doc.FECHA || '';
      if (!esMesDMY(fecha, mes, anio)) return;
      egresosMesCount++;
      egresosMesTotal += parseMonto_(doc.monto || doc.MONTO || 0);
    });

    // ── Ingresos ──────────────────────────────────────────────────────
    let ingresosMesCount = 0, ingresosMesTotal = 0;
    let totalPagadoMes = 0, totalPresentadoMes = 0;
    snapIngresos.forEach(d => {
      const doc    = d.data();
      const estado = String(doc.estado || doc.ESTADO || '').toUpperCase();
      const monto  = parseMonto_(doc.monto || doc.MONTO || 0);

      // totalPagadoMes: filter by payment date so invoices from previous months
      // that were paid this month appear correctly (PATCH /:id/pagar saves fechaPago)
      if (estado === 'PAGADO') {
        const fechaPago = doc.fechaPago || doc.FECHAPAGO || doc.fecha || doc.FECHA || '';
        if (esMesDMY(fechaPago, mes, anio)) totalPagadoMes += monto;
      }

      // Count / total / presentado: filter by invoice creation date
      const fecha = doc.fecha || doc.FECHA || '';
      if (!esMesDMY(fecha, mes, anio)) return;
      ingresosMesCount++;
      ingresosMesTotal += monto;
      if (estado === 'PRESENTADO') totalPresentadoMes += monto;
    });

    // ── KM / Combustible ──────────────────────────────────────────────
    let kmMes = 0, combustibleMes = 0;
    snapReportes.forEach(d => {
      const doc = d.data();
      const fecha = doc.fecha || doc.FECHA || '';
      if (!esMesDMY(fecha, mes, anio)) return;
      kmMes          += Number(doc['KM RECORRIDOS'] || doc.kmRecorridos || 0);
      combustibleMes += parseMonto_(doc.combustibleImporte || doc['COMBUSTIBLE ($)'] || doc.combustiblePesos || 0);
    });

    // ── Choferes activos con reporteHoy, vehiculo, hace (GPS) ────────
    const reportesHoyChoferes = new Set();
    snapReportes.forEach(d => {
      const doc = d.data();
      if ((doc.fecha || doc.FECHA || '') === hoy) {
        reportesHoyChoferes.add(normalizarText_(doc.chofer || doc.CHOFER || ''));
      }
    });

    // Índice de ubicaciones por nombre normalizado
    const ahora = Date.now();
    const ubicMap = {};
    snapUbicaciones.forEach(d => {
      const data = d.data();
      const nombreUbic = data.nombre || data.usuario || d.id || '';
      const ts     = data.timestamp ? new Date(data.timestamp).getTime() : null;
      const diffMin = ts ? Math.round((ahora - ts) / 60000) : null;
      const hace = diffMin === null ? null
        : diffMin < 1  ? 'Hace menos de 1 min'
        : diffMin < 60 ? `Hace ${diffMin} min`
        : `Hace ${Math.round(diffMin / 60)} h`;
      ubicMap[normalizarText_(nombreUbic)] = { hace, diffMin, lat: data.lat, lng: data.lng };
    });

    const estadoChoferes = [];
    snapUsuarios.forEach(d => {
      const doc = d.data();
      const rol = String(doc.rol || doc.ROL || '').toLowerCase();
      if (rol !== 'chofer') return;
      if (doc.activo === false) return;
      const nombre   = doc.nombre || doc.NOMBRE || doc.email || '';
      const vehiculo = doc.vehiculo || doc.VEHICULO || doc.patente || doc.PATENTE || '';
      const ubicKey  = normalizarText_(nombre);
      const ubic     = ubicMap[ubicKey] || {};
      estadoChoferes.push({
        uid:        d.id,
        nombre,
        vehiculo,
        reporteHoy: reportesHoyChoferes.has(ubicKey),
        hace:       ubic.hace  || null,
        lat:        ubic.lat   || null,
        lng:        ubic.lng   || null,
      });
    });

    // ── Respuesta con estructura PLANA que el frontend espera ─────────
    res.json({
      ok: true,
      mes,
      anio,
      mesNombre:          MESES_ES[mes - 1],
      empresaNombre,
      empresaLogo,
      beneficiariosActivos,
      bajasMes,
      // Plano (no anidado) — lo que el frontend espera
      egresosMes:         egresosMesCount,
      totalEgresosMes:    egresosMesTotal,
      ingresosMes:        ingresosMesCount,
      totalIngresosMes:   ingresosMesTotal,
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
