#!/usr/bin/env node
// Repara los pacientes que quedaron afuera de Planilla Incluir / DJ ESC 107 por guardarse con claves distintas.
//
//   node scripts/reparar-incluir.js --tenant=<id>                 DRY-RUN (por defecto): no escribe nada.
//   node scripts/reparar-incluir.js --tenant=<id> --apply         Escribe (después de guardar el backup).
//   node scripts/reparar-incluir.js --tenant=<id> --revertir=<archivo-backup>          Dry-run de la reversión.
//   node scripts/reparar-incluir.js --tenant=<id> --revertir=<archivo-backup> --apply  Revierte.
//   --backup-dir=<carpeta>   Dónde se guarda el backup (por defecto ~/transitya-backups, FUERA del repo).
//
// QUÉ HACE (y nada más):
//   · Si 'N° AFILIADO' está vacío y el N° está en otra clave (nroAfiliado, NRO_AFILIADO …): COPIA ese valor.
//   · Si 'OBRA SOCIAL' está vacía y la obra social está en otra clave (obraSocial, OS …): COPIA ese valor.
// QUÉ NO HACE:
//   · No inventa nada. Un paciente de Incluir sin N° de afiliado en NINGUNA clave solo se MARCA en el informe
//     (la pantalla ya lo muestra con "falta N° afiliado"); no se le escribe nada.
//   · Un paciente sin obra social solo se lista: no se le asigna una.
// Es idempotente: correrlo dos veces no cambia nada la segunda. Imprime solo conteos e IDs de documento.
//
// OJO: usa FIREBASE_SA de tu .env (en esta máquina, producción).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const B = require('../utils/beneficiarios');

const RAIZ_REPO = path.resolve(__dirname, '..');
const AUSENTE = '__ausente__';
const lleno = v => v !== undefined && v !== null && String(v).trim() !== '';

/** Qué hay que copiar y qué hay que marcar. Función pura: recibe [{ id, coleccion, data }]. */
function planificar(docs) {
  const cambios = [];                 // { id, coleccion, campos: { clave: { antes, despues } } }
  const faltaAfiliado = [];           // pacientes de Incluir sin N° en ninguna clave (solo se marcan)
  const sinObraSocial = [];           // sin obra social en ninguna clave (solo se listan)
  for (const { id, coleccion, data } of docs) {
    const d = data || {};
    const n = B.normalizarBeneficiario(id, d, coleccion);
    const campos = {};
    const afiliado = B.primero(d, B.CLAVES.afiliado);
    if (!lleno(d['N° AFILIADO']) && afiliado) campos['N° AFILIADO'] = { antes: 'N° AFILIADO' in d ? d['N° AFILIADO'] : AUSENTE, despues: afiliado };
    const osVal = B.primero(d, B.CLAVES.os);
    if (!lleno(d['OBRA SOCIAL']) && osVal) campos['OBRA SOCIAL'] = { antes: 'OBRA SOCIAL' in d ? d['OBRA SOCIAL'] : AUSENTE, despues: osVal };
    if (Object.keys(campos).length) cambios.push({ id, coleccion, campos });
    if (n.activo && n.nombre) {
      if (!osVal) sinObraSocial.push(id);
      else if (n.esIncluir && !afiliado) faltaAfiliado.push(id);
    }
  }
  return { cambios, faltaAfiliado, sinObraSocial };
}

/** Plan para revertir un backup: devuelve [{ id, coleccion, campos: { clave: valorPrevio | AUSENTE } }]. */
function planificarReversion(backup) {
  return (backup.cambios || []).map(c => ({
    id: c.id, coleccion: c.coleccion,
    campos: Object.fromEntries(Object.entries(c.campos).map(([k, v]) => [k, v.antes])),
  }));
}

const arg = n => { const a = process.argv.find(x => x === `--${n}` || x.startsWith(`--${n}=`)); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : null; };

