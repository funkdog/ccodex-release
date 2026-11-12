import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import test from 'node:test';
import { GatewayProtocol } from '../gateway/protocol.mjs';
import { ThreadStore, readThreadOwnership } from '../gateway/state.mjs';
const connection = { initialized: true, send() {}, request: async () => ({ answers: { permission: { answers: ['Deny'] } } }) };
function fixture(t, adapter = {}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cc-session-')), directory=path.join(home,'threads'), events=[];
  const engine={ adapter:'fixture', supportsModelSwitch:true, approvalModes:['ask','auto','deny'], models:async()=>[{id:'model',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'high'}], run:async({onSession,onText})=>{onSession('source-cli-session');onText('answer');}, ...adapter };
  let protocol;
  const restart=()=>protocol=new GatewayProtocol({home,store:new ThreadStore(directory),engines:new Map([['cli',engine]]),defaultEngine:'cli',notify:(method,params)=>events.push({method,params})});restart();
  t.after(async()=>{await protocol.close();fs.rmSync(home,{recursive:true,force:true});});
  const call=(method,params={})=>protocol.handle(method,params,connection);
  const create=async()=> (await call('thread/start',{cwd:home,model:'cli/model',cliApprovalMode:'deny'})).thread;
  const send=async threadId=>{await call('turn/start',{threadId,input:[{type:'text',text:'hello'}]});await protocol.active.get(threadId)?.done;};
  return {home,directory,engine,events,call,create,send,restart,get protocol(){return protocol;}};
}
test('running execution cannot overwrite rename, project removal or pin changes, including session acknowledgement', async t=>{
  let enter,release; const began=new Promise(r=>enter=r),hold=new Promise(r=>release=r);
  const f=fixture(t,{run:async({onSession,onText})=>{enter();await hold;onSession('source-cli-session');onText('done');}});t.after(()=>release());
  const thread=await f.create();await f.call('thread/metadata/update',{threadId:thread.id,projectId:'project-a'});
  await f.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'hello'}]});await began;
  try {
    await f.call('thread/name/set',{threadId:thread.id,name:'renamed during run'});
    await f.call('thread/metadata/update',{threadId:thread.id,projectId:null});
    await f.call('thread/section/move',{threadId:thread.id,sectionId:'01984de2-8f74-7c91-a3b2-5c5e937cf318'});
  } finally {release();}
  await f.protocol.active.get(thread.id)?.done;
  await f.protocol.close();f.restart();
  const saved=(await f.call('thread/read',{threadId:thread.id})).thread;
  assert.equal(saved.name,'renamed during run');assert.equal(saved.projectId,null);
  assert.equal(saved.section.id,'01984de2-8f74-7c91-a3b2-5c5e937cf318');assert.equal(saved.turns[0].status,'completed');
  assert.equal(f.protocol.store.get(thread.id).nativeSessionId,'source-cli-session');
});
test('project omission preserves membership, explicit null and empty clear it',async t=>{
  const f=fixture(t),thread=await f.create();
  await f.call('thread/metadata/update',{threadId:thread.id,projectId:'project'});
  await f.call('thread/metadata/update',{threadId:thread.id,daybreakEnabled:false});
  assert.equal((await f.call('thread/read',{threadId:thread.id})).thread.projectId,'project');
  await f.call('thread/metadata/update',{threadId:thread.id,projectId:null});
  assert.equal((await f.call('thread/read',{threadId:thread.id})).thread.projectId,null);
});
test('archive stops an active turn before acknowledging, unarchive and metadata survive restart',async t=>{
  let started;const began=new Promise(r=>started=r);
  const f=fixture(t,{run:async({signal,onSession})=>{onSession('source-cli-session');started();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}}), thread=await f.create();
  await f.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'hold'}]});await began;
  await f.call('thread/archive',{threadId:thread.id});assert.equal(f.protocol.active.has(thread.id),false);
  await f.protocol.close();f.restart();
  assert.equal((await f.call('thread/list',{archived:true})).data[0].id,thread.id);
  await f.call('thread/unarchive',{threadId:thread.id});assert.equal((await f.call('thread/list',{})).data[0].id,thread.id);
});
test('delete leaves no transcript and durable routing ownership, never removes project files or independent forks',async t=>{
  const removed=[];const f=fixture(t,{deleteSession:async({nativeSessionId})=>removed.push(nativeSessionId)}), thread=await f.create(),other=await f.create();
  await f.send(thread.id);fs.writeFileSync(path.join(f.home,'project.txt'),'keep');
  await f.call('thread/delete',{threadId:thread.id});
  assert.deepEqual(removed,['source-cli-session']);assert.equal(fs.readFileSync(path.join(f.home,'project.txt'),'utf8'),'keep');
  assert.equal(readThreadOwnership(f.directory,thread.id).engineId,'cli');
  await f.protocol.close();f.restart();
  assert.deepEqual((await f.call('thread/list',{})).data.map(t=>t.id),[other.id]);
  await assert.rejects(f.call('thread/read',{threadId:thread.id}),/deleted/);
  await assert.rejects(f.call('thread/unarchive',{threadId:thread.id}),/deleted/);
  assert.equal(fs.readFileSync(path.join(f.directory,thread.id+'.json'),'utf8').includes('answer'),false);
  await f.call('thread/delete',{threadId:thread.id});assert.equal(removed.length,1);
});
test('title search uses native search result envelopes and finds archived renamed chats after restart',async t=>{
  const f=fixture(t), thread=await f.create();await f.send(thread.id);
  await f.call('thread/name/set',{threadId:thread.id,name:'项目 Alpha'});await f.call('thread/archive',{threadId:thread.id});
  await f.protocol.close();f.restart();
  const page=await f.call('thread/search',{searchTerm:'alpha',archived:true});
  assert.equal(page.data[0].thread.id,thread.id);assert.equal(typeof page.data[0].snippet,'string');
  assert.deepEqual((await f.call('thread/search',{searchTerm:'answer',archived:true})).data,[],'Full transcript search is not part of this feature');
});
test('native sidebar pin section round-trips through move/read/list/unpin without isPinned',async t=>{
  const f=fixture(t), thread=await f.create(), sectionId='01984de2-8f74-7c91-a3b2-5c5e937cf318';
  await f.call('thread/section/move',{threadId:thread.id,sectionId});
  await f.protocol.close();f.restart();assert.equal((await f.call('thread/list',{sectionId})).data[0].id,thread.id);
  await f.call('thread/section/move',{threadId:thread.id,sectionId:null});assert.deepEqual((await f.call('thread/list',{sectionId})).data,[]);
});

