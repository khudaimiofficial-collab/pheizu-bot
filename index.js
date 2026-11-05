'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

// ---------- CONFIGURATION ----------
const SEND_OTP_URL = 'https://pheizuofficialstore.myvipsite.fun/send_otp.php';
const API_SECRET = 'PHEIZU_SECRET_123'; 
const BOT_NAME = 'Pheizu Store';

// If you want to send the QR code to your admin settings page:
const SETTINGS_PAGE_URL = 'https://pheizuofficialstore.myvipsite.fun/admin/settings.php';

const logger = pino({ level: 'warn' });
let sock = null;

// Helper to call the PHP API
async function callApi(action, data = {}) {
    try {
        const res = await fetch(`${SEND_OTP_URL}?action=${action}&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await res.json();
    } catch (e) {
        console.log('API Error:', e.message);
        return { status: 'error' };
    }
}

// Helper to send QR to the settings page
async function sendQrToSettings(qr) {
    try {
        await fetch(`${SETTINGS_PAGE_URL}?api=bot&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'qr', qr: qr })
        });
    } catch (e) {
        console.log('Could not send QR to settings page (network error).');
    }
}

async function startBot() {
    // Save session to the './auth' folder
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false, // We send it to the website instead
        browser: Browsers.ubuntu('Chrome'),
    });

    sock.ev.on('creds.update', saveCreds);

    // --- CONNECTION UPDATE ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // If a QR code is generated and we are not registered yet
        if (qr && !sock.authState.creds.registered) {
            console.log(`[bot] QR Code generated. Sending to settings.php...`);
            await sendQrToSettings(qr);
        }

        if (connection === 'open') {
            console.log('[bot] Connected to WhatsApp successfully!');
            try {
                await fetch(`${SETTINGS_PAGE_URL}?api=bot&secret=${API_SECRET}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'connected' })
                });
            } catch (e) {}
            
            // Start checking the website for pending OTPs
            startPollingWebsite();
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            
            console.log(`[bot] Connection closed (code=${code})${loggedOut ? ' - LOGGED OUT' : ''}`);
            
            if (!loggedOut) {
                console.log('[bot] Reconnecting...');
                startBot();
            } else {
                console.log('[bot] You need to scan a new QR code.');
            }
        }
    });

    // --- INCOMING WHATSAPP MESSAGES (!otp, !verify) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const jid = msg.key.remoteJid;

        // Command: !otp 9876543210
        if (text.startsWith('!otp ')) {
            const phone = text.split(' ')[1];
            const res = await callApi('request', { phone });
            await sock.sendMessage(jid, { 
                text: res.status === 'success' 
                    ? `✅ OTP requested! It will arrive in a moment.` 
                    : `❌ ${res.message}` 
            }, { quoted: msg });
        }

        // Command: !verify 9876543210 123456
        if (text.startsWith('!verify ')) {
            const args = text.split(' ');
            const phone = args[1];
            const otp = args[2];
            const res = await callApi('verify', { phone, otp });
            await sock.sendMessage(jid, { 
                text: res.status === 'success' 
                    ? `✅ Phone Verified Successfully!` 
                    : `❌ ${res.message}` 
            }, { quoted: msg });
        }
    });
}

// --- BACKGROUND LOOP: Checks if your website requested an OTP ---
function startPollingWebsite() {
    setInterval(async () => {
        const res = await callApi('fetch');
        
        if (res.status === 'success' && res.data) {
            const { id, phone, otp } = res.data;
            const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

            console.log(`[bot] Found pending OTP for +${phone}. Sending...`);

            try {
                // Send the OTP message
                await sock.sendMessage(jid, { 
                    text: `*${BOT_NAME}*\n\nYour verification code is: *${otp}*\n\nValid for 10 minutes. Do not share this code.` 
                });
                
                // Mark it as sent in the database so it doesn't send again
                await callApi('mark_sent', { id });
                console.log(`[bot] Successfully sent OTP to +${phone}`);

            } catch (err) {
                console.log(`[bot] Failed to send to +${phone}:`, err.message);
                // Mark as sent anyway so it doesn't get stuck in a loop
                await callApi('mark_sent', { id });
            }
        }
    }, 5000); // Check every 5 seconds
}

// Start the bot
startBot();
