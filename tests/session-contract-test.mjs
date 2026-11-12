import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process'; import test from 'node:test';
import { pinnedSectionId } from '../gateway/protocol.mjs';
import { currentHostContracts } from '../bridge/desktop-current-host-contract.mjs';
import { inspectCurrentHost } from '../bridge/desktop-current-host.mjs';
import { checkNativeSchemas, assertNativeProtocol } from '../bridge/desktop-host-capabilities.mjs';
const executable='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
test('installed CLI passes isolated provider creation, first turn, resume and continued turn', {skip:process.platform!=='darwin'||!fs.existsSync(executable)},()=>{
  const checked=assertNativeProtocol(executable);
  assert.equal(checked.protocolAvailable,true);
  assert.equal(checked.providerBehaviorVerified,true);
});
test('installed protocol exposes the minimal management contract independently of renderer resource names', {skip:process.platform!=='darwin'||!fs.existsSync(executable)},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cc-protocol-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const schema=path.join(root,'schema'),result=spawnSync(executable,['app-server','generate-json-schema','--experimental','--out',schema],{env:{HOME:root,CODEX_HOME:root,PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const files=fs.readdirSync(schema,{recursive:true});
  const read=name=>{const file=files.find(f=>f.endsWith('/'+name+'.json')||f===name+'.json');assert.ok(file,`Missing installed protocol: ${name}`);return JSON.parse(fs.readFileSync(path.join(schema,file),'utf8'));};
  checkNativeSchemas(read);
  assert.throws(()=>checkNativeSchemas(name=>{const value=read(name);if(name==='ThreadResumeParams')delete value.properties.modelProvider;return value;}),/modelProvider missing/);
  assert.throws(()=>checkNativeSchemas(name=>{const value=read(name);if(name==='ThreadStartParams')value.required=['unsupportedNewField'];return value;}),/now requires unsupportedNewField/);
  for(const [name,fields]of Object.entries({ThreadForkParams:['threadId','lastTurnId','beforeTurnId','model','modelProvider','config'],ThreadDeleteParams:['threadId'],ThreadMetadataUpdateParams:['threadId','projectId'],ThreadSectionMoveParams:['threadId','sectionId','beforeThreadId'],ThreadSearchParams:['searchTerm','cursor','limit']})){
    const value=read(name);for(const field of fields)assert.ok(value.properties[field],`${name}.${field} changed; review protocol compatibility`);
  }
  const search=read('ThreadSearchResponse');assert.ok(search.definitions.ThreadSearchResult.properties.thread);assert.ok(search.definitions.ThreadSearchResult.properties.snippet);
  assert.ok(read('ThreadListParams').definitions.ThreadSortKey.enum.includes('section_position'),'Desktop pin lookup needs the installed section_position sort contract');
  const thread=read('ThreadForkResponse').definitions.Thread;assert.ok(thread.properties.forkedFromId);assert.ok(thread.properties.parentThreadId);
  const write=read('ConfigWriteResponse');assert.ok(write.definitions.WriteStatus.enum.includes('okOverridden'));
  assert.deepEqual(write.required.slice().sort(),['filePath','status','version']);
  t.diagnostic('Native pinning uses thread/section/move; no isPinned write is assumed.');
});
test('verified Desktop still persists pins through the native pin service and built-in section', {skip:process.platform!=='darwin'||!fs.existsSync(executable)},()=>{
  const host=inspectCurrentHost('/Applications/ChatGPT.app'),contract=currentHostContracts.find(c=>c.version===host.applicationVersion);assert.ok(contract);
  const file=fs.openSync('/Applications/ChatGPT.app/Contents/Resources/app.asar','r');
  try{
    const prefix=Buffer.alloc(16);fs.readSync(file,prefix,0,16,0);const bytes=Buffer.alloc(prefix.readUInt32LE(12));fs.readSync(file,bytes,0,bytes.length,16);const header=JSON.parse(bytes);
    const read=relative=>{let entry=header;for(const part of relative.split('/'))entry=entry.files[part];assert.ok(entry.size<20*1024*1024&&!entry.unpacked&&!entry.link);const value=Buffer.alloc(entry.size);fs.readSync(file,value,0,value.length,8+prefix.readUInt32LE(4)+Number(entry.offset));return value.toString();};
    const initial=read('webview'+new URL(contract.initialModule).pathname);
    // The app changed from a main bundle to early-bootstrap chunks. Consume
    // the pinning semantics across main-process chunks, not its bundler name.
    const chunks=Object.keys(header.files['.vite'].files.build.files).filter(n=>n.endsWith('.js'));
    const main=chunks.map(name=>read('.vite/build/'+name)).join('\n');
    assert.ok(initial.includes('pinnedThreads()'),'Pin service seam changed');assert.ok(main.includes('thread/section/move'),'Pin protocol seam changed');
    assert.ok(main.includes(pinnedSectionId),'Native built-in pin section changed');assert.ok(main.includes('PINNED_THREAD_IDS'),'Native sidebar persistence seam changed');
    assert.match(main,/sortKey:["`]section_position["`]/,'Native pin list query changed');
  }finally{fs.closeSync(file);}
});
