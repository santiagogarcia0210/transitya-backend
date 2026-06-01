const router = require('express').Router();
const { db } = require('../firebase');
const auth = require('../middleware/authMiddleware');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post('/optimizar-recorrido', auth, async (req, res) => {
  try {
    const { paradas } = req.body;
    const listaTexto = paradas.map((p, i) => `${i}. ${p.nombre} — ${p.domicilio} (lat: ${p.lat}, lng: ${p.lng})`).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
