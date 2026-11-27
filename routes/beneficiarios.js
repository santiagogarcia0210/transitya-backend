const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, fechaHoyAR, col, randomUUID } = require('../utils');
const B = require('../utils/beneficiarios');

// El front muestra `mensaje` tal cual: que diga qué pasó, no solo "error".
const errHandler = (res, req, e) => {
  console.error('[BENEFICIARIOS]', req.method, req.path, e.message);
  res.status(500).json({ ok: false, mensaje: `No se pudo completar la operación: ${e.message}` });
};
const fallo = (res, status, mensaje) => res.status(status).json({ ok: false, mensaje });

const NO_ENCONTRADO = 'No se encontró al paciente (se buscó en registro y en BENEFICIARIOS).';

// Documento tal cual está guardado, pero con el id del documento de Firestore (un `id` guardado adentro,
// por ejemplo vacío, no debe pisarlo).
const crudo = b => ({ ...b.data, id: b.id });

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { termino } = req.query;
    let items = (await B.cargarBeneficiarios(col, req.tenantId)).map(crudo);
    if (termino) {
      const q = normalizarText_(termino);
      items = items.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(q));
    }
    res.json(items);
  } catch (e) { errHandler(res, req, e); }
});

router.post('/buscar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { termino } = req.body;
    const todos = await B.cargarBeneficiarios(col, req.tenantId);
    const q = normalizarText_(termino || '');
    const resultados = todos
      .filter(b => !q || normalizarText_(Object.values(b.data).join(' ')).includes(q))
      .map(b => ({
        nombre: b.nombre, dni: b.dni, afiliado: b.afiliado, localidad: b.localidad,
        ID: b.data['ID'] || b.id,
      }));
    res.json({ ok: true, resultados });
  } catch (e) { errHandler(res, req, e); }
});

// requireAdmin: expone GPS de menores — dato más sensible del sistema. Si un flujo de
// chofer necesita esto en el futuro, NO quitar el guard — filtrar por ruta/email del chofer.
router.get('/con-gps/lista', verifyToken, requireAdmin, async (req, res) => {
  try {
    const lista = (await B.cargarBeneficiarios(col, req.tenantId)).map(b => {
      const doc = b.data;
      const lat = doc['LAT'] || doc['LATITUD'] || null;
      const lng = doc['LNG'] || doc['LONGITUD'] || null;
      const tieneGPS = !!(lat && lng && parseFloat(lat) !== 0);
      return {
        id: b.id, nombre: b.nombre, domicilio: b.domicilio,
        lat: tieneGPS ? parseFloat(lat) : null,
        lng: tieneGPS ? parseFloat(lng) : null,
        tieneGPS,
      };
    }).filter(d => d.nombre).sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json({ ok: true, lista, total: lista.length, conGPS: lista.filter(x => x.tieneGPS).length });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/asignaciones/mapa', verifyToken, requireAdmin, async (req, res) => {
  try {
    const asignaciones = {}, beneficiarios = [];
    (await B.cargarBeneficiarios(col, req.tenantId)).forEach(b => {
      if (!b.nombre) return;
      asignaciones[b.nombre] = b.chofer;
      beneficiarios.push(b.nombre);
    });
    beneficiarios.sort((a, b) => a.localeCompare(b));
    res.json({ ok: true, asignaciones, beneficiarios });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/asignaciones/guardar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { asignaciones } = req.body;
    if (!asignaciones || typeof asignaciones !== 'object') return fallo(res, 400, 'Faltan las asignaciones.');
    const batch = db.batch();
    let n = 0;
    (await B.cargarBeneficiarios(col, req.tenantId)).forEach(b => {
      if (!b.nombre || !Object.prototype.hasOwnProperty.call(asignaciones, b.nombre)) return;
      batch.update(col(req.tenantId, b.coleccion).doc(b.id), { CHOFER: asignaciones[b.nombre] });
      n++;
    });
    await batch.commit();
    res.json({ ok: true, mensaje: `${n} beneficiario(s) actualizados.` });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/chofer/mis-beneficiarios', verifyToken, async (req, res) => {
  try {
    const usuario = (req.user?.nombre || req.user?.name || (req.user?.email ? req.user.email.split('@')[0] : '')).toLowerCase();
    const todos = (await B.cargarBeneficiarios(col, req.tenantId))
      .filter(b => normalizarText_(b.chofer).includes(normalizarText_(usuario)))
      .map(crudo);
    res.json({ ok: true, beneficiarios: todos });
  } catch (e) { errHandler(res, req, e); }
});

// GET /:id must be after specific GET routes
// requireAdmin: un chofer no debe leer beneficiarios arbitrarios por id. Si se necesita
// un flujo de chofer, crear un endpoint dedicado filtrado por su ruta/asignación.
router.get('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const h = await B.buscarDoc(col, req.tenantId, req.params.id);
    if (!h) return fallo(res, 404, NO_ENCONTRADO);
    res.json({ ok: true, registro: { ...h.snap.data(), id: req.params.id } });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = B.limpiarPayload(req.body);
    const nombre = B.normalizarBeneficiario('', data).nombre;
    if (!nombre) return fallo(res, 400, 'Falta el nombre del paciente.');
    const id = String((req.body || {})['ID'] || '').trim() || randomUUID();
    data['ID'] = id;
    await col(req.tenantId, 'registro').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'ALTA GUARDADA', id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const h = await B.buscarDoc(col, req.tenantId, req.params.id);
    if (!h) return fallo(res, 404, NO_ENCONTRADO);
    const data = B.limpiarPayload(req.body);
    if (!Object.keys(data).length) return fallo(res, 400, 'No llegó ningún dato para guardar.');
    await h.ref.update({ ...data, actualizadoEn: new Date() });
    res.json({ ok: true, mensaje: 'Beneficiario actualizado.', coleccion: h.coleccion });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id/gps', verifyToken, async (req, res) => {
  try {
    const lat = parseFloat(req.body && req.body.lat), lng = parseFloat(req.body && req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fallo(res, 400, 'La latitud y la longitud tienen que ser números.');
    const h = await B.buscarDoc(col, req.tenantId, req.params.id);
    if (!h) return fallo(res, 404, NO_ENCONTRADO);
    await h.ref.update({ LAT: lat, LNG: lng });
    res.json({ ok: true, mensaje: 'Ubicación guardada.' });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/baja', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { id, nombre, observaciones } = req.body;
    const lista = await B.cargarBeneficiarios(col, req.tenantId);
    let pac = null;
    if (id) pac = lista.find(b => b.id === id || b.data['ID'] === id) || null;
    else if (nombre) pac = lista.find(b => normalizarText_(b.nombre) === normalizarText_(nombre)) || null;
    if (!pac) return fallo(res, 404, NO_ENCONTRADO);
    const baja = { ...pac.data, 'FECHA DE BAJA': fechaHoyAR(), 'OBSERVACIONES': String(observaciones || '').trim() };
    await col(req.tenantId, 'bajas').add(baja);
    await col(req.tenantId, pac.coleccion).doc(pac.id).delete();
    res.json({ ok: true, mensaje: 'BAJA COMPLETADA.' });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
