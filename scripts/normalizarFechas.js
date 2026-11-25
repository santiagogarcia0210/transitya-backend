#!/usr/bin/env node
// Migra las fechas ya guardadas de remitos y egresos al formato dd/MM/yyyy.
//
// Contexto: algunas rutas guardaban la fecha cruda en ISO (yyyy-MM-dd, lo que manda
// <input type="date">). Esos documentos no se ordenaban ni entraban en los filtros por fecha.
// Las rutas ya normalizan al guardar; este script arregla lo que quedó guardado antes.
//
// Recorre empresas/*/remitos y empresas/*/egresos.
//
//   node scripts/normalizarFechas.js                    DRY-RUN (por defecto): no escribe nada.
//                                                       Cuenta cuántos documentos cambiaría por
//                                                       empresa y colección, y lista los que no
//                                                       puede interpretar.
//   node scripts/normalizarFechas.js --apply            Escribe. En batches de 400. Guarda el valor
//                                                       anterior en el campo fechaOriginal.
//   node scripts/normalizarFechas.js --tenant=<id>      Limita a una empresa (se combina con --apply).
//
// Es idempotente: un documento que ya está en dd/MM/yyyy no se toca, así que correrlo dos veces
// no cambia nada la segunda. Los que no se pueden interpretar nunca se modifican: se listan para
// corregirlos a mano.
//
// OJO: usa FIREBASE_SA, o sea la base a la que apunte tu .env (en esta máquina, producción).
// El dry-run solo lee. Solo --apply escribe.

const { normalizarFecha } = require('../utils/fechas');

const COLECCIONES = ['remitos', 'egresos'];
const TAMANO_BATCH = 400;
// Campos de fecha que leen las rutas. Los documentos migrados desde Sheets traen FECHA en mayúsculas.
const CAMPOS = ['fecha', 'FECHA'];

const tieneValor = v => v !== undefined && v !== null && v !== '';

/**
 * Clasifica un documento:
 *   ok              ya está en dd/MM/yyyy válido
 *   cambia          se puede pasar a dd/MM/yyyy (ISO, d/M/yyyy, dd/MM/yy, Timestamp...)
 *   noInterpretable tiene un valor pero no se entiende
 *   sinFecha        no tiene fecha
 */
function clasificar(doc) {
  const presentes = CAMPOS.filter(k => tieneValor(doc[k]));
  if (!presentes.length) return { tipo: 'sinFecha' };
  // El mismo criterio que las rutas (fechaDoc): el primer campo cuya fecha sea válida.
  const campo = presentes.find(k => normalizarFecha(doc[k])) || null;
  if (!campo) return { tipo: 'noInterpretable', campo: presentes[0], valor: doc[presentes[0]] };
  const valor = doc[campo];
  const nueva = normalizarFecha(valor);
  if (typeof valor === 'string' && valor === nueva) return { tipo: 'ok' };
  return { tipo: 'cambia', campo, valor, nueva };
}

/** Cómo se muestra un valor en pantalla (los Timestamp no se imprimen bien con String()). */
function mostrar(v) {
  if (v && typeof v.toDate === 'function') { try { return `Timestamp(${v.toDate().toISOString()})`; } catch { /* sigue */ } }
  if (v instanceof Date) return `Date(${isNaN(v) ? 'inválida' : v.toISOString()})`;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return JSON.stringify(v);
}

/** Lee y clasifica una colección de una empresa. No escribe. */
async function analizar(db, tenantId, coleccion) {
  const snap = await db.collection('empresas').doc(tenantId).collection(coleccion).get();
  const r = { tenantId, coleccion, total: snap.docs.length, ok: 0, sinFecha: 0, cambios: [], noInterpretables: [] };
  for (const d of snap.docs) {
    const c = clasificar(d.data());
    if (c.tipo === 'ok') r.ok++;
    else if (c.tipo === 'sinFecha') r.sinFecha++;
    else if (c.tipo === 'cambia') r.cambios.push({ ref: d.ref, id: d.id, campo: c.campo, valor: c.valor, nueva: c.nueva });
    else r.noInterpretables.push({ id: d.id, campo: c.campo, valor: c.valor });
  }
  return r;
}

