const { auth } = require('../firebase');

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ ok: false, mensaje: 'Sin token' });
  try {
    const decoded = await auth.verifyIdToken(token);
    req.user = {
      uid:         decoded.uid,
      email:       decoded.email,
      tenantId:    decoded.tenantId,
      rol:         decoded.rol,
      tipoEmpresa: decoded.tipoEmpresa,
    };
    req.tenantId = decoded.tenantId;
    next();
  } catch (e) {
    res.status(401).json({ ok: false, mensaje: 'Token inválido' });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user.rol !== 'admin' && req.user.rol !== 'administrador')
    return res.status(403).json({ ok: false, mensaje: 'Sin permisos' });
  next();
};

const requireModulo = (modulo) => (req, res, next) => {
  const permitidos = ['egresos', 'reportes'];
  if (req.user.rol === 'admin' || req.user.rol === 'administrador') return next();
  if (!permitidos.includes(modulo))
    return res.status(403).json({ ok: false, mensaje: 'Sin permisos' });
  next();
};

module.exports = { verifyToken, requireAdmin, requireModulo };
