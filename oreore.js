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

function rangeOfScope(scope) {
    return { start: scope.firstToken.location.range.start, end: scope.lastToken.location.range.end };
}

function rangeOfAst(ast) {
    return { start: ast.firstToken.location.range.start, end: ast.lastToken.location.range.end };
}

function positionInRange(position, range) {
    if (position.line < range.start.line) return false;
    if (position.line === range.start.line && position.character < range.start.character) return false;
    if (position.line > range.end.line) return false;
    if (position.line === range.end.line && position.character >= range.end.character) return false;
    return true;
}

function findAstOfPosition(uri, position) {
    function f1(ast) {
        if (!positionInRange(position, rangeOfAst(ast))) return null;

        switch (ast.kind) {
            case "defun":
                if (ast.name) {
                    const name = f1(ast.name);
                    if (name) return name;
                }
                for (const param of ast.params) {
                    const param2 = f1(param);
                    if (param2) return param2;
                }
                for (const body of ast.body) {
                    const body2 = f1(body);
                    if (body2) return body2;
                }
                return ast;
            case "if":
                {
                    const cond = f1(ast.cond);
                    if (cond) return cond;
                    const con = f1(ast.con);
                    if (con) return con;
                    const alt = f1(ast.alt);
                    if (alt) return alt;
                    return ast;
                }
            case "call":
                if (ast.func) {
                    const proc = f1(ast.func);
                    if (proc) return proc;
                }
                for (const arg of ast.args) {
                    const arg2 = f1(arg);
                    if (arg2) return arg2;
                }
                return ast;
            case "unit":
                return ast;
            case "number":
                return ast;
            case "variable":
                return ast;
            case "error":
                return ast;
            default:
                throw new Error("unknown ast.kind: " + ast.kind);
        }
    }

    for (const ast of buffers[uri].asts) {
        const a = f1(ast);
        if (a) return a;
    }

    return null;
}

const globalScope = {
    definitions: {
        print: {
            kind: "subroutine",
            ast: {
                kind: "subroutine",
                name: "print",
                type: { params: ["number"], result: "unit" }
            }
        },
        "+": {
            kind: "subroutine",
            ast: {
                kind: "subroutine",
                name: "+",
                type: { params: ["number", "number"], result: "number" }
            }
        },
        "-": {
            kind: "subroutine",
            ast: {
                kind: "subroutine",
                name: "-",
                type: { params: ["number", "number"], result: "number" }
            }
        },
        "*": {
            kind: "subroutine",
            ast: {
                kind: "subroutine",
                name: "*",
                type: { params: ["number", "number"], result: "number" }
            }
        },
        "=": {
            kind: "subroutine",
            ast: {
                kind: "subroutine",
                name: "=",
                type: { params: ["number", "number"], result: "bool" }
            }
        }
    }
}

function parse(tokens) {
    const pts = [];
    let i = 0;

    function parse1() {
        switch (tokens[i].kind) {
            case "(":
                {
                    const data = [];
                    const firstToken = tokens[i++];
                    while (true) {
                        if (tokens.length === i) {
                            diagnostics.push({
                                range: firstToken.location.range,
                                message: "unclosed parenthesis"
                            });
                            break;
                        } else if (tokens[i].kind === ")") {
                            ++i;
                            break;
                        } else {
                            data.push(parse1());
                        }
                    }
                    const lastToken = tokens[i - 1];
                    return { kind: "array", firstToken, lastToken, data };
                }
            case ")":
                {
                    const token = tokens[i++];
                    diagnostics.push({
                        range: token.location.range,
                        message: "extra close parenthesis"
                    });
                    return { kind: "error", firstToken: token, lastToken: token };
                }
            case "number":
                {
                    const token = tokens[i++];
                    return { kind: "number", firstToken: token, lastToken: token, value: Number(token.text) };
                }
            case "variable":
                {
                    const token = tokens[i++];
                    return { kind: "variable", firstToken: token, lastToken: token, text: token.text };
                }
        }
    }

    while (true) {
        if (tokens.length === i) return pts;
        pts.push(parse1());
    }
}

