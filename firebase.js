const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)),
    projectId: 'gestion-transporte-ef756'
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
