import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const PILOT_ORGANIZATION_ID = '00605bb8-3899-406e-a428-d7779e856bb2';
const OIDC_AUDIENCE = 'emcore-live-pilot-smoke';
const routes = ['overview','documents','supplies','analysis','actions','markets','practices','deadlines','fiscality'];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing required environment variable: ' + name);
  return value;
}
function decodeBase32(value) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized=String(value).toUpperCase().replace(/=+$/g,'').replace(/\s+/g,'');
  let bits='';
  for (const char of normalized) {
    const idx=alphabet.indexOf(char);
    if (idx < 0) throw new Error('Invalid base32 secret');
    bits += idx.toString(2).padStart(5,'0');
  }
  const bytes=[];
  for(let i=0;i+8<=bits.length;i+=8) bytes.push(Number.parseInt(bits.slice(i,i+8),2));
  return Buffer.from(bytes);
}
function deriveTotp(secret) {
  const counter=BigInt(Math.floor(Date.now()/1000/30));
  const message=Buffer.alloc(8); message.writeBigUInt64BE(counter);
  const digest=createHmac('sha1',decodeBase32(secret)).update(message).digest();
  const offset=digest[digest.length-1]&0x0f;
  const binary=((digest[offset]&0x7f)<<24)|((digest[offset+1]&0xff)<<16)|((digest[offset+2]&0xff)<<8)|(digest[offset+3]&0xff);
  return String(binary % 1_000_000).padStart(6,'0');
}
async function githubOidcToken() {
  const url=required('ACTIONS_ID_TOKEN_REQUEST_URL');
  const token=required('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  const response=await fetch(url+(url.includes('?')?'&':'?')+'audience='+encodeURIComponent(OIDC_AUDIENCE),{headers:{authorization:'Bearer '+token}});
  if(!response.ok) throw new Error('GitHub OIDC request failed: '+response.status);
  const body=await response.json();
  if(typeof body?.value!=='string') throw new Error('GitHub OIDC token missing');
  return body.value;
}
async function bootstrap(url, oidc, action, userId) {
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+oidc,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({action,userId})});
  if(!response.ok) throw new Error('Bootstrap '+action+' failed: '+response.status);
  return response.json();
}
async function runtimeConfig(baseUrl) {
  const response=await fetch(baseUrl+'/api/runtime-config',{headers:{accept:'application/json'}});
  if(!response.ok) throw new Error('runtime-config failed: '+response.status);
  const body=await response.json();
  if(body.authMode!=='magic_link_mfa' || body.applicationSurfaceMode!=='PILOT' || body.documentIngestionEnabled!==false || body.allowedOrganizationId!==PILOT_ORGANIZATION_ID) {
    throw new Error('PILOT runtime safety contract mismatch');
  }
  return body;
}
async function deploymentIdentity(baseUrl, expectedCommit) {
  const response=await fetch(baseUrl+'/api/deployment-identity',{headers:{accept:'application/json'}});
  if(!response.ok) throw new Error('deployment-identity failed: '+response.status);
  const body=await response.json();
  if(body.commitSha!==expectedCommit) throw new Error('deployed commit mismatch');
}
async function waitFor(fn, timeout=15000) {
  const started=Date.now();
  while(Date.now()-started<timeout) {
    try { if(await fn()) return; } catch {}
    await new Promise(r=>setTimeout(r,180));
  }
  throw new Error('Timed out waiting for browser state');
}
async function openPage(baseUrl) {
  const chrome=spawn('/usr/bin/google-chrome',[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9223',
    '--user-data-dir=/tmp/emcore-owner-acceptance-chrome','about:blank'
  ],{stdio:'ignore'});
  await waitFor(async()=>{try{return (await fetch('http://127.0.0.1:9223/json/version')).ok}catch{return false}});
  const response=await fetch('http://127.0.0.1:9223/json/new?'+encodeURIComponent(baseUrl),{method:'PUT'});
  if(!response.ok) throw new Error('Unable to create Chrome target');
  const target=await response.json();
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
  let seq=0; const pending=new Map();
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(String(event.data));
    if(!msg.id) return;
    const p=pending.get(msg.id); if(!p) return;
    pending.delete(msg.id);
    if(msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
  await send('Page.enable'); await send('Runtime.enable');
  const evalJs=async(expression)=>{
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails) {
      const detail=result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown browser exception';
      throw new Error('Browser expression failed: '+detail);
    }
    return result.result?.value;
  };
  const close=()=>{try{ws.close()}catch{} try{chrome.kill('SIGTERM')}catch{}};
  return {send,evalJs,close};
}
async function setViewport(browser,width,height,mobile) {
  await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:height});
}
async function screenshot(browser,file) {
  const shot=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  await writeFile(file,Buffer.from(shot.data,'base64'));
}
async function waitForPortal(browser) {
  await waitFor(async()=>await browser.evalJs("Boolean(document.querySelector('.emcore-v02') && document.querySelector('[data-pilot-synthetic-owner-test]'))"),20000);
  const bad=await browser.evalJs("document.body.innerText.includes('READ MODEL NON COLLEGATO') || document.body.innerText.includes('Situazione regolare')");
  if(bad) throw new Error('Owner-rejected copy visible in deployed candidate');
}
async function openRoute(browser,route) {
  await browser.evalJs(route==='overview' ? "location.hash=''; window.dispatchEvent(new HashChangeEvent('hashchange'))" : "location.hash='#"+route+"'; window.dispatchEvent(new HashChangeEvent('hashchange'))");
  await new Promise(r=>setTimeout(r,280));
  const overflow=await browser.evalJs("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1");
  if(overflow) throw new Error('Horizontal document overflow on '+route);
}
async function main() {
  const baseUrl=required('EMCORE_PILOT_BASE_URL').replace(/\/$/,'');
  const expectedCommit=required('EMCORE_PILOT_EXPECTED_COMMIT');
  const bootstrapUrl=required('EMCORE_PILOT_BOOTSTRAP_URL');
  const outDir=required('EMCORE_OWNER_ACCEPTANCE_OUTPUT_DIR');
  await mkdir(outDir,{recursive:true});
  await deploymentIdentity(baseUrl,expectedCommit);
  const runtime=await runtimeConfig(baseUrl);
  const oidc=await githubOidcToken();
  let synthetic;
  let browser;
  try {
    synthetic=await bootstrap(bootstrapUrl,oidc,'setup');
    if(synthetic?.organizationId!==PILOT_ORGANIZATION_ID || typeof synthetic?.email!=='string' || typeof synthetic?.password!=='string' || typeof synthetic?.userId!=='string') throw new Error('Invalid synthetic bootstrap envelope');
    const supabase=createClient(runtime.supabaseUrl,runtime.supabasePublishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const signIn=await supabase.auth.signInWithPassword({email:synthetic.email,password:synthetic.password});
    if(signIn.error || !signIn.data.session) throw new Error('Synthetic sign-in failed');
    const enrollment=await supabase.auth.mfa.enroll({factorType:'totp',friendlyName:'EMCORE owner acceptance screenshots'});
    const factorId=enrollment.data?.id, secret=enrollment.data?.totp?.secret;
    if(enrollment.error || typeof factorId!=='string' || typeof secret!=='string') throw new Error('TOTP enrollment failed');
    const challenge=await supabase.auth.mfa.challenge({factorId});
    if(challenge.error || typeof challenge.data?.id!=='string') throw new Error('TOTP challenge failed');
    const verification=await supabase.auth.mfa.verify({factorId,challengeId:challenge.data.id,code:deriveTotp(secret)});
    if(verification.error) throw new Error('TOTP verification failed');
    const session=(await supabase.auth.getSession()).data.session;
    if(!session?.access_token || !session?.refresh_token) throw new Error('AAL2 session missing');

    browser=await openPage(baseUrl);
    const expectedOrigin=new URL(baseUrl).origin;
    await waitFor(async()=>await browser.evalJs("location.origin==="+JSON.stringify(expectedOrigin)+" && document.readyState !== 'loading'"),20000);
    const ref=new URL(runtime.supabaseUrl).hostname.split('.')[0];
    const storageKey='sb-'+ref+'-auth-token';
    await browser.evalJs("localStorage.setItem("+JSON.stringify(storageKey)+","+JSON.stringify(JSON.stringify(session))+"); true");
    await browser.send('Page.reload',{ignoreCache:true});
    await waitForPortal(browser);

    for(const [profile,width,height,mobile] of [['desktop',1365,900,false],['mobile',390,844,true]]) {
      await setViewport(browser,width,height,mobile);
      for(const route of routes) {
        await openRoute(browser,route);
        await screenshot(browser,outDir+'/'+profile+'-'+route+'.png');
      }
    }
    const manifest={
      schema:'emcore.owner-acceptance-screenshot-pack.v1',
      generatedAt:new Date().toISOString(),
      deployedCommit:expectedCommit,
      deployedTree:required('EMCORE_PILOT_EXPECTED_TREE'),
      pilotBaseUrl:baseUrl,
      organizationId:PILOT_ORGANIZATION_ID,
      syntheticTestContext:true,
      customerDataUsed:false,
      documentIngestionEnabled:false,
      viewports:{desktop:'1365x900',mobile:'390x844'},
      routes,
      screenshots:routes.flatMap(route=>['desktop-'+route+'.png','mobile-'+route+'.png']),
    };
    await writeFile(outDir+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');
    console.log('OWNER_ACCEPTANCE_SCREENSHOT_PACK=PASS');
  } finally {
    browser?.close();
    if(synthetic?.userId) await bootstrap(bootstrapUrl,oidc,'cleanup',synthetic.userId);
  }
}
main().catch(error=>{console.error(error instanceof Error ? error.message : String(error));process.exit(1)});