test('Desktop pin discovery reads section_position order and pagination after gateway restart',async t=>{
  const f=fixture(t), first=await f.create(), second=await f.create();await f.create();
  const sectionId='01984de2-8f74-7c91-a3b2-5c5e937cf318';
  await f.call('thread/section/move',{threadId:second.id,sectionId});
  await f.call('thread/section/move',{threadId:first.id,sectionId,beforeThreadId:second.id});
  await f.protocol.close();f.restart();
  // Observed ThreadSectionEngine.listHostSectionThreadIds query, not an ordinary recency list.
  const query={cursor:null,limit:1,modelProviders:[],sectionId,sortKey:'section_position',sourceKinds:['appServer'],useStateDbOnly:true};
  const page=await f.call('thread/list',query);assert.deepEqual(page.data.map(t=>t.id),[first.id]);assert.ok(page.nextCursor);
  const tail=await f.call('thread/list',{...query,cursor:page.nextCursor});assert.deepEqual(tail.data.map(t=>t.id),[second.id]);assert.equal(tail.nextCursor,null);
  await f.call('thread/section/move',{threadId:first.id,sectionId:null});
  assert.deepEqual((await f.call('thread/list',{...query,limit:100})).data.map(t=>t.id),[second.id]);
  await assert.rejects(f.call('thread/search',{searchTerm:'',sortKey:'section_position'}),/sort/);
});

