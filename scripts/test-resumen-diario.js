/**
 * Prueba directa del join resumen-diario contra Firestore.
 *
 * Uso:
 *   node scripts/test-resumen-diario.js <tenantId> [YYYY-MM-DD]
 *   node scripts/test-resumen-diario.js <tenantId> fechas   (lista fechas con egresos)
 *   node scripts/test-resumen-diario.js empresas            (lista tenantIds disponibles)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('../firebase');  // inicializa admin

const { col }                             = require('../utils');
const { calcularResumenDiario, isoToDMY } = require('../services/resumenDiario');

const sep  = () => console.log('─'.repeat(60));
const ok   = (s) => console.log(`  ✅  ${s}`);
const warn = (s) => console.log(`  ⚠️   ${s}`);
const info = (s) => console.log(`  ℹ️   ${s}`);

/* ── Listar empresas disponibles ─────────────────────────────────────────── */
async function listarEmpresas() {
  const { db } = require('../firebase');
  const snap = await db.collection('empresas').get();
  console.log('\n🏢  Empresas disponibles:\n');
  snap.docs.forEach(d => {
    const data = d.data();
    const nombre = data.nombre || data.razonSocial || data.empresa || '(sin nombre)';
    console.log(`  ${d.id}  →  ${nombre}`);
  });
  console.log('');
}

/* ── Listar fechas con egresos ────────────────────────────────────────────── */
async function listarFechas(tenantId) {
  console.log(`\n📅  Fechas con egresos (tenant: ${tenantId}):\n`);
  const snap = await col(tenantId, 'egresos').get();
  const set  = new Set();
  snap.docs.forEach(d => {
    const f = d.data().fecha || d.data().FECHA || '';
    if (f) set.add(f);
  });
  const sorted = [...set].sort();
  if (!sorted.length) { warn('No se encontraron egresos.'); return; }
  sorted.forEach(f => info(f));
  console.log(`\n  Total: ${sorted.length} fechas distintas\n`);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const args = process.argv.slice(2);

  // Modo: listar empresas
  if (!args.length || args[0] === 'empresas') {
    await listarEmpresas();
    console.log('Uso: node scripts/test-resumen-diario.js <tenantId> [YYYY-MM-DD|fechas]');
    process.exit(0);
  }

  const tenantId = args[0];
  const arg2     = args[1] || '';

  // Modo: listar fechas con egresos
  if (arg2 === 'fechas') {
    await listarFechas(tenantId);
    process.exit(0);
  }

  // Modo: resumen de una fecha
  let fechaISO = arg2;
  if (!fechaISO) {
    const hoy = new Date();
    fechaISO  = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-${String(hoy.getDate()).padStart(2,'0')}`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) {
    console.error(`❌  Formato inválido: "${fechaISO}". Usá YYYY-MM-DD.`);
    process.exit(1);
  }

  console.log(`\n🔍  Resumen diario — ${fechaISO} (${isoToDMY(fechaISO)})`);
  console.log(`    TenantId: ${tenantId}\n`);

  const resultado = await calcularResumenDiario(tenantId, fechaISO, null);

  resultado._logs.forEach(l => console.log(l));
  sep();

  if (!resultado.choferes.length) {
    warn('Sin choferes con actividad para esta fecha.');
    console.log('\n  Probá con: node scripts/test-resumen-diario.js ' + tenantId + ' fechas');
    process.exit(0);
  }

  console.log(`\n📊  ${resultado.choferes.length} chofer(es) con actividad:\n`);

  for (const c of resultado.choferes) {
    sep();
    console.log(`👤  ${c.nombre}  <${c.email}>`);
    console.log(`    🚗  Vehículo : ${c.vehiculo || '(sin asignar)'}`);
    console.log(`    🛣️   KM        : ini=${c.km.inicial}  fin=${c.km.final}  rec=${c.km.recorridos}`);
    console.log(`    💰  Monto     : $${c.montoTotal.toFixed(2)}`);
    if (c.observaciones) console.log(`    📝  Obs.      : ${c.observaciones}`);

    if (c.egresos.length) {
      ok(`${c.egresos.length} egreso(s):`);
      c.egresos.forEach((e, i) =>
        info(`      ${i+1}. [${e.categoria}] ${e.proveedor||'—'} · ${e.tipoComprobante||'—'} · $${e.monto}`)
      );
    } else {
      warn('Sin egresos');
    }

    if (c.remitos.length) {
      ok(`${c.remitos.length} remito(s):`);
      c.remitos.forEach((r, i) =>
        info(`      ${i+1}. ${r.nroRemito||'—'} · ${r.razonSocial||'—'} · ${r.tipoCombustible||'—'} · ${r.combustible}L · $${r.monto}`)
      );
    } else {
      warn('Sin remitos');
    }

    if (c.chicos.length) {
      ok(`${c.chicos.length} beneficiario(s):`);
      c.chicos.forEach((b, i) =>
        info(`      ${i+1}. ${b.nombre} — ${b.domicilio||'(sin domicilio)'}`)
      );
    } else {
      warn('Sin chicos (no hay ASISTENCIA para esta fecha o el join no matcheó)');
    }

    const sinNada = !c.egresos.length && !c.remitos.length && !c.km.recorridos && !c.chicos.length;
    if (sinNada) console.log(`  🚨  TODO EN CERO — posible problema de join`);

    console.log('');
  }

  sep();
  console.log('\n✅  Script finalizado.\n');
}

main().catch(e => {
  console.error('❌  Error:', e.message);
  process.exit(1);
});
