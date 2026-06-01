const admin = require('firebase-admin');

let db, auth;

try {
  const saRaw = process.env.FIREBASE_SA;
  console.log('[FIREBASE] SA length:', saRaw ? saRaw.length : 'MISSING');
  console.log('[FIREBASE] SA first 50 chars:', saRaw ? saRaw.substring(0, 50) : 'MISSING');

  const serviceAccount = JSON.parse(saRaw);
  console.log('[FIREBASE] project_id:', serviceAccount.project_id);
  console.log('[FIREBASE] client_email:', serviceAccount.client_email);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: 'gestion-transporte-ef756'
    });
    console.log('[FIREBASE] Initialized successfully');
  }

  db = admin.firestore();
  auth = admin.auth();
  console.log('[FIREBASE] Firestore and Auth ready');
} catch (e) {
  console.error('[FIREBASE] INIT ERROR:', e.message);
}

module.exports = { admin, db, auth };
