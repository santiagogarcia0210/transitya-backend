const router = require('express').Router();
const { db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { normalizarText_, fechaHoyAR, esMesDMY, col, MESES } = require('../utils');

const errHandler = (res, req, e) => {
  console.error('[ASISTENCIA]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── ESTADO DEL DÍA ────────────────────────────────────────────────────────────

router.get('/estado', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    const snap = await col(req.tenantId, 'asistencia').where('fecha', '==', fecha || fechaHoyAR()).get();
    const marcados = {};
    snap.docs.forEach(d => {
      const doc = d.data();
      const nombre = String(doc.nombre || doc.NOMBRE || '').trim();
      if (nombre) marcados[nombre] = doc.estado || doc.ESTADO || '';
    });
    res.json({ ok: true, marcados, fecha: fecha || fechaHoyAR() });
  } catch (e) { errHandler(res, req, e); }
});

// ── ESTADO HOY (resumen por chofer) ──────────────────────────────────────────

router.get('/estado-hoy', verifyToken, requireAdmin, async (req, res) => {
  try {
    const hoy = fechaHoyAR();
    const jsDay = new Date().getDay();
    if (jsDay === 0 || jsDay === 6) {
      return res.json({ ok: true, esFinDeSemana: true, fecha: hoy, choferes: [] });
    }

    const [snapAsist, snapUsuarios] = await Promise.all([
      col(req.tenantId, 'asistencia').where('fecha', '==', hoy).get(),
      col(req.tenantId, 'usuarios').get(),
    ]);

    // Group asistencia docs by chofer
    const porChofer = {};
    snapAsist.docs.forEach(d => {
      const doc  = d.data();
      const ch   = normalizarText_(doc.chofer || doc.CHOFER || '');
      const est  = String(doc.estado || doc.ESTADO || '').toUpperCase();
      if (!ch) return;
      if (!porChofer[ch]) porChofer[ch] = { P: 0, A: 0, F: 0, pendiente: 0 };
      if (est === 'P') porChofer[ch].P++;
      else if (est === 'A') porChofer[ch].A++;
      else if (est === 'F') porChofer[ch].F++;
      else porChofer[ch].pendiente++;
    });

    const choferes = [];
    snapUsuarios.docs.forEach(d => {
      const doc = d.data();
      const rol = String(doc.rol || doc.ROL || '').toLowerCase();
      if (rol !== 'chofer') return;
      if (doc.activo === false) return;
      const nombre = doc.nombre || doc.email || '';
      const key    = normalizarText_(nombre);
      const stats  = porChofer[key] || { P: 0, A: 0, F: 0, pendiente: 0 };
      const total  = stats.P + stats.A + stats.F + stats.pendiente;
      choferes.push({
        chofer: nombre,
        presentes: stats.P, ausentes: stats.A, pendientes: stats.F + stats.pendiente,
        total, tomado: total > 0,
      });
    });

    res.json({ ok: true, fecha: hoy, choferes });
  } catch (e) { errHandler(res, req, e); }
});

// ── CERRAR DÍA ────────────────────────────────────────────────────────────────

router.post('/cerrar-dia', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { fecha } = req.body;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta fecha.' });
    const snap = await col(req.tenantId, 'asistencia').where('fecha', '==', fecha).get();
    const pendientes = snap.docs.filter(d => {
      const est = String(d.data().estado || d.data().ESTADO || '').toUpperCase();
      return est === 'F' || est === '';
    });
    await Promise.all(pendientes.map(d => d.ref.update({ estado: 'A', ESTADO: 'A' })));
    res.json({ ok: true, ausentesCount: pendientes.length });
  } catch (e) { errHandler(res, req, e); }
});

// ── REPORTE MENSUAL ───────────────────────────────────────────────────────────

router.get('/reporte-mensual', verifyToken, async (req, res) => {
  try {
    const m = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y = Number(req.query.anio) || new Date().getFullYear();
    const isAdmin = req.user.rol === 'admin' || req.user.rol === 'administrador';
    const snap = await col(req.tenantId, 'asistencia').get();

    let docs = snap.docs.map(d => d.data())
      .filter(d => esMesDMY(d.fecha || d.FECHA || '', m, y));

    if (!isAdmin) {
      const emailUser = normalizarText_(req.user.email || '');
      docs = docs.filter(d => normalizarText_(d.chofer || d.CHOFER || '') === emailUser);
    }

    // Group by chofer → beneficiario → counts
    const choferMap = {};
    docs.forEach(d => {
      const ch     = String(d.chofer || d.CHOFER || 'Sin chofer').trim();
      const nombre = String(d.nombre || d.NOMBRE || '').trim();
      const est    = String(d.estado || d.ESTADO || '').toUpperCase();
      if (!choferMap[ch]) choferMap[ch] = {};
      if (!choferMap[ch][nombre]) choferMap[ch][nombre] = { P: 0, A: 0, pendiente: 0 };
      if (est === 'P') choferMap[ch][nombre].P++;
      else if (est === 'A') choferMap[ch][nombre].A++;
      else choferMap[ch][nombre].pendiente++;
    });

    const choferes = Object.entries(choferMap).map(([chofer, benef]) => {
      const detalleBenef = Object.entries(benef).map(([nombre, c]) => ({ nombre, ...c }));
      const totalPresentes = detalleBenef.reduce((s, b) => s + b.P, 0);
      const totalAusentes  = detalleBenef.reduce((s, b) => s + b.A, 0);
      return { chofer, detalleBenef, totalPresentes, totalAusentes };
    });

    res.json({ ok: true, choferes, mes: MESES[m - 1], anio: y });
  } catch (e) { errHandler(res, req, e); }
});

