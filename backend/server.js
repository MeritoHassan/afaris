require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const {
  saveTicketRecord,
  getTicketRecord,
  computeHash,
  updateTicketStatus,
  SUPABASE_ENABLED,
} = require('./utils/ticketsStore');

const app = express();

if (!SUPABASE_ENABLED) {
  console.warn('⚠️ Supabase non configuré → stockage des tickets en mode fallback local');
}

// ---------- CORS configuration ----------
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsMiddleware = corsAllowedOrigins.length
  ? cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (
          corsAllowedOrigins.includes(origin) ||
          origin === 'http://localhost' ||
          origin === 'http://127.0.0.1' ||
          origin === `http://localhost:${PORT}` ||
          origin === `http://127.0.0.1:${PORT}`
        ) {
          return callback(null, true);
        }
        return callback(new Error(`Origin not allowed by CORS: ${origin}`));
      },
    })
  : cors(); // fallback permissif en local si aucune liste fournie

app.use(corsMiddleware);
app.use(bodyParser.json());

// ---------- ENV ----------
const {
  PORT = 4000,
  HOST = '0.0.0.0',
  EVENT_NAME = 'Soirée AFARIS – Décembre 2025',
  EVENT_DATE = '2025-12-27',
  ORGANIZER_EMAIL = 'billets@afaris.com',
  JWT_SECRET = 'dev_secret',

  PAYPAL_ENV = 'sandbox',
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,

  FROM_EMAIL,
  BREVO_API_KEY,
  ENABLE_TEST_TICKETS = 'true',
} = process.env;

const PAYPAL_BASE_URL =
  PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const TICKET_PRICES = Object.freeze({
  standard: 30,
  vip: 45,
});

const TEST_TICKETS_ENABLED = String(ENABLE_TEST_TICKETS).toLowerCase() === 'true';

// ---------- Stores mémoire ----------
const tickets = new Map(); // billets émis
const pendingOrders = new Map(); // commandes PayPal en attente de capture
const completedOrders = new Map(); // commande PayPal -> tickets émis (idempotence)

// ---------- Email (Brevo via API) ----------
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const EMAILS_ENABLED = Boolean(FROM_EMAIL && BREVO_API_KEY);

if (!EMAILS_ENABLED) {
  console.warn('📭 BREVO_API_KEY ou FROM_EMAIL manquant → e-mails désactivés');
}

