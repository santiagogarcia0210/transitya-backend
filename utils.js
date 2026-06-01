const { db } = require('./firebase');
const { randomUUID } = require('crypto');

const TIMEZONE = 'America/Argentina/Tucuman';
const MESES = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO',
               'JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];

function normalizarText_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function parseMonto_(v) {
  return parseFloat(String(v || '0').replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0;
}

function fechaHoyAR() {
  const parts = new Intl.DateTimeFormat('es-AR', {
    timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric'
  }).formatToParts(new Date());
  const d = parts.find(p => p.type === 'day')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const y = parts.find(p => p.type === 'year')?.value;
  return `${d}/${m}/${y}`;
}

function esAdmin(user) {
  const rol = user?.rol || user?.role || '';
  return rol === 'admin' || rol === 'administrador';
}

function esSuperadmin(user) {
  return user?.superadmin === true || user?.role === 'superadmin' || user?.rol === 'superadmin';
}

function nombreUsuario(user) {
  return user?.nombre || user?.name || (user?.email ? user.email.split('@')[0] : '') || user?.uid || '';
}

function esMesDMY(fecha, m, y) {
  const p = String(fecha || '').split('/');
  if (p.length < 3) return false;
  return Number(p[1]) === m && Number(p[2].length === 2 ? '20' + p[2] : p[2]) === y;
}

function esMesISO(isoDate, m, y) {
  if (!isoDate) return false;
  const d = new Date(isoDate);
  return d.getMonth() + 1 === m && d.getFullYear() === y;
}

async function generarCorrelativo(tenantId, key) {
  const ref = db.collection('empresas').doc(tenantId).collection('_counters').doc(key);
  return db.runTransaction(async t => {
    const doc = await t.get(ref);
    const next = (doc.exists ? (doc.data().valor || 0) : 0) + 1;
    t.set(ref, { valor: next });
    return next;
  });
}

function col(tenantId, sub) {
  return db.collection('empresas').doc(tenantId).collection(sub);
}

module.exports = {
  normalizarText_, parseMonto_, fechaHoyAR, esAdmin, esSuperadmin,
  nombreUsuario, esMesDMY, esMesISO, generarCorrelativo, col,
  TIMEZONE, MESES, randomUUID
};
