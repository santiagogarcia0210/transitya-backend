const { admin } = require('../firebase');
const { randomUUID } = require('crypto');

/**
 * Sube una imagen en base64 a Firebase Storage.
 * Devuelve una URL de descarga con token (accesible sin autenticación).
 *
 * @param {string} base64   - Datos en base64 (sin prefijo data:…)
 * @param {string} mimeType - p.ej. 'image/jpeg'
 * @param {string} ruta     - Ruta dentro del bucket, p.ej. 'reportes/tenant/foto.jpg'
 */
async function subirFoto(base64, mimeType, ruta) {
  const bucket        = admin.storage().bucket();
  const buffer        = Buffer.from(base64, 'base64');
  const file          = bucket.file(ruta);
  const downloadToken = randomUUID();

  await file.save(buffer, {
    metadata: {
      contentType: mimeType,
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });

  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(ruta)}?alt=media&token=${downloadToken}`;
}

module.exports = { subirFoto };
