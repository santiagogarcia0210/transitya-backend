// Cálculo del presupuesto de transporte (formato multi-viaje). Funciones puras: sin Firestore, sin red.
//
// Reglas (verificadas al centavo contra un presupuesto real de 4 viajes, 824,12 km y $1.001.314,05):
//   importe diario  = km del viaje × valor del km
//   importe mensual = importe diario (SIN redondear) × días por semana × semanas por mes (4,4 por defecto)
//                     y se redondea a centavos POR VIAJE; el total es la suma de esos importes ya redondeados.
//   km mensuales    = Σ km del viaje × días por semana × semanas por mes
//   No se usan días hábiles reales ni feriados.
//
// Adicional por dependencia: valor final = valor base × (1 + %/100), redondeado a centavos (847,27 → 1.143,81 con 35%).
//
// Tramo corto (Resolución Conjunta 1/2023): NO se asume ninguna unidad de aplicación. Está apagado por defecto y,
// si se activa, hay que elegir la unidad. Con mínimo M y km reales K:
//   'sentido' → cada SENTIDO de circulación se lleva a M si K < M. Un viaje de ida y vuelta (total) se parte en dos
//               sentidos iguales; "dos recorridos" son dos sentidos con sus propios km; un viaje de un solo sentido es uno.
//   'viaje'   → el viaje completo (suma de sus sentidos) se lleva a M si el total es < M.
//   'dia'     → el total de km de cada DÍA de la semana (suma de los viajes de ese día) se lleva a M si es < M. El
//               faltante no se le asigna a un viaje en particular: se muestra como "ajuste por mínimo diario".
const SEMANAS_POR_MES_DEFAULT = 4.4;
const TRAMO_CORTO_KM_DEFAULT = 12;
const UNIDADES_TRAMO_CORTO = ['sentido', 'viaje', 'dia'];
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/** Redondeo a centavos (el "medio" sube, tolerando el error binario de los decimales). */
const r2 = x => Math.round((Number(x) + 1e-9) * 100) / 100;
const num = x => (Number.isFinite(Number(x)) ? Number(x) : NaN);

/** Normaliza el valor del km con adicional por dependencia. */
function valorKmFinal(valorBase, dependencia) {
  const base = r2(valorBase);
  const activa = !!(dependencia && dependencia.activa);
  const porcentaje = activa ? Number(dependencia.porcentaje ?? 35) : 0;
  const final = activa ? r2(base * (1 + porcentaje / 100)) : base;
  return { base, adicional: r2(final - base), porcentaje, aplicado: activa, final };
}

/** Sentidos (km de cada uno) de un viaje según cómo se leyó el recorrido. */
function sentidosDe(viaje) {
  const modalidad = viaje.modalidad || 'solo_ida';
  if (modalidad === 'dos_recorridos') return [num(viaje.kmIda), num(viaje.kmVuelta)];
  const km = sumaTramos(viaje);
  if (modalidad === 'ida_vuelta_total') return [km / 2, km / 2];     // NUNCA se duplica un recorrido que ya es ida y vuelta
  return viaje.incluyeVuelta ? [km, km] : [km];
}
const sumaTramos = v => (Array.isArray(v.tramos) && v.tramos.length ? v.tramos.reduce((a, k) => a + num(k), 0) : num(v.km));

/** Días de traslado: acepta una lista de días ('lunes'…) o una cantidad por semana. */
function diasPorSemanaDe(v) {
  if (Array.isArray(v.dias)) return v.dias.filter(d => DIAS.includes(d)).length;
  return num(v.diasPorSemana);
}

/**
 * entrada: { viajes: [{ id, origen, destino, tramos?|km, modalidad?, incluyeVuelta?, kmIda?, kmVuelta?, dias[]|diasPorSemana }],
 *            valorKmBase, dependencia?: { activa, porcentaje }, semanasPorMes?, tramoCorto?: { activo, kmMinimo, unidad } }
 * Lanza Error con `.mensaje` si falta algo o no tiene sentido.
 */
