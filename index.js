require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: ['https://transitya.com', 'http://localhost:3000', 'http://localhost:3001'] }));
app.use(express.json());

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/beneficiarios', require('./routes/beneficiarios'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/recorridos', require('./routes/recorridos'));
app.use('/api/asistencia', require('./routes/asistencia'));
app.use('/api/egresos', require('./routes/egresos'));
app.use('/api/remitos', require('./routes/remitos'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/ubicaciones', require('./routes/ubicaciones'));
app.use('/api/vencimientos', require('./routes/vencimientos'));
app.use('/api/ia', require('./routes/ia'));

app.get('/health', (req, res) => res.json({ ok: true, version: '1.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Transit·Ya backend corriendo en puerto ${PORT}`));