function expand(pts) {
    const toplevelScope = {
        definitions: {},
        parent: globalScope,
        children: []
    };

    function expandDefun(pt, scope) {
        pt.data[0].firstToken.kind = "keyword";

        if (pt.data.length < 3) { // (defun), (defun x), etc.
            diagnostics.push({
                range: rangeOfAst(pt),
                message: "malformed defun"
            });
            return { kind: "error", type: "error", firstToken: pt.firstToken, lastToken: pt.lastToken }
        }
        if (pt.data[1].kind !== "variable") { // (defun 0.1 ...) etc.
            diagnostics.push({
                range: rangeOfAst(pt.data[1]),
                message: "A variable is expected"
            });
            return { kind: "error", type: "error", firstToken: pt.data[1].firstToken, lastToken: pt.data[1].lastToken }
        }
        pt.data[1].firstToken.kind = "function";
        if (pt.data[2].kind !== "array") { // (defun x 1.1 ...) etc.
            diagnostics.push({
                range: rangeOfAst(pt.data[2]),
                message: "An array of variables is expected"
            });
            return { kind: "error", type: "error", firstToken: pt.firstToken, lastToken: pt.lastToken }
        }

        const newScope = {
            definitions: {},
            parent: scope,
            children: [],
            firstToken: pt.data.length === 3 ? pt.lastToken : pt.data[3].firstToken,
            lastToken: pt.lastToken
        };
        scope.children.push(newScope);

        const params2 = [];
        for (const param of pt.data[2].data) {
            if (param.kind !== "variable") { // (defun x (1.0 ...) ...) etc.
                diagnostics.push({
                    range: rangeOfAst(param),
                    message: "A variable is expected"
                });    
                return { kind: "error", type: "error", firstToken: param.firstToken, lastToken: param.lastToken, text: "malformed defun" }
            }

            const param2 = {
                kind: "variable",
                type: { ref: null },
                firstToken: param.firstToken,
                lastToken: param.lastToken,
                text: param.text
            };
            if (param.firstToken.text in newScope.definitions) {
                diagnostics.push({
                    range: rangeOfAst(param),
                    message: "multiple definition"
                });
            }
            newScope.definitions[param.firstToken.text] = {
                kind: "parameter",
                token: param.firstToken,
                ast: param2
            };
            params2.push(param2);
        }
        
        const funcName = pt.data[1].text;
        scope.definitions[funcName] = {
            kind: "function",
            token: pt.data[1].firstToken,
            type:  {
                params: params2.map(p => p.type),
                result: { ref: null }
            },
            ast: null
        };
        scope.definitions[funcName].ast = {
            kind: "defun",
            type: "syntax",
            firstToken: pt.firstToken,
            lastToken: pt.lastToken,
            name: {
                kind: "variable",
                type: scope.definitions[funcName].type,
                firstToken: pt.data[1].firstToken,
                lastToken: pt.data[1].lastToken,
                text: pt.data[1].text
            },
            params: params2,
            body: pt.data.slice(3).map(pt => expand1(pt, newScope))
        }
        return scope.definitions[funcName].ast;
    }
    
    function expandIf(pt, scope) {
        pt.data[0].firstToken.kind = "keyword";

        if (pt.data.length !== 4) {
            diagnostics.push({
                range: rangeOfAst(pt),
                message: "malformed if"
            });
            return {
                kind: "error",
                type: "error",
                firstToken: pt.firstToken,
                lastToken: pt.lastToken,
                text: "malformed if"
            }
        }
        const cond = expand1(pt.data[1], scope);
        const con = expand1(pt.data[2], scope);
        const alt = expand1(pt.data[3], scope);
        return {
            kind: "if",
            type: { ref: null },
            firstToken: pt.firstToken,
            lastToken: pt.lastToken,
            cond,
            con,
            alt
        };
    }

    function findDefinition(scope, name) {
        if (name in scope.definitions) {
            return scope.definitions[name];
        }
        if (scope.parent) {
            return findDefinition(scope.parent, name);
        }
        return null;
    }

    function expandCall(pt, scope) {
        pt.data[0].firstToken.kind = "function";
        const definition = findDefinition(scope, pt.data[0].text);

        let type;
        if (!definition) {
            diagnostics.push({
                range: rangeOfAst(pt.data[0]),
                message: "undefined variable"
            });
            type = {
                params: [...Array(pt.data.length - 1)].map(_ => ({ ref: null })),
                result: { ref: null }
            };
        } else if (definition.kind === "subroutine") {
            type = definition.ast.type;
        } else if (definition.kind === "function") {
            type = definition.type;
        } else {
            diagnostics.push({
                range: rangeOfAst(pt.data[0]),
                message: "A function is expected"
            });
            type = {
                params: [...Array(pt.data.length - 1)].map(_ => "error"),
                result: "error"
            }
        }

        return {
            kind: "call",
            type: type.result,
            firstToken: pt.firstToken,
            lastToken: pt.lastToken,
            func: {
                kind: "variable",
                type,
                definition,
                firstToken: pt.data[0].firstToken,
                lastToken: pt.data[0].lastToken,
                text: pt.text
            },
            args: pt.data.slice(1).map(pt => expand1(pt, scope))
        }
    }

    function expand1(pt, scope) {
        switch (pt.kind) {
            case "array":
                if (pt.data.length === 0) {
                    return {
                        kind: "unit",
                        type: "unit",
                        firstToken: pt.firstToken,
                        lastToken: pt.lastToken
                    }
                } else if (pt.data[0].kind === "variable") {
                    switch (pt.data[0].text) {
                        case "defun":
                            if (scope !== toplevelScope) {
                                diagnostics.push({
                                    range: rangeOfAst(pt),
                                    message: "nested function is not allowed"
                                });
                            }
                            return expandDefun(pt, scope);
                        case "if":
                            return expandIf(pt, scope);
                        default:
                            return expandCall(pt, scope);
                    }
                } else {
                    diagnostics.push({
                        range: rangeOfAst(pt),
                        message: "An operator must be an identifier"
                    });
                    return {
                        kind: "call",
                        type: "error",
                        firstToken: pt.firstToken,
                        lastToken:pt.lastToken,
                        func: null,
                        args: pt.data.map(pt => expand1(pt, scope))
                    }
                }
            case "number":
                return {
                    kind: "number",
                    type: "number",
                    firstToken: pt.firstToken,
                    lastToken: pt.lastToken,
                    value: pt.value
                };
            case "variable":
                {
                    let definition = findDefinition(scope, pt.text);
                    if (!definition) {
                        diagnostics.push({
                            range: rangeOfAst(pt),
                            message: "undefined variable"
                        });
                    }
                    return {
                        kind: "variable",
                        type: definition ? definition.ast.type : { ref: null },
                        definition,
                        firstToken: pt.firstToken,
                        lastToken: pt.lastToken,
                        text: pt.text
                    };
                }
            case "error":
                return pt;
        }
    }
    
    const asts = pts.map(pt => expand1(pt, toplevelScope));
    return [asts, toplevelScope];
}

