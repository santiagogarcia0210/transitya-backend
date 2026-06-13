const { auth, db } = require('../firebase');

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ ok: false, mensaje: 'Sin token' });
  try {
    const decoded = await auth.verifyIdToken(token);
    let tenantId    = decoded.tenantId;
    let rol         = decoded.rol;
    let tipoEmpresa = decoded.tipoEmpresa;
    let superadmin  = decoded.superadmin === true || decoded.superadmin === 'true';

    // Fallback: stale token or manually-created account may lack custom claims in JWT.
    // Re-fetch from Firebase Auth to get the persisted claims.
    if (!tenantId || !rol) {
      const userRecord = await auth.getUser(decoded.uid);
      const claims = userRecord.customClaims || {};
      tenantId    = tenantId    || claims.tenantId;
      rol         = rol         || claims.rol;
      tipoEmpresa = tipoEmpresa || claims.tipoEmpresa;
      superadmin  = superadmin  || claims.superadmin === true || claims.superadmin === 'true';
    }


    // Reject accounts with no tenant unless they are superadmin
    if (!tenantId && !superadmin && rol !== 'superadmin') {
      return res.status(403).json({ ok: false, mensaje: 'Cuenta sin empresa asignada' });
    }

    // Enforce empresa suspension — superadmin bypasses (no tenantId), admins/choferes no
    if (tenantId) {
      const empDoc = await db.collection('empresas').doc(tenantId).get();
      if (empDoc.exists) {
        const emp = empDoc.data();
        if (emp.activo === false || emp.suspendida === true) {
          return res.status(403).json({
            ok: false,
            error: 'empresa_suspendida',
            mensaje: 'Cuenta suspendida. Contactá a soporte para regularizar tu situación.',
          });
        }
      }
    }

    req.user = { uid: decoded.uid, email: decoded.email, tenantId, rol, tipoEmpresa, superadmin };
    req.tenantId = tenantId;
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
