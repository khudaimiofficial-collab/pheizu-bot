'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

const WEBSITE_URL = 'https://pheizuofficialstore.myvipsite.fun/admin/settings.php';
const API_SECRET = 'PHEIZU_SECRET_123'; 
const BOT_NAME = 'Pheizu Store';

const logger = pino({ level: 'warn' });
let sock = null;

async function sendToWebsite(data) {
  try {
    await fetch(`${WEBSITE_URL}?api=bot&secret=${API_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) { console.log('Website offline'); }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Send QR Code directly to website
    if (qr && !sock.authState.creds.registered) {
      console.log(`[bot] New QR Code generated. Sending to website...`);
      await sendToWebsite({ status: 'qr', qr: qr });
    }

    if (connection === 'open') {
      console.log('[bot] Connected!');
      await sendToWebsite({ status: 'connected' });
      startPollingWebsite();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        startBot();
      }
    }
  });
}

function startPollingWebsite() {
  setInterval(async () => {
    try {
      const res = await fetch(`${WEBSITE_URL}?api=otp&action=get&secret=${API_SECRET}`);
      const json = await res.json();

      if (json.status === 'success' && json.data) {
        const { id, phone, otp } = json.data;
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: `*${BOT_NAME}*\n\nYour OTP is: *${otp}*` });
        await fetch(`${WEBSITE_URL}?api=otp&action=mark&id=${id}&secret=${API_SECRET}`);
        console.log(`[bot] Sent OTP to +${phone}`);
      }
    } catch (err) {}
  }, 5000); 
}

startBot();
