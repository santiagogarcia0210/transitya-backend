const { admin } = require('../firebase');

/**
 * Sube una imagen en base64 a Firebase Storage.
 * Devuelve la URL pública de descarga.
 *
 * @param {string} base64   - Datos en base64 (sin prefijo data:…)
 * @param {string} mimeType - p.ej. 'image/jpeg'
 * @param {string} ruta     - Ruta dentro del bucket, p.ej. 'reportes/tenant/foto.jpg'
 */
async function subirFoto(base64, mimeType, ruta) {
  const bucket = admin.storage().bucket();
  const buffer = Buffer.from(base64, 'base64');
  const file   = bucket.file(ruta);

  await file.save(buffer, {
    metadata: { contentType: mimeType },
    public: true,
  });

  return `https://storage.googleapis.com/${bucket.name}/${ruta}`;
}

module.exports = { subirFoto };