/** Escribe los cambios en batches. El valor anterior queda en fechaOriginal. */
async function aplicar(db, cambios) {
  let escritos = 0;
  for (let i = 0; i < cambios.length; i += TAMANO_BATCH) {
    const batch = db.batch();
    for (const c of cambios.slice(i, i + TAMANO_BATCH)) {
      batch.update(c.ref, { [c.campo]: c.nueva, fechaOriginal: c.valor });
    }
    await batch.commit();
    escritos += Math.min(TAMANO_BATCH, cambios.length - i);
  }
  return escritos;
}

/**
 * db: Firestore (admin). Devuelve un resumen. Con apply=false no escribe NADA.
 * log: función de salida (para poder probarlo sin ensuciar la consola).
 */
async function main({ db, apply = false, tenant = null, log = console.log } = {}) {
  if (!db) throw new Error('No hay conexión a Firestore (revisá FIREBASE_SA).');
  log(apply
    ? '*** MODO --apply: se ESCRIBEN los cambios (valor anterior en fechaOriginal) ***'
    : 'DRY-RUN: no se escribe nada. Para aplicar los cambios, correr con --apply.');

  const tenants = tenant ? [tenant] : (await db.collection('empresas').get()).docs.map(d => d.id);
  const resumen = { apply, empresas: tenants.length, docs: 0, ok: 0, sinFecha: 0, cambian: 0, noInterpretables: 0, escritos: 0, detalle: [] };

  for (const t of tenants) {
    for (const col of COLECCIONES) {
      const r = await analizar(db, t, col);
      if (!r.total) continue;
      resumen.docs += r.total; resumen.ok += r.ok; resumen.sinFecha += r.sinFecha;
      resumen.cambian += r.cambios.length; resumen.noInterpretables += r.noInterpretables.length;
      resumen.detalle.push({ tenantId: t, coleccion: col, total: r.total, ok: r.ok, cambian: r.cambios.length, sinFecha: r.sinFecha, noInterpretables: r.noInterpretables });

      log(`\n${t}/${col}: ${r.total} docs · ${r.ok} ya en dd/MM/yyyy · ${r.cambios.length} ${apply ? 'a cambiar' : 'cambiaría'} · ${r.noInterpretables.length} sin poder interpretar · ${r.sinFecha} sin fecha`);
      for (const c of r.cambios.slice(0, 3)) log(`    ej: ${mostrar(c.valor)}  →  "${c.nueva}"`);
      if (r.cambios.length > 3) log(`    … y ${r.cambios.length - 3} más`);
      for (const n of r.noInterpretables) log(`    ✗ NO SE PUEDE INTERPRETAR  ${t}/${col}/${n.id}  ${n.campo}=${mostrar(n.valor)}`);

      if (apply && r.cambios.length) {
        const n = await aplicar(db, r.cambios);
        resumen.escritos += n;
        log(`    ✓ escritos ${n} documentos`);
      }
    }
  }

  log(`\nTOTAL: ${resumen.docs} docs en ${resumen.empresas} empresa(s) · ${resumen.ok} ya OK · `
    + `${resumen.cambian} ${apply ? 'cambiados' : 'cambiaría'} · ${resumen.noInterpretables} sin poder interpretar · ${resumen.sinFecha} sin fecha`);
  if (!apply && resumen.cambian) log('(dry-run: no se escribió nada)');
  if (resumen.noInterpretables) log('Los que no se pueden interpretar NO se tocan: corregirlos a mano desde la app.');
  return resumen;
}

module.exports = { main, clasificar, analizar, aplicar, TAMANO_BATCH, COLECCIONES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const tenant = ((args.find(a => a.startsWith('--tenant=')) || '').slice('--tenant='.length)) || null;
  const raros = args.filter(a => a !== '--apply' && !a.startsWith('--tenant='));
  if (raros.length) {
    console.error(`Argumento desconocido: ${raros.join(' ')}\nUso: node scripts/normalizarFechas.js [--apply] [--tenant=<id>]`);
    process.exit(2);
  }
  const { db, admin } = require('../firebase');
  try { console.log('Proyecto Firebase:', admin.app().options.projectId); } catch { /* sin app: main() avisa */ }
  main({ db, apply, tenant })
    .then(() => process.exit(0))
    .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
