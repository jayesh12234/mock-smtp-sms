'use strict';

const { SMTPServer } = require('smtp-server');
const simpleParser = require('mailparser').simpleParser;
const WebSocket = require('ws');
const express = require('express');
const path = require('path');

const SMTP_SERVER_PORT = parseInt(process.env.SMTP_SERVER_PORT || '8025', 10);
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '8080', 10);
const WS_SERVER_PORT = parseInt(process.env.WS_SERVER_PORT || '8081', 10);
const SERVER_HOST = process.env.SERVER_HOST || '0.0.0.0';
const WS_EX_PROTOCOL = process.env.WS_EX_PROTOCOL || 'ws';
const WS_EX_SERVER_PORT = process.env.WS_EX_SERVER_PORT || '8081';
const WS_EX_BASE_PATH = process.env.WS_EX_BASE_PATH || '';
const MESSAGE_STORE_MAX = parseInt(process.env.MESSAGE_STORE_MAX || '500', 10);
const WS_HEARTBEAT_MS = parseInt(process.env.WS_HEARTBEAT_MS || '30000', 10);
const INDEX = path.join(__dirname, 'index.html');

let messageIdSeq = 0;
const messageStore = [];
let serversReady = false;

const smtp_server = new SMTPServer({
    logger: false,
    banner: 'SMTP mock server, use UI to to check the actual message',
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: 25 * 1024 * 1024,

    onData(stream, session, callback) {
        simpleParser(stream, {
            skipHtmlToText: false,
            skipImageLinks: false,
            skipTextToHtml: false,
            skipTextLinks: false,
            keepCidLinks: true,
        })
            .then((parsed) => {
                const payload = toOtpListenerMessage(parsed);
                const toLabel = payload.to && payload.to.text ? payload.to.text : '';
                console.log('[MAIL]', payload.subject, '->', toLabel);
                storeAndBroadcast(payload);
            })
            .catch((err) => {
                console.log('Error parsing mail:', err.message || err);
            });

        stream.on('end', () => {
            callback(null);
        });

        stream.on('error', (err) => {
            console.log('Error reading mail stream:', err.message || err);
            callback(err);
        });
    },
});

smtp_server.on('error', (err) => {
    console.log('Error: SMTP Error occurred');
    console.log(err);
});

const http_server = express();

http_server.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

http_server.get('/ready', (req, res) => {
    if (serversReady) {
        res.status(200).json({ status: 'ready', clients: socketServer.clients.size });
    } else {
        res.status(503).json({ status: 'starting' });
    }
});

http_server.get('/', (req, res) => {
    res.sendFile(INDEX);
});

http_server.get('/config', (req, res) => {
    res.json({
        wsProtocol: WS_EX_PROTOCOL,
        wsPort: WS_EX_SERVER_PORT,
        basePath: WS_EX_BASE_PATH,
    });
});

http_server.get('/messages', (req, res) => {
    const since = parseInt(req.query.since || '0', 10);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), MESSAGE_STORE_MAX);
    const items = messageStore
        .filter((m) => m.id > since)
        .slice(-limit);
    res.json({ count: items.length, messages: items });
});

http_server.delete('/messages', (req, res) => {
    messageStore.length = 0;
    messageIdSeq = 0;
    res.sendStatus(204);
});

http_server.get('/sendsms', (req, res) => {
    try {
        const message = {
            type: 'SMS',
            date: new Date(),
            to: { text: req.query.mobiles || '' },
            from: { text: req.query.sender || '' },
            subject: 'SMS: ' + (req.query.message || ''),
            text: req.query.message || '',
            html: '',
            messageId: '',
            cc: undefined,
            attachments: [],
            headerLines: [],
            headers: {},
        };
        console.log('[SMS]', message.text, '->', message.to.text);
        storeAndBroadcast(message);
        res.sendStatus(200);
    } catch (error) {
        console.log('Error: SMS Error occurred');
        console.log(error);
        res.sendStatus(500);
    }
});

const socketServer = new WebSocket.Server({
    port: WS_SERVER_PORT,
    host: SERVER_HOST,
});

function heartbeat() {
    this.isAlive = true;
}

socketServer.on('connection', (socketClient) => {
    console.log('WebSocket connected, clients:', socketServer.clients.size);
    socketClient.isAlive = true;
    socketClient.on('pong', heartbeat);

    socketClient.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg && typeof msg.since === 'number') {
                replayToClient(socketClient, msg.since);
            }
        } catch (_) {
            // ignore non-JSON client messages
        }
    });

    socketClient.on('close', () => {
        console.log('WebSocket closed, clients:', socketServer.clients.size);
    });
});

setInterval(() => {
    socketServer.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, WS_HEARTBEAT_MS);

// Payload must match io.mosip.testrig.apirig.otp.Root (Jackson) — only these fields:
// attachments, headerLines, headers, from, html, subject, text, date, cc, messageId, to, type
function toOtpListenerMessage(parsed) {
    return {
        type: 'MAIL',
        date: parsed.date || new Date(),
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject || '',
        text: parsed.text || '',
        html: parsed.html || '',
        messageId: parsed.messageId || '',
        attachments: parsed.attachments || [],
        headerLines: parsed.headerLines || [],
        headers: parsed.headers || {},
    };
}

function toWebSocketPayload(message) {
    const payload = Object.assign({}, message);
    delete payload.id;
    return payload;
}

function storeMessage(payload) {
    const stored = Object.assign({}, payload, { id: ++messageIdSeq });
    messageStore.push(stored);
    while (messageStore.length > MESSAGE_STORE_MAX) {
        messageStore.shift();
    }
    return stored;
}

function storeAndBroadcast(payload) {
    const stored = storeMessage(payload);
    broadCast(stored);
}

function broadCast(message) {
    const data = safeStringify(toWebSocketPayload(message));
    if (!data) {
        return;
    }
    socketServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(data);
            } catch (err) {
                console.log('WebSocket send error:', err.message || err);
            }
        }
    });
}

function safeStringify(message) {
    try {
        return JSON.stringify(message);
    } catch (err) {
        console.log('Error serializing message:', err.message || err);
        return null;
    }
}

function replayToClient(client, sinceId) {
    messageStore
        .filter((m) => m.id > sinceId)
        .forEach((m) => {
            const data = safeStringify(toWebSocketPayload(m));
            if (data && client.readyState === WebSocket.OPEN) {
                try {
                    client.send(data);
                } catch (err) {
                    console.log('WebSocket replay error:', err.message || err);
                }
            }
        });
}

smtp_server.listen(SMTP_SERVER_PORT, SERVER_HOST, () => {
    console.log(`SMTP Server Running on ${SERVER_HOST}:${SMTP_SERVER_PORT}`);
});

http_server.listen(SERVER_PORT, SERVER_HOST, () => {
    console.log(`HTTP Server Running on http://${SERVER_HOST}:${SERVER_PORT}`);
    serversReady = true;
});

socketServer.on('listening', () => {
    console.log(`WebSocket Server Running on ws://${SERVER_HOST}:${WS_SERVER_PORT}`);
});
