/**
 * backfill-foto-urls.js
 *
 * Recorre todas las colecciones con fotos (egresos, remitos, reportes) en TODOS
 * los tenants y regenera las URLs de Firebase Storage que están rotas:
 *
 *   - Formato viejo: https://storage.googleapis.com/BUCKET/path/...
 *     → Sin token de descarga → 403/404.
 *
 *   - Formato encoding roto: .../o/empresas/tenant/egresos/id/file.jpg?...
 *     → Slashes literales en el path → 404 (Firebase Storage espera %2F).
 *
 * Ejecución: node scripts/backfill-foto-urls.js
 * Requiere FIREBASE_SA en el entorno (o .env en la raíz del backend).
 */

require('dotenv').config();
const { randomUUID } = require('crypto');
const { admin, db }  = require('../firebase');

const bucket = admin.storage().bucket();

// Colecciones y campos de foto a revisar
const TARGETS = [
  { collection: 'egresos',  campos: ['comprobanteUrl', 'comprobante'] },
  { collection: 'remitos',  campos: ['comprobante'] },
  { collection: 'reportes', campos: ['fotoIniUrl', 'fotoFinUrl'] },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extrae la ruta del objeto en Storage a partir de una URL rota.
 * Retorna null si la URL ya está bien o no es reconocida.
 */
function extraerRutaRota(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:')) return null; // base64 inline, skip

  // Formato viejo: https://storage.googleapis.com/BUCKET/path/to/file
  const m1 = url.match(/^https:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/);
  if (m1) return decodeURIComponent(m1[1]);

  // Formato Firebase Storage con path NO encodeado (slashes literales)
  // Ejemplo: .../o/empresas/Tenant/egresos/id/comprobante.jpg?alt=media&token=...
  const m2 = url.match(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/(.+?)(\?.*)?$/);
  if (m2) {
    const pathPart = m2[1];
    // Si ya tiene %2F → URL correcta, no tocar
    if (pathPart.includes('%2F')) return null;
    // Tiene slashes literales → roto
    return decodeURIComponent(pathPart);
  }

  return null;
}

/**
 * Agrega un download token al metadata del archivo y retorna la nueva URL.
 */
async function regenerarUrl(ruta) {
  const file = bucket.file(ruta);
  const [exists] = await file.exists();
  if (!exists) {
    console.warn(`    ⚠ Archivo no encontrado en Storage: ${ruta}`);
    return null;
  }
  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(ruta)}?alt=media&token=${token}`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  let totalDocs = 0, totalFixed = 0, totalErrors = 0;

  for (const { collection, campos } of TARGETS) {
    console.log(`\n📂 Procesando colección: ${collection}`);

    // collectionGroup consulta todas las subcolecciones con ese nombre en todos los tenants
    const snap = await db.collectionGroup(collection).get();
    console.log(`   ${snap.size} documentos encontrados`);

    for (const doc of snap.docs) {
      totalDocs++;
      const data    = doc.data();
      const updates = {};

      for (const campo of campos) {
        const url = data[campo];
        const ruta = extraerRutaRota(url);
        if (!ruta) continue;

        console.log(`  🔧 ${doc.ref.path} → campo "${campo}"`);
        console.log(`     URL rota: ${url.substring(0, 80)}…`);

        try {
          const nuevaUrl = await regenerarUrl(ruta);
          if (nuevaUrl) {
            updates[campo] = nuevaUrl;
            console.log(`     ✅ Nueva URL generada`);
          }
        } catch (e) {
          console.error(`     ❌ Error: ${e.message}`);
          totalErrors++;
        }
      }

      if (Object.keys(updates).length > 0) {
        await doc.ref.update(updates);
        totalFixed++;
      }
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Backfill completado`);
  console.log(`   Documentos revisados: ${totalDocs}`);
  console.log(`   Documentos corregidos: ${totalFixed}`);
  console.log(`   Errores:               ${totalErrors}`);
  process.exit(0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
