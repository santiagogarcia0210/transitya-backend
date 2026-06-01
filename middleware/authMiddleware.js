// Legacy shim — routes that import authMiddleware.js get verifyToken directly.
// New routes should import from ./auth and destructure { verifyToken, requireAdmin, requireModulo }.
module.exports = require('./auth').verifyToken;
