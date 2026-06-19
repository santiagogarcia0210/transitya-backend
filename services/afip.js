const Afip = require('@afipsdk/afip.js');

const ACCESS_TOKEN = process.env.AFIPSDK_ACCESS_TOKEN;
if (!ACCESS_TOKEN) {
  throw new Error('[afip] AFIPSDK_ACCESS_TOKEN no está definido.');
}

// Delay helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Instancia Afip lista para usar WS de facturación electrónica.
 * Requiere cert y key ya desencriptados en texto plano (PEM).
 */
function crearInstanciaAfip({ cuit, cert, key, produccion = false }) {
  return new Afip({
    CUIT:         Number(cuit),
    production:   produccion,
    cert,
    key,
    access_token: ACCESS_TOKEN,
  });
}

/**
 * Crea el certificado digital en ARCA para la empresa.
 * Devuelve { cert, key } en texto plano.
 * La claveFiscal NO se persiste en ningún lado.
 */
async function conectarCuentaArca({ cuit, claveFiscal, alias, ambiente }) {
  const produccion     = ambiente === 'produccion';
  const automationName = produccion ? 'create-cert-prod' : 'create-cert-dev';
  const cuitLimpio     = String(cuit).replace(/-/g, '');          // STRING sin guiones → username
  const cuitNumber     = Number(cuitLimpio);                       // NUMBER → CUIT constructor
  const aliasLimpio    = alias.replace(/[^a-zA-Z0-9]/g, '');      // alfanumérico puro → alias

  console.log('[ARCA] conectarCuentaArca params:', {
    automationName, cuitLimpio, cuitNumber, aliasLimpio,
    password_length: claveFiscal?.length || 0,
  });

  const afip = new Afip({
    CUIT:         cuitNumber,
    production:   produccion,
    access_token: ACCESS_TOKEN,
  });

  let result;
  try {
    result = await afip.CreateAutomation(automationName, {
      cuit:     cuitNumber,    // número
      username: cuitLimpio,    // string ← fix
      password: claveFiscal,
      alias:    aliasLimpio,   // alfanumérico puro ← fix
    });
  } catch (err) {
    console.error('[ARCA] CreateAutomation FULL ERROR:', JSON.stringify({
      status:       err.status,
      statusText:   err.statusText,
      message:      err.message,
      responseData: err.data,
    }, null, 2));
    throw err;
  }

  console.log('[ARCA] CreateAutomation result status:', result?.status);

  const data = result?.data;
  if (!data?.cert || !data?.key) {
    console.log('[ARCA] result completo:', JSON.stringify(result));
    throw new Error('AfipSDK no devolvió cert/key. Verificá el acceso a la cuenta fiscal.');
  }

  return { cert: data.cert, key: data.key };
}

/**
 * Autoriza el web service wsfe en ARCA para la empresa.
 * Reintenta hasta 3 veces con backoff porque ARCA puede tardar en propagar el cert.
 */
async function autorizarWebService({ cuit, claveFiscal, alias, ambiente }) {
  const produccion     = ambiente === 'produccion';
  const automationName = produccion ? 'auth-web-service-prod' : 'auth-web-service-dev';
  const cuitLimpio     = String(cuit).replace(/-/g, '');     // STRING sin guiones → username
  const cuitNumber     = Number(cuitLimpio);                  // NUMBER → CUIT constructor
  const aliasLimpio    = alias.replace(/[^a-zA-Z0-9]/g, ''); // alfanumérico puro → alias

  console.log('[ARCA] autorizarWebService params:', {
    automationName, cuitLimpio, cuitNumber, aliasLimpio,
  });

  const afip = new Afip({
    CUIT:         cuitNumber,
    production:   produccion,
    access_token: ACCESS_TOKEN,
  });

  const MAX_REINTENTOS = 3;
  const DELAY_REINTENTO_MS = 20000;

  let ultimoError;
  for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
    try {
      const result = await afip.CreateAutomation(automationName, {
        cuit:     cuitNumber,   // número
        username: cuitLimpio,   // string
        password: claveFiscal,
        alias:    aliasLimpio,  // alfanumérico puro
        service:  'wsfe',       // web service a autorizar
      });
      return result?.data;
    } catch (err) {
      ultimoError = err;
      console.error(`[ARCA] autorizarWebService intento ${intento}/${MAX_REINTENTOS} FULL ERROR:`, JSON.stringify({
        status:       err.status,
        statusText:   err.statusText,
        message:      err.message,
        responseData: err.data,
      }, null, 2));
      if (intento < MAX_REINTENTOS) {
        await sleep(DELAY_REINTENTO_MS);
      }
    }
  }

  throw ultimoError;
}

/**
 * Lista los puntos de venta habilitados para el CUIT.
 * Requiere la config de empresa con cert/key ya desencriptados.
 */
async function listarPuntosVenta({ cuit, cert, key, produccion }) {
  const afip = crearInstanciaAfip({ cuit, cert, key, produccion });
  return afip.ElectronicBilling.getSalesPoints();
}

module.exports = { crearInstanciaAfip, conectarCuentaArca, autorizarWebService, listarPuntosVenta };
