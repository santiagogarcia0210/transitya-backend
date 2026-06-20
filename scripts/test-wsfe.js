/**
 * FASE 1 — Verificar que el wsfe está autorizado y responde.
 *
 * Uso:
 *   node scripts/test-wsfe.js <tenantId>
 *   node scripts/test-wsfe.js empresas   ← lista tenantIds disponibles
 *
 * Requiere en .env (o en entorno):
 *   FIREBASE_SA           — service account de Firebase (ya está)
 *   ENCRYPTION_KEY        — 32-byte hex (está en Railway, agregala al .env local)
 *   AFIPSDK_ACCESS_TOKEN  — token de AfipSDK (está en Railway, agregalo al .env local)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/* ── Validar env vars ANTES de cargar módulos que las necesitan ────────── */
const missingVars = [];
if (!process.env.FIREBASE_SA)          missingVars.push('FIREBASE_SA');
if (!process.env.ENCRYPTION_KEY)       missingVars.push('ENCRYPTION_KEY');
if (!process.env.AFIPSDK_ACCESS_TOKEN) missingVars.push('AFIPSDK_ACCESS_TOKEN');

if (missingVars.length) {
  console.error('\n❌  Variables de entorno faltantes en .env:\n');
  missingVars.forEach(v => console.error(`     ${v}=<valor>`));
  console.error('\n  Copiá estos valores desde Railway → proyecto → Variables\n');
  process.exit(1);
}

/* ── Ahora sí cargamos los módulos que necesitan las vars ─────────────── */
require('../firebase');

const { db }               = require('../firebase');
const { createDecipheriv } = require('crypto');
const Afip                 = require('@afipsdk/afip.js');

/* Desencriptado inline (igual a helpers/cripto.js) para no depender de su require */
const keyBuf = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
function desencriptar(texto) {
  const [ivHex, tagHex, dataHex] = texto.split(':');
  const iv      = Buffer.from(ivHex,   'hex');
  const tag     = Buffer.from(tagHex,  'hex');
  const data    = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

const sep  = () => console.log('─'.repeat(60));
const ok   = (s) => console.log(`  ✅  ${s}`);
const fail = (s) => console.log(`  ❌  ${s}`);
const info = (s) => console.log(`  ℹ️   ${s}`);

async function listarEmpresas() {
  const snap = await db.collection('empresas').get();
  console.log('\n🏢  Empresas disponibles:\n');
  snap.docs.forEach(d => {
    const data   = d.data();
    const nombre = data.nombre || data.razonSocial || data.empresa || '(sin nombre)';
    console.log(`  ${d.id}  →  ${nombre}`);
  });
  console.log('');
}

async function main() {
  const args     = process.argv.slice(2);
  const tenantId = args[0];

  if (!tenantId || tenantId === 'empresas') {
    await listarEmpresas();
    console.log('Uso: node scripts/test-wsfe.js <tenantId>');
    process.exit(0);
  }

  console.log(`\n🔍  Test WSFE — tenant: ${tenantId}\n`);
  sep();

  /* 1 ── Leer config ARCA de Firestore ─────────────────────────────────── */
  const arcaSnap = await db
    .collection('empresas').doc(tenantId)
    .collection('config').doc('arca')
    .get();

  if (!arcaSnap.exists) {
    fail(`No existe /empresas/${tenantId}/config/arca`);
    console.log('\n  Ejecutá primero: node scripts/test-wsfe.js empresas\n');
    process.exit(1);
  }

  const {
    cuit, certEncriptado, keyEncriptada, ambiente,
    puntoVenta, wsAutorizado, condicionIva,
  } = arcaSnap.data();

  info(`CUIT        : ${cuit}`);
  info(`Ambiente    : ${ambiente}`);
  info(`Punto venta : ${puntoVenta ?? '(no guardado)'}`);
  info(`wsAutorizado: ${wsAutorizado}`);
  info(`CondicionIVA: ${condicionIva}`);
  sep();

  /* 2 ── Desencriptar cert/key ─────────────────────────────────────────── */
  let cert, key;
  try {
    cert = desencriptar(certEncriptado);
    key  = desencriptar(keyEncriptada);
    ok('cert y key desencriptados');
    info(`cert length: ${cert.length} chars`);
    info(`key  length: ${key.length} chars`);
  } catch (e) {
    fail('Error al desencriptar: ' + e.message);
    console.log('\n  Verificá que ENCRYPTION_KEY en .env sea la misma que en Railway.\n');
    process.exit(1);
  }
  sep();

  /* 3 ── Instanciar Afip ───────────────────────────────────────────────── */
  const produccion = ambiente === 'produccion';
  const afip = new Afip({
    CUIT:         Number(String(cuit).replace(/\D/g, '')),
    production:   produccion,
    cert,
    key,
    access_token: process.env.AFIPSDK_ACCESS_TOKEN,
  });
  ok(`Instancia Afip creada (produccion=${produccion})`);
  sep();

  /* 4 ── getServerStatus ───────────────────────────────────────────────── */
  console.log('\n📡  getServerStatus (wsfe)…\n');
  try {
    const status = await afip.ElectronicBilling.getServerStatus();
    ok('getServerStatus OK');
    console.log('  ', JSON.stringify(status));
  } catch (e) {
    fail('getServerStatus: ' + e.message);
    if (e.response) console.error('  response:', JSON.stringify(e.response));
  }
  sep();

  /* 5 ── getLastVoucher Factura B (tipo 6) ─────────────────────────────── */
  const pv = Number(puntoVenta || 5);
  console.log(`\n📄  getLastVoucher(PV=${pv}, tipo=6 — Factura B)…\n`);
  try {
    const ultimo6 = await afip.ElectronicBilling.getLastVoucher(pv, 6);
    ok(`Último Factura B en PV ${pv}: nro ${ultimo6}`);
  } catch (e) {
    fail('getLastVoucher(6): ' + e.message);
    if (e.response) console.error('  response:', JSON.stringify(e.response));
  }
  sep();

  /* 6 ── getLastVoucher Factura A (tipo 1) ─────────────────────────────── */
  console.log(`\n📄  getLastVoucher(PV=${pv}, tipo=1 — Factura A)…\n`);
  try {
    const ultimo1 = await afip.ElectronicBilling.getLastVoucher(pv, 1);
    ok(`Último Factura A en PV ${pv}: nro ${ultimo1}`);
  } catch (e) {
    fail('getLastVoucher(1): ' + e.message);
    if (e.response) console.error('  response:', JSON.stringify(e.response));
  }
  sep();

  console.log('\n✅  Script finalizado.\n');
}

main().catch(e => {
  console.error('\n❌  Error fatal:', e.message);
  process.exit(1);
});
