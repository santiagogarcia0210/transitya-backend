/**
 * Lógica de join multi-colección para resumen diario y mensual por chofer.
 */
const { col, parseMonto_, normalizarText_ } = require('../utils');

/* ── Helpers de fecha ─────────────────────────────────────────────────────── */

const isoToDMY = (iso) => {
  if (!iso || !iso.includes('-')) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

// Parsea dd/MM/yyyy → Date (null si no puede)
const dmyToDate = (f) => {
  const p = String(f || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!p) return null;
  return new Date(Number(p[3]), Number(p[2]) - 1, Number(p[1]));
};

const getField = (doc, ...keys) => {
  for (const k of keys) if (doc[k] !== undefined) return doc[k];
  return undefined;
};

const mismaFecha = (campoFecha, fechaISO) => {
  const f = String(campoFecha || '').trim();
  return f === fechaISO || f === isoToDMY(fechaISO);
};

// ¿campoFecha (cualquier formato) pertenece al mes/año dado?
const enMes = (campoFecha, mes, anio) => {
  const f = String(campoFecha || '').trim();
  const pDMY = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (pDMY) return Number(pDMY[2]) === mes && Number(pDMY[3]) === anio;
  const pISO = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (pISO) return Number(pISO[1]) === anio && Number(pISO[2]) === mes;
  return false;
};

// Normaliza cualquier fecha de campo a string dd/MM/yyyy (para mostrar)
const normalizarFecha = (campoFecha) => {
  const f = String(campoFecha || '').trim();
  // Si ya es dd/MM/yyyy
  if (/^\d{1,2}\/\d{2}\/\d{4}$/.test(f)) return f;
  // Si es ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return isoToDMY(f);
  return f;
};

// Ordena un array de docs por fecha asc (soporta ambos formatos)
const ordenarPorFecha = (docs) => {
  const toMs = (f) => {
    const d = dmyToDate(normalizarFecha(f));
    return d ? d.getTime() : 0;
  };
  return [...docs].sort((a, b) => {
    const fa = getField(a, 'fecha', 'FECHA') || '';
    const fb = getField(b, 'fecha', 'FECHA') || '';
    return toMs(fa) - toMs(fb);
  });
};

/* ── Carga de usuarios activos con rol=chofer ─────────────────────────────── */
async function cargarChoferes(tenantId, soloEmail) {
  const snap = await col(tenantId, 'usuarios').get();
  let choferes = snap.docs
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
  return choferes;
}

/* ── Carga paralela de todas las colecciones ──────────────────────────────── */
async function cargarColecciones(tenantId) {
  const [egSnap, rmSnap, repSnap, asSnap] = await Promise.all([
    col(tenantId, 'egresos').get(),
    col(tenantId, 'remitos').get(),
    col(tenantId, 'reportes').get(),
    col(tenantId, 'ASISTENCIA').get(),
  ]);
  return {
    egresos:     egSnap.docs.map(d => ({ _id: d.id, ...d.data() })),
    remitos:     rmSnap.docs.map(d => ({ _id: d.id, ...d.data() })),
    reportes:    repSnap.docs.map(d => ({ _id: d.id, ...d.data() })),
    asistencias: asSnap.docs.map(d => ({ _docId: d.id, ...d.data() })),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   calcularResumenDiario
   ═══════════════════════════════════════════════════════════════════════════ */
async function calcularResumenDiario(tenantId, fechaISO, soloEmail = null) {
  const fechaDMY = isoToDMY(fechaISO);
  const choferes = await cargarChoferes(tenantId, soloEmail);
  const { egresos: todosE, remitos: todosR, reportes: todosRep, asistencias: todasA } =
    await cargarColecciones(tenantId);

  const logs = [
    `[RESUMEN-DIARIO] ${fechaISO} (${fechaDMY}) | raw →` +
    ` egresos:${todosE.length} remitos:${todosR.length}` +
    ` reportes:${todosRep.length} asistencias:${todasA.length}`
  ];

  const resultado = choferes.map(chofer => {
    const emailNorm  = normalizarText_(chofer.email);
    const nombreNorm = normalizarText_(chofer.nombre);

    const egresos = todosE
      .filter(e => normalizarText_(getField(e,'chofer','CHOFER')||'') === emailNorm &&
                   mismaFecha(getField(e,'fecha','FECHA'), fechaISO))
      .map(e => ({
        categoria:       String(getField(e,'categoria','CATEGORIA')||''),
        proveedor:       String(getField(e,'proveedor','PROVEEDOR')||''),
        monto:           parseMonto_(getField(e,'monto','MONTO')),
        concepto:        String(getField(e,'concepto','CONCEPTO')||''),
        tipoComprobante: String(getField(e,'tipoComprobante','TIPOCOMPROBANTE')||''),
      }));

    const remitos = todosR
      .filter(r => normalizarText_(getField(r,'chofer','CHOFER')||'') === emailNorm &&
                   mismaFecha(getField(r,'fecha','FECHA'), fechaISO))
      .map(r => ({
        nroRemito:       String(getField(r,'nroRemito','NROREMITO')||''),
        razonSocial:     String(getField(r,'razonSocial','RAZONSOCIAL')||''),
        combustible:     Number(getField(r,'combustible','COMBUSTIBLE')||0),
        monto:           parseMonto_(getField(r,'monto','MONTO')),
        tipoCombustible: String(getField(r,'tipoCombustible','TIPOCOMBUSTIBLE')||''),
      }));

    const reportesDia = todosRep.filter(rep =>
      normalizarText_(getField(rep,'chofer','CHOFER')||'') === emailNorm &&
      mismaFecha(getField(rep,'fecha','FECHA'), fechaISO)
    );

    let km = { inicial: 0, final: 0, recorridos: 0 };
    let observaciones = '';
    if (reportesDia.length > 0) {
      const rep     = reportesDia[reportesDia.length - 1];
      km.inicial    = Number(getField(rep,'kmInicial','KM INICIAL','km_inicial')||0);
      km.final      = Number(getField(rep,'kmFinal','KM FINAL','km_final')||0);
      km.recorridos = Number(getField(rep,'kmRecorridos','KM RECORRIDOS','km_recorridos')||0);
      observaciones = String(getField(rep,'observaciones','OBSERVACIONES')||'');
    }

    const docIdExacto = `${fechaISO}_${chofer.uid}`;
    let asistencia = todasA.find(a =>
      a._docId === docIdExacto || (a.fecha === fechaISO && a.choferId === chofer.uid)
    );
    if (!asistencia) {
      asistencia = todasA.find(a =>
        a.fecha === fechaISO && (
          normalizarText_(a.choferNombre||'') === nombreNorm ||
          normalizarText_(a.choferId||'')    === nombreNorm
        )
      );
    }
    const chicos = (asistencia?.beneficiarios || [])
      .map(b => ({ nombre: String(b.nombre||b.NOMBRE||''), domicilio: String(b.domicilio||b.DOMICILIO||'') }))
      .filter(b => b.nombre);

    const montoTotal = egresos.reduce((s, e) => s + e.monto, 0);

    logs.push(
      `[RESUMEN-DIARIO]   → ${chofer.nombre} | egresos:${egresos.length}` +
      ` remitos:${remitos.length} reportes:${reportesDia.length}` +
      ` chicos:${chicos.length} monto:$${montoTotal.toFixed(2)}`
    );

    return { email:chofer.email, nombre:chofer.nombre, vehiculo:chofer.vehiculo,
             km, montoTotal, observaciones, egresos, remitos, chicos };
  });

  const conActividad = resultado.filter(c =>
    c.egresos.length>0 || c.remitos.length>0 || c.km.recorridos>0 || c.chicos.length>0
  );
  logs.push(`[RESUMEN-DIARIO] ${fechaISO} → ${conActividad.length}/${resultado.length} con actividad`);

  return { fecha: fechaISO, choferes: conActividad, _logs: logs };
}

/* ═══════════════════════════════════════════════════════════════════════════
   calcularResumenMensual
   ═══════════════════════════════════════════════════════════════════════════ */
async function calcularResumenMensual(tenantId, mesISO, soloEmail = null) {
  // mesISO: 'YYYY-MM'
  const [anioStr, mesStr] = mesISO.split('-');
  const anio = Number(anioStr);
  const mes  = Number(mesStr);

  const choferes = await cargarChoferes(tenantId, soloEmail);
  const { egresos: todosE, remitos: todosR, reportes: todosRep, asistencias: todasA } =
    await cargarColecciones(tenantId);

  const logs = [
    `[RESUMEN-MENSUAL] ${mesISO} | raw →` +
    ` egresos:${todosE.length} remitos:${todosR.length}` +
    ` reportes:${todosRep.length} asistencias:${todasA.length}`
  ];

  const resultado = choferes.map(chofer => {
    const emailNorm  = normalizarText_(chofer.email);
    const nombreNorm = normalizarText_(chofer.nombre);

    /* Egresos del mes — incluyen fecha para el PDF */
    const egresosRaw = ordenarPorFecha(
      todosE.filter(e =>
        normalizarText_(getField(e,'chofer','CHOFER')||'') === emailNorm &&
        enMes(getField(e,'fecha','FECHA'), mes, anio)
      )
    );
    const egresos = egresosRaw.map(e => ({
      fecha:           normalizarFecha(getField(e,'fecha','FECHA')||''),
      categoria:       String(getField(e,'categoria','CATEGORIA')||''),
      proveedor:       String(getField(e,'proveedor','PROVEEDOR')||''),
      monto:           parseMonto_(getField(e,'monto','MONTO')),
      concepto:        String(getField(e,'concepto','CONCEPTO')||''),
      tipoComprobante: String(getField(e,'tipoComprobante','TIPOCOMPROBANTE')||''),
    }));

    /* Remitos del mes — incluyen fecha */
    const remitosRaw = ordenarPorFecha(
      todosR.filter(r =>
        normalizarText_(getField(r,'chofer','CHOFER')||'') === emailNorm &&
        enMes(getField(r,'fecha','FECHA'), mes, anio)
      )
    );
    const remitos = remitosRaw.map(r => ({
      fecha:           normalizarFecha(getField(r,'fecha','FECHA')||''),
      nroRemito:       String(getField(r,'nroRemito','NROREMITO')||''),
      razonSocial:     String(getField(r,'razonSocial','RAZONSOCIAL')||''),
      combustible:     Number(getField(r,'combustible','COMBUSTIBLE')||0),
      monto:           parseMonto_(getField(r,'monto','MONTO')),
      tipoCombustible: String(getField(r,'tipoCombustible','TIPOCOMBUSTIBLE')||''),
    }));

    /* Reportes KM del mes — ordenados por fecha */
    const reportesMes = ordenarPorFecha(
      todosRep.filter(rep =>
        normalizarText_(getField(rep,'chofer','CHOFER')||'') === emailNorm &&
        enMes(getField(rep,'fecha','FECHA'), mes, anio)
      )
    );

    let km = { inicial: 0, final: 0, recorridos: 0 };
    let diasActivos = reportesMes.length;
    let observaciones = '';

    if (reportesMes.length > 0) {
      const primero = reportesMes[0];
      const ultimo  = reportesMes[reportesMes.length - 1];
      km.inicial  = Number(getField(primero,'kmInicial','KM INICIAL','km_inicial')||0);
      km.final    = Number(getField(ultimo,'kmFinal','KM FINAL','km_final')||0);
      km.recorridos = reportesMes.reduce((s, rep) =>
        s + Number(getField(rep,'kmRecorridos','KM RECORRIDOS','km_recorridos')||0), 0
      );
      // Observaciones: una por día con fecha
      const obsLines = reportesMes
        .map(rep => {
          const obs = String(getField(rep,'observaciones','OBSERVACIONES')||'').trim();
          const f   = normalizarFecha(getField(rep,'fecha','FECHA')||'');
          return obs ? `${f}: ${obs}` : null;
        })
        .filter(Boolean);
      observaciones = obsLines.join('\n');
    }

    /* ASISTENCIA mensual — todos los docs del mes para este chofer */
    const asistenciasMes = todasA.filter(a => {
      if (!a.fecha || !a.fecha.startsWith(mesISO)) return false;
      return a.choferId === chofer.uid ||
             normalizarText_(a.choferNombre||'') === nombreNorm ||
             normalizarText_(a.choferId||'')     === nombreNorm;
    });

    // Beneficiarios únicos + conteo de días transportados
    const chicosMap = new Map(); // nombre → { domicilio, dias }
    asistenciasMes.forEach(a => {
      (a.beneficiarios || []).forEach(b => {
        const nombre = String(b.nombre||b.NOMBRE||'').trim();
        if (!nombre) return;
        const dom = String(b.domicilio||b.DOMICILIO||'');
        if (chicosMap.has(nombre)) {
          chicosMap.get(nombre).diasTransportado++;
        } else {
          chicosMap.set(nombre, { nombre, domicilio: dom, diasTransportado: 1 });
        }
      });
    });
    const chicos = [...chicosMap.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));

    const montoTotal = egresos.reduce((s, e) => s + e.monto, 0);

    logs.push(
      `[RESUMEN-MENSUAL]   → ${chofer.nombre} | egresos:${egresos.length}` +
      ` remitos:${remitos.length} reportes:${diasActivos}` +
      ` chicos:${chicos.size||chicos.length} monto:$${montoTotal.toFixed(2)}`
    );

    return {
      email: chofer.email, nombre: chofer.nombre, vehiculo: chofer.vehiculo,
      km, diasActivos, montoTotal, observaciones,
      egresos, remitos, chicos,
    };
  });

  const conActividad = resultado.filter(c =>
    c.egresos.length>0 || c.remitos.length>0 || c.km.recorridos>0 || c.chicos.length>0
  );
  logs.push(`[RESUMEN-MENSUAL] ${mesISO} → ${conActividad.length}/${resultado.length} con actividad`);

  return { mes: mesISO, choferes: conActividad, _logs: logs };
}

module.exports = { calcularResumenDiario, calcularResumenMensual, isoToDMY };
