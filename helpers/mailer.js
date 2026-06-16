const nodemailer = require('nodemailer');

console.log('[MAILER] config', {
  host:       process.env.FEROZO_HOST,
  port:       process.env.FEROZO_PORT,
  user:       process.env.FEROZO_USER,
  passSet:    !!process.env.FEROZO_PASS,
  from:       process.env.FEROZO_FROM,
  superadmin: process.env.SUPERADMIN_EMAIL,
});

const port = Number(process.env.FEROZO_PORT) || 465;

const transporter = nodemailer.createTransport({
  host:   process.env.FEROZO_HOST || 'a0130335.ferozo.com',
  port,
  secure: port === 465,
  auth: {
    user: process.env.FEROZO_USER,
    pass: process.env.FEROZO_PASS,
  },
});

transporter.verify()
  .then(() => console.log('[MAILER] SMTP OK'))
  .catch(err => console.error('[MAILER] SMTP FALLO', err.message));

const FROM  = `"Transit·Ya" <${process.env.FEROZO_FROM || process.env.FEROZO_USER || 'info@transitya.com'}>`;
const ADMIN = process.env.SUPERADMIN_EMAIL || 'info@transitya.com';

async function enviarBienvenida({ email, nombreEmpresa, tipo }) {
  await transporter.sendMail({
    from:    FROM,
    to:      email,
    subject: '¡Bienvenido a Transit·Ya! Tu cuenta está lista 🚌',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
        <div style="background:#0f1729;padding:32px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Transit·Ya</h1>
          <p style="color:rgba(255,255,255,.55);margin:6px 0 0;font-size:13px">Sistema de gestión de transporte</p>
        </div>
        <div style="background:#f8fafc;padding:32px;border-radius:0 0 12px 12px">
          <h2 style="color:#0f1729;font-size:18px;margin-top:0">¡Hola! Tu empresa <strong>${nombreEmpresa}</strong> ya está registrada.</h2>
          <p style="color:#475569;line-height:1.6">Tenés <strong>15 días de prueba gratuita</strong> para explorar todas las funciones. Sin tarjeta de crédito requerida.</p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0">
            <p style="margin:0 0 6px;font-size:13px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Tu cuenta</p>
            <p style="margin:4px 0;font-size:14px;color:#1e293b"><strong>Empresa:</strong> ${nombreEmpresa}</p>
            <p style="margin:4px 0;font-size:14px;color:#1e293b"><strong>Email:</strong> ${email}</p>
          </div>
          <a href="${process.env.FRONTEND_URL || 'https://transitya-frontend.vercel.app'}/login"
            style="display:inline-block;background:#6c5fff;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;margin-top:4px">
            Ingresar al panel →
          </a>
          <p style="color:#94a3b8;font-size:12px;margin-top:28px">¿Tenés dudas? Escribinos a <a href="mailto:info@transitya.com" style="color:#6c5fff">info@transitya.com</a></p>
        </div>
      </div>
    `,
  });
}

async function enviarNotificacionInterna({ email, nombreEmpresa, tipo, tenantId }) {
  const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' });
  await transporter.sendMail({
    from:    FROM,
    to:      ADMIN,
    subject: `🆕 Nueva empresa: ${nombreEmpresa}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;color:#1e293b">
        <h2 style="margin-top:0">Nueva empresa registrada</h2>
        <table style="font-size:14px;border-collapse:collapse;width:100%">
          <tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap">Empresa</td><td style="padding:6px 0"><strong>${nombreEmpresa}</strong></td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#64748b">Email</td><td style="padding:6px 0">${email}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#64748b">Tipo</td><td style="padding:6px 0">${tipo}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#64748b">Tenant ID</td><td style="padding:6px 0;font-family:monospace;font-size:12px">${tenantId}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#64748b">Fecha</td><td style="padding:6px 0">${ahora}</td></tr>
        </table>
      </div>
    `,
  });
}

async function enviarConfirmacionPago({ email, nombreEmpresa }) {
  await transporter.sendMail({
    from:    FROM,
    to:      email,
    subject: 'Transit·Ya — Tu pago fue confirmado, plan activo',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
        <div style="background:#0f1729;padding:32px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Transit·Ya</h1>
          <p style="color:rgba(255,255,255,.55);margin:6px 0 0;font-size:13px">Sistema de gestión de transporte</p>
        </div>
        <div style="background:#f8fafc;padding:32px;border-radius:0 0 12px 12px">
          <h2 style="color:#057a55;margin-top:0">¡Tu plan está activo!</h2>
          <p style="color:#475569;line-height:1.6">Confirmamos que el pago de <strong>${nombreEmpresa}</strong> fue procesado correctamente. Tu suscripción ya está activa y podés utilizar todas las funciones sin restricciones.</p>
          <a href="${process.env.FRONTEND_URL || 'https://transitya-frontend.vercel.app'}/login"
            style="display:inline-block;background:#057a55;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;margin-top:4px">
            Ingresar al panel →
          </a>
          <p style="color:#94a3b8;font-size:12px;margin-top:28px">¿Tenés dudas? Escribinos a <a href="mailto:info@transitya.com" style="color:#6c5fff">info@transitya.com</a></p>
        </div>
      </div>
    `,
  });
}

module.exports = { enviarBienvenida, enviarNotificacionInterna, enviarConfirmacionPago };