async function sendEmailHTML(to, subject, html, attachments = []) {
  if (!EMAILS_ENABLED) throw new Error('EMAIL_DISABLED');

  try {
    const payload = {
      sender: {
        email: FROM_EMAIL,
        name: EVENT_NAME,
      },
      to: [
        {
          email: to,
        },
      ],
      replyTo: ORGANIZER_EMAIL ? { email: ORGANIZER_EMAIL } : undefined,
      subject,
      htmlContent: html,
    };

    if (attachments.length) {
      payload.attachment = attachments.map((att) => ({
        name: att.name,
        content: att.content,
        type: att.contentType || 'application/octet-stream',
      }));
    }

    await axios.post(BREVO_API_URL, payload, {
      headers: {
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      timeout: 20000,
    });
  } catch (err) {
    const message = err.response?.data || err.message || err;
    console.error('❌ Envoi e-mail Brevo échoué :', message);
    throw new Error('EMAIL_DISABLED');
  }
}

async function sendTicketEmail(to, ticket) {
  const templatePath = path.join(__dirname, 'ticketTemplate.html');
  const htmlTpl = fs.readFileSync(templatePath, 'utf8');
  const qrPngBuffer = await QRCode.toBuffer(ticket.jwt, { width: 300, margin: 1 });
  const qrBase64 = qrPngBuffer.toString('base64');
  const qrDataUrl = `data:image/png;base64,${qrBase64}`;

  const html = htmlTpl
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, ticket.name)
    .replace(/{{TICKET_ID}}/g, ticket.id)
    .replace(/{{TICKET_TYPE}}/g, ticket.type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard (sans menu)')
    .replace(/{{QR_DATA_URL}}/g, qrDataUrl);

  return sendEmailHTML(
    to,
    `[${EVENT_NAME}] Votre billet – ${ticket.id}`,
    html,
    [
      {
        name: `ticket-${ticket.id}.png`,
        content: qrBase64,
        contentType: 'image/png',
      },
    ]
  );
}

// ---------- PayPal helpers ----------
let paypalToken = null;
let paypalTokenExpiry = 0;

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new Error('PAYPAL_NOT_CONFIGURED');
  }

  const now = Date.now();
  if (paypalToken && now < paypalTokenExpiry) {
    return paypalToken;
  }

  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');

  const response = await axios({
    method: 'post',
    url: `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    data: 'grant_type=client_credentials',
  });

  paypalToken = response.data.access_token;
  paypalTokenExpiry = now + (Number(response.data.expires_in || 0) - 60) * 1000;
  return paypalToken;
}

function getTicketPrice(type) {
  return TICKET_PRICES[type] ?? null;
}

function issueTicket({ name, email, ticketType, amount, orderId, captureId }) {
  const id = `AFR-${new Date().getFullYear()}-${uuidv4().slice(0, 8).toUpperCase()}`;
  const payload = {
    id,
    name,
    email,
    type: ticketType,
    amount,
    issuedAt: Date.now(),
    orderId,
    captureId,
  };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });

  const hash = computeHash(email, id, ticketType);
  const ticket = {
    ...payload,
    status: 'valid',
    jwt: token,
    hash,
  };

  tickets.set(id, ticket);
  saveTicketRecord(ticket);
  return ticket;
}

// ---------- API ----------
app.get('/api/config', (_req, res) => {
  res.json({
    event: { name: EVENT_NAME, date: EVENT_DATE },
    paypalClientId: PAYPAL_CLIENT_ID || null,
    currency: 'EUR',
    emailsEnabled: EMAILS_ENABLED,
  });
});

app.get('/admin/api/me', (_req, res) => {
  res.status(204).end();
});

app.get('/api/smtp-check', (_req, res) => {
  res.json({
    emailsEnabled: EMAILS_ENABLED,
    provider: EMAILS_ENABLED ? 'brevo' : null,
    from: EMAILS_ENABLED ? FROM_EMAIL : null,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    paypal: !!PAYPAL_CLIENT_ID && !!PAYPAL_SECRET,
    emails: EMAILS_ENABLED,
  });
});

app.post('/api/test/generate-ticket', async (req, res) => {
  if (!TEST_TICKETS_ENABLED) {
    return res.status(403).json({ error: 'TEST_ENDPOINT_DISABLED' });
  }

  const name = String(req.body.name || '').trim();
  const rawEmail = String(req.body.email || '').trim();
  const ticketTypeRaw = String(req.body.ticketType || 'standard').toLowerCase();
  const ticketType = ticketTypeRaw === 'vip' ? 'vip' : 'standard';

  if (!name || !rawEmail) {
    return res.status(400).json({ error: 'CHAMPS_MANQUANTS' });
  }

  const amount = getTicketPrice(ticketType);
  if (!amount) {
    return res.status(400).json({ error: 'TYPE_BILLET_INVALIDE' });
  }

  try {
    const ticket = issueTicket({
      name,
      email: rawEmail,
      ticketType,
      amount,
      orderId: 'TEST-MANUAL',
      captureId: null,
    });

    let emailSent = false;
    if (EMAILS_ENABLED) {
      try {
        await sendTicketEmail(rawEmail, ticket);
        emailSent = true;
      } catch (mailErr) {
        console.error('test ticket email error:', mailErr.message);
      }
    }

    res.json({ ok: true, ticketId: ticket.id, emailSent });
  } catch (err) {
    console.error('test generate ticket error:', err.message);
    res.status(500).json({ error: 'TICKET_TEST_FAILED' });
  }
});

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const ticketTypeRaw = String(req.body.ticketType || '').trim().toLowerCase();
    const ticketsInput = req.body.tickets || {};

    if (!name || !email) {
      return res.status(400).json({ error: 'CHAMPS_MANQUANTS' });
    }

    const parseQty = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.floor(n));
    };

    let standardQty = parseQty(ticketsInput.standard);
    let vipQty = parseQty(ticketsInput.vip);

    if (standardQty === 0 && vipQty === 0) {
      standardQty = parseQty(req.body.standardQty);
      vipQty = parseQty(req.body.vipQty);
    }

    if (standardQty === 0 && vipQty === 0) {
      if (ticketTypeRaw === 'vip') vipQty = 1;
      else standardQty = 1;
    }

    const totalQty = standardQty + vipQty;
    if (!totalQty) {
      return res.status(400).json({ error: 'AUCUN_BILLET' });
    }

    const amount = standardQty * TICKET_PRICES.standard + vipQty * TICKET_PRICES.vip;

    const accessToken = await getPayPalAccessToken();
    const payload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `AF-${Date.now()}`,
          amount: {
            currency_code: 'EUR',
            value: amount.toFixed(2),
          },
          description: `${EVENT_NAME} - Billets (${standardQty} standard, ${vipQty} vip)`,
        },
      ],
    };

    const response = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders`, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const orderId = response.data.id;
    pendingOrders.set(orderId, {
      name,
      email,
      amount,
      items: {
        standard: standardQty,
        vip: vipQty,
      },
      totalQty,
      ticketType: totalQty === 1 ? (vipQty ? 'vip' : 'standard') : null,
      createdAt: Date.now(),
    });

    res.json({ id: orderId });
  } catch (err) {
    console.error('create-order error:', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'PAYPAL_CREATE_FAILED' });
  }
});