test('fork clones CLI context at the chosen turn, survives restart, and never shares future context or cascades deletion',async t=>{
  const contexts=new Map(), forks=[], runs=[];let serial=0;
  const f=fixture(t,{supportsForkBoundary:true,
    run:async({nativeSessionId,prompt,onSession,onCheckpoint,onText})=>{
      const id=nativeSessionId||`cli-${++serial}`, history=contexts.get(id)||[];contexts.set(id,history);onSession(id);
      onCheckpoint(`event-${history.length}`);history.push(prompt);runs.push(id);onText(history.join('|'));
    },
    forkSession:async({nativeSessionId,beforeEventId})=>{const id=`cli-${++serial}`;forks.push({nativeSessionId,beforeEventId});
      contexts.set(id,contexts.get(nativeSessionId).slice(0,beforeEventId?Number(beforeEventId.split('-')[1]):undefined));return id;},
    deleteSession:async({nativeSessionId})=>{contexts.delete(nativeSessionId);}});
  const parent=await f.create();const send=async(id,prompt)=>{await f.call('turn/start',{threadId:id,input:[{type:'text',text:prompt}]});await f.protocol.active.get(id)?.done;};
  await send(parent.id,'A');await send(parent.id,'B');const source=f.protocol.store.get(parent.id);
  const response=await f.call('thread/fork',{threadId:parent.id,lastTurnId:source.turns[0].id,excludeTurns:true});
  const branch=response.thread;assert.deepEqual(branch.turns,[]);assert.equal(branch.forkedFromId,parent.id);assert.equal(branch.parentThreadId,null);
  assert.equal(branch.model,parent.model);assert.equal(branch.cliApprovalMode,'deny');assert.equal(branch.reasoningEffort,'high');
  const saved=f.protocol.store.get(branch.id);assert.notEqual(saved.nativeSessionId,source.nativeSessionId);assert.equal(saved.turns.length,1);assert.equal(runs.length,2,'Forking must never replay prompts or tools');
  assert.equal(forks[0].beforeEventId,'event-1');await f.protocol.close();f.restart();
  await send(branch.id,'C');await send(parent.id,'D');
  assert.deepEqual(contexts.get(saved.nativeSessionId),['A','C']);assert.deepEqual(contexts.get(source.nativeSessionId),['A','B','D']);
  await f.call('thread/delete',{threadId:parent.id});assert.deepEqual(contexts.get(saved.nativeSessionId),['A','C']);
  assert.equal((await f.call('thread/resume',{threadId:branch.id})).thread.id,branch.id);
});
test('unsupported/invalid forks never create a display-only branch or substitute a new session',async t=>{
  let forks=0;const f=fixture(t),thread=await f.create();await f.send(thread.id);
  await assert.rejects(f.call('thread/fork',{threadId:thread.id}),/independent|clone|fork/i);
  f.engine.forkSession=async()=>{forks++;return 'source-cli-session';};
  await assert.rejects(f.call('thread/fork',{threadId:thread.id}),/identity|independent/i);
  assert.equal(f.protocol.store.all().length,1);assert.equal(forks,1);
  for(const params of [{lastTurnId:'missing'},{beforeTurnId:'missing'},{lastTurnId:'x',beforeTurnId:'y'},{attachToSource:true},{cwd:'/other'}])
    await assert.rejects(f.call('thread/fork',{threadId:thread.id,...params}));
  assert.equal(f.protocol.store.all().length,1);assert.equal(forks,1);
});
test('deletion waits for cancellation, rejects a racing new turn and cannot be undone by stale execution',async t=>{
  let entered,release;const began=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let signal;
  const f=fixture(t,{run:async c=>{signal=c.signal;c.onSession('source-cli-session');entered();await hold;c.onText('late result');}}), thread=await f.create();t.after(()=>release());
  await f.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'hold'}]});await began;
  const old=f.protocol.store.get(thread.id), pending=f.call('thread/delete',{threadId:thread.id});
  await new Promise(r=>setImmediate(r));assert.equal(signal.aborted,true);
  assert.equal(f.events.some(e=>e.method==='thread/deleted'),false,'Cancellation acknowledgement is not completion');
  await assert.rejects(f.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'race'}]}),/deletion|pending/);
  release();await pending;assert.throws(()=>f.protocol.store.saveExecution(old),/deleted/);
  assert.equal(f.events.filter(e=>e.method==='thread/deleted').length,1);
});
test('failed CLI deletion keeps a durable local tombstone and retries cleanup after restart',async t=>{
  let attempts=0;const f=fixture(t,{deleteSession:async()=>{if(++attempts===1)throw Error('offline');}}),thread=await f.create();await f.send(thread.id);
  await assert.rejects(f.call('thread/delete',{threadId:thread.id}),/deleted locally.*cleanup/);
  assert.deepEqual((await f.call('thread/list',{})).data,[]);await f.protocol.close();f.restart();
  await assert.rejects(f.call('thread/resume',{threadId:thread.id}),/deleted/);
  await f.call('thread/delete',{threadId:thread.id});assert.equal(attempts,2);
  assert.equal(f.protocol.store.deleted.get(thread.id).nativeSessionId,undefined);
});

