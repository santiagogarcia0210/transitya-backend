const { auth } = require('../firebase');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try {
    const decoded = await auth.verifyIdToken(token);
    console.log('[AUTH] uid:', decoded.uid);
    console.log('[AUTH] tenantId:', decoded.tenantId);
    console.log('[AUTH] rol:', decoded.rol);
    console.log('[AUTH] all claims:', JSON.stringify(decoded));
    req.user = decoded;
    req.tenantId = decoded.tenantId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' });
  }
};
