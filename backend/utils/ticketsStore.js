const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

let supabase = null;
let supabaseEnabled = false;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
      },
    });
    supabaseEnabled = true;
    console.log('✅ Supabase initialisé pour les tickets');
  } catch (err) {
    console.error('❌ Initialisation Supabase échouée :', err.message);
  }
} else {
  console.warn('⚠️ Supabase non configuré → fallback JSON local');
}

const FALLBACK_DATA_DIR = path.join(__dirname, '..', 'data');
const FALLBACK_STORE_FILE = path.join(FALLBACK_DATA_DIR, 'tickets.fallback.json');
let fallbackCache = null;

function ensureFallback() {
  if (fallbackCache) return;

  if (!fs.existsSync(FALLBACK_DATA_DIR)) fs.mkdirSync(FALLBACK_DATA_DIR, { recursive: true });
  if (!fs.existsSync(FALLBACK_STORE_FILE)) fs.writeFileSync(FALLBACK_STORE_FILE, '{}', 'utf8');

  try {
    fallbackCache = JSON.parse(fs.readFileSync(FALLBACK_STORE_FILE, 'utf8'));
  } catch (err) {
    console.error('ticketsStore fallback: JSON invalide → réinitialisation');
    fallbackCache = {};
    fs.writeFileSync(FALLBACK_STORE_FILE, '{}', 'utf8');
  }
}

function writeFallback() {
  if (!fallbackCache) return;
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
    issued_at: ticket.issuedAt,
    status: ticket.status || 'valid',
  };

  if (supabaseEnabled) {
    const { error } = await supabase.from('tickets').upsert({
      id: ticket.id,
      ...record,
    });
    if (error) {
      console.error('Supabase upsert ticket échoué :', error.message);
    }
    return;
  }

  ensureFallback();
  fallbackCache[ticket.id] = record;
  writeFallback();
}

async function getTicketRecord(ticketId) {
  if (supabaseEnabled) {
    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', ticketId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Supabase get ticket échoué :', error.message);
    }
    return data || null;
  }

  ensureFallback();
  return fallbackCache[ticketId] || null;
}

async function updateTicketStatus(ticketId, status) {
  if (supabaseEnabled) {
    const payload = { status };
    if (status === 'used') payload.used_at = new Date().toISOString();
    const { error } = await supabase
      .from('tickets')
      .update(payload)
      .eq('id', ticketId);
    if (error) {
      console.error('Supabase update ticket échoué :', error.message);
    }
    return;
  }

  ensureFallback();
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
  SUPABASE_ENABLED: supabaseEnabled,
};