async function main() {
  require('dotenv').config({ quiet: true });
  const admin = require('firebase-admin');
  let sa;
  try { sa = JSON.parse(process.env.FIREBASE_SA); } catch { console.error('Falta FIREBASE_SA en el .env.'); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'gestion-transporte-ef756' });
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  const tenant = arg('tenant');
  if (!tenant || tenant === true) { console.error('Uso: --tenant=<id>'); process.exit(1); }
  const aplicar = arg('apply') === true;
  const base = db.collection('empresas').doc(tenant);
  const dirBackup = path.resolve(String(arg('backup-dir') === true || !arg('backup-dir') ? path.join(os.homedir(), 'transitya-backups') : arg('backup-dir')));
  if (dirBackup === RAIZ_REPO || dirBackup.startsWith(RAIZ_REPO + path.sep)) {
    console.error('El backup tiene que quedar FUERA del repo (los datos de pacientes no se commitean). Usá --backup-dir=<otra carpeta>.'); process.exit(1);
  }

  /* ── Reversión ── */
  if (arg('revertir')) {
    const archivo = path.resolve(String(arg('revertir')));
    const backup = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    if (backup.tenant !== tenant) { console.error(`El backup es de otra empresa (${backup.tenant}).`); process.exit(1); }
    const plan = planificarReversion(backup);
    console.log(`${aplicar ? 'REVIERTE' : 'DRY-RUN de la reversión'}: ${plan.length} documento(s) de ${path.basename(archivo)}`);
    for (const p of plan) {
      console.log(`  ${p.coleccion}/${p.id}: ${Object.keys(p.campos).join(', ')}`);
      if (!aplicar) continue;
      const upd = {};
      for (const [k, v] of Object.entries(p.campos)) upd[k] = v === AUSENTE ? FieldValue.delete() : v;
      await base.collection(p.coleccion).doc(p.id).update(upd);
    }
    console.log(aplicar ? '\nListo.' : '\n(No se escribió nada. Para revertir de verdad, agregá --apply.)');
    return;
  }

  /* ── Reparación ── */
  const leer = async c => (await base.collection(c).get()).docs.map(d => ({ id: d.id, coleccion: c, data: d.data() }));
  const regDocs = await leer('registro');
  const ids = new Set(regDocs.map(d => d.id));
  const benDocs = (await leer('BENEFICIARIOS').catch(() => [])).filter(d => !ids.has(d.id));
  const todos = [...regDocs, ...benDocs];
  const { cambios, faltaAfiliado, sinObraSocial } = planificar(todos);

  console.log(`${aplicar ? 'APLICAR' : 'DRY-RUN (no se escribe nada)'} · empresa ${tenant} · ${todos.length} pacientes`);
  console.log(`\nSe copiarían datos en ${cambios.length} documento(s):`);
  for (const c of cambios) console.log(`  ${c.coleccion}/${c.id}: ${Object.entries(c.campos).map(([k, v]) => `${k} (${v.antes === AUSENTE ? 'no existía' : 'estaba vacío'} ← copia de otra clave)`).join('; ')}`);
  console.log(`\nSOLO MARCADOS (Incluir sin N° de afiliado en ninguna clave; hay que pedirlo y cargarlo a mano): ${faltaAfiliado.length}`);
  if (faltaAfiliado.length) console.log('  ' + faltaAfiliado.join(', '));
  console.log(`\nSIN OBRA SOCIAL (no entran a ninguna planilla hasta que la cargues): ${sinObraSocial.length}`);
  if (sinObraSocial.length) console.log('  ' + sinObraSocial.join(', '));

  if (!aplicar) { console.log('\n(Dry-run: no se escribió nada. Para aplicar: --apply.)'); return; }
  if (!cambios.length) { console.log('\nNada para copiar: ya está todo al día.'); return; }

  // Backup ANTES de escribir: el valor previo de cada campo y el documento completo.
  fs.mkdirSync(dirBackup, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivo = path.join(dirBackup, `reparar-incluir-${tenant.replace(/[^\w.-]+/g, '_')}-${stamp}.json`);
  const porId = new Map(todos.map(d => [`${d.coleccion}/${d.id}`, d.data]));
  const completo = JSON.parse(JSON.stringify(cambios.map(c => ({ ruta: `${c.coleccion}/${c.id}`, documento: porId.get(`${c.coleccion}/${c.id}`) }))));
  fs.writeFileSync(archivo, JSON.stringify({ tenant, creadoEn: new Date().toISOString(), cambios, documentosOriginales: completo }, null, 2), { flag: 'wx' });
  console.log(`\nBackup guardado en: ${archivo}`);

  for (let i = 0; i < cambios.length; i += 400) {
    const batch = db.batch();
    for (const c of cambios.slice(i, i + 400)) {
      batch.update(base.collection(c.coleccion).doc(c.id), Object.fromEntries(Object.entries(c.campos).map(([k, v]) => [k, v.despues])));
    }
    await batch.commit();
  }
  console.log(`Modificados ${cambios.length} documento(s):\n  ${cambios.map(c => `${c.coleccion}/${c.id}`).join('\n  ')}`);
  console.log(`\nPara revertir: node scripts/reparar-incluir.js --tenant=${tenant} --revertir="${archivo}" --apply`);
}

module.exports = { planificar, planificarReversion, AUSENTE };
if (require.main === module) main().catch(e => { console.error('Error:', e.code || e.name, e.message); process.exit(1); });
