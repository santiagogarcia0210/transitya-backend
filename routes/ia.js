const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { col } = require('../utils');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const errHandler = (res, req, e) => {
  console.error('[IA]', req.path, e.message);
  res.status(500).json({ ok: false, mensaje: e.message });
};

// ── PUNTO DE SALIDA ───────────────────────────────────────────────────────────

router.get('/salida-chofer', verifyToken, async (req, res) => {
  try {
    const doc = await col(req.tenantId, 'salidas_choferes').doc(req.user.uid).get();
    res.json({ ok: true, salida: doc.exists ? doc.data() : null });
  } catch (e) { errHandler(res, req, e); }
});

router.put('/salida-chofer', verifyToken, async (req, res) => {
  try {
    const { direccion, lat, lng } = req.body;
    await col(req.tenantId, 'salidas_choferes').doc(req.user.uid).set(
      { direccion: direccion || '', lat: lat || null, lng: lng || null, actualizadoEn: new Date() },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (e) { errHandler(res, req, e); }
});

// ── OPTIMIZAR RECORRIDO ───────────────────────────────────────────────────────

router.post('/optimizar-recorrido', verifyToken, async (req, res) => {
  try {
    const { paradas } = req.body;
    if (!paradas?.length) return res.status(400).json({ ok: false, mensaje: 'Se requieren paradas.' });

    // Leer punto de salida del chofer
    const salidaDoc = await col(req.tenantId, 'salidas_choferes').doc(req.user.uid).get();
    const salida = salidaDoc.exists ? salidaDoc.data() : null;

    const salidaLinea = salida
      ? `Punto de salida: ${salida.direccion || ''}${salida.lat ? ` (lat: ${salida.lat}, lng: ${salida.lng})` : ''}\n\n`
      : '';

    const listaTexto = paradas
      .map((p, i) => `${i}. ${p.nombre} — ${p.domicilio}${p.lat ? ` (lat: ${p.lat}, lng: ${p.lng})` : ''}`)
      .join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Sos un optimizador de recorridos de transporte especial en Tucumán, Argentina.
${salidaLinea}Optimizá el orden de estas paradas para minimizar la distancia total recorrida, agrupando por zonas geográficas.
Respondé SOLO con JSON válido sin markdown:
{"orden":[índices 0-based],"distancia_estimada_km":número,"explicacion":"texto breve","zonas":["nombre zona (N paradas)"]}

Paradas:
${listaTexto}`,
      }],
    });

    const raw = message.content[0].text.replace(/```json?|```/g, '').trim();
    const resultado = JSON.parse(raw);
    res.json({ ok: true, resultado, salidaUsada: salida });
  } catch (e) { errHandler(res, req, e); }
});

// ── ESCANEAR COMPROBANTE (egreso o remito) ───────────────────────────────────

router.post('/escanear-comprobante', verifyToken, async (req, res) => {
  try {
    const { fotoBase64, mimeType, tipo } = req.body;
    if (!fotoBase64 || !mimeType) return res.status(400).json({ ok: false, mensaje: 'Falta fotoBase64 o mimeType.' });

    const promptEgreso = 'Extraé los datos de este comprobante fiscal. Respondé SOLO con JSON válido sin markdown:\n{"fecha":"dd/MM/yyyy","monto":número,"proveedor":"","cuit":"","nroFactura":"","tipoComprobante":"","concepto":"","categoria":""}';
    const promptRemito = 'Extraé los datos de este remito de combustible. Respondé SOLO con JSON válido sin markdown:\n{"nroRemito":"","razonSocial":"","cuit":"","fecha":"dd/MM/yyyy","combustible":número,"monto":número,"tipoCombustible":""}';

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: fotoBase64 } },
          { type: 'text', text: tipo === 'remito' ? promptRemito : promptEgreso },
        ],
      }],
    });

    const raw   = message.content[0].text.replace(/```json?|```/g, '').trim();
    const datos = JSON.parse(raw);
    res.json({ ok: true, datos });
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
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: fotoBase64 } },
          {
            type: 'text',
            text: `Foto del odómetro al ${tipoLabel} de la jornada.\nLeé el valor exacto del contador de kilómetros.\nRespondé SOLO con JSON:\n{"km":NUMERO,"confianza":"alta"|"media"|"baja","nota":"texto breve"}\nSi no podés leer claramente: {"km":null,"confianza":"baja","nota":"no legible"}`,
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
