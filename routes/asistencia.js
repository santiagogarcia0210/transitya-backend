const router   = require('express').Router();
const { db }   = require('../firebase');
const auth     = require('../middleware/authMiddleware');
const { col }  = require('../utils');
const Anthropic = require('@anthropic-ai/sdk');

const err = (res, req, e) => {
  console.error('[ERROR asistencia]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── Asistencia legacy (colección 'asistencia') ─────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    let q = col(req.tenantId, 'asistencia');
    if (fecha) q = q.where('fecha', '==', fecha);
    const snap = await q.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { err(res, req, e); }
});

router.post('/legacy', auth, async (req, res) => {
  try {
    const ref = await col(req.tenantId, 'asistencia').add({ ...req.body, creadoEn: new Date() });
    res.json({ ok: true, id: ref.id });
  } catch (e) { err(res, req, e); }
});

router.put('/legacy/:id', auth, async (req, res) => {
  try {
    await col(req.tenantId, 'asistencia').doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (e) { err(res, req, e); }
});

// ── Asistencia DIARIA (colección 'ASISTENCIA', doc ID: {fecha}_{choferId}) ──────
// GET  /api/asistencia/diaria?fecha=2026-06-04   → todos los choferes del día
// GET  /api/asistencia/diaria/:choferId?fecha=   → asignación de un chofer
// POST /api/asistencia/diaria                    → guardar/actualizar chofer+día
// DELETE /api/asistencia/diaria/:choferId?fecha= → eliminar

router.get('/diaria', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });

    const snap = await col(req.tenantId, 'ASISTENCIA').get();
    const asignaciones = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(d => d.fecha === fecha)
      .map(d => ({
        choferId:     d.choferId,
        choferNombre: d.choferNombre,
        beneficiarios: d.beneficiarios || [],
        confirmado:   d.confirmado !== false,
        creadoEn:     d.creadoEn || ''
      }))
      .sort((a, b) => (a.choferNombre || '').localeCompare(b.choferNombre || ''));

    res.json({ ok: true, fecha, asignaciones });
  } catch (e) { err(res, req, e); }
});

router.get('/diaria/:choferId', auth, async (req, res) => {
  try {
    const { choferId } = req.params;
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });

    const docId = `${fecha}_${choferId}`;
    const snap  = await col(req.tenantId, 'ASISTENCIA').doc(docId).get();
    if (!snap.exists) return res.json({ ok: true, existe: false, beneficiarios: [] });

    const d = snap.data();
    res.json({
      ok:           true,
      existe:       true,
      choferId:     d.choferId,
      choferNombre: d.choferNombre,
      beneficiarios: d.beneficiarios || [],
      confirmado:   d.confirmado !== false
    });
  } catch (e) { err(res, req, e); }
});

router.post('/diaria', auth, async (req, res) => {
  try {
    const { fecha, choferId, choferNombre, beneficiarios } = req.body;
    if (!fecha || !choferId) return res.status(400).json({ ok: false, mensaje: 'Faltan fecha o choferId.' });

    const docId = `${fecha}_${choferId}`;
    const doc = {
      fecha,
      choferId,
      choferNombre: choferNombre || choferId,
      beneficiarios: beneficiarios || [],
      confirmado: true,
      creadoEn: new Date().toISOString()
    };

    await col(req.tenantId, 'ASISTENCIA').doc(docId).set(doc);
    res.json({ ok: true, mensaje: `Asistencia guardada para ${fecha}.`, docId });
  } catch (e) { err(res, req, e); }
});

router.delete('/diaria/:choferId', auth, async (req, res) => {
  try {
    const { choferId } = req.params;
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });
    await col(req.tenantId, 'ASISTENCIA').doc(`${fecha}_${choferId}`).delete();
    res.json({ ok: true, mensaje: 'Asignación eliminada.' });
  } catch (e) { err(res, req, e); }
});

