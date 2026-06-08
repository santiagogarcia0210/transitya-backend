/**
 * scripts/limpiar-duplicados.js
 *
 * Identifica y elimina beneficiarios duplicados en Firestore.
 * Compara documentos de las colecciones 'registro' y 'BENEFICIARIOS'
 * buscando coincidencias por DNI o nombre normalizado.
 *
 * Uso:
 *   node scripts/limpiar-duplicados.js <tenantId>
 *   node scripts/limpiar-duplicados.js <tenantId> --dry-run
 *
 * Si se omite tenantId, lista las empresas disponibles.
 * Con --dry-run muestra qué haría sin modificar Firestore.
 */

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)),
    projectId: 'gestion-transporte-ef756',
  });
}
const db = admin.firestore();

function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function camposRellenos(obj) {
  return Object.values(obj).filter(v => v !== null && v !== undefined && v !== '').length;
}

async function listarEmpresas() {
  const snap = await db.collection('empresas').get();
  console.log('\nEmpresas disponibles:');
  snap.docs.forEach(d => {
    const data = d.data();
    console.log(`  tenantId: ${d.id}  nombre: ${data.nombre || data.razonSocial || '—'}`);
  });
  console.log('\nUsá: node scripts/limpiar-duplicados.js <tenantId>');
}

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.find(a => !a.startsWith('--'));
  const dryRun   = args.includes('--dry-run');

  if (!tenantId) {
    await listarEmpresas();
    process.exit(0);
  }

  console.log(`\n=== LIMPIEZA DE DUPLICADOS [tenantId: ${tenantId}] ${dryRun ? '(DRY RUN)' : ''} ===\n`);

  const base = db.collection('empresas').doc(tenantId);

  const [snapReg, snapBen] = await Promise.all([
    base.collection('registro').get(),
    base.collection('BENEFICIARIOS').get().catch(() => null),
  ]);

  const docs = [];

  snapReg.docs.forEach(d => docs.push({ coleccion: 'registro', ref: d.ref, id: d.id, ...d.data() }));
  if (snapBen) {
    snapBen.docs.forEach(d => docs.push({ coleccion: 'BENEFICIARIOS', ref: d.ref, id: d.id, ...d.data() }));
  }

  console.log(`Documentos encontrados: ${docs.length}`);
  console.log(`  - registro:       ${snapReg.size}`);
  console.log(`  - BENEFICIARIOS:  ${snapBen ? snapBen.size : 0}\n`);

  // Agrupar por DNI o nombre normalizado
  const grupos = new Map();

  for (const doc of docs) {
    const dni    = String(doc['DNI'] || doc['dni'] || '').replace(/\D/g, '').trim();
    const nombre = norm(doc['APELLIDO Y NOMBRE'] || doc['NOMBRE'] || doc['nombre'] || '');

    const clave = dni || nombre;
    if (!clave) continue;

    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(doc);
  }

  const duplicados = [...grupos.values()].filter(g => g.length > 1);
  console.log(`Grupos duplicados encontrados: ${duplicados.length}\n`);

  if (duplicados.length === 0) {
    console.log('No hay duplicados. Firestore está limpio.');
    process.exit(0);
  }

  let eliminados = 0;
  let errores    = 0;

  for (const grupo of duplicados) {
    console.log('─'.repeat(60));
    grupo.forEach((d, i) => {
      const nombre = d['APELLIDO Y NOMBRE'] || d['NOMBRE'] || '';
      const dni    = d['DNI'] || '';
      const lat    = d['LAT'] || d['LATITUD'] || '';
      const campos = camposRellenos(d) - 3; // descontar ref/id/coleccion internos
      console.log(`  [${i}] ${d.coleccion}/${d.id}  nombre:"${nombre}" dni:"${dni}" lat:"${lat}" campos:${campos}`);
    });

    // Elegir el doc a mantener:
    // 1. Preferir el de 'registro' sobre 'BENEFICIARIOS'
    // 2. Entre iguales, el que tiene más campos
    const ordenados = [...grupo].sort((a, b) => {
      if (a.coleccion === 'registro' && b.coleccion !== 'registro') return -1;
      if (b.coleccion === 'registro' && a.coleccion !== 'registro') return 1;
      return camposRellenos(b) - camposRellenos(a);
    });

    const keeper = ordenados[0];
    const toDelete = ordenados.slice(1);

    // Si el keeper no tiene GPS pero algún duplicado sí, copiarlo
    const keeperLat = keeper['LAT'] || keeper['LATITUD'];
    const keeperLng = keeper['LNG'] || keeper['LONGITUD'];

    const gpsSource = toDelete.find(d => {
      const lat = d['LAT'] || d['LATITUD'];
      const lng = d['LNG'] || d['LONGITUD'];
      return lat && lng && parseFloat(lat) !== 0;
    });

    const updateData = {};
    if (!keeperLat && gpsSource) {
      updateData['LAT'] = gpsSource['LAT'] || gpsSource['LATITUD'];
      updateData['LNG'] = gpsSource['LNG'] || gpsSource['LONGITUD'];
      console.log(`  ✔ Copiando GPS del duplicado al keeper: LAT=${updateData.LAT} LNG=${updateData.LNG}`);
    }

    console.log(`  ➜ Keeper: ${keeper.coleccion}/${keeper.id}`);
    toDelete.forEach(d => console.log(`  ✗ Eliminar: ${d.coleccion}/${d.id}`));

    if (!dryRun) {
      try {
        if (Object.keys(updateData).length > 0) {
          await keeper.ref.update(updateData);
        }
        for (const d of toDelete) {
          await d.ref.delete();
          eliminados++;
        }
        console.log(`  ✔ Hecho`);
      } catch (e) {
        console.error(`  ✖ Error: ${e.message}`);
        errores++;
      }
    } else {
      console.log('  (dry-run: sin cambios)');
    }
  }

  console.log('\n' + '='.repeat(60));
  if (dryRun) {
    console.log(`DRY RUN completado. Se eliminarían ${duplicados.reduce((n, g) => n + g.length - 1, 0)} documentos.`);
    console.log('Corré sin --dry-run para aplicar los cambios.');
  } else {
    console.log(`Limpieza completada. Eliminados: ${eliminados}  Errores: ${errores}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
