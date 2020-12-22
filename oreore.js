const fs = require("fs");

function sendMessage(msg) {
    const s = new TextEncoder("utf-8").encode(JSON.stringify(msg));
    process.stdout.write(`Content-Length: ${s.length}\r\n\r\n`);
    process.stdout.write(s);
}

function logMessage(message) {
    sendMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message } });
}

const buffers = {};
const diagnostics = [];

function tokenize(uri, str) {
    let i = 0;
    let line = 0;
    let character = 0;
    let tokens = [];

    function nextChar() {
        if (str.length === i) return;
        if (str[i] === "\n") {
            ++i;
            ++line;
            character = 0;
        } else {
            ++i;
            ++character;
        }
    }

    while (true) {
        // skip leading whitespaces
        while (true) {
            if (str.length === i) return tokens;
            if (" \t\r\n".indexOf(str[i]) === -1) break;
            nextChar();
        }

        const start = { line, character };

        let text;
        let kind;
        if (str[i] === "(") {
            text = "(";
            kind = "(";
            nextChar();
        } else if (str[i] === ")") {
            text = ")";
            kind = ")";
            nextChar();
        } else if (str[i] === ";") {
            const begin = i;
            while (true) {
                if (str.length === i) break;
                if (str[i] === "\n") break;
                nextChar();
            }
            text = str.substring(begin, i);
            kind = "comment";
        } else {
            const begin = i;
            while (true) {
                if (str.length === i) break;
                if (" \t\r\n();".indexOf(str[i]) !== -1) break;
                nextChar();
            }
            text = str.substring(begin, i);

            if (!isNaN(Number(text))) {
                kind = "number";
            } else {
                kind = "variable";
            }
        }

        const end = { line, character };
        const location = { uri, range: { start, end } };
        tokens.push({ kind, text, location });
    }
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
let publishDiagnosticsCapable = false;

requestTable["initialize"] = (msg) => {
    if (msg.params && msg.params.capabilities) {
        if (msg.params.capabilities.textDocument && msg.params.capabilities.textDocument.publishDiagnostics) {
            publishDiagnosticsCapable = true;
        }
    }

    const capabilities = {
        textDocumentSync: 1,
    };

    sendMessage({ jsonrpc: "2.0", id: msg.id, result: { capabilities } });
}

notificationTable["initialized"] = (msg) => {
    logMessage("initialized!");
}

function sendPublishDiagnostics(uri, diagnostics) {
    if (publishDiagnosticsCapable) {
        sendMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
    }
}

function compile(uri, src) {
    diagnostics.length = 0;
    const tokens = tokenize(uri, src);
    buffers[uri] = { tokens };
}

notificationTable["textDocument/didOpen"] = (msg) => {
    const uri = msg.params.textDocument.uri;
    const text = msg.params.textDocument.text;
    compile(uri, text);
    sendPublishDiagnostics(uri, diagnostics);
}

notificationTable["textDocument/didChange"] = (msg) => {
    if (msg.params.contentChanges.length !== 0) {
        const uri = msg.params.textDocument.uri;
        const text = msg.params.contentChanges[msg.params.contentChanges.length - 1].text;
        compile(uri, text);
        sendPublishDiagnostics(uri, diagnostics);
    }
}

notificationTable["textDocument/didClose"] = (msg) => {
    const uri = msg.params.textDocument.uri;
    sendPublishDiagnostics(uri, []);
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