app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const orderId = String(req.body.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'ORDERID_MANQUANT' });

    if (completedOrders.has(orderId)) {
      const previous = completedOrders.get(orderId);
      return res.json({ ok: true, ...previous });
    }

    const meta = pendingOrders.get(orderId);
    if (!meta) return res.status(404).json({ error: 'ORDER_INCONNUE' });

    const accessToken = await getPayPalAccessToken();
    const captureResp = await axios.post(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const capture = captureResp.data?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture || capture.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'PAIEMENT_NON_CAPTURE' });
    }

    pendingOrders.delete(orderId);

    pendingOrders.delete(orderId);

    const items = meta.items || {
      standard: meta.ticketType === 'vip' ? 0 : 1,
      vip: meta.ticketType === 'vip' ? 1 : 0,
    };

    const ticketsIssued = [];
    const ticketIds = [];

    const addTickets = (type, qty) => {
      const unitPrice = TICKET_PRICES[type];
      if (!unitPrice || qty <= 0) return;
      for (let i = 0; i < qty; i += 1) {
        const ticket = issueTicket({
          name: meta.name,
          email: meta.email,
          ticketType: type,
          amount: unitPrice,
          orderId,
          captureId: capture.id,
        });
        ticketsIssued.push(ticket);
        ticketIds.push(ticket.id);
      }
    };

    addTickets('standard', Number(items.standard) || 0);
    addTickets('vip', Number(items.vip) || 0);

    if (!ticketIds.length) {
      addTickets(meta.ticketType === 'vip' ? 'vip' : 'standard', 1);
    }

    let emailsSent = 0;
    if (EMAILS_ENABLED) {
      for (const ticket of ticketsIssued) {
        try {
          await sendTicketEmail(meta.email, ticket);
          emailsSent += 1;
        } catch (mailErr) {
          console.error('ticket email error:', mailErr.message);
        }
      }
    } else {
      console.warn('Email non envoyé (Brevo API inactif)');
    }

    const payload = {
      ticketIds,
      emailsSent,
      emailSent: EMAILS_ENABLED && emailsSent === ticketsIssued.length,
    };

    completedOrders.set(orderId, payload);

    res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('capture-order error:', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'PAYPAL_CAPTURE_FAILED' });
  }
});

app.post('/api/validate', (req, res) => {
  try {
    const token = String(req.body.token || '');
    if (!token) return res.status(400).json({ ok: false, reason: 'TOKEN_MANQUANT' });

    const decoded = jwt.verify(token, JWT_SECRET);
    let ticket = tickets.get(decoded.id);
    const stored = getTicketRecord(decoded.id);

    if (!stored) {
      return res.status(404).json({ ok: false, reason: 'BILLET_INCONNU' });
    }

    const expectedHash = computeHash(stored.email, decoded.id, decoded.type || stored.type);
    if (!expectedHash || stored.hash !== expectedHash) {
      return res.status(400).json({ ok: false, reason: 'BILLET_HASH_INVALID' });
    }

    if (!ticket) {
      ticket = {
        id: decoded.id,
        email: stored.email,
        name: decoded.name || stored.email,
        type: decoded.type || stored.type,
        status: stored.status || 'valid',
      };
      tickets.set(decoded.id, ticket);
    }

    if (ticket.status === 'used' || stored.status === 'used') {
      return res.status(400).json({ ok: false, reason: 'BILLET_DEJA_UTILISE' });
    }

    ticket.status = 'used';
    tickets.set(ticket.id, ticket);
    updateTicketStatus(ticket.id, 'used');

    return res.json({
      ok: true,
      ticketId: ticket.id,
      name: ticket.name,
      type: ticket.type,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, reason: 'QR_INVALIDE_OU_EXPIRE' });
  }
});

// ---------- Static frontend (après API) ----------
const publicDir = path.join(__dirname, '..', 'public');
const scannerDir = path.join(__dirname, '..', 'scanner');

app.use('/scanner', express.static(scannerDir));
app.get('/scanner', (_req, res) => {
  res.sendFile(path.join(scannerDir, 'scanner.html'));
});
app.use('/', express.static(publicDir));

// ---------- Start ----------
app.listen(PORT, HOST, () => {
  console.log(
    `🚀 AFARIS backend sur ${HOST}:${PORT} (PayPal=${PAYPAL_CLIENT_ID ? 'on' : 'off'} | Emails=${
      EMAILS_ENABLED ? 'on' : 'off'
    })`
  );
});
