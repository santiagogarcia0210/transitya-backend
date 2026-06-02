const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const errHandler = (res, req, e) => {
  console.error('[IA]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

router.post('/optimizar-recorrido', verifyToken, async (req, res) => {
  try {
    const { paradas } = req.body;
    const listaTexto = paradas.map((p, i) => `${i}. ${p.nombre} — ${p.domicilio} (lat: ${p.lat}, lng: ${p.lng})`).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Optimizá el orden de estas paradas de transporte en Tucumán, Argentina para minimizar distancia. Respondé SOLO con JSON válido:
{"orden": [índices 0-based], "distancia_estimada_km": número, "explicacion": "texto", "zonas": ["zona (N paradas)"]}

Paradas:
${listaTexto}`
      }]
    });

    const json = JSON.parse(message.content[0].text);
    res.json({ ok: true, resultado: json });
  } catch (e) { errHandler(res, req, e); }
});

// ── ESCANEAR ODÓMETRO ─────────────────────────────────────────────────────────

router.post('/escanear-odometro', verifyToken, async (req, res) => {
  try {
    const { fotoBase64, mimeType, tipo } = req.body;
    if (!fotoBase64 || !mimeType) return res.status(400).json({ ok: false, mensaje: 'Falta fotoBase64 o mimeType.' });
    const tipoLabel = tipo === 'fin' ? 'FINAL' : 'INICIO';

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: fotoBase64 },
          },
          {
            type: 'text',
            text: `Foto del odómetro al ${tipoLabel} de la jornada.\nLeé el valor exacto del contador de kilómetros.\nRespondé SOLO con JSON:\n{ "km": NUMERO, "confianza": "alta"|"media"|"baja", "nota": "texto breve" }\nSi no podés leer claramente: { "km": null, "confianza": "baja", "nota": "no legible" }`,
          },
        ],
      }],
    });

    const raw = message.content[0].text.replace(/```json?|```/g, '').trim();
    const { km, confianza, nota } = JSON.parse(raw);
    res.json({ ok: true, km, confianza, nota, tipo: tipo || 'inicio' });
  } catch (e) { errHandler(res, req, e); }
});

module.exports = router;
