/* ════════════════════════════════════════════════════
   server.js
   Mama's Kitchen — M-Pesa Daraja backend proxy

   This server holds all secrets and is the ONLY thing
   that talks to Safaricom's API. The frontend (browser)
   talks only to this server.
════════════════════════════════════════════════════ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const twilio = require('twilio');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_ENV,
  CALLBACK_BASE_URL,
  PORT
} = process.env;

const BASE_URL = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

/* ── In-memory store of payment results.
   For real production, replace with a database (e.g. Postgres, MongoDB). ── */
const paymentResults = {}; // { CheckoutRequestID: { status, resultCode, resultDesc, amount, phone } }

/* ════════════════════════════════════════════════════
   Helper: format phone to 2547XXXXXXXX
════════════════════════════════════════════════════ */
function formatPhoneKE(phone) {
  phone = String(phone).replace(/\s/g, '').replace(/\+/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  if (!phone.startsWith('254')) phone = '254' + phone;
  return phone;
}

/* ════════════════════════════════════════════════════
   Helper: get OAuth token from Safaricom
════════════════════════════════════════════════════ */
async function getAccessToken() {
  const credentials = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  return res.data.access_token;
}

/* ════════════════════════════════════════════════════
   Helper: build the Lipa Na M-Pesa password
════════════════════════════════════════════════════ */
function buildPassword() {
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp).toString('base64');
  return { password, timestamp };
}

/* ════════════════════════════════════════════════════
   ROUTE: POST /api/mpesa/stkpush
   Body: { phone, amount, accountRef, description }
════════════════════════════════════════════════════ */
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, accountRef, description } = req.body;
    if (!phone || !amount) {
      return res.status(400).json({ error: 'phone and amount are required' });
    }

    const token = await getAccessToken();
    const { password, timestamp } = buildPassword();
    const formattedPhone = formatPhoneKE(phone);

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: Math.ceil(amount),
      PartyA: formattedPhone,
      PartyB: process.env.MPESA_TILL_NUMBER,
      PhoneNumber: formattedPhone,
      CallBackURL: `${CALLBACK_BASE_URL}/api/mpesa/callback`,
      AccountReference: accountRef || 'MamasKitchen',
      TransactionDesc: description || 'Mama\'s Kitchen payment'
    };

    const stkRes = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    // Pre-register this CheckoutRequestID so the frontend can poll it
    if (stkRes.data.CheckoutRequestID) {
      paymentResults[stkRes.data.CheckoutRequestID] = {
        status: 'pending',
        phone: formattedPhone,
        amount
      };
    }

    res.json(stkRes.data);
  } catch (err) {
    console.error('STK Push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'STK push failed', details: err.response?.data || err.message });
  }
});

/* ════════════════════════════════════════════════════
   ROUTE: POST /api/mpesa/callback
   Safaricom calls THIS automatically once the user
   completes (or cancels) the payment on their phone.
════════════════════════════════════════════════════ */
app.post('/api/mpesa/callback', (req, res) => {
  console.log('M-Pesa callback received:', JSON.stringify(req.body, null, 2));

  const stkCallback = req.body?.Body?.stkCallback;
  if (stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

    let amount, mpesaReceipt, phone;
    if (CallbackMetadata?.Item) {
      amount = CallbackMetadata.Item.find(i => i.Name === 'Amount')?.Value;
      mpesaReceipt = CallbackMetadata.Item.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      phone = CallbackMetadata.Item.find(i => i.Name === 'PhoneNumber')?.Value;
    }

    paymentResults[CheckoutRequestID] = {
      status: ResultCode === 0 ? 'success' : 'failed',
      resultCode: ResultCode,
      resultDesc: ResultDesc,
      amount,
      mpesaReceipt,
      phone
    };
  }

  // Safaricom requires this exact acknowledgement response
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

/* ════════════════════════════════════════════════════
   ROUTE: GET /api/mpesa/status/:checkoutRequestId
   Frontend polls this to check if payment succeeded.
════════════════════════════════════════════════════ */
app.get('/api/mpesa/status/:checkoutRequestId', (req, res) => {
  const result = paymentResults[req.params.checkoutRequestId];
  if (!result) {
    return res.json({ status: 'pending' });
  }
  res.json(result);
});

/* ════════════════════════════════════════════════════
   ROUTE: POST /api/sms/send
   Proxies SMS sends through Africa's Talking (also
   needs to be server-side for the same secret-exposure
   reason as M-Pesa).
════════════════════════════════════════════════════ */
app.post('/api/sms/send', async (req, res) => {
  try {
    const { to, message } = req.body;

    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+${formatPhoneKE(to)}`
    });

    res.json({ status: 'success', sid: result.sid });
  } catch (err) {
    console.error('SMS error:', err.message);
    res.status(500).json({ error: 'SMS send failed', details: err.message });
  }
});

/* ── Health check (Render uses this to confirm the service is alive) ── */
app.get('/', (req, res) => res.send('Mama\'s Kitchen M-Pesa backend is running ✅'));

app.listen(PORT || 3000, () => {
  console.log(`Server running on port ${PORT || 3000}`);
});