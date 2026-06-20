const router = require('express').Router();
const { verifyToken }           = require('../middleware/auth');
const { col, parseMonto_, normalizarText_ } = require('../utils');

/* ── Helpers ──────────────────────────────────────────────────────────────── */

// YYYY-MM-DD → dd/MM/yyyy
const isoToDMY = (iso) => {
  if (!iso || !iso.includes('-')) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

// Lee el primero de los keys que exista en doc (manejo dual-casing)
const getField = (doc, ...keys) => {
  for (const k of keys) if (doc[k] !== undefined) return doc[k];
  return undefined;
};

// ¿Esta fecha (cualquier formato) corresponde a la fecha ISO dada?
const mismaFecha = (campoFecha, fechaISO) => {
  const f = String(campoFecha || '').trim();
  return f === fechaISO || f === isoToDMY(fechaISO);
};

/* ── GET /api/reportes-km/resumen-diario?fecha=YYYY-MM-DD ─────────────────── */

router.get('/resumen-diario', verifyToken, async (req, res) => {
  try {
    const fechaISO = (req.query.fecha || '').trim();
    if (!fechaISO || !/^\d{4}-\d{2}-\d{2}$/.test(fechaISO))
      return res.status(400).json({ ok: false, mensaje: 'Falta fecha en formato YYYY-MM-DD.' });

    const tenantId = req.tenantId;
    const isAdmin  = req.user.rol === 'admin' || req.user.rol === 'administrador';

    /* 1 ── Choferes desde colección usuarios ─────────────────────────────── */
    const usuariosSnap = await col(tenantId, 'usuarios').get();
    let choferes = usuariosSnap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(u => {
        const rol     = u.rol || u.role || '';
        const activo  = u.activo !== false;
        return (rol === 'chofer') && activo;
      })
      .map(u => ({
        uid:      u.uid,
        email:    (u.email    || '').trim(),
        nombre:   (u.nombre   || u.usuario || (u.email ? u.email.split('@')[0] : '') || '').trim(),
        vehiculo: (u.vehiculo || '').trim(),
      }));

    // Choferes ven solo sus propios datos
    if (!isAdmin) {
      choferes = choferes.filter(c => c.email.toLowerCase() === (req.user.email || '').toLowerCase());
    }

    /* 2 ── Cargar colecciones en paralelo ────────────────────────────────── */
    const [egresosSnap, remitosSnap, reportesSnap, asistenciaSnap] = await Promise.all([
      col(tenantId, 'egresos').get(),
      col(tenantId, 'remitos').get(),
      col(tenantId, 'reportes').get(),
      col(tenantId, 'ASISTENCIA').get(),
    ]);

    const todosEgresos     = egresosSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
    const todosRemitos     = remitosSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
    const todosReportes    = reportesSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
    const todasAsistencias = asistenciaSnap.docs.map(d => ({ _docId: d.id, ...d.data() }));

    console.log(`[RESUMEN-DIARIO] ${fechaISO} | raw totales → egresos:${todosEgresos.length} remitos:${todosRemitos.length} reportes:${todosReportes.length} asistencias:${todasAsistencias.length}`);

    /* 3 ── Armar resumen por chofer ──────────────────────────────────────── */
    const resultado = choferes.map(chofer => {
      const emailNorm  = chofer.email.toLowerCase();
      const nombreNorm = normalizarText_(chofer.nombre);

      /* Egresos del día */
      const egresos = todosEgresos
        .filter(e => {
          const c = normalizarText_(getField(e, 'chofer', 'CHOFER') || '');
          return c === emailNorm && mismaFecha(getField(e, 'fecha', 'FECHA'), fechaISO);
        })
        .map(e => ({
          categoria:       String(getField(e, 'categoria',       'CATEGORIA')       || ''),
          proveedor:       String(getField(e, 'proveedor',       'PROVEEDOR')       || ''),
          monto:           parseMonto_(getField(e, 'monto', 'MONTO')),
          concepto:        String(getField(e, 'concepto',        'CONCEPTO')        || ''),
          tipoComprobante: String(getField(e, 'tipoComprobante', 'TIPOCOMPROBANTE') || ''),
        }));

      /* Remitos del día */
      const remitos = todosRemitos
        .filter(r => {
          const c = normalizarText_(getField(r, 'chofer', 'CHOFER') || '');
          return c === emailNorm && mismaFecha(getField(r, 'fecha', 'FECHA'), fechaISO);
        })
        .map(r => ({
          nroRemito:       String(getField(r, 'nroRemito',      'NROREMITO')      || ''),
          razonSocial:     String(getField(r, 'razonSocial',    'RAZONSOCIAL')    || ''),
          combustible:     Number(getField(r, 'combustible',    'COMBUSTIBLE')    || 0),
          monto:           parseMonto_(getField(r, 'monto', 'MONTO')),
          tipoCombustible: String(getField(r, 'tipoCombustible','TIPOCOMBUSTIBLE')|| ''),
        }));

      /* Reporte KM del día — si hay varios tomamos el último guardado */
      const reportesDia = todosReportes.filter(rep => {
        const c = normalizarText_(getField(rep, 'chofer', 'CHOFER') || '');
        return c === emailNorm && mismaFecha(getField(rep, 'fecha', 'FECHA'), fechaISO);
      });

      let km = { inicial: 0, final: 0, recorridos: 0 };
      let observaciones = '';
      if (reportesDia.length > 0) {
        const rep      = reportesDia[reportesDia.length - 1];
        km.inicial     = Number(getField(rep, 'kmInicial',    'KM INICIAL',    'km_inicial')    || 0);
        km.final       = Number(getField(rep, 'kmFinal',      'KM FINAL',      'km_final')      || 0);
        km.recorridos  = Number(getField(rep, 'kmRecorridos', 'KM RECORRIDOS', 'km_recorridos') || 0);
        observaciones  = String(getField(rep, 'observaciones', 'OBSERVACIONES') || '');
      }

      /* ASISTENCIA — primero por doc ID exacto ({ISO}_{uid}), luego fallback por nombre */
      const docIdExacto = `${fechaISO}_${chofer.uid}`;
      let asistencia = todasAsistencias.find(a =>
        a._docId === docIdExacto ||
        (a.fecha === fechaISO && a.choferId === chofer.uid)
      );
      if (!asistencia) {
        asistencia = todasAsistencias.find(a =>
          a.fecha === fechaISO && (
            normalizarText_(a.choferNombre || '') === nombreNorm ||
            normalizarText_(a.choferId     || '') === nombreNorm
          )
        );
      }
      const chicos = (asistencia?.beneficiarios || []).map(b => ({
        nombre:    String(b.nombre    || b.NOMBRE    || ''),
        domicilio: String(b.domicilio || b.DOMICILIO || ''),
      })).filter(b => b.nombre);

      const montoTotal = egresos.reduce((s, e) => s + e.monto, 0);

      console.log(
        `[RESUMEN-DIARIO]   → ${chofer.nombre} (${chofer.email})` +
        ` | egresos:${egresos.length} remitos:${remitos.length}` +
        ` reportes:${reportesDia.length} chicos:${chicos.length}`
      );

      return {
        email:        chofer.email,
        nombre:       chofer.nombre,
        vehiculo:     chofer.vehiculo,
        km,
        montoTotal,
        observaciones,
        egresos,
        remitos,
        chicos,
      };
    });

    /* 4 ── Filtrar choferes sin ninguna actividad ese día ─────────────────── */
    const conActividad = resultado.filter(c =>
      c.egresos.length > 0 ||
      c.remitos.length > 0 ||
      c.km.recorridos  > 0 ||
      c.chicos.length  > 0
    );

    console.log(`[RESUMEN-DIARIO] ${fechaISO} → ${conActividad.length}/${resultado.length} choferes con actividad`);

    res.json({ ok: true, fecha: fechaISO, choferes: conActividad });
  } catch (e) {
    console.error('[RESUMEN-DIARIO]', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
