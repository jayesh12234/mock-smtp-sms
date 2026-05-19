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
                parsed.type = 'MAIL';
                console.log(parsed);
                broadCast(parsed);
            })
            .catch((err) => {
                console.log('Error parsing mail:', err.message || err);
            });

        stream.on('end', () => {
            callback(null);
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
            date: new Date().toJSON(),
            to: { text: req.query.mobiles },
            from: { text: req.query.sender },
            subject: 'SMS: ' + req.query.message,
            text: req.query.message,
        };
        console.log(message);
        broadCast(message);
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

    const interval = setInterval(() => {
        socketServer.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    socketClient.on('close', () => {
        clearInterval(interval);
        console.log('closed');
        console.log('Number of clients: ', socketServer.clients.size);
    });
});

function broadCast(message) {
    let data;
    try {
        data = JSON.stringify(message);
    } catch (err) {
        console.log('Error serializing message:', err.message || err);
        return;
    }
    socketServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}
