const { auth } = require('../firebase');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try {
    const decoded = await auth.verifyIdToken(token);
    req.user = decoded;
    req.tenantId = decoded.tenantId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' });
  }
};
