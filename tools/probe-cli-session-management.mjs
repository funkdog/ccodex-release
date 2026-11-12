// Real Copilot runtime, isolated profile and workspace. Never connects to the
// production gateway/Desktop or replays tools. Five bounded, text-only turns.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto'; import { pathToFileURL } from 'node:url';
import { copilotEngine } from '../gateway/engines/github-copilot.mjs';
import { cliEnvironment } from '../gateway/engines/index.mjs';
import { startGateway } from '../gateway/server.mjs';
export async function probeSessionManagement(connectionFile) {
  const configured=JSON.parse(fs.readFileSync(connectionFile,'utf8')).engines.find(e=>e.adapter==='github-copilot');
  if(!configured)throw Error('Configured Copilot SDK is required.');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cc-manage-')), profile=path.join(root,'profile'),home=path.join(root,'gateway'),workspace=path.join(root,'work');
  for(const directory of [profile,home,workspace])fs.mkdirSync(directory,{mode:0o700});
  const report={recordedAt:new Date().toISOString(),temporaryProfiles:true,productionTouched:false,desktopRestarted:false,nativeInferenceTurns:0,cliTurns:0,checks:{},passed:false};
  let gateway;
  try {
    const source=path.join(os.homedir(),'.copilot/config.json'),stat=fs.lstatSync(source);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error('Expected private regular Copilot account config.');
    const account=path.join(profile,'config.json');fs.copyFileSync(source,account);fs.chmodSync(account,0o600);
    const sdk=await import(pathToFileURL(configured.sdkPath).href);
    // Keep the existing OS login context (HOME); baseDirectory/COPILOT_HOME own every
    // test session/config file. No production session is opened.
    const env={...cliEnvironment(),COPILOT_HOME:profile};
    const engine=copilotEngine({env,sdk:{...sdk,CopilotClient:class extends sdk.CopilotClient {constructor(options){super({...options,baseDirectory:profile});}}}});
    const settings={home,endpoint:path.join(root,'s'),token:randomUUID(),generation:'isolated-session-management',defaultEngine:'copilot',engines:new Map([['copilot',{adapter:'github-copilot',...engine}]])};
    const events=[];
    const start=async()=>{gateway=await startGateway(settings);const notify=gateway.protocol.notify;gateway.protocol.notify=(method,params)=>{events.push({method,params});notify(method,params);};};
    await start();
    const call=(method,params={})=>gateway.protocol.handle(method,params,{initialized:true,send(){},request:async()=>({answers:{permission:{answers:['Deny']}}})});
    const catalog=(await call('model/list',{limit:1000})).data;
    const model=catalog.find(m=>/gpt-6\.1-sol$/.test(m.model))??catalog.find(m=>m.inputModalities.includes('text'));
    if(!model)throw Error('No actual text model is available.');
    const effort=model.supportedReasoningEfforts.some(e=>e.reasoningEffort==='low')?'low':model.defaultReasoningEffort;
    report.model=model.model; report.reasoningEffort=effort;
    fs.writeFileSync(path.join(workspace,'project.txt'),'KEEP_PROJECT');
    const {thread:parent}=await call('thread/start',{cwd:workspace,model:model.model,effort,cliApprovalMode:'deny'});
    const send=async(id,prompt,metadata)=>{
      report.cliTurns++;await call('turn/start',{threadId:id,input:[{type:'text',text:prompt+' Do not use any tools, files, shell, delegation or questions.'}]});
      if(metadata)await metadata();
      const active=gateway.protocol.active.get(id),timer=setTimeout(()=>active?.controller.abort(),90000);
      try{await active?.done;}finally{clearTimeout(timer);}
      const saved=gateway.protocol.store.get(id),turn=saved.turns.at(-1);
      assert.equal(turn.status,'completed',turn.error?.message);
      assert.equal(turn.items.some(i=>i.type==='dynamicToolCall'),false,'This probe must not execute tools');
      return turn.items.filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n');
    };
    const nonceA='FIRST_'+randomUUID().slice(0,12),nonceB='SECOND_'+randomUUID().slice(0,12),nonceC='BRANCH_'+randomUUID().slice(0,12);
    await send(parent.id,`Remember first nonce ${nonceA}. Reply only FIRST_OK.`,async()=>{
      await call('thread/name/set',{threadId:parent.id,name:'Isolated session management'});
      await call('thread/metadata/update',{threadId:parent.id,projectId:'isolated-project'});
    });
    await send(parent.id,`Remember a secondary nonce ${nonceB}. Reply only SECOND_OK.`);
    const sourceThread=gateway.protocol.store.get(parent.id);
    assert.equal(sourceThread.name,'Isolated session management');assert.equal(sourceThread.projectId,'isolated-project');
    assert.ok(sourceThread.turns[1].nativeStartEventId,'New real turns must record their runtime event boundaries');
    const {thread:branch}=await call('thread/fork',{threadId:parent.id,lastTurnId:sourceThread.turns[0].id,excludeTurns:true});
    const branchSession=gateway.protocol.store.get(branch.id).nativeSessionId;
    assert.notEqual(branchSession,sourceThread.nativeSessionId);report.checks.runtimeCloneHasIndependentIdentity=true;
    assert.equal(report.cliTurns,2,'A fork must not submit or replay a turn');
    // The SDK fork's immutable prefix must preserve the event identities used
    // for a future fork of this fork as well.
    const inspector=new sdk.CopilotClient({env,baseDirectory:profile,connection:sdk.RuntimeConnection.forStdio({}),logLevel:'error'});
    try{await inspector.start();const session=await inspector.resumeSession(branchSession,{model:model.model.slice('copilot/'.length),onPermissionRequest:async()=>({kind:'reject'})});
      try{assert.ok((await session.getEvents()).some(event=>event.id===sourceThread.turns[0].nativeStartEventId));report.checks.clonedPrefixEventIdsRetained=true;}finally{await session.disconnect();}
    }finally{await inspector.stop();}
    await call('thread/name/set',{threadId:branch.id,name:'Branch title lookup'});
    await call('thread/metadata/update',{threadId:branch.id,projectId:null});
    const pin='01984de2-8f74-7c91-a3b2-5c5e937cf318';await call('thread/section/move',{threadId:branch.id,sectionId:pin});
    await gateway.close();await start();
    assert.equal((await call('thread/search',{searchTerm:'branch title'})).data[0].thread.id,branch.id);
    assert.equal((await call('thread/list',{sectionId:pin})).data[0].id,branch.id);
    await call('thread/section/move',{threadId:branch.id,sectionId:null});
    await call('thread/archive',{threadId:branch.id});assert.ok((await call('thread/list',{archived:true})).data.some(t=>t.id===branch.id));
    await call('thread/unarchive',{threadId:branch.id});
    const a=await send(branch.id,`Remember branch-only secret ${nonceC}. Reply with the FIRST nonce I previously gave you. Then state SECOND_NOT_SEEN if I never gave a secondary nonce in this branch.`);
    assert.ok(a.includes(nonceA));assert.ok(a.includes('SECOND_NOT_SEEN'));assert.equal(a.includes(nonceB),false);
    const b=await send(parent.id,'Reply with the most recent SECONDARY nonce I gave you, followed by BRANCH_UNKNOWN if I never gave a branch-only secret.');
    assert.ok(b.includes(nonceB));assert.ok(b.includes('BRANCH_UNKNOWN'));assert.equal(b.includes(nonceC),false);
    await call('thread/delete',{threadId:parent.id});
    await gateway.close();await start();
    const c=await send(branch.id,'Reply only with the branch-only secret I gave you previously.');assert.ok(c.includes(nonceC));
    const final=gateway.protocol.store.get(branch.id);assert.equal(final.nativeSessionId,branchSession);assert.equal(final.cliApprovalMode,'deny');assert.equal(final.reasoningEffort,effort);assert.equal(final.projectId,null);
    await call('thread/delete',{threadId:branch.id});assert.deepEqual((await call('thread/list',{})).data,[]);
    assert.equal(fs.readFileSync(path.join(workspace,'project.txt'),'utf8'),'KEEP_PROJECT');
    report.checks={...report.checks,selectedTurnContext:true,futureBranchesIsolated:true,parentDeletionDoesNotDeleteFork:true,coldResume:true,renameDuringRun:true,projectClear:true,pinUnpin:true,titleSearch:true,archiveRestore:true,permanentDeletion:true,projectFilesPreserved:true,policiesRetained:true};
    report.passed=true;
  }catch(error){report.error=error.message;}
  finally{await gateway?.close();for(const dir of [profile,home,workspace])fs.rmSync(dir,{recursive:true,force:true});report.privateStateRemoved=true;}
  const reportFile=path.join(root,'report.json');fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});return {reportFile,...report};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
  const result=await probeSessionManagement(process.argv[2]);console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