function calcularPresupuesto(entrada) {
  const err = mensaje => Object.assign(new Error(mensaje), { mensaje });
  const viajes = Array.isArray(entrada.viajes) ? entrada.viajes : [];
  if (!viajes.length) throw err('Cargá al menos un viaje.');
  if (!(num(entrada.valorKmBase) > 0)) throw err('Falta el valor del km.');
  const semanas = entrada.semanasPorMes === undefined ? SEMANAS_POR_MES_DEFAULT : num(entrada.semanasPorMes);
  if (!(semanas > 0 && semanas <= 5)) throw err('Las semanas por mes tienen que estar entre 0 y 5.');
  const tc = entrada.tramoCorto || { activo: false };
  const tramoCortoActivo = tc.activo === true;
  const minimo = tc.kmMinimo === undefined ? TRAMO_CORTO_KM_DEFAULT : num(tc.kmMinimo);
  if (tramoCortoActivo) {
    if (!UNIDADES_TRAMO_CORTO.includes(tc.unidad)) throw err('El tramo corto está activo pero no tiene unidad de aplicación configurada (por sentido, por viaje o por día).');
    if (!(minimo > 0)) throw err('El km mínimo del tramo corto no es válido.');
  }
  const valor = valorKmFinal(entrada.valorKmBase, entrada.dependencia);

  const filas = viajes.map((v, i) => {
    const id = String(v.id || i + 1);
    const sentidos = sentidosDe(v);
    if (sentidos.some(k => !(k > 0))) throw err(`El viaje ${id} no tiene km válidos.`);
    const dias = diasPorSemanaDe(v);
    if (!(dias > 0 && dias <= 6)) throw err(`El viaje ${id} no tiene días de traslado.`);
    const kmReales = sentidos.reduce((a, k) => a + k, 0);
    let kmFacturables = kmReales, llevadoAlMinimo = false;
    if (tramoCortoActivo && tc.unidad === 'sentido') {
      const ajustados = sentidos.map(k => Math.max(k, minimo));
      kmFacturables = ajustados.reduce((a, k) => a + k, 0);
      llevadoAlMinimo = sentidos.some(k => k < minimo);
    } else if (tramoCortoActivo && tc.unidad === 'viaje') {
      kmFacturables = Math.max(kmReales, minimo);
      llevadoAlMinimo = kmReales < minimo;
    }
    const viajesMes = dias * semanas;
    const importeDiario = kmFacturables * valor.final;                      // sin redondear (se muestra redondeado)
    return {
      id, origen: v.origen || '', destino: v.destino || '', tramos: Array.isArray(v.tramos) ? v.tramos.map(Number) : null,
      modalidad: v.modalidad || 'solo_ida', sentidos: sentidos.map(k => r2(k)), diasPorSemana: dias, dias: Array.isArray(v.dias) ? v.dias : null,
      kmReales: r2(kmReales), kmFacturables: r2(kmFacturables), llevadoAlMinimo,
      viajesMes: r2(viajesMes), kmMes: r2(kmFacturables * viajesMes),
      importeDiario: r2(importeDiario), importeMensual: r2(importeDiario * dias * semanas),
      _kmMesExacto: kmFacturables * viajesMes,
    };
  });

  // Tramo corto por día: se mira cada día de la semana con todos los viajes de ese día.
  let ajusteDiario = null;
  if (tramoCortoActivo && tc.unidad === 'dia') {
    const porDia = Object.fromEntries(DIAS.map(d => [d, 0]));
    const sinLista = viajes.some(v => !Array.isArray(v.dias));
    if (sinLista) throw err('Para aplicar el tramo corto por día hace falta indicar qué días de la semana hace cada viaje.');
    viajes.forEach((v, i) => v.dias.forEach(d => { if (porDia[d] !== undefined) porDia[d] += filas[i].kmReales; }));
    const dias = [];
    let kmExtraSemana = 0;
    for (const d of DIAS) {
      if (porDia[d] > 0 && porDia[d] < minimo) { dias.push({ dia: d, kmReales: r2(porDia[d]), kmFacturables: r2(minimo) }); kmExtraSemana += minimo - porDia[d]; }
    }
    if (kmExtraSemana > 0) {
      const kmMes = kmExtraSemana * semanas;
      ajusteDiario = { unidad: 'dia', minimo, dias, kmMes: r2(kmMes), importeMensual: r2(kmMes * valor.final) };
    }
  }

  const kmMensuales = r2(filas.reduce((a, f) => a + f._kmMesExacto, 0) + (ajusteDiario ? ajusteDiario.kmMes : 0));
  const total = r2(filas.reduce((a, f) => a + f.importeMensual, 0) + (ajusteDiario ? ajusteDiario.importeMensual : 0));
  for (const f of filas) delete f._kmMesExacto;
  return {
    valorKm: valor, semanasPorMes: semanas,
    tramoCorto: tramoCortoActivo ? { activo: true, unidad: tc.unidad, kmMinimo: minimo, viajesLlevadosAlMinimo: filas.filter(f => f.llevadoAlMinimo).map(f => f.id) } : { activo: false },
    viajes: filas, ajusteDiario, kmMensuales, total,
  };
}

module.exports = { calcularPresupuesto, valorKmFinal, sentidosDe, r2, DIAS, UNIDADES_TRAMO_CORTO, SEMANAS_POR_MES_DEFAULT, TRAMO_CORTO_KM_DEFAULT };
