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
  const produccion    = ambiente === 'produccion';
  const automationName = produccion ? 'create-cert-prod' : 'create-cert-dev';

  const afip = new Afip({
    CUIT:         Number(cuit),
    production:   produccion,
    access_token: ACCESS_TOKEN,
  });

  const result = await afip.CreateAutomation(automationName, {
    tax_id:   String(cuit),
    username: String(cuit),
    password: claveFiscal,
    alias,
  });

  const data = result?.data;
  if (!data?.cert || !data?.key) {
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

  const afip = new Afip({
    CUIT:         Number(cuit),
    production:   produccion,
    access_token: ACCESS_TOKEN,
  });

  const MAX_REINTENTOS = 3;
  const DELAY_REINTENTO_MS = 20000;

  let ultimoError;
  for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
    try {
      const result = await afip.CreateAutomation(automationName, {
        tax_id:   String(cuit),
        username: String(cuit),
        password: claveFiscal,
        alias,
        wsid:     'wsfe',
      });
      return result?.data;
    } catch (err) {
      ultimoError = err;
      console.warn(`[ARCA] autorizarWebService intento ${intento}/${MAX_REINTENTOS} falló:`, err.message);
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