// ── CALENDARIO ────────────────────────────────────────────────────────────────

router.get('/calendario', verifyToken, async (req, res) => {
  try {
    const m      = Number(req.query.mes)  || (new Date().getMonth() + 1);
    const y      = Number(req.query.anio) || new Date().getFullYear();
    const chofer = req.query.chofer || '';

    const snap = await col(req.tenantId, 'asistencia').get();
    const dias = {};

    snap.docs.forEach(d => {
      const doc   = d.data();
      const fecha = String(doc.fecha || doc.FECHA || '');
      if (!esMesDMY(fecha, m, y)) return;
      if (chofer && normalizarText_(doc.chofer || doc.CHOFER || '') !== normalizarText_(chofer)) return;

      const parts = fecha.split('/');
      const dia   = parts[0]; // "01", "02", ...
      const est   = String(doc.estado || doc.ESTADO || '').toUpperCase();
      if (!dias[dia]) dias[dia] = { P: 0, A: 0, F: 0 };
      if (est === 'P') dias[dia].P++;
      else if (est === 'A') dias[dia].A++;
      else if (est === 'F') dias[dia].F++;
    });

    res.json({ ok: true, dias, mes: MESES[m - 1], anio: y });
  } catch (e) { errHandler(res, req, e); }
});

// ── BUSCAR POR BENEFICIARIO ───────────────────────────────────────────────────

router.get('/buscar', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { nombre } = req.query;
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Falta nombre.' });
    const qn   = normalizarText_(nombre);
    const snap = await col(req.tenantId, 'asistencia').get();

    const porNombre = {};
    snap.docs.forEach(d => {
      const doc = d.data();
      const n   = String(doc.nombre || doc.NOMBRE || '').trim();
      if (!normalizarText_(n).includes(qn)) return;
      const fecha = String(doc.fecha || doc.FECHA || '');
      const parts = fecha.split('/');
      const clave = parts.length >= 3 ? `${parts[1]}/${parts[2]}` : '';
      const est   = String(doc.estado || doc.ESTADO || '').toUpperCase();
      if (!porNombre[n]) porNombre[n] = { nombre: n, porMes: {}, totalP: 0, totalA: 0 };
      if (clave) {
        if (!porNombre[n].porMes[clave]) porNombre[n].porMes[clave] = { P: 0, A: 0 };
        if (est === 'P') { porNombre[n].porMes[clave].P++; porNombre[n].totalP++; }
        if (est === 'A') { porNombre[n].porMes[clave].A++; porNombre[n].totalA++; }
      }
    });

    res.json({ ok: true, resultados: Object.values(porNombre) });
  } catch (e) { errHandler(res, req, e); }
});

// ── ASIGNACIONES CHOFER ───────────────────────────────────────────────────────

router.put('/asignaciones', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { asignaciones } = req.body;
    if (!asignaciones || typeof asignaciones !== 'object') {
      return res.status(400).json({ ok: false, mensaje: 'Falta asignaciones.' });
    }
    const snap = await col(req.tenantId, 'registro').get();
    const batch = db.batch();
    let actualizados = 0;
    snap.docs.forEach(d => {
      const nombre = String(d.data()['APELLIDO Y NOMBRE'] || d.data()['NOMBRE'] || '').trim();
      if (!nombre || !Object.prototype.hasOwnProperty.call(asignaciones, nombre)) return;
      batch.update(d.ref, { CHOFER: asignaciones[nombre] });
      actualizados++;
    });
    await batch.commit();
    res.json({ ok: true, actualizados });
  } catch (e) { errHandler(res, req, e); }
});

// ── CRUD BASE ─────────────────────────────────────────────────────────────────

router.get('/', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = col(req.tenantId, 'asistencia');
    if (fecha) query = query.where('fecha', '==', fecha);
    const snap = await query.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { errHandler(res, req, e); }
});

router.post('/', verifyToken, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'asistencia').add({ ...req.body, creadoEn: new Date() });
    res.json({ ok: true, id: ref.id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/:id', verifyToken, async (req, res) => {
  try {
    await col(req.tenantId, 'asistencia').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
