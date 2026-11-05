import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadPinned } from "../scripts/prepare-language-pack.ts";
import { LANGUAGE_PACK_ARCHIVE_SCRIPT } from "../src/language-pack-archive.ts";

let work: string;
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "pack source cache ")); });
afterAll(async () => { await rm(work, { recursive: true, force: true }); });

test("shared preparation verifies and reuses pinned source in place without download or duplicate", async () => {
  const shared = join(work, "shared");
  await mkdir(shared);
  const bytes = Buffer.from("pinned Node source fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const original = join(shared, "node.tar.xz"); await writeFile(original, bytes);
  const inode = (await stat(original)).ino;
  const result = await downloadPinned(shared, "https://invalid.invalid/node.tar.xz", "node.tar.xz", "sha256", digest);
  expect(result).toBe(original); expect((await stat(result)).ino).toBe(inode);
  expect(await readFile(result)).toEqual(bytes);
});

test("shared cache corruption fails closed rather than downloading or trusting the filename", async () => {
  const shared = join(work, "corrupt shared");
  await mkdir(shared); await writeFile(join(shared, "node.tar.xz"), "corrupt");
  await expect(downloadPinned(shared, "https://invalid.invalid/node.tar.xz", "node.tar.xz", "sha256", "0".repeat(64))).rejects.toThrow("Cached upstream checksum mismatch");
});

test("Python publish and cache integrity hash large payloads and archives with bounded reads", async () => {
  const dir = await mkdtemp(join(work, "streaming "));
  const program = String.raw`
import builtins, hashlib, json, os, sys
script, root = sys.argv[1:]
pack=os.path.join(root,'pack'); os.makedirs(pack)
payload=bytes(range(256))*(2*1024*1024//256)+b'boundary\x00\xff'
required=['bin/node','bin/pyright-langserver','pyright/langserver.index.js','pyright/package.json','pyright/LICENSE.txt','licenses/node-LICENSE']
for rel in required:
    path=os.path.join(pack,rel); os.makedirs(os.path.dirname(path),exist_ok=True)
    with open(path,'wb') as f: f.write(payload if rel=='bin/node' else rel.encode())
    os.chmod(path,0o755 if rel.startswith('bin/') else 0o644)
original_open=builtins.open
reads={}
class BoundedReader:
    def __init__(self, file, path): self.file=file; self.path=path
    def __getattr__(self, name): return getattr(self.file,name)
    def __enter__(self): self.file.__enter__(); return self
    def __exit__(self, *args): return self.file.__exit__(*args)
    def read(self, size=-1):
        if size<0 or size>1024*1024: raise AssertionError('unbounded read: '+self.path)
        reads[self.path]=reads.get(self.path,0)+1
        return self.file.read(size)
def bounded_open(path, mode='r', *args, **kwargs):
    file=original_open(path,mode,*args,**kwargs)
    name=os.fspath(path)
    return BoundedReader(file,name) if mode=='rb' and not name.endswith('manifest.json') else file
builtins.open=bounded_open
namespace={}
exec(script.split('\nmode=sys.argv[1]')[0],namespace)
out=os.path.join(root,'published')
namespace['publish'](pack,out,'arm64',{})
with open(out+'.json') as f: descriptor=json.load(f)
with original_open(out+'.tar.gz','rb') as f: assert descriptor['archiveSha256']==hashlib.sha256(f.read()).hexdigest()
with open(os.path.join(pack,'manifest.json')) as f: manifest=json.load(f)
assert manifest['files']['bin/node']['sha256']==hashlib.sha256(payload).hexdigest()
cache=os.path.join(root,'cache')
sys.argv=['archive','cache',cache,descriptor['id'],'arm64',out+'.tar.gz',descriptor['archiveSha256'],'python']
exec(script,{})
sys.argv[5]='-'
exec(script,{})
assert reads[os.path.join(pack,'bin/node')]>=6
assert reads[out+'.tar.gz']>=2
installed=os.path.join(cache,descriptor['id'],'bin/node')
assert reads[installed]>=4
with open(installed,'r+b') as f: f.write(b'changed')
try: exec(script,{})
except ValueError as error: assert 'file checksum mismatch' in str(error)
else: raise AssertionError('corrupt cached payload accepted')
print('bounded integrity checks passed')
`;
  const process = Bun.spawn(["python3", "-c", program, LANGUAGE_PACK_ARCHIVE_SCRIPT, dir], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  expect(await process.exited, stderr).toBe(0);
  expect(stdout).toContain("bounded integrity checks passed");
});
