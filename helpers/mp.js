const https = require('https');

function mpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.MP_ACCESS_TOKEN || '';
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.mercadopago.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const mpGet  = (path, params) => mpRequest('GET',  path + (params || ''), null);
const mpPost = (path, body)   => mpRequest('POST', path, body);

module.exports = { mpGet, mpPost };
