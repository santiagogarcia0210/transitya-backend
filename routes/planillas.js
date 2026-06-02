const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { esMesDMY, fechaHoyAR, col, MESES } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[PLANILLAS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── PLANILLA DE INCLUIR ───────────────────────────────────────────────────────
// Returns beneficiaries from `registro` cross-referenced with billing records
// from `facturacion` for the given mes/anio.

router.get('/incluir', verifyToken, requireAdmin, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();

    const [regSnap, facSnap] = await Promise.all([
      col(req.tenantId, 'registro').get(),
      col(req.tenantId, 'facturacion').get(),
    ]);

    const facFilas = facSnap.docs.map(d => d.data())
      .filter(f => esMesDMY(f['FECHA'] || f.fecha || '', m, y));

    // Index billing rows by afiliado/DNI for quick lookup
    const facPorAfiliado = {};
    facFilas.forEach(f => {
      const key = String(f['N° AFILIADO'] || f.afiliado || f['DNI'] || '').trim();
      if (key) facPorAfiliado[key] = f;
    });

    const beneficiarios = regSnap.docs.map(d => d.data());

    const filas = beneficiarios
      .filter(b => b['APELLIDO Y NOMBRE'] || b['NOMBRE'])
      .map(b => {
        const afiliado = String(b['N° AFILIADO'] || '').trim();
        const dni      = String(b['DNI'] || '').trim();
        const facRow   = facPorAfiliado[afiliado] || facPorAfiliado[dni] || {};
        return {
          afiliado,
          nombre:      b['APELLIDO Y NOMBRE'] || b['NOMBRE'] || '',
          dni,
          obraSocial:  b['OBRA SOCIAL'] || b['OS'] || facRow['OBRA SOCIAL'] || '',
          prestador:   b['PRESTADOR'] || b['DEPENDENCIA'] || '',
          chofer:      b['CHOFER'] || '',
          domicilio:   b['DOMICILIO'] || '',
          localidad:   b['LOCALIDAD'] || '',
          monto:       facRow['MONTO'] || facRow.monto || '',
          estado:      facRow['ESTADO'] || facRow.estado || '',
          observaciones: facRow['OBSERVACIONES'] || facRow.observaciones || '',
        };
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre));

    res.json({
      ok: true,
      mes: MESES[m - 1], anio: y,
      periodo: `${String(m).padStart(2, '0')}/${y}`,
      filas,
      total: filas.length,
      generadoEn: fechaHoyAR(),
    });
  } catch (e) { errHandler(res, req, e); }
});

// ── PLANILLA DJ-107 ───────────────────────────────────────────────────────────
// DJ-107 is the standard OSECAC/Obra Social declaration.
// Returns rows grouped by obra social, one row per beneficiary with
// the fields required to complete the form.

router.get('/dj107', verifyToken, requireAdmin, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();

    const [regSnap, facSnap] = await Promise.all([
      col(req.tenantId, 'registro').get(),
      col(req.tenantId, 'facturacion').get(),
    ]);

    const facFilas = facSnap.docs.map(d => d.data())
      .filter(f => esMesDMY(f['FECHA'] || f.fecha || '', m, y));

    const facPorAfiliado = {};
    facFilas.forEach(f => {
      const key = String(f['N° AFILIADO'] || f.afiliado || f['DNI'] || '').trim();
      if (key) facPorAfiliado[key] = f;
    });

    const beneficiarios = regSnap.docs.map(d => d.data());

    const filas = beneficiarios
      .filter(b => b['APELLIDO Y NOMBRE'] || b['NOMBRE'])
      .map(b => {
        const afiliado = String(b['N° AFILIADO'] || '').trim();
        const dni      = String(b['DNI'] || '').trim();
        const facRow   = facPorAfiliado[afiliado] || facPorAfiliado[dni] || {};
        return {
          nroAfiliado:   afiliado,
          apellidoNombre: b['APELLIDO Y NOMBRE'] || b['NOMBRE'] || '',
          dni,
          cuil:          b['CUIL'] || '',
          obraSocial:    b['OBRA SOCIAL'] || b['OS'] || facRow['OBRA SOCIAL'] || '',
          prestador:     b['PRESTADOR'] || b['DEPENDENCIA'] || '',
          cantDias:      facRow['CANT DIAS'] || facRow.cantDias || '',
          monto:         facRow['MONTO'] || facRow.monto || '',
          periodo:       `${String(m).padStart(2, '0')}/${y}`,
          observaciones: facRow['OBSERVACIONES'] || facRow.observaciones || '',
        };
      })
      .sort((a, b) => {
        const osA = a.obraSocial.localeCompare(b.obraSocial);
        return osA !== 0 ? osA : a.apellidoNombre.localeCompare(b.apellidoNombre);
      });

    // Group by obra social for summary
    const porObraSocial = {};
    filas.forEach(f => {
      const os = f.obraSocial || 'SIN OBRA SOCIAL';
      if (!porObraSocial[os]) porObraSocial[os] = { obraSocial: os, cantidad: 0, filas: [] };
      porObraSocial[os].cantidad++;
      porObraSocial[os].filas.push(f);
    });

    res.json({
      ok: true,
      mes: MESES[m - 1], anio: y,
      periodo: `${String(m).padStart(2, '0')}/${y}`,
      filas,
      porObraSocial: Object.values(porObraSocial),
      total: filas.length,
      generadoEn: fechaHoyAR(),
    });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
