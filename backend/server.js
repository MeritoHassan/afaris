require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static files (landing + purchase) from ../public
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// ------------------ ENV ------------------
const {
  PORT = 4000,
  EVENT_NAME = 'Soirée AFARIS – Décembre 2025',
  EVENT_DATE = '2025-12-27',
  ORGANIZER_EMAIL = 'billets@afaris.com',

  // PayPal (si tu gardes l’option carte via PayPal)
  PAYPAL_ENV = 'sandbox',
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,

  // SMTP
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,

  // Virement
  IBAN,
  BIC,

  // JWT
  JWT_SECRET = 'dev_secret',
} = process.env;

// ------------------ Stores en mémoire ------------------
const tickets = new Map();
const reservations = new Map();

// ------------------ Helper JWT ------------------
function signTicketPayload(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

// ------------------ SMTP avec fallback 465 -> 587 ------------------
let EMAILS_ENABLED = true;
let transporter = null;

function makeTransport(host, port, user, pass) {
  const p = Number(port);
  const secure = p === 465; // 465 = SSL / 587 = STARTTLS
  return nodemailer.createTransport({
    host,
    port: p,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

(async () => {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn('⚠️  SMTP incomplet : Emails OFF');
    EMAILS_ENABLED = false;
    return;
  }

  // essai 1 : port fourni (souvent 465)
  try {
    transporter = makeTransport(SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS);
    await transporter.verify();
    console.log(`✅ SMTP OK (${SMTP_HOST}:${SMTP_PORT})`);
    EMAILS_ENABLED = true;
    return;
  } catch (e) {
    console.error(`❌ SMTP KO (${SMTP_HOST}:${SMTP_PORT}) :`, e.message);
  }

  // essai 2 : fallback 587
  try {
    console.log('↩️  Fallback SMTP sur 587 (STARTTLS)…');
    transporter = makeTransport(SMTP_HOST, 587, SMTP_USER, SMTP_PASS);
    await transporter.verify();
    console.log(`✅ SMTP OK (${SMTP_HOST}:587)`);
    EMAILS_ENABLED = true;
  } catch (e) {
    console.error('❌ SMTP KO (587) :', e.message);
    EMAILS_ENABLED = false;
  }
})();

// Expose un check rapide
app.get('/api/smtp-check', (req, res) => {
  res.json({
    emailsEnabled: EMAILS_ENABLED,
    host: SMTP_HOST || null,
    user: SMTP_USER || null,
    port: SMTP_PORT || null,
  });
});

// ------------------ PayPal helpers (facultatif) ------------------
async function getPayPalAccessToken() {
  const url =
    PAYPAL_ENV === 'live'
      ? 'https://api-m.paypal.com/v1/oauth2/token'
      : 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
  const res = await axios({
    url,
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_SECRET },
    data: 'grant_type=client_credentials',
  });
  return res.data.access_token;
}

async function capturePayPalOrder(orderId) {
  const base =
    PAYPAL_ENV === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  const token = await getPayPalAccessToken();
  const res = await axios.post(
    `${base}/v2/checkout/orders/${orderId}/capture`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return res.data;
}

// ------------------ Emails ------------------
async function sendTicketEmail(to, ticket) {
  if (!EMAILS_ENABLED || !transporter)
    throw new Error('SMTP disabled');

  const htmlTemplate = fs.readFileSync(
    path.join(__dirname, 'ticketTemplate.html'),
    'utf8'
  );
  const qrDataUrl = await QRCode.toDataURL(ticket.jwt);
  const html = htmlTemplate
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, ticket.name)
    .replace(/{{TICKET_ID}}/g, ticket.id)
    .replace(
      /{{TICKET_TYPE}}/g,
      ticket.type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard (sans menu)'
    )
    .replace(/{{QR_DATA_URL}}/g, qrDataUrl);

  await transporter.sendMail({
    from: ORGANIZER_EMAIL || SMTP_USER,
    to,
    subject: `[${EVENT_NAME}] Votre billet – ${ticket.id}`,
    html,
  });
}

async function sendTransferReservationEmail(to, reservation) {
  if (!EMAILS_ENABLED || !transporter)
    throw new Error('SMTP disabled');

  const htmlTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'emails', 'transferReservation.html'),
    'utf8'
  );
  const html = htmlTemplate
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, reservation.name)
    .replace(/{{AMOUNT}}/g, reservation.amount.toFixed(2))
    .replace(/{{REFERENCE}}/g, reservation.referenceCode)
    .replace(/{{IBAN}}/g, IBAN || '—')
    .replace(/{{BIC}}/g, BIC || '—');

  await transporter.sendMail({
    from: ORGANIZER_EMAIL || SMTP_USER,
    to,
    subject: `[${EVENT_NAME}] Réservation en attente de virement (${reservation.referenceCode})`,
    html,
  });
}

