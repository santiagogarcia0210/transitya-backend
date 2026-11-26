// Node 18 no expone globalThis.crypto (Web Crypto) y imapflow lo usa en su constructor
// (imap-flow.js:233 -> getRandomId), asi que conectar una casilla fallaba con
// "Cannot read properties of undefined (reading 'getRandomValues')".
// engines.node (y .node-version) fijan Node 24, donde el global existe; esto es el seguro por si la
// plataforma vuelve a construir con una version vieja. En Node >=20 el ??= no hace nada.
// Va antes de cualquier require de la app, no solo de dotenv.
globalThis.crypto ??= require('node:crypto').webcrypto;
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const app = express();

// Security headers — pure JSON API: CSP desactivado, CORP en cross-origin para que el
// frontend pueda consumir la API desde otro origen.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS allowlist desde env — separar por comas en Railway: CORS_ORIGINS
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',').map(s => s.trim()).filter(Boolean)
);
app.use(cors({
  origin: (origin, cb) => {
    // Sin origin (curl / server-to-server) → permitir; de lo contrario validar contra la lista.
    cb(null, !origin || ALLOWED_ORIGINS.has(origin) ? origin : false);
  },
  credentials: true,
}));

// Legajos recibe archivos (PDF/fotos en base64, máx. 8 MB) → límite propio, montado antes del parser global.
app.use('/api/legajos', express.json({ limit: '12mb' }), require('./routes/legajos'));

app.use(express.json({ limit: '5mb' }));

// Rutas
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/beneficiarios', require('./routes/beneficiarios'));
app.use('/api/registro',      require('./routes/registro'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/recorridos', require('./routes/recorridos'));
app.use('/api/asistencia', require('./routes/asistencia'));
app.use('/api/egresos', require('./routes/egresos'));
app.use('/api/remitos', require('./routes/remitos'));
app.use('/api/reportes-km', require('./routes/reportes-km'));
app.use('/api/reportes',    require('./routes/reportes'));
app.use('/api/ubicaciones', require('./routes/ubicaciones'));
app.use('/api/vencimientos', require('./routes/vencimientos'));
app.use('/api/ia', require('./routes/ia'));
app.use('/api/ingresos', require('./routes/ingresos'));
app.use('/api/facturacion', require('./routes/facturacion'));
app.use('/api/paqueteria', require('./routes/paqueteria'));
app.use('/api/traslado', require('./routes/traslado'));
app.use('/api/empresa', require('./routes/empresa'));
app.use('/api/superadmin',         require('./routes/superadmin'));
app.use('/api/admin',              require('./routes/admin'));
app.use('/api/planillas',          require('./routes/planillas'));
app.use('/api/cambio-transporte',  require('./routes/cambio-transporte'));
app.use('/api/altas-pres',         require('./routes/altas-pres'));
app.use('/api/presentacion-docs',  require('./routes/presentacion-docs'));
app.use('/api/geo',  require('./routes/geocodificacion'));
app.use('/api/arca', require('./routes/arca-config'));
app.use('/api/requisitos-os', require('./routes/requisitos-os'));
app.use('/api/agenda-admin',  require('./routes/agenda-admin'));
// El router OAuth va ANTES de /api/correo: su callback es una redirección del
// navegador y no debe caer en el guard 503 que devuelve JSON.
app.use('/api/correo/oauth', require('./routes/correo-oauth'));
app.use('/api/correo',        require('./routes/correo'));

app.get('/health', (req, res) => res.json({ ok: true, version: '1.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Transit·Ya backend corriendo en puerto ${PORT}`));

// Lee el correo de cada empresa conectada cada CORREO_SYNC_MINUTOS (default 10; 0 = apagado).
require('./services/correoSync').iniciarProgramador(require('./firebase').db);