test('a failed local delete commit preserves the chat and never deletes its CLI context',async t=>{
  let removed=0;const f=fixture(t,{deleteSession:async()=>removed++}),thread=await f.create();await f.send(thread.id);
  const original=f.protocol.store.tombstone;f.protocol.store.tombstone=()=>{throw Error('write failed');};
  await assert.rejects(f.call('thread/delete',{threadId:thread.id}),/write failed/);assert.equal(removed,0);
  assert.equal((await f.call('thread/read',{threadId:thread.id})).thread.id,thread.id);
  f.protocol.store.tombstone=original;
});
test('failed branch persistence cleans only the newly cloned CLI session and preserves the source',async t=>{
  const removed=[];const f=fixture(t,{forkSession:async()=> 'independent-clone',deleteSession:async({nativeSessionId})=>removed.push(nativeSessionId)}), thread=await f.create();await f.send(thread.id);
  const original=f.protocol.store.save.bind(f.protocol.store);f.protocol.store.save=value=>{if(value.id!==thread.id)throw Error('branch write failed');return original(value);};
  await assert.rejects(f.call('thread/fork',{threadId:thread.id}),/branch write failed/);
  assert.deepEqual(removed,['independent-clone']);assert.equal(f.protocol.store.all().length,1);assert.equal(f.protocol.store.get(thread.id).nativeSessionId,'source-cli-session');
});
test('a concurrent fork reserves its source, refuses new turns and leaves project changes intact',async t=>{
  let entered,release;const began=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const f=fixture(t,{forkSession:async()=>{entered();await hold;return 'independent-clone';}}), thread=await f.create();await f.send(thread.id);t.after(()=>release());
  const pending=f.call('thread/fork',{threadId:thread.id});await began;
  await assert.rejects(f.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'racing send'}]}),/pending/);
  await f.call('thread/metadata/update',{threadId:thread.id,projectId:'new-project'});
  release();const branch=(await pending).thread;
  assert.equal(f.protocol.store.get(thread.id).projectId,'new-project');assert.equal(branch.projectId,null,'The fork retains metadata from its admission point');
  assert.equal(f.protocol.active.size,0);
});
test('runtime event checkpoints stay private to the persistence/adapter boundary',async t=>{
  const f=fixture(t,{run:async({onSession,onCheckpoint,onText})=>{onSession('source-cli-session');onCheckpoint('private-event-id');onText('public text');}}), thread=await f.create();await f.send(thread.id);
  assert.equal(f.protocol.store.get(thread.id).turns[0].nativeStartEventId,'private-event-id');
  assert.equal(JSON.stringify(await f.call('thread/read',{threadId:thread.id})).includes('private-event-id'),false);
  assert.equal(JSON.stringify(await f.call('thread/turns/list',{threadId:thread.id,itemsView:'full'})).includes('private-event-id'),false);
  assert.equal(JSON.stringify(f.events).includes('private-event-id'),false);
});

test('removing an adapter defers its archive cleanup without losing routing ownership or the retry identity',async t=>{
  let removed=0;const f=fixture(t,{deleteSession:async()=>removed++}),thread=await f.create();await f.send(thread.id);
  const engine=f.protocol.engines.get('cli');f.protocol.engines.delete('cli');
  await assert.rejects(f.call('thread/delete',{threadId:thread.id}),/deleted locally.*pending/);
  assert.equal(f.protocol.store.deleted.get(thread.id).nativeSessionId,'source-cli-session');assert.equal(readThreadOwnership(f.directory,thread.id).deleted,true);
  f.protocol.engines.set('cli',engine);await f.call('thread/delete',{threadId:thread.id});assert.equal(removed,1);
  assert.equal(f.protocol.store.deleted.get(thread.id).nativeSessionId,undefined);
});
