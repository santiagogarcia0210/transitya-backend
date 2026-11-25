const { createCipheriv, createDecipheriv, randomBytes, createHmac } = require('crypto');

/**
 * Cifrado AES-256-GCM para secretos de cada empresa (contraseñas IMAP, cert/key de ARCA).
 *
 * ENCRYPTION_KEY = 64 caracteres hexadecimales (32 bytes). Se decodifica como hex.
 *
 * Una clave ausente o inválida NO tumba el proceso: el módulo queda "no disponible"
 * y solo falla quien intente cifrar o descifrar. Así el backend arranca completo y
 * las rutas que dependen del cifrado responden 503 en lugar de impedir el boot.
 * Antes, el throw en el nivel superior se propagaba por el require de index.js y
 * dejaba todo el servidor caído (facturación, remitos, planillas) por una variable
 * que solo hace falta para correo y ARCA.
 */
function leerClave_() {
  const crudo = String(process.env.ENCRYPTION_KEY || '').trim();
  if (!crudo) {
    return { buf: null, motivo: 'ENCRYPTION_KEY no está definida.' };
  }
  if (!/^[0-9a-fA-F]+$/.test(crudo)) {
    return { buf: null, motivo: 'ENCRYPTION_KEY debe ser hexadecimal (solo 0-9 y a-f), sin espacios ni comillas.' };
  }
  const buf = Buffer.from(crudo, 'hex');
  if (buf.length !== 32) {
    return {
      buf: null,
      motivo: `ENCRYPTION_KEY debe tener 64 caracteres hex (32 bytes); tiene ${crudo.length} caracteres (${buf.length} bytes).`,
    };
  }
  return { buf, motivo: '' };
}

const { buf: keyBuf, motivo: motivo_ } = leerClave_();

if (!keyBuf) {
  console.error(
    `[cripto] Cifrado DESHABILITADO: ${motivo_} ` +
    'Las funciones que lo necesitan (correo, ARCA) van a responder 503. ' +
    'Generar con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

/** true si hay una clave usable. Las rutas lo consultan para degradar en vez de fallar. */
function disponible() {
  return keyBuf !== null;
}

/** Motivo por el que el cifrado no está disponible ('' si lo está). Nunca incluye la clave. */
function motivoNoDisponible() {
  return motivo_;
}

/**
 * Deriva una subclave de 32 bytes a partir de ENCRYPTION_KEY, atada a una etiqueta.
 * Sirve para firmar cosas (ej. el state de OAuth) sin reutilizar la clave de cifrado:
 * etiquetas distintas dan claves independientes, así que una firma no sirve en otro contexto.
 * Lanza si no hay clave, igual que encriptar/desencriptar.
 */
function derivarClave(etiqueta) {
  exigirClave_();
  if (!etiqueta) throw new Error('[cripto] derivarClave necesita una etiqueta.');
  return createHmac('sha256', keyBuf).update(String(etiqueta)).digest();
}

function exigirClave_() {
  if (!keyBuf) throw new Error(`[cripto] ${motivo_}`);
}

function encriptar(texto) {
  exigirClave_();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function desencriptar(texto) {
  exigirClave_();
  const [ivHex, tagHex, dataHex] = texto.split(':');
  const iv   = Buffer.from(ivHex,   'hex');
  const tag  = Buffer.from(tagHex,  'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encriptar, desencriptar, disponible, motivoNoDisponible, derivarClave };