// ------------------ API ------------------
app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// Créer commande (virement ou carte)
app.post('/api/create-order', async (req, res) => {
  const { name, email, ticketType, amount, method } = req.body; // 'standard' | 'vip'
  if (!name || !email || !ticketType || !amount || !method)
    return res.status(400).json({ error: 'Missing fields' });

  if (method === 'transfer') {
    const referenceCode = `AFR-${new Date().getFullYear()}-${String(
      Math.floor(Math.random() * 100000)
    ).padStart(5, '0')}`;
    const reservation = {
      email,
      name,
      ticketType,
      amount: Number(amount),
      referenceCode,
      createdAt: Date.now(),
      status: 'pending_transfer',
    };
    reservations.set(referenceCode, reservation);
    try {
      await sendTransferReservationEmail(email, reservation);
    } catch (e) {
      console.error('Email error:', e.message);
    }
    return res.json({ ok: true, method, referenceCode, iban: IBAN, bic: BIC });
  }

  if (method === 'card') {
    // MVP : on simule une order PayPal (sinon utilise API officielle)
    const orderId = uuidv4();
    return res.json({ ok: true, method, orderId });
  }

  return res.status(400).json({ error: 'Invalid method' });
});

// Capture PayPal (simulé)
app.post('/api/paypal/capture', async (req, res) => {
  const { orderId, name, email, amount, ticketType } = req.body;
  if (!orderId || !name || !email || !amount || !ticketType)
    return res.status(400).json({ error: 'Missing fields' });

  try {
    // const capture = await capturePayPalOrder(orderId);
    // if (capture.status !== 'COMPLETED') return res.status(400).json({ error: 'Payment not completed' });

    const id = `AFR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const payload = {
      id,
      email,
      name,
      amount: Number(amount),
      type: ticketType,
      issuedAt: Date.now(),
      source: 'paypal',
    };
    const token = signTicketPayload(payload);
    const ticket = {
      id,
      email,
      name,
      amount: Number(amount),
      type: ticketType,
      method: 'card',
      status: 'valid',
      jwt: token,
      createdAt: Date.now(),
    };
    tickets.set(id, ticket);
    try {
      await sendTicketEmail(email, ticket);
    } catch (e) {
      console.error('Email error:', e.message);
    }
    return res.json({ ok: true, ticketId: id });
  } catch (e) {
    console.error('capture error', e.message);
    return res.status(500).json({ error: 'Capture failed' });
  }
});

// Confirmation virement (quand payé)
app.post('/api/confirm-transfer', async (req, res) => {
  const { referenceCode, name, email, amount, ticketType } = req.body;
  const r = reservations.get(referenceCode);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });

  r.status = 'paid';

  const id = `AFR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const payload = {
    id,
    email,
    name,
    amount: Number(amount || r.amount),
    type: ticketType || r.ticketType,
    issuedAt: Date.now(),
    reference: referenceCode,
  };
  const token = signTicketPayload(payload);
  const ticket = {
    id,
    email,
    name,
    amount: Number(amount || r.amount),
    type: ticketType || r.ticketType,
    method: 'transfer',
    status: 'valid',
    jwt: token,
    createdAt: Date.now(),
  };
  tickets.set(id, ticket);

  try {
    await sendTicketEmail(email, ticket);
  } catch (e) {
    console.error('Email error:', e.message);
  }
  return res.json({ ok: true, ticketId: id });
});

// Scanner/validation
app.post('/api/validate', (req, res) => {
  const { token } = req.body;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const t = tickets.get(decoded.id);
    if (!t) return res.status(404).json({ ok: false, reason: 'Ticket not found' });
    if (t.status === 'used')
      return res.status(400).json({ ok: false, reason: 'Already used' });
    t.status = 'used';
    tickets.set(t.id, t);
    return res.json({ ok: true, ticketId: t.id, name: t.name, type: t.type });
  } catch (e) {
    return res.status(400).json({ ok: false, reason: 'Invalid or expired QR' });
  }
});

/* ============================
   TESTS E-MAILS / BILLETS (diagnostic)
   ============================ */

