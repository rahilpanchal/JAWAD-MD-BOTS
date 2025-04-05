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
                console.log(`♻️ Loaded ${this.messageCache.size} messages from database`);
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
    const isOwner = m.sender === Matrix.user.id;
    const prefix = config.PREFIX;
    const [cmd, subCmd] = m.body?.slice(prefix.length).trim().split(/ +/).map(s => s.toLowerCase()) || [];

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
        if (!isOwner) {
            await m.reply('🚫 *You are not authorized to use this command!*');
            return;
        }

        const mode = config.ANTI_DELETE_PATH === "same" ? 
            "🔄 *Same Chat Mode*" : 
            "📨 *Inbox Mode*";

        const responses = {
            on: `━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Status:* 🟢 ENABLED\n┃◈┃• *Mode:* ${mode}\n┃◈┃• *Cache:* 5 minutes\n┃◈╰─────────────·๏\n┃◈• Deleted messages will be recovered!`,
            off: `━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Status:* 🔴 DISABLED\n┃◈┃• *Cache:* Cleared\n┃◈╰─────────────·๏\n┃◈• System is now inactive`,
            status: `━━〔 *ANTI-DELETE STATUS* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *State:* ${antiDelete.enabled ? '🟢 ACTIVE' : '🔴 INACTIVE'}\n┃◈┃• *Mode:* ${mode}\n┃◈┃• *Messages in cache:* ${antiDelete.messageCache.size}\n┃◈╰─────────────·๏`
        };

        try {
            if (subCmd === 'on') {
                antiDelete.enabled = true;
                await m.reply(responses.on);
            } 
            else if (subCmd === 'off') {
                antiDelete.enabled = false;
                antiDelete.messageCache.clear();
                await m.reply(responses.off);
            }
            else {
                await m.reply(responses.status);
            }
            await m.React(antiDelete.enabled ? '✅' : '❌');
        } catch (error) {
            console.error('⚠️ Command error:', error);
            await m.React('❌');
        }
        return;
    }

    /* Message Processing */
    Matrix.ev.on('messages.upsert', async ({ messages }) => {
        if (!antiDelete.enabled) return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message) continue;

            try {
                const content = msg.message.conversation || 
                    msg.message.extendedTextMessage?.text ||
                    Object.values(msg.message).find(m => m?.caption)?.caption;

                let media, mediaType;
                for (const type of ['image', 'video', 'audio', 'document']) {
                    if (msg.message[`${type}Message`]) {
                        const stream = await downloadContentFromMessage(msg.message[`${type}Message`], type);
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

        for (const update of updates) {
            try {
                const { key, update: updateData } = update;
                if (!updateData?.messageStubType === proto.WebMessageInfo.StubType.REVOKE || 
                    !antiDelete.messageCache.has(key.id)) continue;

                const msg = antiDelete.messageCache.get(key.id);
                const destination = config.ANTI_DELETE_PATH === "same" ? key.remoteJid : Matrix.user.id;

                const alertMsg = [
                    `━━〔 *ANTI-DELETE ALERT* 〕━━┈⊷`,
                    `┃◈╭─────────────·๏`,
                    `┃◈┃• *Type:* ${msg.type ? msg.type.toUpperCase() : 'TEXT'}`,
                    `┃◈┃• *Sender:* @${formatJid(msg.sender)}`,
                    `┃◈┃• *Deleted by:* @${formatJid(updateData.participant || key.participant)}`,
                    `┃◈┃• *Time:* ${formatTime(msg.timestamp)}`,
                    `┃◈╰─────────────·๏`
                ].join('\n');

                if (msg.media) {
                    await Matrix.sendMessage(destination, {
                        [msg.type]: msg.media,
                        caption: alertMsg,
                        mentions: [msg.sender, updateData.participant || key.participant].filter(Boolean)
                    });
                } else {
                    await Matrix.sendMessage(destination, {
                        text: `${alertMsg}\n┃◈• *Content:*\n${msg.content}`,
                        mentions: [msg.sender, updateData.participant || key.participant].filter(Boolean)
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