function typeToString(type) {
    function deref(t) {
        while (t && typeof t === "object" && "ref" in t) t = t.ref;
        return t ? t : "unknown";
    }
    type = deref(type);
    if (typeof type === "object" && "params" in type) {
        const params = "(" + type.params.map(deref).join(", ") + ")";
        const result = deref(type.result);
        return params + " -> " + result;
    } else {
        return deref(type).toString();
    }
}

function typing(asts) {
    function deref(t) {
        while (t.ref) t = t.ref;
        return t;
    }

    function unify(lhs, rhs, rhsRange) {
        const lhs2 = deref(lhs);
        const rhs2 = deref(rhs);

        if (lhs === rhs) return;
        if (lhs === "error" || rhs === "error") return;

        if (typeof lhs2 === "object" && "ref" in lhs2 && !lhs2.ref) {
            lhs2.ref = rhs2;
        } else if (typeof rhs2 === "object" && "ref" in rhs2 && !rhs2.ref) {
            rhs2.ref = lhs2;
        } else if (lhs2 !== rhs2) {
            diagnostics.push({
                range: rhsRange,
                message: typeToString(lhs) + " is expected"
            });
        }
    }

    function typing1(ast) {
        switch (ast.kind) {
            case "defun":
                {
                    let lastBody = null;
                    for (const body of ast.body) {
                        typing1(body);
                        lastBody = body;
                    }

                    if (lastBody) {
                        unify(ast.name.type.result, lastBody.type, rangeOfAst(lastBody));
                    }
                }
                return;
            case "if":
                typing1(ast.cond);
                typing1(ast.con);
                typing1(ast.alt);
                unify("bool", ast.cond.type, rangeOfAst(ast.cond));
                unify(ast.con.type, ast.alt.type, rangeOfAst(ast.alt));
                unify(ast.type, ast.con.type, rangeOfAst(ast.con));
                return;
            case "call":
                if (ast.func) {
                    const t = deref(ast.func.type);
                    if (t.result) {
                        unify(ast.type, t.result, rangeOfAst(ast.func));
                    }
                }

                for (const arg of ast.args) {
                    typing1(arg);
                }

                if (ast.func) {
                    const params = deref(ast.func.type).params;
                    if (params) {
                        if (params.length !== ast.args.length) {
                            diagnostics.push({
                                range: rangeOfAst(ast),
                                message: "wrong number of arguments"
                            });
                        }
                        const length = Math.min(params.length, ast.args.length);
                        for (let i = 0; i < length; ++i) {
                            unify(params[i], ast.args[i].type, rangeOfAst(ast.args[i]));
                        }
                    }
                }
                return;
            case "unit":
                return;
            case "number":
                return;
            case "variable":
                return;
            case "error":
                return;
            default:
                throw new Error("unknown ast.kind: " + ast.kind);
        }
    }
    for (const ast of asts) {
        typing1(ast);
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
            dispatch(msg);
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
const tokenTypeToIndex = {};
let publishDiagnosticsCapable = false;

requestTable["initialize"] = (msg) => {
    const capabilities = {
        textDocumentSync: 1,
        definitionProvider: true,
        hoverProvider: true, // <---- ここ
        completionProvider: {}
    };

    if (msg.params && msg.params.capabilities) {
        if (msg.params.capabilities.textDocument && msg.params.capabilities.textDocument.publishDiagnostics) {
            publishDiagnosticsCapable = true;
        }
        if (msg.params.capabilities.textDocument && msg.params.capabilities.textDocument.semanticTokens && msg.params.capabilities.textDocument.semanticTokens.tokenTypes) {
            const tokenTypes = msg.params.capabilities.textDocument.semanticTokens.tokenTypes;
            for (const i in tokenTypes) {
                tokenTypeToIndex[tokenTypes[i]] = i;
            }
            capabilities.semanticTokensProvider = {
                legend: {
                    tokenTypes,
                    tokenModifiers: []
                },
                range: false,
                full: true
            }
        }
    }

    sendMessage({ jsonrpc: "2.0", id: msg.id, result: { capabilities } });
}

requestTable["textDocument/semanticTokens/full"] = (msg) => {
    const uri = msg.params.textDocument.uri;
    const data = [];
    let line = 0;
    let character = 0;

    for (const token of buffers[uri].tokens) {
        if (token.kind in tokenTypeToIndex) {
            let d_line;
            let d_char;
            if (token.location.range.start.line === line) {
                d_line = 0;
                d_char = token.location.range.start.character - character;
            } else {
                d_line = token.location.range.start.line - line;
                d_char = token.location.range.start.character;
            }
            line = token.location.range.start.line;
            character = token.location.range.start.character;

            data.push(d_line, d_char, token.text.length, tokenTypeToIndex[token.kind], 0);
        }
    }

    sendMessage({ jsonrpc: "2.0", id: msg.id, result: { data } })
}

requestTable["textDocument/completion"] = (msg) => {
    const uri = msg.params.textDocument.uri;
    const position = msg.params.position;
    const toplevelScope = buffers[uri].toplevelScope;
    const result = [];

    for (const name in globalScope.definitions) {
        result.push({ label: name });
    }

    for (const name in toplevelScope.definitions) {
        result.push({ label: name });
    }

    for (const localScope of toplevelScope.children) {
        if (positionInRange(position, rangeOfScope(localScope))) {
            for (const name in localScope.definitions) {
                result.push({ label: name });
            }
        }
    }

    sendMessage({ jsonrpc: "2.0", id: msg.id, result });
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
    const pts = parse(tokens.filter(t => t.kind !== "comment"));
    const [asts, toplevelScope] = expand(pts);
    typing(asts);
    buffers[uri] = { tokens, toplevelScope, asts };
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

requestTable["textDocument/definition"] = (msg) => {
    const uri = msg.params.textDocument.uri;
    const position = msg.params.position;

    const ast = findAstOfPosition(uri, position);
    if (!ast || ast.kind !== "variable" || !ast.definition || !ast.definition.token) {
        sendMessage({ jsonrpc: "2.0", id: msg.id, result: null });
    } else {
        sendMessage({ jsonrpc: "2.0", id: msg.id, result: ast.definition.token.location });
    }
}

requestTable["textDocument/hover"] = (msg) => {
    const uri = msg.params.textDocument.uri;
    const position = msg.params.position;
    const ast = findAstOfPosition(uri, position);
    if (!ast || !"type" in ast) {
        sendMessage({ jsonrpc: "2.0", id: msg.id, result: null });
    } else {
        sendMessage({ jsonrpc: "2.0", id: msg.id, result: { contents: typeToString(ast.type) } });
    }
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