// ── Mi ruta (chofer logueado) ─────────────────────────────────────────────────
// GET /api/asistencia/mi-ruta?fecha=YYYY-MM-DD
// Devuelve las paradas del chofer para la fecha, enriquecidas con GPS de registro.
router.get('/mi-ruta', auth, async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });

    const uid    = req.user.uid;
    const email  = req.user.email || '';

    // Obtener nombre del chofer desde su perfil
    let nombreChofer = '';
    try {
      const perfilDoc = await col(req.tenantId, 'usuarios').doc(uid).get();
      if (perfilDoc.exists) {
        const p = perfilDoc.data();
        nombreChofer = p.nombre || p.usuario || email.split('@')[0];
      } else {
        nombreChofer = email.split('@')[0];
      }
    } catch { nombreChofer = uid; }

    // Buscar asignación del día: primero por UID, luego por nombre
    const snap = await col(req.tenantId, 'ASISTENCIA').get();
    const docs  = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));

    const asignacion = docs.find(d =>
      d.fecha === fecha && (
        d.choferId    === uid          ||
        d.choferId    === nombreChofer ||
        d.choferNombre === nombreChofer
      )
    );

    const beneficiarios = asignacion?.beneficiarios || [];

    // Enriquecer con GPS y horarios del registro
    const regSnap = await col(req.tenantId, 'registro').get();
    const gpsMap  = {};
    regSnap.docs.forEach(d => {
      const data = d.data();
      const key  = data['ID'] || d.id;
      const lat  = parseFloat(data['LAT']  || data['lat']  || 0);
      const lng  = parseFloat(data['LNG']  || data['lng']  || data['lon'] || 0);
      const h = (data.horarios && typeof data.horarios === 'object') ? data.horarios : {};
      gpsMap[key] = {
        lat: isFinite(lat) ? lat : 0,
        lng: isFinite(lng) ? lng : 0,
        fsId: d.id,
        horaIngreso: h.horaIngreso || '',
        horaEgreso:  h.horaEgreso  || '',
        tieneHorariosEspeciales: Array.isArray(h.horariosEspeciales) && h.horariosEspeciales.length > 0,
      };
    });

    const paradas = beneficiarios
      .map((b, i) => {
        const id  = b.beneficiarioId || b.id || '';
        const gps = gpsMap[id] || {};
        const lat = gps.lat || 0;
        const lng = gps.lng || 0;
        return {
          orden:          b.ordenVisita || (i + 1),
          beneficiarioId: id,
          fsId:           gps.fsId || id,
          nombre:         b.nombre        || '',
          domicilio:      b.domicilio     || '',
          horarioTurno:   b.horarioTurno  || '',
          horaIngreso:    gps.horaIngreso || '',
          horaEgreso:     gps.horaEgreso  || '',
          tieneHorariosEspeciales: gps.tieneHorariosEspeciales || false,
          lat:            lat !== 0 ? lat : null,
          lng:            lng !== 0 ? lng : null,
          tieneGPS:       !!(lat && lng),
        };
      })
      .sort((a, b) => a.orden - b.orden);

    const sinGPS = paradas.filter(p => !p.tieneGPS).length;

    res.json({
      ok: true, fecha, choferNombre: nombreChofer,
      paradas, total: paradas.length,
      sinGPS, conGPS: paradas.length - sinGPS,
    });
  } catch (e) { err(res, req, e); }
});

// ── Optimizar orden con IA — idéntico al GAS asist_armarRecorridoConIA ────────
// POST /api/asistencia/optimizar
// Body: { choferId, choferNombre, beneficiarios: [{ id, nombre, domicilio, horarioTurno }] }
// Returns: { ok, fuente:'ia'|'fallback', paradas: [...] }
router.post('/optimizar', auth, async (req, res) => {
  const { choferId, choferNombre, beneficiarios } = req.body;

  if (!beneficiarios || !beneficiarios.length) {
    return res.status(400).json({ ok: false, mensaje: 'No hay beneficiarios para ordenar.' });
  }

  // Fallback: ordenar por horarioTurno (sin IA)
  const fallback = (razon) => {
    const paradas = [...beneficiarios].sort((a, b) => {
      const hA = a.horarioTurno || '99:99';
      const hB = b.horarioTurno || '99:99';
      return hA < hB ? -1 : hA > hB ? 1 : 0;
    }).map((b, i) => ({
      beneficiarioId: b.id,
      nombre:         b.nombre        || '',
      domicilio:      b.domicilio     || '',
      horarioTurno:   b.horarioTurno  || '',
      ordenVisita:    i + 1,
    }));
    return res.json({ ok: true, fuente: 'fallback', razonFallback: razon, paradas });
  };

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return fallback('ANTHROPIC_API_KEY no configurada.');

    const paradasTexto = beneficiarios.map((b, i) =>
      `${i + 1}. ID: ${b.id} | Nombre: ${b.nombre || ''} | Domicilio: ${b.domicilio || 'Sin domicilio'} | Turno médico: ${b.horarioTurno || 'Sin horario'}`
    ).join('\n');

    const prompt =
      `Sos un optimizador de recorridos para transporte de pacientes en Tucumán, Argentina.\n\n` +
      `El chofer "${choferNombre || choferId}" tiene que buscar estos pacientes:\n` +
      paradasTexto + `\n\n` +
      `INSTRUCCIONES:\n` +
      `1. Ordená las paradas para minimizar la distancia total del recorrido, considerando que domicilios cercanos entre sí deben visitarse juntos.\n` +
      `2. Respetá que cada paciente llegue ANTES de su horario de turno médico. Los de turno más temprano tienen prioridad.\n` +
      `3. Si dos pacientes tienen el mismo horario o sin horario, agrupalos por zona geográfica.\n\n` +
      `Respondé ÚNICAMENTE con un JSON válido, sin texto adicional:\n` +
      `{\n  "paradas": [\n    {\n      "beneficiarioId": "... (el ID exacto de la lista)",\n      "nombre": "...",\n      "domicilio": "...",\n      "horarioTurno": "...",\n      "ordenVisita": 1\n    }\n  ]\n}`;

    const anthropic = new Anthropic({ apiKey });
    const response  = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText = (response.content[0]?.text || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback('La IA no devolvió JSON válido.');

    const resultado = JSON.parse(jsonMatch[0]);
    const paradasIA = resultado.paradas || [];

    // Validar que la IA no perdió ni inventó IDs
    const idsOrig = beneficiarios.map(b => b.id);
    const idsIA   = paradasIA.map(p => p.beneficiarioId);
    if (!idsOrig.every(id => idsIA.includes(id)) || paradasIA.length !== beneficiarios.length) {
      return fallback('Lista de IA incompleta o inválida.');
    }

    // Reasignar ordenVisita secuencial
    paradasIA.forEach((p, i) => { p.ordenVisita = i + 1; });
    res.json({ ok: true, fuente: 'ia', paradas: paradasIA });

  } catch (e) {
    console.error('[ASISTENCIA optimizar]', e.message);
    fallback(e.message);
  }
});

module.exports = router;
