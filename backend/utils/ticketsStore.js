const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
} = process.env;

const hasFirebaseCredentials =
  FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY;

let firestore = null;
if (hasFirebaseCredentials) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    firestore = admin.firestore();
    console.log('✅ Firestore initialisé pour les tickets');
  } catch (err) {
    console.error('❌ Initialisation Firestore échouée :', err.message);
    firestore = null;
  }
}

const FALLBACK_DATA_DIR = path.join(__dirname, '..', 'data');
const FALLBACK_STORE_FILE = path.join(FALLBACK_DATA_DIR, 'tickets.fallback.json');
const FALLBACK_ENABLED = !firestore;
let fallbackCache = null;

function ensureFallbackFile() {
  if (!FALLBACK_ENABLED) return;
  if (!fs.existsSync(FALLBACK_DATA_DIR)) fs.mkdirSync(FALLBACK_DATA_DIR, { recursive: true });
  if (!fs.existsSync(FALLBACK_STORE_FILE)) fs.writeFileSync(FALLBACK_STORE_FILE, '{}', 'utf8');
  if (!fallbackCache) {
    try {
      fallbackCache = JSON.parse(fs.readFileSync(FALLBACK_STORE_FILE, 'utf8'));
    } catch (err) {
      console.error('ticketsStore fallback: JSON invalide → réinitialisation');
      fallbackCache = {};
      fs.writeFileSync(FALLBACK_STORE_FILE, '{}', 'utf8');
    }
  }
}

function writeFallback() {
  if (!FALLBACK_ENABLED) return;
  ensureFallbackFile();
  fs.writeFileSync(FALLBACK_STORE_FILE, JSON.stringify(fallbackCache, null, 2), 'utf8');
}

function computeHash(email, ticketId, ticketType) {
  if (!email || !ticketId || !ticketType) return null;
  return crypto
    .createHash('sha256')
    .update(`${String(email).toLowerCase()}|${ticketId}|${ticketType}`)
    .digest('hex');
}

async function saveTicketRecord(ticket) {
  const record = {
    email: ticket.email,
    type: ticket.type,
    hash: ticket.hash,
    issuedAt: ticket.issuedAt,
    status: ticket.status || 'valid',
  };
  if (firestore) {
    await firestore.collection('tickets').doc(ticket.id).set(record, { merge: true });
    return;
  }
  ensureFallbackFile();
  fallbackCache[ticket.id] = record;
  writeFallback();
}

async function getTicketRecord(ticketId) {
  if (firestore) {
    const snap = await firestore.collection('tickets').doc(ticketId).get();
    return snap.exists ? snap.data() : null;
  }
  ensureFallbackFile();
  return fallbackCache[ticketId] || null;
}

async function updateTicketStatus(ticketId, status) {
  if (firestore) {
    const data = { status };
    if (status === 'used') data.usedAt = Date.now();
    await firestore.collection('tickets').doc(ticketId).set(data, { merge: true });
    return;
  }
  ensureFallbackFile();
  if (!fallbackCache[ticketId]) return;
  fallbackCache[ticketId].status = status;
  if (status === 'used') fallbackCache[ticketId].usedAt = Date.now();
  writeFallback();
}

module.exports = {
  computeHash,
  saveTicketRecord,
  getTicketRecord,
  updateTicketStatus,
  FIREBASE_ENABLED: Boolean(firestore),
};
