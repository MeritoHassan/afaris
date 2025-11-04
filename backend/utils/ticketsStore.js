const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'tickets.json');

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{}', 'utf8');
}

function readStore() {
  ensureStoreFile();
  const raw = fs.readFileSync(STORE_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('ticketsStore: JSON invalide, réinitialisation', err);
    fs.writeFileSync(STORE_FILE, '{}', 'utf8');
    return {};
  }
}

function writeStore(data) {
  ensureStoreFile();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function computeHash(email, ticketId, ticketType) {
  if (!email || !ticketId || !ticketType) {
    return null;
  }
  return crypto
    .createHash('sha256')
    .update(`${String(email).toLowerCase()}|${ticketId}|${ticketType}`)
    .digest('hex');
}

function saveTicketRecord(ticket) {
  const store = readStore();
  store[ticket.id] = {
    email: ticket.email,
    type: ticket.type,
    hash: ticket.hash,
    issuedAt: ticket.issuedAt,
    status: ticket.status || 'valid',
  };
  writeStore(store);
}

function getTicketRecord(ticketId) {
  const store = readStore();
  return store[ticketId] || null;
}

function updateTicketStatus(ticketId, status) {
  const store = readStore();
  if (!store[ticketId]) return;
  store[ticketId].status = status;
  if (status === 'used') store[ticketId].usedAt = Date.now();
  writeStore(store);
}

module.exports = {
  saveTicketRecord,
  getTicketRecord,
  computeHash,
  updateTicketStatus,
};