// Test e-mail simple
app.post('/api/test-email', express.json(), async (req, res) => {
  try {
    if (!EMAILS_ENABLED || !transporter) {
      return res
        .status(400)
        .json({ ok: false, error: 'Emails désactivés (SMTP incomplet ou KO)' });
    }
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: 'missing "to"' });

    const info = await transporter.sendMail({
      from: ORGANIZER_EMAIL || SMTP_USER,
      to,
      subject: '[AFARIS] Test email Render',
      html: `<p>✅ Test e-mail OK depuis Render.</p><p>Date: ${new Date().toISOString()}</p>`,
    });
    console.log('✅ Test email envoyé:', info.messageId);
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    console.error('❌ Test email error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Test billet (QR + template)
app.post('/api/test-ticket', express.json(), async (req, res) => {
  try {
    if (!EMAILS_ENABLED || !transporter) {
      return res
        .status(400)
        .json({ ok: false, error: 'Emails désactivés (SMTP incomplet ou KO)' });
    }
    const { to, type = 'standard', name = 'Test AFARIS' } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: 'missing "to"' });

    const id = `AFR-TEST-${Date.now()}`;
    const amount = type === 'vip' ? 40 : 25;
    const payload = {
      id,
      email: to,
      name,
      amount,
      type,
      issuedAt: Date.now(),
      source: 'test',
    };
    const token = signTicketPayload(payload);
    const ticket = {
      id,
      email: to,
      name,
      amount,
      type,
      method: 'test',
      status: 'valid',
      jwt: token,
      createdAt: Date.now(),
    };

    await sendTicketEmail(to, ticket);
    console.log('✅ Test billet envoyé à', to, 'id', id);
    res.json({ ok: true, id });
  } catch (e) {
    console.error('❌ Test billet error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


// --- TESTS EN GET POUR NAVIGATEUR (à usage temporaire) ---
// 1) Test email simple: /api/test-email-get?to=mail@exemple.com
app.get('/api/test-email-get', async (req, res) => {
  try {
    if (!EMAILS_ENABLED || !transporter) {
      return res.status(400).send('Emails désactivés (SMTP incomplet ou KO)');
    }
    const to = req.query.to;
    if (!to) return res.status(400).send('Paramètre "to" manquant ex: ?to=mail@exemple.com');

    const info = await transporter.sendMail({
      from: ORGANIZER_EMAIL || SMTP_USER,
      to,
      subject: '[AFARIS] Test email Render (GET)',
      html: `<p>✅ Test e-mail OK depuis Render (GET).</p><p>Date: ${new Date().toISOString()}</p>`
    });
    res.send(`OK, messageId=${info.messageId}`);
  } catch (e) {
    console.error('❌ Test email GET error:', e);
    res.status(500).send('Erreur: ' + (e.message || e));
  }
});

// 2) Test billet: /api/test-ticket-get?to=mail@exemple.com&type=vip&name=Test
app.get('/api/test-ticket-get', async (req, res) => {
  try {
    if (!EMAILS_ENABLED || !transporter) {
      return res.status(400).send('Emails désactivés (SMTP incomplet ou KO)');
    }
    const to = req.query.to;
    const type = (req.query.type === 'vip') ? 'vip' : 'standard';
    const name = req.query.name || 'Test AFARIS';
    if (!to) return res.status(400).send('Paramètre "to" manquant ex: ?to=mail@exemple.com');

    const id = `AFR-TEST-${Date.now()}`;
    const amount = type === 'vip' ? 40 : 25;
    const payload = { id, email: to, name, amount, type, issuedAt: Date.now(), source: 'test-get' };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
    const ticket = { id, email: to, name, amount, type, method: 'test', status: 'valid', jwt: token, createdAt: Date.now() };

    // réutilise ton template + QR
    const htmlTemplate = fs.readFileSync(path.join(__dirname, 'ticketTemplate.html'), 'utf8');
    const qrDataUrl = await QRCode.toDataURL(ticket.jwt);
    const html = htmlTemplate
      .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
      .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
      .replace(/{{NAME}}/g, ticket.name)
      .replace(/{{TICKET_ID}}/g, ticket.id)
      .replace(/{{TICKET_TYPE}}/g, ticket.type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard (sans menu)')
      .replace(/{{QR_DATA_URL}}/g, qrDataUrl);

    await transporter.sendMail({
      from: ORGANIZER_EMAIL || SMTP_USER,
      to,
      subject: `[${EVENT_NAME}] Votre billet – ${ticket.id}`,
      html,
    });

    res.send(`OK, billet envoyé à ${to} (id=${id})`);
  } catch (e) {
    console.error('❌ Test billet GET error:', e);
    res.status(500).send('Erreur: ' + (e.message || e));
  }
});

// ------------------ Start ------------------
app.listen(PORT, () =>
  console.log('AFARIS all-in-one running on port', PORT)
);
