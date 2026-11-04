import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languagePackCacheCommand, deployLanguagePack } from "../src/language-pack-deploy.ts";
import { sha256, type PythonLspPackDescriptor } from "../src/python-lsp-pack.ts";
import { buildSshWorkerCommand } from "../src/ssh.ts";
import { parseConnectArgs, parseConnectOptions, loadConfiguredSshHosts } from "../src/connect-options.ts";

let work: string;
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), "lsp pack tests ")); });
afterAll(async () => { await rm(work, {recursive:true,force:true}); });
const required = ["bin/node", "bin/pyright-langserver", "pyright/langserver.index.js", "pyright/package.json", "pyright/LICENSE.txt", "licenses/node-LICENSE"];
interface PackFixture { dir: string; descriptor: PythonLspPackDescriptor; archive: string; root: string }
async function fixture(kind = "valid"): Promise<PackFixture> {
  const dir = await mkdtemp(join(work, "fixture "));
  const files = Object.fromEntries(required.map(path => [path,{sha256:sha256(Buffer.from(path)),mode:path.startsWith("bin/")?0o755:0o644}]));
  const manifest = JSON.stringify({format:1,platform:"linux",arch:"arm64",entrypoint:"bin/pyright-langserver",files});
  const descriptor: PythonLspPackDescriptor = {format:1,platform:"linux",arch:"arm64",id:sha256(Buffer.from(manifest)),archiveSha256:""};
  const archive = join(dir,"pack.tar.gz");
  const generator = `import tarfile,io,json,sys\narchive,manifest,kind=sys.argv[1:]\nwith tarfile.open(archive,'w:gz') as t:\n for name in ['manifest.json']+list(json.loads(manifest)['files']):\n  b=manifest.encode() if name=='manifest.json' else name.encode()\n  m=tarfile.TarInfo(name);m.size=len(b);m.mode=0o755 if name.startswith('bin/') else 0o644;t.addfile(m,io.BytesIO(b))\n if kind!='valid':\n  m=tarfile.TarInfo('../escaped' if kind=='traversal' else '/absolute' if kind=='absolute' else 'evil');m.mode=0o644\n  if kind=='symlink':m.type=tarfile.SYMTYPE;m.linkname='/tmp'\n  if kind=='hardlink':m.type=tarfile.LNKTYPE;m.linkname='bin/node'\n  if kind=='duplicate':m.name='bin/node'\n  t.addfile(m)\n`;
  const result = Bun.spawnSync(["python3","-c",generator,archive,manifest,kind]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  descriptor.archiveSha256=sha256(await readFile(archive));
  return {dir,descriptor,archive,root:join(dir,"cache with spaces")};
}
async function activate(f: PackFixture, archive = f.archive) {
  const command = languagePackCacheCommand("python", f.root,f.descriptor,archive);
  const proc=Bun.spawn(["sh","-c",command],{stdout:"pipe",stderr:"pipe"});
  const stdout=await new Response(proc.stdout).text(); const stderr=await new Response(proc.stderr).text();
  return {code:await proc.exited,stdout:stdout.trim(),stderr};
}

describe("private Python pack cache", () => {
  test("publishes verified pack atomically; cache hit reuses inode without archive",async()=>{
    const f=await fixture(); const first=await activate(f);
    expect(first.code).toBe(0);expect(first.stdout).toBe(join(f.root,f.descriptor.id));
    const node=join(first.stdout,"bin/node");const before=await stat(node);
    const second=await activate(f,"-");expect(second.code).toBe(0);
    expect((await stat(node)).ino).toBe(before.ino);
    expect((await stat(node)).mtimeMs).toBe(before.mtimeMs);
  });
  test("rejects partial cache rather than blessing or overwriting it",async()=>{
    const f=await fixture();await mkdir(join(f.root,f.descriptor.id),{recursive:true});
    const result=await activate(f);expect(result.code).not.toBe(0);
    expect(await readdir(join(f.root,f.descriptor.id))).toEqual([]);
  });
  test("rejects corrupt file, wrong mode and mismatched manifest on reuse",async()=>{
    for(const damage of ["bytes","mode","manifest"]){
      const f=await fixture();const installed=await activate(f);expect(installed.code).toBe(0);
      if(damage==='mode') await chmod(join(installed.stdout,'bin/node'),0o644);
      else await writeFile(join(installed.stdout,damage==='manifest'?'manifest.json':'bin/node'),'corrupt');
      expect((await activate(f,'-')).code).not.toBe(0);
    }
  });
  test("rejects traversal, absolute, linked and duplicate members before publishing",async()=>{
    for(const kind of ['traversal','absolute','symlink','hardlink','duplicate']){
      const f=await fixture(kind);const result=await activate(f);expect(result.code).not.toBe(0);
      expect(await readdir(f.root)).not.toContain(f.descriptor.id);
      expect(await readdir(f.dir)).not.toContain('escaped');
      expect((await readdir(f.root)).filter(n=>n.includes('.stage-'))).toEqual([]);
    }
  });
  test("rejects archive checksum mismatch",async()=>{
    const f=await fixture();f.descriptor.archiveSha256='0'.repeat(64);
    const result=await activate(f);expect(result.code).not.toBe(0);expect(result.stderr).toContain('archive checksum mismatch');
  });
  test("concurrent independent publishers converge on one complete same-hash directory",async()=>{
    const f=await fixture();const results=await Promise.all(Array.from({length:4},()=>activate(f)));
    expect(results.every(r=>r.code===0)).toBe(true);
    expect(new Set(results.map(r=>r.stdout)).size).toBe(1);
    expect((await readdir(f.root)).filter(n=>!n.startsWith('.'))).toEqual([f.descriptor.id]);
  });
  test("deployer skips SCP on verified hit and keeps SSH host policy",async()=>{
    const f=await fixture(); const prefix=join(f.dir,'python-lsp-linux-arm64');
    await writeFile(prefix+'.json',JSON.stringify(f.descriptor));await writeFile(prefix+'.tar.gz',await readFile(f.archive));
    const commands:string[][]=[];
    const path=await deployLanguagePack("python", {target:'example.com'},'/home/test user','arm64',f.dir,async command=>{
      commands.push(command);return `/home/test user/.cache/omp-ssh-remote/language-packs/python/linux-arm64/${f.descriptor.id}`;
    });
    expect(path).toContain('/home/test user/');expect(commands).toHaveLength(1);expect(commands[0]![0]).toBe('ssh');
    expect(commands[0]).toContain('StrictHostKeyChecking=yes');
  });
  test("local archive checksum mismatch rejects before any SSH or SCP",async()=>{
    const f=await fixture(); const prefix=join(f.dir,'python-lsp-linux-arm64');
    await writeFile(prefix+'.json',JSON.stringify(f.descriptor));
    await writeFile(prefix+'.tar.gz','corrupt archive');
    const commands:string[][]=[];
    await expect(deployLanguagePack("python", {target:'example.com'},'/home/test','arm64',f.dir,async command=>{
      commands.push(command);return '';
    })).rejects.toThrow('Local Python LSP pack archive checksum mismatch');
    expect(commands).toHaveLength(0);
  });
  test("missing pack gives actionable opt-in error",async()=>{
    await expect(deployLanguagePack("python", {target:'example.com'},'/home/test','arm64',work,async()=>'')).rejects.toThrow('prepare-python-lsp.ts arm64');
  });
});

describe("host-only opt-in and worker launch",()=>{
  test("alias opt-in survives structured and slash parsing; direct targets stay unchanged",()=>{
    const hosts=[{name:'fixture',host:'example.com',lsp:{python:true}}];
    expect(parseConnectArgs('fixture /project',hosts).pythonLsp).toBe(true);
    expect(parseConnectOptions({target:'fixture'},hosts).pythonLsp).toBe(true);
    expect(parseConnectArgs('user@example.com /project',hosts).pythonLsp).toBeUndefined();
    expect(parseConnectArgs('fixture',[{...hosts[0]!,lsp:{python:false}}]).pythonLsp).toBeUndefined();
  });
  test("local ssh.json validates opt-in shape",async()=>{
    const dir=await mkdtemp(join(work,'host '));await mkdir(join(dir,'.omp'));
    await writeFile(join(dir,'.omp/ssh.json'),JSON.stringify({hosts:{fixture:{host:'example.com',lsp:{python:true}}}}));
    expect((await loadConfiguredSshHosts(dir)).find(h=>h.name==='fixture')?.lsp).toEqual({python:true});
    for (const lsp of [true, false, null, "python", [], {}, {python:"yes"}, {python:1}, {python:null}, {python:true,pythonPath:"/remote/python"}, {python:true,extra:true}]) {
      await writeFile(join(dir,'.omp/ssh.json'),JSON.stringify({hosts:{fixture:{host:'example.com',lsp}}}));
      await expect(loadConfiguredSshHosts(dir)).rejects.toThrow('invalid lsp');
    }
    for (const python of [true,false]) {
      await writeFile(join(dir,'.omp/ssh.json'),JSON.stringify({hosts:{fixture:{host:'example.com',lsp:{python}}}}));
      const configured = await loadConfiguredSshHosts(dir);
      expect(configured.find(h=>h.name==='fixture')?.lsp).toEqual({python});
      expect(parseConnectArgs('fixture',configured).pythonLsp).toBe(python ? true : undefined);
    }
  });
  test("pack opt-in is not a model-facing or slash-command parameter",()=>{
    expect(()=>parseConnectArgs('fixture --python-lsp true')).toThrow('Unknown option');
    expect(parseConnectOptions({target:'example.com',...{pythonLsp:true,lsp:{python:true}}}).pythonLsp).toBeUndefined();
  });
  test("launch resolves spaces/quotes with process-scoped environment and no PATH mutation",async()=>{
    const dir=await mkdtemp(join(work,"worker's directory "));const worker=join(dir,'worker');
    await writeFile(worker,'#!/bin/sh\nprintf "%s\\n" "${OMP_REMOTE_PYTHON_LSP_PACK-unset}"\n');await chmod(worker,0o755);
    const pack=join(dir,"pack's files");
    for(const enabled of [false,true]){
      const command=buildSshWorkerCommand({target:'example.com',workerPath:worker,...(enabled?{pythonLspPack:pack}:{})}).at(-1)!;
      const p=Bun.spawn(['sh','-c',command],{env:{...process.env,OMP_REMOTE_PYTHON_LSP_PACK:'/ambient/unrequested'},stdout:'pipe',stderr:'pipe'});
      const output=await new Response(p.stdout).text();const errors=await new Response(p.stderr).text();
      expect(await p.exited,errors).toBe(0);expect(output.trim()).toBe(enabled?pack:'unset');
      expect(command).not.toContain('PATH=');
    }
    for (const invalid of ['', 'relative', '/remote\npack', '/remote\rpack', '/remote\0pack']) {
      expect(()=>buildSshWorkerCommand({target:'example.com',workerPath:worker,pythonLspPack:invalid})).toThrow('absolute');
    }
    const enabled=buildSshWorkerCommand({target:'example.com',workerPath:worker,pythonLspPack:pack}).at(-1)!;
    const scoped=Bun.spawn(['sh','-c',`( ${enabled} ); printf '%s\\n' "$OMP_REMOTE_PYTHON_LSP_PACK"`],{
      env:{...process.env,OMP_REMOTE_PYTHON_LSP_PACK:'/ambient/parent'},stdout:'pipe',stderr:'pipe',
    });
    const output=await new Response(scoped.stdout).text();
    expect(await scoped.exited).toBe(0);
    expect(output.trim().split('\n')).toEqual([pack,'/ambient/parent']);
  });
});
