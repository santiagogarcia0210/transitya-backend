const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken } = require('../middleware/auth');
const { variantesFecha } = require('../utils/fechas');

router.get('/', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = db.collection('empresas').doc(req.tenantId).collection('asistencia');
    if (fecha) {
      // Tolerante al formato: trae los documentos guardados con ese día en ISO, dd/MM/yyyy o d/M/yyyy. La
      // consulta se hace con "in" (en el servidor) y no leyendo toda la colección para filtrar acá. Lo que
      // se pidió, tal cual vino, también cuenta: así sigue encontrando todo lo que antes encontraba.
      const crudo = String(fecha).trim();
      query = query.where('fecha', 'in', [...new Set([...variantesFecha(crudo), crudo])]);
    }
    const snap = await query.get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
