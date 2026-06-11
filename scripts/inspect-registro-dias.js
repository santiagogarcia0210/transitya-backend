/**
 * inspect-registro-dias.js
 * Lee 5 documentos de /empresas/Transporte Flores/registro
 * e imprime TODOS los campos que parezcan días de semana o programación.
 *
 * node scripts/inspect-registro-dias.js
 */
require('dotenv').config();
const { db } = require('../firebase');

const TENANT  = 'Transporte Flores';
const MUESTRA = 5;

const DIA_KEYWORDS = ['lunes','martes','miercoles','miércoles','jueves','viernes','sabado',
                      'sábado','dias','días','semana','horario','schedule','programacion',
                      'programación','viene','turno'];

function esCampoDia(nombre) {
  const lower = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  return DIA_KEYWORDS.some(k => lower.includes(k));
}

async function main() {
  const snap = await db.collection(`empresas/${TENANT}/registro`).limit(MUESTRA).get();

  if (snap.empty) { console.log('Sin documentos en registro'); process.exit(0); }

  console.log(`\nInspeccionando ${snap.size} docs de registro (tenant: "${TENANT}")\n`);

  snap.docs.forEach((doc, i) => {
    const data = doc.data();
    const nombre = data['APELLIDO Y NOMBRE'] || data.nombre || data.NOMBRE || doc.id;
    console.log(`\n─── Doc ${i+1}: ${nombre} (id: ${doc.id})`);

    const todos  = Object.entries(data);
    const diaCampos = todos.filter(([k]) => esCampoDia(k));

    if (diaCampos.length === 0) {
      console.log('  ⚠  No se encontraron campos de días/programación');
      console.log('  Todos los keys:', todos.map(([k]) => `"${k}"`).join(', '));
    } else {
      console.log('  Campos de días encontrados:');
      diaCampos.forEach(([k, v]) => console.log(`    "${k}" → ${JSON.stringify(v)}`));
    }
  });

  // También mostrar el primer doc completo para entender la estructura
  console.log('\n\n═══ PRIMER DOCUMENTO COMPLETO ═══');
  const first = snap.docs[0].data();
  Object.entries(first).forEach(([k, v]) => {
    const val = typeof v === 'string' && v.length > 80 ? v.substring(0, 80) + '…' : v;
    console.log(`  "${k}": ${JSON.stringify(val)}`);
  });

  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
