const router = require('express').Router();
const auth   = require('../middleware/authMiddleware');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Optimizar recorrido (ruta existente) ───────────────────────────────────────
router.post('/optimizar-recorrido', auth, async (req, res) => {
  try {
    const { paradas } = req.body;
    const listaTexto = paradas.map((p, i) =>
      `${i}. ${p.nombre} — ${p.domicilio} (lat: ${p.lat || '?'}, lng: ${p.lng || '?'})`
    ).join('\n');

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Optimizá el orden de estas paradas de transporte en Tucumán, Argentina para minimizar distancia. Respondé SOLO con JSON válido:
{"orden": [índices 0-based], "distancia_estimada_km": número, "explicacion": "texto", "zonas": ["zona (N paradas)"]}

Paradas:
${listaTexto}`
      }]
    });

    const text = msg.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    res.json({ ok: true, resultado: JSON.parse(text) });
  } catch (e) {
    console.error('[IA] optimizar-recorrido:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Escanear comprobante / remito con IA (Claude Haiku) ────────────────────────
// Body: { base64: string, tipo: 'egreso' | 'remito' }
router.post('/escanear-comprobante', auth, async (req, res) => {
  try {
    const { base64, tipo = 'egreso' } = req.body;
    if (!base64) return res.status(400).json({ ok: false, mensaje: 'Falta la imagen en base64.' });

    // Sanear base64: quitar posible data URI prefix
    const b64 = base64.includes(',') ? base64.split(',')[1] : base64;

    const prompts = {
      egreso:
        'Sos un experto en comprobantes fiscales argentinos.\n' +
        'Analizá esta imagen y extraé los datos del comprobante.\n' +
        'Respondé ÚNICAMENTE con un objeto JSON válido, sin explicaciones, sin markdown, sin backticks.\n\n' +
        'Campos a extraer:\n' +
        '- "fecha": fecha en dd/MM/yyyy\n' +
        '- "monto": TOTAL final pagado, solo número sin $ ni puntos de miles\n' +
        '- "proveedor": razón social del EMISOR\n' +
        '- "cuit": CUIT del emisor sin guiones\n' +
        '- "nroFactura": punto_de_venta-numero (ej: 00012-00010268)\n' +
        '- "tipoComprobante": Factura A | Factura B | Factura C | Tique Factura | Ticket | Remito | Recibo\n' +
        '- "concepto": producto o servicio (GNC, Nafta, Gasoil, Repuesto, etc.)\n' +
        '- "iva": alícuota de IVA si aparece (ej: 21)\n' +
        '- "categoria": combustible | repuesto | mantenimiento | seguro | peaje | limpieza | comida | otro\n\n' +
        'Reglas: el monto es el TOTAL FINAL pagado. Si no podés leer un campo dejalo como "". Solo el JSON.',

      remito:
        'Sos un experto en comprobantes de combustible y remitos argentinos.\n' +
        'Analizá la imagen y extraé los datos. Respondé ÚNICAMENTE con JSON válido sin explicaciones ni markdown.\n\n' +
        'Campos:\n' +
        '- "nroRemito": número del remito/ticket (ej: 0001-00012345)\n' +
        '- "razonSocial": nombre de la estación/proveedor\n' +
        '- "cuit": CUIT del emisor sin guiones\n' +
        '- "fecha": dd/MM/yyyy\n' +
        '- "combustible": litros cargados, solo el número\n' +
        '- "monto": importe TOTAL pagado, solo número sin $ ni puntos de miles\n' +
        '- "tipoCombustible": GNC | Nafta | Gasoil | Diesel | Super\n\n' +
        'Si no podés leer un campo dejalo como "". Solo el JSON.'
    };

    const prompt = prompts[tipo] || prompts.egreso;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text',  text: prompt }
        ]
      }]
    });

    const raw = msg.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ ok: false, mensaje: 'No se detectó un comprobante válido.' });

    const datos = JSON.parse(jsonMatch[0]);

    // Normalizar campos numéricos
    if (datos.monto)       datos.monto       = String(datos.monto).replace(/[$\s]/g,'').replace(/\.(?=\d{3})/g,'').replace(',','.');
    if (datos.cuit)        datos.cuit        = String(datos.cuit).replace(/[-\s]/g,'');
    if (datos.combustible) datos.combustible = String(datos.combustible).replace(/[^\d.,]/g,'').replace(',','.');

    console.log(`[IA] escanear-comprobante (${tipo}) OK`);
    res.json({ ok: true, datos, tipo });
  } catch (e) {
    console.error('[IA] escanear-comprobante:', e.message);
    res.status(500).json({ ok: false, mensaje: 'Error al procesar la imagen: ' + e.message });
  }
});

// ── Ordenar paradas de un chofer (asistencia diaria) ──────────────────────────
// Body: { choferId, choferNombre, beneficiarios: [{id, nombre, domicilio, horarioTurno}] }
router.post('/ordenar-paradas', auth, async (req, res) => {
  try {
    const { choferId, choferNombre, beneficiarios } = req.body;
    if (!beneficiarios?.length) return res.status(400).json({ ok: false, mensaje: 'Sin beneficiarios.' });

    const lista = beneficiarios.map((b, i) =>
      `${i + 1}. ID: ${b.id} | Nombre: ${b.nombre} | Domicilio: ${b.domicilio || 'Sin domicilio'} | Turno: ${b.horarioTurno || 'Sin horario'}`
    ).join('\n');

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content:
          `El chofer "${choferNombre}" debe recoger a estos pacientes en Tucumán:\n${lista}\n\n` +
          'Ordená las paradas minimizando el recorrido total y respetando que cada paciente llegue antes de su turno médico.\n' +
          'Respondé SOLO en JSON:\n' +
          '{"paradas":[{"beneficiarioId":"...","nombre":"...","domicilio":"...","horarioTurno":"...","ordenVisita":1}]}'
      }]
    });

    const raw = msg.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON inválido de IA');
    const resultado = JSON.parse(jsonMatch[0]);

    // Validar que no se pierdan beneficiarios
    const idsOrig = beneficiarios.map(b => b.id);
    const idsIA   = (resultado.paradas || []).map(p => p.beneficiarioId);
    if (!idsOrig.every(id => idsIA.includes(id)) || idsIA.length !== idsOrig.length) {
      // Fallback: ordenar por horario
      const fallback = [...beneficiarios].sort((a, b) =>
        (a.horarioTurno || '99:99').localeCompare(b.horarioTurno || '99:99')
      ).map((b, i) => ({ beneficiarioId: b.id, nombre: b.nombre, domicilio: b.domicilio, horarioTurno: b.horarioTurno, ordenVisita: i + 1 }));
      return res.json({ ok: true, choferId, fuente: 'fallback', paradas: fallback });
    }

    resultado.paradas.forEach((p, i) => { p.ordenVisita = i + 1; });
    res.json({ ok: true, choferId, fuente: 'ia', paradas: resultado.paradas });
  } catch (e) {
    console.error('[IA] ordenar-paradas:', e.message);
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

module.exports = router;
