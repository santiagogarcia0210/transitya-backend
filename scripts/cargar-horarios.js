/**
 * scripts/cargar-horarios.js
 *
 * Carga horarios de beneficiarios en Firestore.
 * Busca cada beneficiario en la colección 'registro' por nombre (fuzzy)
 * y actualiza el campo 'horarios' sin tocar el resto del documento.
 *
 * Uso:
 *   node scripts/cargar-horarios.js <tenantId>
 *   node scripts/cargar-horarios.js <tenantId> --dry-run
 *
 * Si se omite tenantId, lista las empresas disponibles.
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

// ──────────────────────────────────────────────
// DATOS DE HORARIOS (planilla)
// ──────────────────────────────────────────────
const HORARIOS = [
  {
    nombre: 'BORQUEZ ALEXANDRA DEL VALLE',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '14:00',
    horaEgreso:  '17:40',
  },
  {
    nombre: 'CARRANZA JIMENEZ ALEJANDRO',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '12:00',
  },
  {
    nombre: 'CARRIZO MAXIMO GUILLERMO',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '11:00',
  },
  {
    nombre: 'CRUZ ALCIDES',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:00',
  },
  {
    nombre: 'DELAVEN DAIRA NEREA',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '14:00',
    horaEgreso:  '17:40',
  },
  {
    nombre: 'DYLAN FERNANDEZ',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '14:00',
    horaEgreso:  '17:30',
  },
  {
    // Viernes: egreso a las 18:00 en lugar de 17:30
    nombre: 'FERNADEZ SANTINO',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '14:00',
    horaEgreso:  '17:30',
    horariosEspeciales: [
      { dia: 'viernes', horaIngreso: '14:00', horaEgreso: '18:00' },
    ],
  },
  {
    // Días distintos con horarios distintos → solo horariosEspeciales
    nombre: 'FRIAS MONICA',
    horariosEspeciales: [
      { dia: 'miercoles', horaIngreso: '10:00', horaEgreso: '11:00' },
      { dia: 'jueves',    horaIngreso: '15:00', horaEgreso: '16:00' },
    ],
  },
  {
    nombre: 'GALVAN ARIADNA',
    dias: ['martes'],
    horaIngreso: '08:30',
    horaEgreso:  '12:00',
  },
  {
    nombre: 'GALVAN BENJAMIN',
    dias: ['martes', 'miercoles'],
    horaIngreso: '14:20',
    horaEgreso:  '15:40',
  },
  {
    nombre: 'GALVAN LISANDRO',
    dias: ['martes', 'miercoles'],
    horaIngreso: '14:20',
    horaEgreso:  '15:40',
  },
  {
    nombre: 'GONZALES JAVIER',
    dias: ['lunes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:00',
  },
  {
    nombre: 'JUAREZ TOMAS MIGUEL',
    dias: ['lunes'],
    horaIngreso: '14:00',
    horaEgreso:  '18:00',
  },
  // LEZCANO FABIANA DEL VALLE — sin horario definido (omitido)
  {
    nombre: 'LEZCANO FELIPE YONATHAN',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '17:15',
    horaEgreso:  '18:45',
  },
  {
    // Cada día tiene horario distinto → solo horariosEspeciales
    nombre: 'LOPEZ LOAN ABEL',
    horariosEspeciales: [
      { dia: 'lunes',     horaIngreso: '16:30', horaEgreso: '18:00' },
      { dia: 'miercoles', horaIngreso: '18:00', horaEgreso: '19:30' },
      { dia: 'viernes',   horaIngreso: '18:00', horaEgreso: '19:30' },
      { dia: 'jueves',    horaIngreso: '17:15', horaEgreso: '18:00' },
    ],
  },
  // MERCADO RAMON — sin horario definido (omitido)
  {
    nombre: 'MOYANO MAYRA DENIS',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:30',
  },
  // MUSSA YANINA — sin horario definido (omitido)
  {
    nombre: 'NIEVA CLAUDIO',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:00',
  },
  {
    nombre: 'OROSCO OLGA TERESITA',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:00',
  },
  {
    nombre: 'PAZ ROCIO NATALI',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:30',
  },
  {
    nombre: 'SUAREZ AGUERO AVRIL G',
    horariosEspeciales: [
      { dia: 'lunes',   horaIngreso: '16:00', horaEgreso: '16:30' },
      { dia: 'viernes', horaIngreso: '15:00', horaEgreso: '16:30' },
    ],
  },
  {
    nombre: 'SUAREZ HECTOR OSVALDO',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:30',
  },
  {
    // Lun y Mié, mismo horario → dias normal
    nombre: 'TOLEDO GAEL',
    dias: ['lunes', 'miercoles'],
    horaIngreso: '15:00',
    horaEgreso:  '16:20',
  },
  // TOLEDO LOURDES — sin horario definido (omitido)
  {
    nombre: 'TOSCANO NANCY',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:30',
  },
  {
    // Lun + Jue + Vie, mismo horario
    nombre: 'VALDEZ ANDRES',
    dias: ['lunes', 'jueves', 'viernes'],
    horaIngreso: '14:00',
    horaEgreso:  '16:00',
  },
  {
    nombre: 'VALDEZ MARCELA',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:00',
  },
  {
    nombre: 'VALOR YUTIEL',
    dias: ['miercoles', 'jueves'],
    horaIngreso: '08:00',
    horaEgreso:  '10:30',
  },
  {
    nombre: 'VAZQUEZ IRENE',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:30',
  },
  {
    nombre: 'VELIZ SILVANA',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:30',
  },
  {
    // Lun y Mié, mismo horario
    nombre: 'VILLA CRISTINA',
    dias: ['lunes', 'miercoles'],
    horaIngreso: '13:30',
    horaEgreso:  '17:30',
  },
  {
    nombre: 'VILLA OSCAR',
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
    horaIngreso: '08:00',
    horaEgreso:  '14:00',
  },
  {
    nombre: 'VILLEGAS ANGEL',
    dias: ['martes'],
    horaIngreso: '14:00',
    horaEgreso:  '16:00',
  },
];

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Retorna true si todas las palabras del patrón están en el target
function coincide(nombrePlanilla, nombreFirestore) {
  const palabrasPlanilla  = norm(nombrePlanilla).split(' ').filter(Boolean);
  const targetNorm = norm(nombreFirestore);
  return palabrasPlanilla.every(p => targetNorm.includes(p));
}

async function listarEmpresas() {
  const snap = await db.collection('empresas').get();
  console.log('\nEmpresas disponibles:');
  snap.docs.forEach(d => {
    const data = d.data();
    console.log(`  tenantId: ${d.id}  nombre: ${data.nombre || data.razonSocial || '—'}`);
  });
  console.log('\nUsá: node scripts/cargar-horarios.js <tenantId>');
}

async function main() {
  const args    = process.argv.slice(2);
  const tenantId = args.find(a => !a.startsWith('--'));
  const dryRun   = args.includes('--dry-run');

  if (!tenantId) {
    await listarEmpresas();
    process.exit(0);
  }

  console.log(`\n=== CARGAR HORARIOS [tenantId: ${tenantId}] ${dryRun ? '(DRY RUN)' : ''} ===\n`);

  const base = db.collection('empresas').doc(tenantId);

  // Leer todas las colecciones donde pueden estar los beneficiarios
  const [snapReg, snapBen] = await Promise.all([
    base.collection('registro').get(),
    base.collection('BENEFICIARIOS').get().catch(() => null),
  ]);

  const docs = [];
  snapReg.docs.forEach(d => docs.push({ ref: d.ref, id: d.id, ...d.data() }));
  if (snapBen) {
    snapBen.docs.forEach(d => docs.push({ ref: d.ref, id: d.id, ...d.data() }));
  }

  console.log(`Beneficiarios en Firestore: ${docs.length}\n`);

  const encontrados    = [];
  const noEncontrados  = [];
  let actualizados     = 0;
  let errores          = 0;

  for (const entrada of HORARIOS) {
    const { nombre: nombrePlanilla, ...horarioData } = entrada;

    // Construir objeto horarios limpio
    const horarios = {};
    if (horarioData.dias)             horarios.dias             = horarioData.dias;
    if (horarioData.horaIngreso)      horarios.horaIngreso      = horarioData.horaIngreso;
    if (horarioData.horaEgreso)       horarios.horaEgreso       = horarioData.horaEgreso;
    if (horarioData.horariosEspeciales) horarios.horariosEspeciales = horarioData.horariosEspeciales;

    // Buscar en Firestore por coincidencia de palabras
    const matches = docs.filter(d => {
      const nombreDoc = d['APELLIDO Y NOMBRE'] || d['NOMBRE'] || d['nombre'] || '';
      return coincide(nombrePlanilla, nombreDoc);
    });

    if (matches.length === 0) {
      noEncontrados.push(nombrePlanilla);
      console.log(`✗ NO ENCONTRADO: "${nombrePlanilla}"`);
      continue;
    }

    if (matches.length > 1) {
      console.log(`⚠ MÚLTIPLES MATCHES (${matches.length}) para "${nombrePlanilla}":`);
      matches.forEach(m => console.log(`    - ${m['APELLIDO Y NOMBRE'] || m['NOMBRE']} [${m.id}]`));
      console.log(`  → Actualizando todos los matches`);
    }

    for (const match of matches) {
      const nombreDoc = match['APELLIDO Y NOMBRE'] || match['NOMBRE'] || '';
      console.log(`✔ ENCONTRADO: "${nombrePlanilla}" → "${nombreDoc}" [${match.id}]`);
      console.log(`  horarios: ${JSON.stringify(horarios)}`);
      encontrados.push(nombrePlanilla);

      if (!dryRun) {
        try {
          await match.ref.update({ horarios });
          actualizados++;
        } catch (e) {
          console.error(`  ✖ Error al actualizar ${match.id}: ${e.message}`);
          errores++;
        }
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`\nRESUMEN:`);
  console.log(`  Entradas en planilla: ${HORARIOS.length}`);
  console.log(`  Encontrados:          ${encontrados.length}`);
  console.log(`  No encontrados:       ${noEncontrados.length}`);
  if (!dryRun) {
    console.log(`  Actualizados:         ${actualizados}`);
    console.log(`  Errores:              ${errores}`);
  }

  if (noEncontrados.length > 0) {
    console.log(`\nNO ENCONTRADOS (revisar nombre en Firestore):`);
    noEncontrados.forEach(n => console.log(`  - ${n}`));
  }

  // Beneficiarios sin horario definido (para referencia)
  const sinHorario = [
    'LEZCANO FABIANA DEL VALLE',
    'MERCADO RAMON',
    'MUSSA YANINA',
    'TOLEDO LOURDES',
  ];
  console.log(`\nSin horario definido (no procesados): ${sinHorario.join(', ')}`);

  if (dryRun) {
    console.log('\nDRY RUN completado. Corré sin --dry-run para aplicar los cambios.');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
