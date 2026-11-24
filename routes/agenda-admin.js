// Agenda administrativa + panel unificado "qué hay que hacer".
// Colecciones:
//   empresas/{tenantId}/agenda_tareas/{id}
//     { id, titulo, obraSocial, frecuencia: MENSUAL|ANUAL|UNICA, dia, mes, fecha, diasAviso, notas, activo, creadoEn }
//   empresas/{tenantId}/agenda_hechos/{tareaId}_{periodo}
//     { tareaId, periodo, hechoPor, hechoEn }
const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, randomUUID, nombreUsuario } = require('../utils');
const { calcEstado, normalizarDMY } = require('../helpers/fechas');
const { ocurrencias, ordenar } = require('../services/agenda');
const { estadoGeneral } = require('./legajos');

const errHandler = (res, req, e) => {
  console.error('[AGENDA-ADMIN]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const FRECUENCIAS = new Set(['MENSUAL', 'ANUAL', 'UNICA']);

// BORRADOR: días tentativos, editables desde la app.
const TAREAS_BORRADOR = [
  { titulo: 'Juntar y hacer firmar las planillas de asistencia del mes anterior', dia: 2, diasAviso: 2,
    notas: 'Firmas de transportista, paciente o familiar e institución. Revisar que coincidan con los km del Reporte KM.' },
  { titulo: 'Incluir Salud: completar DJ-ESC107 y Planilla de conformidad', obraSocial: 'Incluir Salud', dia: 4, diasAviso: 2,
    notas: 'Desde los módulos DJ-ESC107 y Planilla Incluir. Controlar el tope de 880 km por paciente.' },
  { titulo: 'Emitir facturas del mes anterior a cada obra social', dia: 5, diasAviso: 3,
    notas: 'Desde Facturación (ARCA). Fecha de emisión dentro del período facturado.' },
  { titulo: 'Presentar carpetas mensuales (factura + planillas + autorización)', dia: 10, diasAviso: 3,
    notas: 'Confirmar fecha límite real de cada obra social y ajustar este día.' },
  { titulo: 'Revisar carpetas de pacientes: documentos que vencen el mes que viene', dia: 15, diasAviso: 3,
    notas: 'Pedir a las familias CUD, pedido médico o FIM renovados antes de que venzan.' },
  { titulo: 'Control de cobros: verificar pagos recibidos de obras sociales', dia: 25, diasAviso: 3,
    notas: 'Cruzar con las facturas emitidas y anotar en Ingresos.' },
];

function limpiarTarea(b) {
  const frecuencia = FRECUENCIAS.has(b.frecuencia) ? b.frecuencia : 'MENSUAL';
  return {
    titulo:     String(b.titulo || '').trim(),
    obraSocial: String(b.obraSocial || ''),
    frecuencia,
    dia:        Math.min(31, Math.max(1, Number(b.dia) || 1)),
    mes:        Math.min(12, Math.max(1, Number(b.mes) || 1)),
    fecha:      frecuencia === 'UNICA' ? normalizarDMY(b.fecha) : '',
    diasAviso:  Math.min(60, Math.max(0, Number(b.diasAviso ?? 5))),
    notas:      String(b.notas || ''),
    activo:     b.activo !== false,
  };
}

async function cargarHechos(tenantId) {
  const snap = await col(tenantId, 'agenda_hechos').get();
  return new Map(snap.docs.map(d => [d.id, d.data()]));
}

router.get('/panel', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [tareasSnap, hechos, legajos, vencSnap, mailsSnap, correoCfg] = await Promise.all([
      col(req.tenantId, 'agenda_tareas').get(),
      cargarHechos(req.tenantId),
      estadoGeneral(req.tenantId),
      col(req.tenantId, 'vencimientos').get(),
      col(req.tenantId, 'correo_mails').get(),
      col(req.tenantId, 'correo_config').doc('principal').get(),
    ]);
    const tareas = tareasSnap.docs.flatMap(d => ocurrencias({ id: d.id, ...d.data() }, hechos)).sort(ordenar);

    const vencimientos = vencSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(v => v.estado !== 'ELIMINADO')
      .map(v => ({ id: v.ID || v.id, descripcion: v.descripcion || '', persona: v.persona || v.chofer || '',
        tipo: v.tipo || '', fechaVenc: v.fechaVenc || '', ...calcEstado(v.fechaVenc, v.diasAviso) }))
      .filter(v => v.estado === 'VENCIDO' || v.estado === 'PROXIMO')
      .sort((a, b) => a.diffDias - b.diffDias);

    const docsPacientes = legajos.alertas.sort((a, b) => {
      const o = { VENCIDO: 0, FALTA: 1, PROXIMO: 2, SIN_FECHA: 3, SIN_OBRA_SOCIAL: 4 };
      return (o[a.tipo] - o[b.tipo]) || ((a.diffDias ?? 999) - (b.diffDias ?? 999));
    });

    const mailsPend = mailsSnap.docs.map(d => d.data()).filter(m => m.estado !== 'RESUELTO');
    const URG = { ALTA: 0, MEDIA: 1, BAJA: 2 };
    const correo = {
      conectado: correoCfg.exists,
      error: correoCfg.exists ? (correoCfg.data().error || '') : '',
      nuevos: mailsPend.filter(m => m.estado === 'NUEVO').length,
      conAccion: mailsPend.filter(m => m.requiereAccion).length,
      destacados: mailsPend.filter(m => m.requiereAccion || m.urgencia === 'ALTA')
        .sort((a, b) => (URG[a.urgencia] ?? 2) - (URG[b.urgencia] ?? 2) || String(b.fecha).localeCompare(String(a.fecha)))
        .slice(0, 5)
        .map(m => ({ id: m.id, asunto: m.asunto, deNombre: m.deNombre || m.de, resumen: m.resumen, accion: m.accion,
          urgencia: m.urgencia, categoria: m.categoria, fecha: m.fecha, pacienteNombre: m.pacienteNombre || '' })),
    };

    const urgentes =
      tareas.filter(t => t.estado === 'VENCIDO').length +
      vencimientos.filter(v => v.estado === 'VENCIDO').length +
      docsPacientes.filter(a => a.tipo === 'VENCIDO').length;

    res.json({
      ok: true, tareas, vencimientos, docsPacientes, correo,
      resumen: {
        urgentes,
        tareasPendientes: tareas.filter(t => t.estado !== 'HECHO').length,
        tareasHechas: tareas.filter(t => t.estado === 'HECHO').length,
        carpetasCompletas: legajos.carpetas.filter(c => c.resumen.completo).length,
        carpetasTotal: legajos.carpetas.length,
      },
      hayTareas: tareasSnap.size > 0,
      hayRequisitos: legajos.hayRequisitos,
    });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/tareas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await col(req.tenantId, 'agenda_tareas').get();
    const tareas = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.frecuencia + String(a.dia).padStart(2, '0')).localeCompare(b.frecuencia + String(b.dia).padStart(2, '0')));
    res.json({ ok: true, tareas });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/tareas/semilla', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'agenda_tareas');
    if (!(await ref.limit(1).get()).empty) return res.json({ ok: true, creadas: 0, mensaje: 'Ya hay tareas cargadas.' });
    for (const t of TAREAS_BORRADOR) {
      const id = randomUUID();
      await ref.doc(id).set({ ...limpiarTarea({ frecuencia: 'MENSUAL', ...t }), id, creadoEn: new Date().toISOString() });
    }
    res.json({ ok: true, creadas: TAREAS_BORRADOR.length });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/tareas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const data = limpiarTarea(req.body);
    if (!data.titulo) return res.status(400).json({ ok: false, mensaje: 'Falta el título.' });
    if (data.frecuencia === 'UNICA' && !data.fecha) return res.status(400).json({ ok: false, mensaje: 'Falta la fecha.' });
    const id = randomUUID();
    await col(req.tenantId, 'agenda_tareas').doc(id).set({ ...data, id, creadoEn: new Date().toISOString() });
    res.json({ ok: true, id });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/tareas/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'agenda_tareas').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    const data = limpiarTarea(req.body);
    if (!data.titulo) return res.status(400).json({ ok: false, mensaje: 'Falta el título.' });
    await ref.update({ ...data, actualizadoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

router.delete('/tareas/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'agenda_tareas').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// Marcar / desmarcar una ocurrencia como hecha.
router.post('/tareas/:id/hecho', verifyToken, requireAdmin, async (req, res) => {
  try {
    const periodo = String(req.body.periodo || '');
    if (!/^(\d{4}-\d{2}|\d{4}|unica)$/.test(periodo)) return res.status(400).json({ ok: false, mensaje: 'Período inválido.' });
    const ref = col(req.tenantId, 'agenda_hechos').doc(`${req.params.id}_${periodo}`);
    if (req.body.hecho === false) await ref.delete();
    else await ref.set({ tareaId: req.params.id, periodo, hechoPor: nombreUsuario(req.user), hechoEn: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
