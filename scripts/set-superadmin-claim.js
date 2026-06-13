// Cargar .env antes de cualquier require que use process.env
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { admin } = require('../firebase');

async function setSuperAdminClaim() {
  const email = 'superadmin@transitya.app';
  const user = await admin.auth().getUserByEmail(email);
  console.log('Usuario encontrado:', user.uid, user.email);

  await admin.auth().setCustomUserClaims(user.uid, {
    superadmin: true,
    rol: 'superadmin',
    tenantId: null,
  });

  // Verificar que quedó bien
  const updated = await admin.auth().getUser(user.uid);
  console.log('✅ Claim superadmin asignado a:', updated.uid);
  console.log('   Claims actuales:', JSON.stringify(updated.customClaims));
  process.exit(0);
}

setSuperAdminClaim().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
