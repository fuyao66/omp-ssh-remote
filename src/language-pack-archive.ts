// Python's stdlib is used only for explicit pack preparation/deployment, never server execution.
export const LANGUAGE_PACK_ARCHIVE_SCRIPT = String.raw`
import os, sys, json, hashlib, tarfile, pathlib, tempfile, shutil, stat, fcntl

def digest(data): return hashlib.sha256(data).hexdigest()
def digest_file(path):
    checksum=hashlib.sha256()
    with open(path,'rb') as f:
        while True:
            chunk=f.read(1024*1024)
            if not chunk: break
            checksum.update(chunk)
    return checksum.hexdigest()
def safe_name(name):
    p = pathlib.PurePosixPath(name)
    if not name or name.startswith('/') or '..' in p.parts or '\\' in name or any(ord(c)<32 for c in name):
        raise ValueError('unsafe archive path: '+repr(name))
    return str(p)
def members(tar):
    seen=set()
    result=[]
    for m in tar.getmembers():
        name=safe_name(m.name)
        if name in seen: raise ValueError('duplicate archive member')
        seen.add(name)
        if not (m.isfile() or m.isdir()): raise ValueError('links and special archive members are forbidden')
        if m.mode & 0o7000: raise ValueError('privileged archive mode')
        if m.isfile() and (m.size<0 or m.size>300*1024*1024): raise ValueError('oversized archive member')
        result.append((m,name))
    if len(result)>20000 or sum(m.size for m,n in result)>500*1024*1024: raise ValueError('oversized archive')
    return result
def extract(tar, entries, target):
    for m,name in entries:
        dest=os.path.join(target,name)
        if m.isdir(): os.makedirs(dest,exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dest),exist_ok=True)
            with tar.extractfile(m) as src, open(dest,'xb') as dst: shutil.copyfileobj(src,dst)
            os.chmod(dest,0o755 if m.mode & 0o111 else 0o644)
PROFILES={
    'python': ('bin/pyright-langserver', {'bin/node','bin/pyright-langserver','pyright/langserver.index.js','pyright/package.json','pyright/LICENSE.txt','licenses/node-LICENSE'}),
    'typescript': ('bin/typescript-language-server', {'bin/node','bin/typescript-language-server','typescript-language-server/lib/cli.mjs','typescript-language-server/package.json','typescript-language-server/LICENSE','typescript-language-server/node_modules/typescript/lib/tsserver.js','typescript-language-server/node_modules/typescript/lib/_tsserver.js','typescript-language-server/node_modules/typescript/lib/typescript.js','typescript-language-server/node_modules/typescript/package.json','typescript-language-server/node_modules/typescript/LICENSE.txt','typescript-language-server/node_modules/typescript/ThirdPartyNoticeText.txt','licenses/node-LICENSE'}),
    'cpp': ('bin/clangd', {'bin/clangd','bin/clangd.real','lib/libLLVM.so.23.1','lib/libclang-cpp.so.23.1','lib/libstdc++.so.6','lib/libgcc_s.so.1','lib/clang/23/include/stddef.h','licenses/clangd-23-copyright','licenses/libclang-common-23-dev-copyright','licenses/libclang-cpp23-copyright','licenses/libllvm23-copyright','licenses/gcc-10-base-copyright'})
}
EXECUTABLES={'python':('bin/node','bin/pyright-langserver'),'typescript':('bin/node','bin/typescript-language-server'),'cpp':('bin/clangd','bin/clangd.real')}
profile='python'
def verify(root, ident, arch):
    if os.path.islink(root) or not os.path.isdir(root): raise ValueError('missing or linked pack')
    manifest_path=os.path.join(root,'manifest.json')
    if os.path.islink(manifest_path): raise ValueError('linked manifest')
    with open(manifest_path,'rb') as f: raw=f.read()
    if digest(raw)!=ident: raise ValueError('manifest identity mismatch')
    manifest=json.loads(raw)
    entrypoint,required=PROFILES[profile]
    if manifest['format']!=1 or manifest['platform']!='linux' or manifest['arch']!=arch or manifest['entrypoint']!=entrypoint: raise ValueError('invalid manifest')
    expected=manifest['files']
    if profile=='cpp': required=required | {'licenses/common/Apache-2.0','licenses/common/GPL-3','licenses/common/LGPL-2.1'}
    if profile=='cpp' and arch=='x64':
        required=required | {'lib/'+name for name in ('libffi.so.7','libedit.so.2','libxml2.so.2','libzstd.so.1','libz.so.1','libbsd.so.0','libtinfo.so.6','libicuuc.so.66','libicudata.so.66','liblzma.so.5')} | {'licenses/'+name+'-copyright' for name in ('libffi7','libedit2','libxml2','libzstd1','zlib1g','libbsd0','libtinfo6','libicu66','liblzma5')}
    if not required.issubset(expected): raise ValueError('incomplete manifest')
    actual=set()
    for base,dirs,files in os.walk(root,followlinks=False):
        for n in dirs:
            if os.path.islink(os.path.join(base,n)): raise ValueError('linked directory')
        for n in files:
            path=os.path.join(base,n); rel=os.path.relpath(path,root)
            st=os.lstat(path)
            if not stat.S_ISREG(st.st_mode): raise ValueError('nonregular pack file')
            if rel=='manifest.json': continue
            actual.add(rel)
            item=expected.get(rel)
            if not item or stat.S_IMODE(st.st_mode)!=item['mode']: raise ValueError('file/mode mismatch: '+rel)
            if digest_file(path)!=item['sha256']: raise ValueError('file checksum mismatch: '+rel)
    if actual!=set(expected): raise ValueError('incomplete pack')
    for n in EXECUTABLES[profile]:
        if expected[n]['mode']!=0o755: raise ValueError('nonexecutable launcher')
    return manifest

def publish(pack,out,arch,provenance):
    entrypoint,_=PROFILES[profile]
    files={}
    for base,dirs,names in os.walk(pack):
        for name in names:
            p=os.path.join(base,name); rel=os.path.relpath(p,pack)
            checksum=digest_file(p)
            files[rel]={'sha256':checksum,'mode':stat.S_IMODE(os.stat(p).st_mode)}
    manifest={'format':1,'platform':'linux','arch':arch,'entrypoint':entrypoint,'provenance':provenance,'files':files}
    raw=(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n').encode()
    with open(os.path.join(pack,'manifest.json'),'wb') as f: f.write(raw)
    ident=digest(raw)
    verify(pack,ident,arch)
    import gzip
    with open(out+'.tar.gz','wb') as rawout, gzip.GzipFile(filename='',fileobj=rawout,mode='wb',mtime=0) as zipped, tarfile.open(fileobj=zipped,mode='w',format=tarfile.USTAR_FORMAT) as tar:
        for rel in sorted(['manifest.json']+list(files)):
            info=tar.gettarinfo(os.path.join(pack,rel),arcname=rel)
            info.uid=info.gid=0; info.uname=info.gname=''; info.mtime=0
            with open(os.path.join(pack,rel),'rb') as f: tar.addfile(info,f)
    archive_hash=digest_file(out+'.tar.gz')
    with open(out+'.json','w') as f: json.dump({'format':1,'platform':'linux','arch':arch,'id':ident,'archiveSha256':archive_hash},f,sort_keys=True)
    print(ident)

mode=sys.argv[1]
if mode=='cache':
    root,ident,arch,archive,archive_hash=sys.argv[2:7]
    profile=sys.argv[7] if len(sys.argv)>7 else 'python'
    if profile not in PROFILES: raise ValueError('unknown pack profile')
    os.makedirs(root,mode=0o700,exist_ok=True)
    if os.path.islink(root): raise ValueError('linked cache root')
    final=os.path.join(root,ident)
    lock=os.path.join(root,'.'+ident+'.lock')
    fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as held:
        fcntl.flock(held,fcntl.LOCK_EX)
        if os.path.lexists(final):
            verify(final,ident,arch)
            print(final)
        elif archive=='-': print('missing')
        else:
            if digest_file(archive)!=archive_hash: raise ValueError('archive checksum mismatch')
            staging=tempfile.mkdtemp(prefix='.'+ident+'.stage-',dir=root)
            try:
                with tarfile.open(archive,'r:gz') as tar: extract(tar,members(tar),staging)
                verify(staging,ident,arch)
                os.rename(staging,final)
                print(final)
            finally:
                if os.path.isdir(staging): shutil.rmtree(staging)
elif mode in ('prepare','prepare-typescript'):
    if mode=='prepare':
        node_archive,pyright_archive,out,arch,provenance_json=sys.argv[2:]
        packages=[(pyright_archive,'pyright')]
    else:
        profile='typescript'
        node_archive,server_archive,typescript_archive,out,arch,provenance_json=sys.argv[2:]
        packages=[(server_archive,'typescript-language-server'),(typescript_archive,'typescript-language-server/node_modules/typescript')]
    entrypoint,_=PROFILES[profile]
    provenance=json.loads(provenance_json)
    os.makedirs(os.path.dirname(out),exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=profile+'-lsp-') as work:
        pack=os.path.join(work,'pack'); os.makedirs(pack)
        with tarfile.open(node_archive,'r:xz') as tar:
            # Only the actual Node executable and upstream copyright/license aggregation are shipped.
            selected=[]
            prefix='node-v'+provenance['node']['version']+'-linux-'+arch+'/'
            for m in tar.getmembers():
                if m.name in (prefix+'bin/node',prefix+'LICENSE'):
                    if not m.isfile(): raise ValueError('invalid Node member')
                    m.name='bin/node' if m.name.endswith('/bin/node') else 'licenses/node-LICENSE'
                    selected.append((m,m.name))
            if len(selected)!=2: raise ValueError('missing Node runtime/license')
            extract(tar,selected,pack)
        for package_archive,target in packages:
            with tarfile.open(package_archive,'r:gz') as tar:
                selected=[]
                for m,name in members(tar):
                    if name=='package' and m.isdir(): continue
                    if not name.startswith('package/'): raise ValueError('unexpected npm root')
                    selected.append((m,target+'/'+name[len('package/'):]))
                extract(tar,selected,pack)
        if profile=='typescript':
            # Both published packages bundle their runtime; no resolver or install scripts are run.
            for _,target in packages:
                with open(os.path.join(pack,target,'package.json')) as f: package=json.load(f)
                if package.get('dependencies') or package.get('optionalDependencies') or package.get('peerDependencies'):
                    raise ValueError('unpinned npm runtime dependency closure')
        program='pyright/langserver.index.js' if profile=='python' else 'typescript-language-server/lib/cli.mjs'
        launcher='#!/bin/sh\nset -eu\npack=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd -P)\nexec "$pack/bin/node" "$pack/'+program+'" "$@"\n'
        with open(os.path.join(pack,entrypoint),'w') as f: f.write(launcher)
        os.chmod(os.path.join(pack,entrypoint),0o755)
        publish(pack,out,arch,provenance)
elif mode=='prepare-cpp-directory':
    profile='cpp'
    pack,out,arch,provenance_json=sys.argv[2:]
    publish(pack,out,arch,json.loads(provenance_json))
else: raise ValueError('unknown operation')
`;
