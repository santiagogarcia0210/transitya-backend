// Permisos de los datos clínicos del legajo (diagnóstico, orientación prestacional…), en UN solo lugar.
//
// Hoy los ve y edita únicamente un admin/administrador de la propia empresa. Para sumar un rol "administrativo"
// más adelante alcanza con agregarlo a ROLES_CLINICO: ninguna ruta ni pantalla vuelve a decidir por su cuenta.
// El tenant no se compara contra nada acá: sale del token verificado (req.tenantId) y TODAS las consultas ya van
// acotadas a esa empresa; un usuario sin empresa (p. ej. superadmin) no puede ver datos clínicos de nadie.
const ROLES_CLINICO = new Set(['admin', 'administrador']);

/** ¿Este usuario puede ver o editar datos clínicos de pacientes de su empresa? */
function puedeVerClinico(usuario) {
  return !!usuario && !!usuario.tenantId && ROLES_CLINICO.has(usuario.rol);
}

/** Middleware: 403 si no puede. Usar siempre después de verifyToken. */
function requireClinico(req, res, next) {
  if (!puedeVerClinico(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos para ver datos clínicos.' });
  next();
}

module.exports = { puedeVerClinico, requireClinico, ROLES_CLINICO };
