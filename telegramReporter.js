import "dotenv/config";
import axios from 'axios';

export async function sendTelegramNotification(message) {
    
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.error("[Telegram Reporter] Variabel .env Telegram tidak diset. Notifikasi dilewati.");
        return;
    }

    let textToSend = message;

    const walletAddressRegex = /\b0x[a-fA-F0-9]{40}\b/g;
    if (typeof textToSend === 'string') { // Pastikan textToSend adalah string
        textToSend = textToSend.replace(walletAddressRegex, (match) => {
            if (match.length === 42) {
                const firstPart = match.substring(0, 4); // Ambil 4 karakter pertama (misal "0x12")
                const lastPart = match.substring(match.length - 4); // Ambil 4 karakter terakhir
                return `${firstPart}...${lastPart}`;
            }
            return match;
        });

        const shortstringsToCensor = [
            "privateKey",       // Contoh, meskipun sebaiknya tidak pernah ada di log
            "mnemonicPhrase",   // Contoh
            "secretToken",      // Contoh
            "PRIVATE_KEY",      // Jika env var bocor ke string pesan (jarang terjadi jika kode baik)
        ];

        shortstringsToCensor.forEach(keyword => {
            const keywordRegex = new RegExp(`\\b${keyword}\\b`, 'gi');
            textToSend = textToSend.replace(keywordRegex, '[RAHASIA]');
        });
    } else {
        console.warn("[Telegram Reporter] Pesan yang diterima bukan string, tidak dapat disensor:", textToSend);
        textToSend = String(textToSend); // Konversi paksa ke string agar tidak error saat kirim
    }


    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    try {
        await axios.post(url, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: textToSend, // Gunakan pesan yang sudah disensor
            parse_mode: 'Markdown'
        });
        console.log("[Telegram Reporter] Notifikasi Telegram berhasil terkirim (setelah sensor).");
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[Telegram Reporter] Gagal mengirim notifikasi Telegram: ${errorMessage}`);
    }
}
