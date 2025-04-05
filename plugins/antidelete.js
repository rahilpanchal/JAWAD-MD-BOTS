import pkg from '@whiskeysockets/baileys';
const { proto, downloadContentFromMessage } = pkg;
import config from '../config.cjs';
import fs from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'database.json');

class AntiDeleteSystem {
    constructor() {
        this.enabled = config.ANTI_DELETE;
        this.cacheExpiry = 5 * 60 * 1000;
        this.cleanupInterval = setInterval(() => this.cleanExpiredMessages(), this.cacheExpiry);
        this.loadDatabase();
    }

    loadDatabase() {
        try {
            if (fs.existsSync(DB_FILE)) {
                const data = fs.readFileSync(DB_FILE, 'utf8');
                this.messageCache = new Map(JSON.parse(data));
            } else {
                this.messageCache = new Map();
            }
        } catch (error) {
            console.error('Error loading database:', error);
            this.messageCache = new Map();
        }
    }

    saveDatabase() {
        try {
            const data = JSON.stringify(Array.from(this.messageCache.entries()));
            fs.writeFileSync(DB_FILE, data);
        } catch (error) {
            console.error('Error saving database:', error);
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
        let changed = false;
        
        for (const [key, msg] of this.messageCache.entries()) {
            if (now - msg.timestamp > this.cacheExpiry) {
                this.messageCache.delete(key);
                changed = true;
            }
        }
        
        if (changed) this.saveDatabase();
    }

    formatTime(timestamp) {
        try {
            const date = new Date(timestamp);
            const options = {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true,
                timeZoneName: 'short'
            };
            
            return date.toLocaleString('en-US', options)
                .replace(/(\d+)(:\d+)(:\d+)\s(AM|PM)/, (match, h, m, s, period) => {
                    return `${h}${m} ${period}`;
                })
                .replace(/,/g, '');
        } catch (e) {
            console.error('Time formatting error:', e);
            return 'Unknown Time';
        }
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.saveDatabase();
    }
}

const antiDelete = new AntiDeleteSystem();

const AntiDelete = async (m, Matrix) => {
    const prefix = config.PREFIX;
    const botNumber = await Matrix.decodeJid(Matrix.user.id);
    const isCreator = [botNumber, config.OWNER_NUMBER + '@s.whatsapp.net'].includes(m.sender);
    const text = m.body?.slice(prefix.length).trim().split(' ') || [];
    const cmd = text[0]?.toLowerCase();
    const subCmd = text[1]?.toLowerCase();

    const formatJid = (jid) => jid ? jid.replace(/@s\.whatsapp\.net|@g\.us/g, '') : 'Unknown';
    
    const getChatInfo = async (jid) => {
        if (!jid) return { name: 'Unknown Chat', isGroup: false };
        
        if (jid.includes('@g.us')) {
            try {
                const groupMetadata = await Matrix.groupMetadata(jid);
                return {
                    name: groupMetadata?.subject || 'Unknown Group',
                    isGroup: true
                };
            } catch {
                return { name: 'Unknown Group', isGroup: true };
            }
        }
        return { name: 'Private Chat', isGroup: false };
    };

    if (cmd === 'antidelete') {
        if (!isCreator) {
            await m.reply('╭━━〔 *PERMISSION DENIED* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• You are not authorized!\n┃◈╰─────────────·๏\n╰━━━━━━━━━━━━━━━━┈⊷');
            return;
        }
        
        try {
            const mode = config.ANTI_DELETE_PATH === "same" ? "Same Chat" : 
                       config.ANTI_DELETE_PATH === "inbox" ? "Bot Inbox" : "Owner PM";
            const responses = {
                on: `╭━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *🛡️ Status:* Enabled\n┃◈┃• *🌍 Scope:* All Chats\n┃◈┃• *⏳ Cache:* 5 minutes\n┃◈┃• *📁 Mode:* ${mode}\n┃◈╰─────────────·๏\n╰━━━━━━━━━━━━━━━━┈⊷`,
                off: `╭━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *🛡️ Status:* Disabled\n┃◈┃• *⚠️ Cache Cleared*\n┃◈╰─────────────·๏\n╰━━━━━━━━━━━━━━━━┈⊷`,
                help: `╭━━〔 *ANTI-DELETE HELP* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *${prefix}antidelete on* - Enable\n┃◈┃• *${prefix}antidelete off* - Disable\n┃◈┃• *Status:* ${antiDelete.enabled ? '✅ Enabled' : '❌ Disabled'}\n┃◈┃• *Mode:* ${mode}\n┃◈╰─────────────·๏\n╰━━━━━━━━━━━━━━━━┈⊷`
            };

            if (subCmd === 'on') {
                antiDelete.enabled = true;
                await m.reply(responses.on);
            } 
            else if (subCmd === 'off') {
                antiDelete.enabled = false;
                antiDelete.messageCache.clear();
                antiDelete.saveDatabase();
                await m.reply(responses.off);
            }
            else {
                await m.reply(responses.help);
            }
            await m.React('✅');
            return;
        } catch (error) {
            console.error('AntiDelete Command Error:', error);
            await m.React('❌');
        }
    }

    Matrix.ev.on('messages.upsert', async ({ messages }) => {
        if (!antiDelete.enabled || !messages?.length) return;
        
        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message || msg.key.remoteJid === 'status@broadcast') continue;
            
            try {
                const content = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text ||
                              msg.message.imageMessage?.caption ||
                              msg.message.videoMessage?.caption ||
                              msg.message.documentMessage?.caption;

                let media, type, mimetype;
                
                const mediaTypes = ['image', 'video', 'audio', 'sticker', 'document'];
                for (const mediaType of mediaTypes) {
                    if (msg.message[`${mediaType}Message`]) {
                        const mediaMsg = msg.message[`${mediaType}Message`];
                        try {
                            const stream = await downloadContentFromMessage(mediaMsg, mediaType);
                            let buffer = Buffer.from([]);
                            for await (const chunk of stream) {
                                buffer = Buffer.concat([buffer, chunk]);
                            }
                            media = buffer;
                            type = mediaType;
                            mimetype = mediaMsg.mimetype;
                            break;
                        } catch (e) {
                            console.error(`Error downloading ${mediaType} media:`, e);
                        }
                    }
                }
                
                if (msg.message.audioMessage?.ptt) {
                    try {
                        const stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                        type = 'audio';
                        mimetype = msg.message.audioMessage.mimetype || 'audio/ogg; codecs=opus';
                    } catch (e) {
                        console.error('Error downloading voice message:', e);
                    }
                }
                
                if (content || media) {
                    antiDelete.addMessage(msg.key.id, {
                        content,
                        media,
                        type,
                        mimetype,
                        sender: msg.key.participant || msg.key.remoteJid,
                        senderFormatted: `@${formatJid(msg.key.participant || msg.key.remoteJid)}`,
                        timestamp: Date.now(),
                        chatJid: msg.key.remoteJid
                    });
                }
            } catch (error) {
                console.error('Error caching message:', error);
            }
        }
    });

    Matrix.ev.on('messages.update', async (updates) => {
        if (!antiDelete.enabled || !updates?.length) return;

        for (const update of updates) {
            try {
                const { key, update: updateData } = update;
                const isDeleted = updateData?.messageStubType === proto.WebMessageInfo.StubType.REVOKE || 
                                 updateData?.status === proto.WebMessageInfo.Status.DELETED;
                
                if (!isDeleted || key.fromMe || !antiDelete.messageCache.has(key.id)) continue;

                const cachedMsg = antiDelete.messageCache.get(key.id);
                antiDelete.deleteMessage(key.id);
                
                let destination;
                if (config.ANTI_DELETE_PATH === "same") {
                    destination = key.remoteJid;
                } else if (config.ANTI_DELETE_PATH === "inbox") {
                    destination = Matrix.user.id;
                } else {
                    destination = config.OWNER_NUMBER + '@s.whatsapp.net';
                }

                const chatInfo = await getChatInfo(cachedMsg.chatJid);
                const deletedBy = updateData?.participant ? 
                    `@${formatJid(updateData.participant)}` : 
                    (key.participant ? `@${formatJid(key.participant)}` : 'Unknown');

                const messageType = cachedMsg.type ? 
                    cachedMsg.type.charAt(0).toUpperCase() + cachedMsg.type.slice(1) : 
                    'Text';
                
                const baseInfo = `╭━━〔 *DELETED ${messageType}* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Sender:* ${cachedMsg.senderFormatted}\n┃◈┃• *Deleted By:* ${deletedBy}\n┃◈┃• *Chat:* ${chatInfo.name}${chatInfo.isGroup ? ' (Group)' : ''}\n┃◈┃• *Sent At:* ${antiDelete.formatTime(cachedMsg.timestamp)}\n┃◈┃• *Deleted At:* ${antiDelete.formatTime(Date.now())}\n┃◈╰─────────────·๏\n╰━━━━━━━━━━━━━━━━┈⊷`;

                if (cachedMsg.media) {
                    const messageOptions = {
                        [cachedMsg.type]: cachedMsg.media,
                        mimetype: cachedMsg.mimetype,
                        caption: baseInfo
                    };

                    if (cachedMsg.type === 'audio' && cachedMsg.mimetype?.includes('ogg')) {
                        messageOptions.ptt = true;
                        messageOptions.mimetype = 'audio/ogg; codecs=opus';
                    }

                    await Matrix.sendMessage(destination, messageOptions);
                } 
                else if (cachedMsg.content) {
                    await Matrix.sendMessage(destination, {
                        text: `${baseInfo}\n\n💬 *Content:* \n${cachedMsg.content}`
                    });
                }
            } catch (error) {
                console.error('Error handling deleted message:', error);
            }
        }
    });
};

export default AntiDelete;
