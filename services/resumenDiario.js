/**
 * Lógica de join multi-colección para el resumen diario por chofer.
 * Usada por routes/reportes-km.js y scripts/test-resumen-diario.js.
 */
const { col, parseMonto_, normalizarText_ } = require('../utils');

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const isoToDMY = (iso) => {
  if (!iso || !iso.includes('-')) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const getField = (doc, ...keys) => {
  for (const k of keys) if (doc[k] !== undefined) return doc[k];
  return undefined;
};

const mismaFecha = (campoFecha, fechaISO) => {
  const f = String(campoFecha || '').trim();
  return f === fechaISO || f === isoToDMY(fechaISO);
};

/* ── Core ─────────────────────────────────────────────────────────────────── */

/**
 * @param {string} tenantId
 * @param {string} fechaISO  — YYYY-MM-DD
 * @param {string|null} soloEmail — si no es null, filtra solo ese chofer
 * @returns {Promise<{ fecha: string, choferes: object[] }>}
 */
async function calcularResumenDiario(tenantId, fechaISO, soloEmail = null) {
  const fechaDMY = isoToDMY(fechaISO);

  /* 1 ── Choferes desde colección usuarios ─────────────────────────────── */
  const usuariosSnap = await col(tenantId, 'usuarios').get();
  let choferes = usuariosSnap.docs
    .map(d => ({ uid: d.id, ...d.data() }))
    .filter(u => {
      const rol    = u.rol || u.role || '';
      const activo = u.activo !== false;
      return (rol === 'chofer') && activo;
    })
    .map(u => ({
      uid:      u.uid,
      email:    (u.email    || '').trim(),
      nombre:   (u.nombre   || u.usuario || (u.email ? u.email.split('@')[0] : '') || '').trim(),
      vehiculo: (u.vehiculo || '').trim(),
    }));

  if (soloEmail) {
    choferes = choferes.filter(c => c.email.toLowerCase() === soloEmail.toLowerCase());
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

  const logs = [
    `[RESUMEN-DIARIO] ${fechaISO} (${fechaDMY}) | raw totales →` +
    ` egresos:${todosEgresos.length}` +
    ` remitos:${todosRemitos.length}` +
    ` reportes:${todosReportes.length}` +
    ` asistencias:${todasAsistencias.length}`
  ];

  /* 3 ── Armar resumen por chofer ──────────────────────────────────────── */
  const resultado = choferes.map(chofer => {
    const emailNorm  = normalizarText_(chofer.email);
    const nombreNorm = normalizarText_(chofer.nombre);

    /* Egresos */
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

    /* Remitos */
    const remitos = todosRemitos
      .filter(r => {
        const c = normalizarText_(getField(r, 'chofer', 'CHOFER') || '');
        return c === emailNorm && mismaFecha(getField(r, 'fecha', 'FECHA'), fechaISO);
      })
      .map(r => ({
        nroRemito:       String(getField(r, 'nroRemito',       'NROREMITO')       || ''),
        razonSocial:     String(getField(r, 'razonSocial',     'RAZONSOCIAL')     || ''),
        combustible:     Number(getField(r, 'combustible',     'COMBUSTIBLE')     || 0),
        monto:           parseMonto_(getField(r, 'monto', 'MONTO')),
        tipoCombustible: String(getField(r, 'tipoCombustible', 'TIPOCOMBUSTIBLE') || ''),
      }));

    /* Reporte KM — tomamos el último del día */
    const reportesDia = todosReportes.filter(rep => {
      const c = normalizarText_(getField(rep, 'chofer', 'CHOFER') || '');
      return c === emailNorm && mismaFecha(getField(rep, 'fecha', 'FECHA'), fechaISO);
    });

    let km = { inicial: 0, final: 0, recorridos: 0 };
    let observaciones = '';
    if (reportesDia.length > 0) {
      const rep     = reportesDia[reportesDia.length - 1];
      km.inicial    = Number(getField(rep, 'kmInicial',    'KM INICIAL',    'km_inicial')    || 0);
      km.final      = Number(getField(rep, 'kmFinal',      'KM FINAL',      'km_final')      || 0);
      km.recorridos = Number(getField(rep, 'kmRecorridos', 'KM RECORRIDOS', 'km_recorridos') || 0);
      observaciones = String(getField(rep, 'observaciones', 'OBSERVACIONES') || '');
    }

    /* ASISTENCIA — por UID exacto, fallback por nombre */
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
    const chicos = (asistencia?.beneficiarios || [])
      .map(b => ({
        nombre:    String(b.nombre    || b.NOMBRE    || ''),
        domicilio: String(b.domicilio || b.DOMICILIO || ''),
      }))
      .filter(b => b.nombre);

    const montoTotal = egresos.reduce((s, e) => s + e.monto, 0);

    logs.push(
      `[RESUMEN-DIARIO]   → ${chofer.nombre} (${chofer.email})` +
      ` | egresos:${egresos.length} remitos:${remitos.length}` +
      ` reportes:${reportesDia.length} chicos:${chicos.length}` +
      ` monto:$${montoTotal.toFixed(2)}`
    );

    return {
      email: chofer.email,
      nombre: chofer.nombre,
      vehiculo: chofer.vehiculo,
      km,
      montoTotal,
      observaciones,
      egresos,
      remitos,
      chicos,
    };
  });

  /* 4 ── Filtrar sin actividad ─────────────────────────────────────────── */
  const conActividad = resultado.filter(c =>
    c.egresos.length > 0 ||
    c.remitos.length > 0 ||
    c.km.recorridos  > 0 ||
    c.chicos.length  > 0
  );

  logs.push(
    `[RESUMEN-DIARIO] ${fechaISO} → ${conActividad.length}/${resultado.length} choferes con actividad`
  );

  return { fecha: fechaISO, choferes: conActividad, _logs: logs };
}

module.exports = { calcularResumenDiario, isoToDMY };
