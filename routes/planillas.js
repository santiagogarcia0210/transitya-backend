const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { fechaHoyAR, col, MESES } = require('../utils');
const { esMesFecha, fechaDoc } = require('../utils/fechas');
const B = require('../utils/beneficiarios');

const errHandler = (res, req, e) => {
  console.error('[PLANILLAS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── Quién entra a las planillas de Incluir ────────────────────────────────────
// Planilla Incluir y DJ ESC 107 listan a TODO paciente ACTIVO cuya obra social sea Incluir (cualquier grafía),
// lea donde lo lea: `registro` y `BENEFICIARIOS`. El N° de afiliado se lee de cualquier variante
// ('N° AFILIADO', nroAfiliado, NRO_AFILIADO …); si falta, la fila igual sale con `faltaAfiliado: true`
// para que la pantalla lo marque. Los de otras obras sociales NO entran, y los que no tienen obra social
// cargada tampoco: se devuelven aparte en `sinObraSocial` para que alguien los revise.
async function pacientesDeIncluir(tenantId, m, y) {
  const [todos, facSnap] = await Promise.all([
    B.cargarBeneficiarios(col, tenantId),
    col(tenantId, 'facturacion').get(),
  ]);

  const facPorAfiliado = {};
  facSnap.docs.map(d => d.data())
    .filter(f => esMesFecha(fechaDoc(f), m, y))
    .forEach(f => {
      const key = String(f['N° AFILIADO'] || f.afiliado || f['DNI'] || '').trim();
      if (key) facPorAfiliado[key] = f;
    });

  const activos = todos.filter(b => b.activo && b.nombre);
  const sinObraSocial = activos.filter(b => b.sinObraSocial)
    .map(b => ({ id: b.id, nombre: b.nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const pacientes = activos.filter(b => b.esIncluir).map(b => {
    const fac = facPorAfiliado[b.afiliado] || facPorAfiliado[b.dni] || {};
    return { b, fac };
  });
  return { pacientes, sinObraSocial };
}

// ── PLANILLA DE INCLUIR ───────────────────────────────────────────────────────
router.get('/incluir', verifyToken, requireAdmin, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const { pacientes, sinObraSocial } = await pacientesDeIncluir(req.tenantId, m, y);

    const filas = pacientes.map(({ b, fac }) => ({
      id:            b.id,
      afiliado:      b.afiliado,
      faltaAfiliado: b.faltaAfiliado,
      nombre:        b.nombre,
      dni:           b.dni,
      obraSocial:    b.obraSocial,
      prestador:     b.prestador,
      chofer:        b.chofer,
      domicilio:     b.domicilio,
      localidad:     b.localidad,
      monto:         fac['MONTO'] || fac.monto || '',
      estado:        fac['ESTADO'] || fac.estado || '',
      observaciones: fac['OBSERVACIONES'] || fac.observaciones || '',
    })).sort((a, b) => a.nombre.localeCompare(b.nombre));

    res.json({
      ok: true,
      mes: MESES[m - 1], anio: y,
      periodo: `${String(m).padStart(2, '0')}/${y}`,
      filas,
      total: filas.length,
      sinAfiliado: filas.filter(f => f.faltaAfiliado).length,
      sinObraSocial,
      generadoEn: fechaHoyAR(),
    });
  } catch (e) { errHandler(res, req, e); }
});

// ── PLANILLA DJ-107 ───────────────────────────────────────────────────────────
// Una fila por paciente de Incluir con los datos que pide el formulario.
router.get('/dj107', verifyToken, requireAdmin, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const { pacientes, sinObraSocial } = await pacientesDeIncluir(req.tenantId, m, y);

    const filas = pacientes.map(({ b, fac }) => ({
      id:             b.id,
      nroAfiliado:    b.afiliado,
      afiliado:       b.afiliado,
      faltaAfiliado:  b.faltaAfiliado,
      apellidoNombre: b.nombre,
      dni:            b.dni,
      cuil:           b.cuil,
      obraSocial:     b.obraSocial,
      prestador:      b.prestador,
      cantDias:       fac['CANT DIAS'] || fac.cantDias || '',
      monto:          fac['MONTO'] || fac.monto || '',
      periodo:        `${String(m).padStart(2, '0')}/${y}`,
      observaciones:  fac['OBSERVACIONES'] || fac.observaciones || '',
    })).sort((a, b) => a.apellidoNombre.localeCompare(b.apellidoNombre));

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
      sinAfiliado: filas.filter(f => f.faltaAfiliado).length,
      sinObraSocial,
      generadoEn: fechaHoyAR(),
    });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
