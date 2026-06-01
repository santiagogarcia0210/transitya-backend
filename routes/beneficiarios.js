const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const { normalizarText_, esAdmin, fechaHoyAR, col, randomUUID } = require('../utils');

const err = (res, req, e) => {
  console.error('[ERROR beneficiarios]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// Listar / buscar beneficiarios
router.get('/', auth, async (req, res) => {
  try {
    const { termino } = req.query;
    const snap = await col(req.tenantId, 'registro').get();
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (termino) {
      const q = normalizarText_(termino);
      items = items.filter(doc => normalizarText_(Object.values(doc).join(' ')).includes(q));
    }
    res.json(items);
  } catch (e) { err(res, req, e); }
});

router.post('/buscar', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const { termino } = req.body;
    const snap = await col(req.tenantId, 'registro').get();
    const todos = snap.docs.map(d => ({ _fsId: d.id, ...d.data() }));
    const q = normalizarText_(termino || '');
    const resultados = todos
      .filter(r => !q || normalizarText_(Object.values(r).join(' ')).includes(q))
      .map(r => ({
        nombre:   r['APELLIDO Y NOMBRE'] || r['NOMBRE'] || '',
        dni:      r['DNI']       || '',
        afiliado: r['N° AFILIADO'] || '',
        localidad:r['LOCALIDAD']  || '',
        ID:       r['ID']        || r._fsId || ''
      }));
    res.json({ ok: true, resultados });
  } catch (e) { err(res, req, e); }
});

// Obtener un beneficiario por ID
router.get('/:id', auth, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'registro').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, registro: { id: doc.id, ...doc.data() } });
  } catch (e) { err(res, req, e); }
});

// Alta
router.post('/', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const data = { ...req.body };
    const nombre = String(data['APELLIDO Y NOMBRE'] || data['NOMBRE'] || '').trim();
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Falta el nombre.' });
    const id = data['ID'] || randomUUID();
    data['ID'] = id;
    await col(req.tenantId, 'registro').doc(id).set({ ...data, creadoEn: new Date() });
    res.json({ ok: true, mensaje: 'ALTA GUARDADA', id });
  } catch (e) { err(res, req, e); }
});

// Actualizar beneficiario
router.put('/:id', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const ref = col(req.tenantId, 'registro').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.update({ ...req.body, actualizadoEn: new Date() });
    res.json({ ok: true, mensaje: 'Beneficiario actualizado.' });
  } catch (e) { err(res, req, e); }
});

// Guardar GPS de beneficiario
router.put('/:id/gps', auth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    await col(req.tenantId, 'registro').doc(req.params.id).update({ LAT: parseFloat(lat), LNG: parseFloat(lng) });
    res.json({ ok: true, mensaje: 'Ubicación guardada.' });
  } catch (e) { err(res, req, e); }
});

// Baja (mueve a colección bajas)
router.post('/baja', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const { id, nombre, observaciones } = req.body;
    const snap = await col(req.tenantId, 'registro').get();
    let pac = null;
    snap.docs.forEach(d => {
      const data = d.data();
      if (id && (data['ID'] === id || d.id === id)) { pac = { _fsId: d.id, ...data }; return; }
      if (!id && nombre && normalizarText_(data['APELLIDO Y NOMBRE'] || '') === normalizarText_(nombre)) { pac = { _fsId: d.id, ...data }; }
    });
    if (!pac) return res.status(404).json({ ok: false, mensaje: 'No se encontró al beneficiario.' });
    const baja = { ...pac, 'FECHA DE BAJA': fechaHoyAR(), 'OBSERVACIONES': String(observaciones || '').trim() };
    delete baja._fsId;
    await col(req.tenantId, 'bajas').add(baja);
    await col(req.tenantId, 'registro').doc(pac._fsId).delete();
    res.json({ ok: true, mensaje: 'BAJA COMPLETADA.' });
  } catch (e) { err(res, req, e); }
});

// Listar con GPS
router.get('/con-gps/lista', auth, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'registro').get();
    const lista = snap.docs.map(d => {
      const doc = d.data();
      const lat = doc['LAT'] || doc['LATITUD'] || null;
      const lng = doc['LNG'] || doc['LONGITUD'] || null;
      const tieneGPS = !!(lat && lng && parseFloat(lat) !== 0);
      return {
        id: d.id,
        nombre:    doc['APELLIDO Y NOMBRE'] || doc['NOMBRE'] || '',
        domicilio: doc['DOMICILIO'] || '',
        lat:       tieneGPS ? parseFloat(lat) : null,
        lng:       tieneGPS ? parseFloat(lng) : null,
        tieneGPS
      };
    }).filter(d => d.nombre).sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json({ ok: true, lista, total: lista.length, conGPS: lista.filter(x => x.tieneGPS).length });
  } catch (e) { err(res, req, e); }
});

// Asignaciones chofer
router.get('/asignaciones/mapa', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const snap = await col(req.tenantId, 'registro').get();
    const asignaciones = {}, beneficiarios = [];
    snap.docs.forEach(d => {
      const doc = d.data();
      const nombre = doc['APELLIDO Y NOMBRE'] || doc['NOMBRE'] || '';
      if (!nombre) return;
      asignaciones[nombre] = doc['CHOFER'] || '';
      beneficiarios.push(nombre);
    });
    beneficiarios.sort((a, b) => a.localeCompare(b));
    res.json({ ok: true, asignaciones, beneficiarios });
  } catch (e) { err(res, req, e); }
});

router.put('/asignaciones/guardar', auth, async (req, res) => {
  try {
    if (!esAdmin(req.user)) return res.status(403).json({ ok: false, mensaje: 'Sin permisos.' });
    const { asignaciones } = req.body;
    const snap = await col(req.tenantId, 'registro').get();
    const batch = db.batch();
    let n = 0;
    snap.docs.forEach(d => {
      const nombre = d.data()['APELLIDO Y NOMBRE'] || d.data()['NOMBRE'] || '';
      if (!nombre || !asignaciones.hasOwnProperty(nombre)) return;
      batch.update(d.ref, { CHOFER: asignaciones[nombre] });
      n++;
    });
    await batch.commit();
    res.json({ ok: true, mensaje: `${n} beneficiario(s) actualizados.` });
  } catch (e) { err(res, req, e); }
});

// Beneficiarios del chofer logueado
router.get('/chofer/mis-beneficiarios', auth, async (req, res) => {
  try {
    const usuario = (req.user?.nombre || req.user?.name || (req.user?.email ? req.user.email.split('@')[0] : '')).toLowerCase();
    const snap = await col(req.tenantId, 'registro').get();
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(doc => normalizarText_(doc['CHOFER'] || '').includes(normalizarText_(usuario)));
    res.json({ ok: true, beneficiarios: todos });
  } catch (e) { err(res, req, e); }
});

module.exports = router;
