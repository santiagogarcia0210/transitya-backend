/**
 * inspect-foto-fields.js
 * Lee 3 docs de egresos, remitos y reportes de Transporte Flores
 * e imprime TODOS los campos relacionados a fotos (sin modificar nada).
 *
 * node scripts/inspect-foto-fields.js
 */

require('dotenv').config();
const { db } = require('../firebase');

const TENANT   = 'Transporte Flores';
const COLECCIONES = ['egresos', 'remitos', 'reportes'];
const MUESTRA  = 3;

// Matcha cualquier campo cuyo nombre contenga estas palabras (case-insensitive)
const KEYWORDS = ['foto', 'url', 'comprobante', 'imagen', 'image', 'archivo', 'file', 'photo'];

function esCampoFoto(nombre) {
  const lower = nombre.toLowerCase();
  return KEYWORDS.some(k => lower.includes(k));
}

async function main() {
  for (const col of COLECCIONES) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📂  ${col.toUpperCase()}  —  tenant: "${TENANT}"`);
    console.log('═'.repeat(60));

    const snap = await db
      .collection(`empresas/${TENANT}/${col}`)
      .limit(MUESTRA)
      .get();

    if (snap.empty) {
      console.log('  (sin documentos)');
      continue;
    }

    snap.docs.forEach((doc, i) => {
      console.log(`\n  Doc ${i + 1}  id: ${doc.id}`);
      const data = doc.data();

      // Todos los campos del documento
      const todos = Object.entries(data);

      // Filtrar los que parecen foto/url/comprobante
      const fotoCampos = todos.filter(([k]) => esCampoFoto(k));

      if (fotoCampos.length === 0) {
        console.log('    (ningún campo de foto/url/comprobante encontrado)');
        // Igual mostrar TODOS los keys para ver qué hay
        console.log('    Todos los campos:', todos.map(([k]) => k).join(', '));
      } else {
        fotoCampos.forEach(([k, v]) => {
          const val = typeof v === 'string' && v.length > 120
            ? v.substring(0, 120) + '…'
            : v;
          console.log(`    ${k}: ${JSON.stringify(val)}`);
        });
      }
    });
  }

  console.log('\n\nListo.\n');
  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
