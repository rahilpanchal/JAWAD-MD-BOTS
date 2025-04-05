import pkg from '@whiskeysockets/baileys';
const { proto, downloadContentFromMessage } = pkg;
import config from '../config.cjs';
import fs from 'fs';
import path from 'path';

// Database Configuration
const DB_FILE = path.join(process.cwd(), 'database.json');

class AntiDeleteSystem {
    constructor() {
        this.enabled = config.ANTI_DELETE || false;
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.messageCache = new Map();
        this.loadDatabase();
        this.cleanupInterval = setInterval(() => this.cleanExpiredMessages(), this.cacheExpiry);
    }

    /* Database Methods */
    loadDatabase() {
        try {
            if (fs.existsSync(DB_FILE)) {
                const data = fs.readFileSync(DB_FILE, 'utf8');
                const parsed = JSON.parse(data);
                this.messageCache = new Map(parsed);
                console.log(`♻️ Loaded ${this.messageCache.size} cached messages`);
            }
        } catch (error) {
            console.error('🚨 Database load error:', error);
        }
    }

    saveDatabase() {
        try {
            const data = JSON.stringify(Array.from(this.messageCache.entries()));
            fs.writeFileSync(DB_FILE, data, 'utf8');
        } catch (error) {
            console.error('🚨 Database save error:', error);
        }
    }

    addMessage(key, message) {
        this.messageCache.set(key, message);
        this.saveDatabase();
    }

    deleteMessage(key) {
        if (this.messageCache.has(key)) {
            this.messageCache.delete(key);
            this.saveDatabase();
        }
    }

    cleanExpiredMessages() {
        const now = Date.now();
        for (const [key, msg] of this.messageCache.entries()) {
            if (now - msg.timestamp > this.cacheExpiry) {
                this.messageCache.delete(key);
            }
        }
        this.saveDatabase();
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.saveDatabase();
    }
}

const antiDelete = new AntiDeleteSystem();

const AntiDelete = async (m, Matrix) => {
    // Updated Authorization
    const botNumber = await Matrix.decodeJid(Matrix.user.id);
    const isCreator = [botNumber, config.OWNER_NUMBER + '@s.whatsapp.net'].includes(m.sender);
    const prefix = config.PREFIX;
    const cmd = m.body.startsWith(prefix) ? m.body.slice(prefix.length).split(' ')[0].toLowerCase() : '';
    const text = m.body.slice(prefix.length + cmd.length).trim();

    // Formatting Functions
    const formatJid = (jid) => jid?.replace(/@.+/, '') || 'Unknown';
    const formatTime = (timestamp) => new Date(timestamp).toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short'
    });

    // Command Handler
    if (cmd === 'antidelete') {
        if (!isCreator) return m.reply("*📛 THIS IS AN OWNER COMMAND*");
        
        const mode = config.ANTI_DELETE_PATH === "same" ? 
            "🔄 Same Chat" : "📨 Bot Inbox";

        if (text === 'on') {
            antiDelete.enabled = true;
            await m.reply(`━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Status:* 🟢 ENABLED\n┃◈┃• *Mode:* ${mode}\n┃◈╰─────────────·๏`);
        } 
        else if (text === 'off') {
            antiDelete.enabled = false;
            antiDelete.messageCache.clear();
            await m.reply(`━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Status:* 🔴 DISABLED\n┃◈╰─────────────·๏`);
        }
        else {
            await m.reply(`━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Usage:*\n┃◈┃• ${prefix}antidelete on\n┃◈┃• ${prefix}antidelete off\n┃◈┃• *Current Mode:* ${mode}\n┃◈╰─────────────·๏`);
        }
        await m.React(antiDelete.enabled ? '✅' : '❌');
        return;
    }

    /* Message Caching */
    Matrix.ev.on('messages.upsert', async ({ messages }) => {
        if (!antiDelete.enabled) return;

        for (const msg of messages.filter(m => !m.key.fromMe && m.message)) {
            try {
                const content = [
                    msg.message.conversation,
                    msg.message.extendedTextMessage?.text,
                    msg.message.imageMessage?.caption,
                    msg.message.videoMessage?.caption,
                    msg.message.documentMessage?.caption
                ].find(Boolean);

                let media, mediaType;
                for (const type of ['image', 'video', 'audio', 'document', 'sticker']) {
                    if (msg.message[`${type}Message`]) {
                        const mediaMsg = msg.message[`${type}Message`];
                        const stream = await downloadContentFromMessage(mediaMsg, type);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        media = buffer;
                        mediaType = type;
                        break;
                    }
                }

                if (content || media) {
                    antiDelete.addMessage(msg.key.id, {
                        content,
                        media,
                        type: mediaType,
                        sender: msg.key.participant || msg.key.remoteJid,
                        timestamp: Date.now(),
                        chatJid: msg.key.remoteJid
                    });
                }
            } catch (error) {
                console.error('⚠️ Cache error:', error);
            }
        }
    });

    /* Deletion Handler */
    Matrix.ev.on('messages.update', async updates => {
        if (!antiDelete.enabled) return;

        for (const { key, update } of updates.filter(u => 
            u.update?.messageStubType === proto.WebMessageInfo.StubType.REVOKE &&
            !u.key.fromMe &&
            antiDelete.messageCache.has(u.key.id)
        )) {
            try {
                const msg = antiDelete.messageCache.get(key.id);
                const destination = config.ANTI_DELETE_PATH === "same" 
                    ? key.remoteJid 
                    : Matrix.user.id;

                const alertMsg = [
                    `━━〔 *ANTI-DELETE ALERT ⚠️* 〕━━┈⊷`,
                    `┃◈╭─────────────·๏`,
                    `┃◈┃• *Type:* ${msg.type ? msg.type.toUpperCase() : 'TEXT'}`,
                    `┃◈┃• *Sender:* @${formatJid(msg.sender)}`,
                    `┃◈┃• *Deleted By:* @${formatJid(update.participant || key.participant)}`,
                    `┃◈┃• *Time:* ${formatTime(msg.timestamp)}`,
                    `┃◈╰─────────────·๏`
                ].join('\n');

                if (msg.media) {
                    await Matrix.sendMessage(destination, {
                        [msg.type]: msg.media,
                        caption: msg.type !== 'sticker' ? alertMsg : undefined,
                        mentions: [msg.sender, update.participant || key.participant].filter(Boolean)
                    });
                    if (msg.type === 'sticker') {
                        await Matrix.sendMessage(destination, { text: alertMsg });
                    }
                } else {
                    await Matrix.sendMessage(destination, {
                        text: `${alertMsg}\n┃◈• *Content:*\n${msg.content}`,
                        mentions: [msg.sender, update.participant || key.participant].filter(Boolean)
                    });
                }

                antiDelete.deleteMessage(key.id);
            } catch (error) {
                console.error('⚠️ Recovery error:', error);
            }
        }
    });
};

export default AntiDelete;
