// Carpeta (legajo) digital de cada paciente transportado.
// Colección: empresas/{tenantId}/legajo_docs/{id}
//   { id, beneficiarioId, beneficiarioNombre, requisitoKey, nombre, fechaEmision, fechaVenc,
//     estadoTramite: CARGADO|PRESENTADO|APROBADO|OBSERVADO, archivoUrl, archivoNombre, notas,
//     creadoEn, creadoPor, actualizadoEn }
// Los requisitos salen de requisitos_os según la OBRA SOCIAL del registro del paciente.
const router = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { col, randomUUID, nombreUsuario } = require('../utils');
const { normalizarDMY } = require('../helpers/fechas');
const { subirFoto } = require('../helpers/storage');
const L = require('../services/legajos');

const errHandler = (res, req, e) => {
  console.error('[LEGAJOS]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

const ESTADOS_TRAMITE = new Set(['CARGADO', 'PRESENTADO', 'APROBADO', 'OBSERVADO']);
const MIME_OK = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_BYTES = 8 * 1024 * 1024;

async function cargarBeneficiarios(tenantId) {
  const [reg, ben] = await Promise.all([
    col(tenantId, 'registro').get(),
    col(tenantId, 'BENEFICIARIOS').get().catch(() => null),
  ]);
  const vistos = new Set();
  const lista = [];
  for (const d of [...reg.docs, ...(ben ? ben.docs : [])]) {
    if (vistos.has(d.id)) continue;
    vistos.add(d.id);
    const b = L.datosBeneficiario({ id: d.id, ...d.data() });
    if (b.nombre) lista.push(b);
  }
  return lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

async function cargarObras(tenantId) {
  const snap = await col(tenantId, 'requisitos_os').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function cargarDocs(tenantId, beneficiarioId) {
  let q = col(tenantId, 'legajo_docs');
  if (beneficiarioId) q = q.where('beneficiarioId', '==', beneficiarioId);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Resumen + alertas de todas las carpetas. Lo usa también el panel administrativo. */
async function estadoGeneral(tenantId) {
  const [benefs, obras, docs] = await Promise.all([cargarBeneficiarios(tenantId), cargarObras(tenantId), cargarDocs(tenantId)]);
  const porBenef = new Map();
  for (const d of docs) {
    if (!porBenef.has(d.beneficiarioId)) porBenef.set(d.beneficiarioId, []);
    porBenef.get(d.beneficiarioId).push(d);
  }
  const alertas = [];
  const carpetas = benefs.map(b => {
    const obra = L.matchObraSocial(b.obraSocial, obras);
    const items = L.checklist(obra, porBenef.get(b.id) || []);
    alertas.push(...L.alertasDe(b, obra, items));
    return { ...b, obraId: obra?.id || null, obraNombre: obra?.nombre || '', resumen: L.resumenChecklist(items) };
  });
  return { carpetas, alertas, hayRequisitos: obras.length > 0 };
}

async function prepararArchivo(tenantId, beneficiarioId, archivo) {
  if (!archivo || !archivo.base64) return {};
  const mime = String(archivo.mimeType || '').toLowerCase();
  if (!MIME_OK.has(mime)) throw Object.assign(new Error('Formato no permitido. Subí PDF o imagen.'), { status: 400 });
  const base64 = String(archivo.base64).replace(/^data:[^,]+,/, '');
  if (Buffer.byteLength(base64, 'base64') > MAX_BYTES) throw Object.assign(new Error('El archivo supera 8 MB.'), { status: 400 });
  const nombre = String(archivo.nombre || 'documento').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  const ruta = `legajos/${tenantId}/${beneficiarioId}/${randomUUID()}-${nombre}`;
  const url = await subirFoto(base64, mime, ruta);
  return { archivoUrl: url, archivoNombre: nombre, archivoRuta: ruta };
}

function camposDoc(body) {
  const out = {};
  if (body.requisitoKey !== undefined) out.requisitoKey = String(body.requisitoKey || '');
  if (body.nombre !== undefined) out.nombre = String(body.nombre || '').trim();
  if (body.fechaEmision !== undefined) out.fechaEmision = normalizarDMY(body.fechaEmision);
  if (body.fechaVenc !== undefined) out.fechaVenc = normalizarDMY(body.fechaVenc);
  if (body.estadoTramite !== undefined) out.estadoTramite = ESTADOS_TRAMITE.has(body.estadoTramite) ? body.estadoTramite : 'CARGADO';
  if (body.notas !== undefined) out.notas = String(body.notas || '');
  return out;
}

router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { carpetas, hayRequisitos } = await estadoGeneral(req.tenantId);
    res.json({ ok: true, carpetas, hayRequisitos });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/alertas/lista', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { alertas } = await estadoGeneral(req.tenantId);
    res.json({ ok: true, alertas });
  } catch (e) { errHandler(res, req, e); }
});

router.get('/:beneficiarioId', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { beneficiarioId } = req.params;
    let snap = await col(req.tenantId, 'registro').doc(beneficiarioId).get();
    if (!snap.exists) snap = await col(req.tenantId, 'BENEFICIARIOS').doc(beneficiarioId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'Paciente no encontrado.' });
    const beneficiario = L.datosBeneficiario({ id: snap.id, ...snap.data() });
    const [obras, documentos] = await Promise.all([cargarObras(req.tenantId), cargarDocs(req.tenantId, beneficiarioId)]);
    const obra = L.matchObraSocial(beneficiario.obraSocial, obras);
    const items = L.checklist(obra, documentos);
    const keys = new Set(items.map(i => i.requisito.key));
    res.json({
      ok: true, beneficiario, obra, checklist: items, resumen: L.resumenChecklist(items),
      otros: documentos.filter(d => !keys.has(d.requisitoKey)),
      obras: obras.map(o => ({ id: o.id, nombre: o.nombre })),
    });
  } catch (e) { errHandler(res, req, e); }
});

router.post('/:beneficiarioId/documentos', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { beneficiarioId } = req.params;
    const datos = camposDoc({ estadoTramite: 'CARGADO', ...req.body });
    if (!datos.nombre && !datos.requisitoKey) return res.status(400).json({ ok: false, mensaje: 'Indicá qué documento es.' });
    const archivo = await prepararArchivo(req.tenantId, beneficiarioId, req.body.archivo);
    const id = randomUUID();
    await col(req.tenantId, 'legajo_docs').doc(id).set({
      ...datos, ...archivo, id, beneficiarioId,
      beneficiarioNombre: String(req.body.beneficiarioNombre || ''),
      creadoEn: new Date().toISOString(), creadoPor: nombreUsuario(req.user),
    });
    res.json({ ok: true, id });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, mensaje: e.message });
    errHandler(res, req, e);
  }
});

router.put('/documentos/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'legajo_docs').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    const archivo = await prepararArchivo(req.tenantId, snap.data().beneficiarioId, req.body.archivo);
    await ref.update({ ...camposDoc(req.body), ...archivo, actualizadoEn: new Date().toISOString(), actualizadoPor: nombreUsuario(req.user) });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, mensaje: e.message });
    errHandler(res, req, e);
  }
});

router.delete('/documentos/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const ref = col(req.tenantId, 'legajo_docs').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ ok: false, mensaje: 'No encontrado.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
module.exports.estadoGeneral = estadoGeneral;
