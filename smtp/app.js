'use strict';

const { SMTPServer } = require('smtp-server');
const simpleParser = require('mailparser').simpleParser;
const WebSocket = require('ws');
const express = require('express');
const path = require('path');

const SMTP_SERVER_PORT = process.env.SMTP_SERVER_PORT || 8025;
const SERVER_PORT = process.env.SERVER_PORT || 8080;
const WS_SERVER_PORT = process.env.WS_SERVER_PORT || 8081;
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const WS_EX_PROTOCOL = process.env.WS_EX_PROTOCOL || 'ws';
const WS_EX_SERVER_PORT = process.env.WS_EX_SERVER_PORT || 8081;
const WS_EX_BASE_PATH = process.env.WS_EX_BASE_PATH || '';
const INDEX = path.join(__dirname, 'index.html');
const MESSAGE_STORE_MAX = parseInt(process.env.MESSAGE_STORE_MAX || '500', 10);
const WS_HEARTBEAT_MS = parseInt(process.env.WS_HEARTBEAT_MS || '60000', 10);
const WS_SEND_BUFFER_MAX = parseInt(process.env.WS_SEND_BUFFER_MAX || '1048576', 10);

let messageIdSeq = 0;
const messageStore = [];

const smtp_server = new SMTPServer({
    logger: false,
    banner: 'SMTP mock server, use UI to to check the actual message',
    disabledCommands: ['AUTH', 'STARTTLS'],

    onData(stream, session, callback) {
        simpleParser(stream, {
            skipHtmlToText: false,
            skipImageLinks: false,
            skipTextToHtml: false,
            skipTextLinks: false,
            keepCidLinks: true,
        })
            .then((parsed) => {
                const payload = toMailPayload(parsed);
                console.log(payload);
                storeAndBroadcast(payload);
                callback(null);
            })
            .catch((err) => {
                console.log('Error parsing mail:', err.message || err);
                callback(err);
            });
    },
});

smtp_server.on('error', (err) => {
    console.log('Error: SMTP Error occurred');
    console.log(err);
});

smtp_server.listen(SMTP_SERVER_PORT, SERVER_HOST);
console.log(`\x1b[33m SMTP Server Running on ${SERVER_HOST}:${SMTP_SERVER_PORT}\x1b[0m`);

const http_server = express();

http_server.get('/', (req, res) => {
    res.sendFile(INDEX);
});

http_server.get('/config', (req, res) => {
    res.send({
        wsProtocol: WS_EX_PROTOCOL,
        wsPort: WS_EX_SERVER_PORT,
        basePath: WS_EX_BASE_PATH,
    });
});

http_server.get('/sendsms', (req, res) => {
    try {
        const message = {
            type: 'SMS',
            date: new Date().toISOString(),
            to: { text: req.query.mobiles || '' },
            from: { text: req.query.sender || '' },
            subject: 'SMS: ' + (req.query.message || ''),
            text: req.query.message || '',
        };
        console.log(message);
        storeAndBroadcast(message);
        res.sendStatus(200);
    } catch (error) {
        console.log('Error: SMS Error occurred');
        console.log(error);
        res.sendStatus(500);
    }
});

http_server.listen(SERVER_PORT, () => {
    console.log(`\x1b[33m HTTP Server Running on http://${SERVER_HOST}:${SERVER_PORT}\x1b[0m`);
});

const socketServer = new WebSocket.Server({
    port: WS_SERVER_PORT,
    perMessageDeflate: {
        zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
        zlibInflateOptions: { chunkSize: 10 * 1024 },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024,
    },
});
console.log(`\x1b[33m Socket Server Running on ws://${SERVER_HOST}:${WS_SERVER_PORT}\x1b[0m`);

function heartbeat() {
    this.isAlive = true;
}

socketServer.on('connection', (socketClient) => {
    console.log('connected');
    console.log('Number of clients: ', socketServer.clients.size);
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
        console.log('closed');
        console.log('Number of clients: ', socketServer.clients.size);
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

function toMailPayload(parsed) {
    return {
        type: 'MAIL',
        date: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
        from: { text: (parsed.from && parsed.from.text) || '' },
        to: { text: (parsed.to && parsed.to.text) || '' },
        subject: parsed.subject || '',
        text: parsed.text || '',
        html: parsed.html || '',
        textAsHtml: parsed.textAsHtml || '',
        messageId: parsed.messageId || '',
        attachments: (parsed.attachments || []).map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
        })),
    };
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
    broadCast(stored, true);
}

function safeStringify(message) {
    try {
        return JSON.stringify(message);
    } catch (err) {
        console.log('Error serializing message:', err.message || err);
        return null;
    }
}

function sendToClient(client, data) {
    if (client.readyState !== WebSocket.OPEN) {
        return;
    }
    if (!client._outbound) {
        client._outbound = [];
    }
    client._outbound.push(data);
    flushOutbound(client);
}

function flushOutbound(client) {
    if (client._flushing || client.readyState !== WebSocket.OPEN) {
        return;
    }
    const next = client._outbound[0];
    if (!next) {
        return;
    }
    if (client.bufferedAmount > WS_SEND_BUFFER_MAX) {
        setTimeout(() => flushOutbound(client), 25);
        return;
    }
    client._flushing = true;
    client.send(next, (err) => {
        client._flushing = false;
        if (err) {
            console.log('WebSocket send error:', err.message || err);
        }
        client._outbound.shift();
        flushOutbound(client);
    });
}

function replayToClient(client, sinceId) {
    messageStore
        .filter((m) => m.id > sinceId)
        .forEach((m) => {
            const data = safeStringify(m);
            if (data) {
                sendToClient(client, data);
            }
        });
}

function broadCast(message, alreadyStored) {
    const stored = alreadyStored ? message : storeMessage(message);
    const data = safeStringify(stored);
    if (!data) {
        return;
    }
    socketServer.clients.forEach((client) => sendToClient(client, data));
}
