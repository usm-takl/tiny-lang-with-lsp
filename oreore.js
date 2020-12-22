const fs = require("fs");

function sendMessage(msg) {
    const s = new TextEncoder("utf-8").encode(JSON.stringify(msg));
    process.stdout.write(`Content-Length: ${s.length}\r\n\r\n`);
    process.stdout.write(s);
}

function logMessage(message) {
    sendMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message } });
}

function sendErrorResponse(id, code, message) {
    sendMessage({ jsonrpc: "2.0", id, error: { code, message }});
}

function sendParseErrorResponse() {
    // If there was an error in detecting the id in the Request object (e.g. Parse error/Invalid Request), it MUST be Null.
    // https://www.jsonrpc.org/specification#response_object
    sendErrorResponse(null, -32700, "received an invalid JSON");
}

function languageServer() {
    let buffer = Buffer.from(new Uint8Array(0));
    process.stdin.on("readable", () => {
        let chunk;
        while (chunk = process.stdin.read()) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const bufferString = buffer.toString();
        if (!bufferString.includes("\r\n\r\n")) return;

        const headerString = bufferString.split("\r\n\r\n", 1)[0];

        let contentLength = -1;
        let headerLength = headerString.length + 4;
        for (const line of headerString.split("\r\n")) {
            const [key, value] = line.split(": ");
            if (key === "Content-Length") {
                contentLength = parseInt(value, 10);
            }
        }

        if (contentLength === -1) return;
        if (buffer.length < headerLength + contentLength) return;

        try {
            const msg = JSON.parse(buffer.slice(headerLength, headerLength + contentLength));
            dispatch(msg); // 後述
        } catch (e) {
            if (e instanceof SyntaxError) {
                sendParseErrorResponse();
                return;
            } else {
                throw e;
            }
        } finally {
            buffer = buffer.slice(headerLength + contentLength);
        }
    });
}

function sendInvalidRequestResponse() {
    sendErrorResponse(null, -32600, "received an invalid request");
}

function sendMethodNotFoundResponse(id, method) {
    sendErrorResponse(id, -32601, method + " is not supported");
}

const requestTable = {};
const notificationTable = {};

requestTable["initialize"] = (msg) => {
    logMessage("initialize");
    // TODO: implement
}

function dispatch(msg) {
    if ("id" in msg && "method" in msg) { // request
        if (msg.method in requestTable) {
            requestTable[msg.method](msg);
        } else {
            sendMethodNotFoundResponse(msg.id, msg.method)
        }
    } else if ("id" in msg) { // response
        // Ignore.
        // This language server doesn't send any request.
        // If this language server receives a response, that is invalid.
    } else if ("method" in msg) { // notification
        if (msg.method in notificationTable) {
            notificationTable[msg.method](msg);
        }
    } else { // error
        sendInvalidRequestResponse();
    }
}

if (process.argv.length !== 3) {
    console.log(`usage: ${process.argv[1]} [--language-server|FILE]`);
} else if (process.argv[2] == "--language-server") {
    languageServer();
} else {
    // TODO: interpret(process.argv[2]);
}
