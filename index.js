'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

// ---------- CONFIGURATION (Pulled from GitHub Secrets) ----------
const SEND_OTP_URL = process.env.SEND_OTP_URL;
const API_SECRET = process.env.API_SECRET; 
const BOT_NAME = 'Pheizu Store';
const SETTINGS_PAGE_URL = process.env.SETTINGS_PAGE_URL;

const logger = pino({ level: 'warn' });
let sock = null;
let qrSent = false; 

async function callApi(action, data = {}) {
    try {
        const res = await fetch(`${SEND_OTP_URL}?action=${action}&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await res.json();
    } catch (e) {
        return { status: 'error' };
    }
}

async function sendStatusToSettings(status, data = {}) {
    try {
        await fetch(`${SETTINGS_PAGE_URL}?api=bot&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status, ...data })
        });
    } catch (e) {}
}

async function startBot() {
    const hasSession = fs.existsSync('./auth/creds.json');
    
    if (hasSession) {
        await sendStatusToSettings('connecting');
    }

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

        if (qr && !sock.authState.creds.registered && !qrSent) {
            qrSent = true; 
            await sendStatusToSettings('qr', { qr: qr });
        }

        if (connection === 'open') {
            qrSent = false; 
            await sendStatusToSettings('connected');
            startPollingWebsite();
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                qrSent = false; 
                startBot();
            } else {
                await sendStatusToSettings('disconnected');
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const jid = msg.key.remoteJid;

        if (text.startsWith('!otp ')) {
            const phone = text.split(' ')[1];
            const res = await callApi('request', { phone });
            await sock.sendMessage(jid, { text: res.status === 'success' ? `✅ OTP requested!` : `❌ ${res.message}` }, { quoted: msg });
        }

        if (text.startsWith('!verify ')) {
            const args = text.split(' ');
            const res = await callApi('verify', { phone: args[1], otp: args[2] });
            await sock.sendMessage(jid, { text: res.status === 'success' ? `✅ Verified!` : `❌ ${res.message}` }, { quoted: msg });
        }
    });
}

function startPollingWebsite() {
    setInterval(async () => {
        const res = await callApi('fetch');
        if (res.status === 'success' && res.data) {
            const { id, phone, otp } = res.data;
            const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

            try {
                await sock.sendMessage(jid, { text: `*${BOT_NAME}*\n\nYour verification code is: *${otp}*\n\nValid for 10 minutes.` });
                await callApi('mark_sent', { id });
            } catch (err) {
                await callApi('mark_sent', { id });
            }
        }
    }, 5000);
}

startBot();
