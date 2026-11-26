// Arancel del nomenclador (valor del km) por mes y por obra social. Solo administración, por empresa.
//   GET    /api/aranceles                 lista + estado ("el último valor tiene más de 35 días")
//   GET    /api/aranceles/vigente?fecha=&obraId=   valor que rige a una fecha (el de la obra social si lo tiene)
//   POST   /api/aranceles                 carga un valor nuevo (cierra el anterior que seguía abierto)
//   PUT    /api/aranceles/:id             corrige un valor
//   DELETE /api/aranceles/:id
//   POST   /api/aranceles/sembrar         carga el valor inicial de noviembre 2026 (marcado "verificar")
const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, randomUUID, nombreUsuario } = require('../utils');
const A = require('../services/arancel');
const { fechaToDate, normalizarFecha } = require('../utils/fechas');

const errHandler = (res, req, e) => {
  if (e.mensaje) return res.status(400).json({ ok: false, mensaje: e.mensaje });
  console.error('[ARANCELES]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: 'No se pudo procesar el arancel.' });
};

async function todos(tenantId) {
  const snap = await col(tenantId, 'aranceles_nomenclador').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const lista = await todos(req.tenantId);
    const orden = [...lista].sort((a, b) => fechaToDate(b.vigenteDesde) - fechaToDate(a.vigenteDesde));
    res.json({ ok: true, aranceles: orden, estado: A.estadoActualizacion(lista, { obraId: req.query.obraId || null }) });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/vigente', verifyToken, requireAdmin, async (req, res) => {
  try {
    const lista = await todos(req.tenantId);
    const fecha = normalizarFecha(req.query.fecha) || normalizarFecha(new Date());
    const v = A.valorVigente(lista, { fecha, obraId: req.query.obraId || null });
    res.json({ ok: true, vigente: v, estado: A.estadoActualizacion(lista, { obraId: req.query.obraId || null }) });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const dato = A.limpiarArancel(req.body || {});
    const lista = await todos(req.tenantId);
    const id = randomUUID();
    const nuevo = { id, ...dato };
    for (const c of A.cierresPorNuevo(lista, nuevo)) await col(req.tenantId, 'aranceles_nomenclador').doc(c.id).update({ vigenteHasta: c.vigenteHasta });
    await col(req.tenantId, 'aranceles_nomenclador').doc(id).set({ ...nuevo, cargadoPor: nombreUsuario(req.user), creadoEn: new Date().toISOString() });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'aranceles_nomenclador').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    const dato = A.limpiarArancel({ ...snap.data(), ...(req.body || {}) });
    const nuevo = { ...snap.data(), ...dato, actualizadoEn: new Date().toISOString(), actualizadoPor: nombreUsuario(req.user) };
    if (!dato.vigenteHasta) delete nuevo.vigenteHasta;
    await ref.set(nuevo);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'aranceles_nomenclador').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/sembrar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const lista = await todos(req.tenantId);
    if (lista.some(a => !a.obraId && a.vigenteDesde === A.SEMILLA_NOV_2026.vigenteDesde)) return res.json({ ok: true, yaExistia: true });
    const id = randomUUID();
    await col(req.tenantId, 'aranceles_nomenclador').doc(id).set({ id, ...A.SEMILLA_NOV_2026, cargadoPor: nombreUsuario(req.user), creadoEn: new Date().toISOString() });
    res.json({ ok: true, id, yaExistia: false });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
