// Preload para tests: simula Node 18, donde globalThis.crypto (Web Crypto) no existe.
// Se usa con `node --require ./test/helpers/simular-node18.js ...` para que corra
// ANTES del código de la app y reproduzca el entorno real de Railway con nodejs_18.
delete globalThis.crypto;
