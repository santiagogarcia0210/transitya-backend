// Configuración de presupuestos de transporte: datos del transportista (se cargan UNA vez) y, por obra social, el
// formato, la plantilla y los parámetros (tramo corto, semanas por mes, % de dependencia). Funciones puras.
//   empresas/{t}/config/transportista            { razonSocial, responsable, cuit, domicilio, telefono, mail, aseguradora, poliza }
//   empresas/{t}/presupuesto_obras/{obraId}      { obraId, nombre, cuit, formato, plantilla?, tramoCorto, semanasPorMes, dependenciaPct }
const { UNIDADES_TRAMO_CORTO, SEMANAS_POR_MES_DEFAULT, TRAMO_CORTO_KM_DEFAULT } = require('./presupuestoCalculo');

const FORMATOS = ['traslados_programados', 'multi_viaje'];
const FORMATO_DEFAULT = 'multi_viaje';          // la obra social sin plantilla propia usa el multi-viaje
const err = mensaje => Object.assign(new Error(mensaje), { mensaje });
const recortar = (v, n) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** Dígito verificador del CUIT/CUIL (módulo 11). */
function cuitValido(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  const m = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let r = 11 - (d.slice(0, 10).split('').reduce((a, x, i) => a + Number(x) * m[i], 0) % 11);
  if (r === 11) r = 0;
  if (r === 10) r = 9;
  return r === Number(d[10]);
}
const formatoCuit = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d[10]}` : String(c || ''); };

/** Datos del transportista. Lanza Error con `.mensaje` si algo no es válido. */
function limpiarTransportista(b) {
  const t = {
    razonSocial: recortar(b.razonSocial, 120), responsable: recortar(b.responsable, 120), cuit: formatoCuit(recortar(b.cuit, 20)),
    domicilio: recortar(b.domicilio, 200), telefono: recortar(b.telefono, 40), mail: recortar(b.mail, 120).toLowerCase(),
    aseguradora: recortar(b.aseguradora, 80), poliza: recortar(b.poliza, 60),
  };
  if (!t.razonSocial) throw err('Falta la razón social.');
  if (!cuitValido(t.cuit)) throw err('El CUIT no es válido (revisá los dígitos).');
  if (/^[xX\s._-]+$/.test(t.domicilio)) throw err('El domicilio es un texto de relleno: cargá el domicilio real.');
  if (t.mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.mail)) throw err('El mail no es válido.');
  return t;
}

/** Qué falta para poder emitir un presupuesto (la póliza queda como aviso, no bloquea). */
function faltantesTransportista(t) {
  const obligatorios = { razonSocial: 'razón social', cuit: 'CUIT', domicilio: 'domicilio', telefono: 'teléfono', mail: 'mail' };
  const faltan = Object.entries(obligatorios).filter(([k]) => !t || !String(t[k] || '').trim()).map(([, n]) => n);
  const avisos = [];
  if (!t || !String(t.aseguradora || '').trim()) avisos.push('Falta la compañía de seguros.');
  if (!t || !String(t.poliza || '').trim()) avisos.push('Falta el número de póliza.');
  return { faltan, avisos };
}

/** Configuración de una obra social. El tramo corto arranca apagado y, si se activa, exige elegir la unidad. */
function limpiarObra(b) {
  const nombre = recortar(b.nombre, 120);
  if (!nombre) throw err('Falta el nombre de la obra social.');
  const cuit = recortar(b.cuit, 20);
  if (cuit && !cuitValido(cuit)) throw err('El CUIT de la obra social no es válido.');
  const formato = b.formato === undefined || b.formato === '' ? FORMATO_DEFAULT : b.formato;
  if (!FORMATOS.includes(formato)) throw err('Formato de presupuesto inválido.');
  const tc = b.tramoCorto && typeof b.tramoCorto === 'object' ? b.tramoCorto : {};
  const activo = tc.activo === true;
  const kmMinimo = tc.kmMinimo === undefined || tc.kmMinimo === '' ? TRAMO_CORTO_KM_DEFAULT : Number(tc.kmMinimo);
  if (!(kmMinimo > 0 && kmMinimo <= 100)) throw err('El km mínimo del tramo corto no es válido.');
  const unidad = UNIDADES_TRAMO_CORTO.includes(tc.unidad) ? tc.unidad : null;
  if (activo && !unidad) throw err('Para activar el tramo corto elegí la unidad de aplicación (por sentido, por viaje o por día): la resolución no la especifica.');
  const semanas = b.semanasPorMes === undefined || b.semanasPorMes === '' ? SEMANAS_POR_MES_DEFAULT : Number(b.semanasPorMes);
  if (!(semanas > 0 && semanas <= 5)) throw err('Las semanas por mes tienen que estar entre 0 y 5.');
  const dep = b.dependenciaPct === undefined || b.dependenciaPct === '' ? 35 : Number(b.dependenciaPct);
  if (!(dep >= 0 && dep <= 200)) throw err('El porcentaje de dependencia no es válido.');
  return { nombre, cuit: cuit ? formatoCuit(cuit) : '', formato, tramoCorto: { activo, kmMinimo, unidad }, semanasPorMes: semanas, dependenciaPct: dep };
}

/** Configuración por defecto de una obra social que todavía no se configuró. */
const obraPorDefecto = (obraId, nombre = '') => ({
  obraId, nombre, cuit: '', formato: FORMATO_DEFAULT, plantilla: null,
  tramoCorto: { activo: false, kmMinimo: TRAMO_CORTO_KM_DEFAULT, unidad: null }, semanasPorMes: SEMANAS_POR_MES_DEFAULT, dependenciaPct: 35,
});

module.exports = { FORMATOS, FORMATO_DEFAULT, cuitValido, formatoCuit, limpiarTransportista, faltantesTransportista, limpiarObra, obraPorDefecto };
