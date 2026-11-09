// Embedded Python keeps the remote fixture independent of Node/npm/Bun.
// Every delayed notification is released by an explicit JSON-RPC request.
export const lspFixtureSource = String.raw`import json, os, sys

log_path = sys.argv[1]
documents = {}
pending = set()

def log(event, **fields):
    row = json.dumps(dict(event=event, **fields), separators=(',', ':'))
    print(row, file=sys.stderr, flush=True)
    with open(log_path, 'a') as f:
        f.write(row + '\n')

def send(value):
    body = json.dumps(value, separators=(',', ':')).encode()
    sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n' % len(body)).encode() + body)
    sys.stdout.buffer.flush()

def notify(uri, version, text):
    diagnostics = [] if 'CLEAN' in text else [dict(range=dict(start=dict(line=0,character=0),end=dict(line=0,character=1)),severity=1,source='smoke-fixture',code='SMOKE',message=text.strip())]
    send(dict(jsonrpc='2.0',method='textDocument/publishDiagnostics',params=dict(uri=uri,version=version,diagnostics=diagnostics)))
    log('published',uri=uri,version=version,text=text.strip(),count=len(diagnostics))

log('started',pid=os.getpid())
while True:
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b'\r\n',b'\n'):
            break
        if line.lower().startswith(b'content-length:'):
            length = int(line.split(b':',1)[1])
    if length is None:
        continue
    message = json.loads(sys.stdin.buffer.read(length))
    method = message.get('method')
    params = message.get('params') or {}
    ident = message.get('id')
    log('received',method=method,id=ident)
    result = None
    error = None
    if method == 'initialize':
        result = dict(capabilities=dict(textDocumentSync=dict(openClose=True,change=1,save=True),hoverProvider=True,codeActionProvider=dict(codeActionKinds=['source.organizeImports'])))
    elif method in ('textDocument/didOpen','textDocument/didChange'):
        doc = params['textDocument']
        text = doc.get('text') if method.endswith('didOpen') else params['contentChanges'][-1]['text']
        documents.setdefault(doc['uri'],{})[doc['version']] = text
        log('document',uri=doc['uri'],version=doc['version'],text=text.strip())
        if 'HOLD' not in text:
            notify(doc['uri'],doc['version'],text)
    elif method == 'smoke/release':
        uri = params['uri']
        versions = documents.get(uri,{})
        version = params.get('version',max(versions) if versions else 0)
        text = versions[version]
        notify(uri,version,text)
        result = dict(uri=uri,version=version,text=text.strip())
    elif method == 'smoke/state':
        result = dict(documents=documents,pending=list(pending))
    elif method == 'smoke/hang':
        pending.add(ident)
        continue
    elif method == '$/cancelRequest':
        cancelled = params['id']
        pending.discard(cancelled)
        log('cancelled',id=cancelled)
    elif method == 'smoke/fail':
        error = dict(code=-32603,message='intentional fixture failure')
    elif method == 'textDocument/hover':
        result = dict(contents='fixture hover')
    elif method == 'textDocument/codeAction':
        uri = params['textDocument']['uri']
        context = params.get('context',{})
        only = context.get('only')
        log('code-action',uri=uri,only=only,diagnostics=context.get('diagnostics',[]))
        # Deliberately absent from the ordinary response: native code_actions
        # must explicitly request source actions, then apply the workspace edit.
        if only and any(kind in ('source','source.organizeImports') for kind in only):
            versions = documents[uri]
            text = versions[max(versions)]
            edit = dict(range=dict(start=dict(line=0,character=0),end=dict(line=len(text.splitlines()),character=0)),newText='CLEAN_SOURCE_APPLIED\n')
            result = [dict(title='Fixture organize imports',kind='source.organizeImports',edit=dict(changes={uri:[edit]}))]
        else:
            result = []
    elif method == 'shutdown':
        result = None
    elif method == 'exit':
        sys.exit(0)
    elif ident is not None:
        error = dict(code=-32601,message='Method not found: '+str(method))
    if ident is not None:
        reply = dict(jsonrpc='2.0',id=ident)
        reply['error' if error else 'result'] = error if error else result
        send(reply)
`;
