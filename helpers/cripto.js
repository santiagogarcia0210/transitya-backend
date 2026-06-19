const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const keyBuf = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
if (keyBuf.length !== 32) {
  throw new Error(
    '[cripto] ENCRYPTION_KEY debe tener exactamente 32 bytes. ' +
    `Longitud actual: ${keyBuf.length} bytes.`
  );
}

function encriptar(texto) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function desencriptar(texto) {
  const [ivHex, tagHex, dataHex] = texto.split(':');
  const iv   = Buffer.from(ivHex,   'hex');
  const tag  = Buffer.from(tagHex,  'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encriptar, desencriptar };
