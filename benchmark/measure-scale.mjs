#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {getEncoding} from 'js-tiktoken';
import {createFixtures} from './fixtures.mjs';
import {createScaleConfig} from './scale-fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const work=path.resolve(process.argv[2] ?? '.local/scale-measurement');
const out=path.resolve(process.argv[3] ?? 'benchmark/results/scale-v7');
const gatewayEntry=path.resolve(process.argv[4] ?? 'dist/cli.js');
const enc=getEncoding('o200k_base');
const records=[];
const rawCases=[];
await fs.mkdir(out,{recursive:true});
async function connect(command,args,env={}) {
 const client=new Client({name:'scale-measurement',version:'1.0.0'});
 const transport=new StdioClientTransport({command,args,env,stderr:'ignore'});
 try {await client.connect(transport,{signal:AbortSignal.timeout(60000)});return {client,transport};}
 catch(error){await transport.close().catch(()=>{});throw error;}
}
async function allTools(client) {
 const tools=[];let cursor;
 do {const page=await client.listTools(cursor?{cursor}:{},{signal:AbortSignal.timeout(60000)});tools.push(...page.tools);cursor=page.nextCursor;}while(cursor);
 return tools;
}
for(const count of [2,8,16,32]) {
 const scope=path.join(work,`servers-${count}`);
 await createFixtures(path.join(scope,'fixtures'));
 for(const mode of ['direct','gateway-default','gateway-native']) {
  const dir=path.join(scope,mode);await fs.mkdir(dir,{recursive:true});
  await fs.copyFile(path.join(scope,'fixtures/memory.jsonl'),path.join(dir,'memory.jsonl'));
  const {gatewayConfig}=await createScaleConfig(scope,dir,count/2,mode==='gateway-native');
  const connected=[];const started=performance.now();let tools,discovered,upstreamLists=[];
  try {
   if(mode==='direct') {
    const servers=Object.entries(gatewayConfig.servers);
    for(let i=0;i<servers.length;i+=4) {
     const chunk=await Promise.allSettled(servers.slice(i,i+4).map(async([name,s])=>{
      const connection=await connect(s.command,s.args??[],s.env??{});connected.push(connection);
      return {name,...connection};
     }));
     const error=chunk.find(x=>x.status==='rejected');if(error)throw error.reason;
     for(const entry of chunk)if(entry.status==='fulfilled')upstreamLists.push({name:entry.value.name,client:entry.value.client});
    }
    for(let i=0;i<upstreamLists.length;i+=4)await Promise.all(upstreamLists.slice(i,i+4).map(async item=>{item.tools=await allTools(item.client);}));
    tools=upstreamLists.flatMap(({name,tools})=>tools.map(t=>({name:`${name}__${t.name}`,description:t.description,inputSchema:t.inputSchema}))).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    discovered=tools.length;
   } else {
    const configPath=path.join(dir,'gateway.json');await fs.writeFile(configPath,JSON.stringify(gatewayConfig));
    const connection=await connect(process.execPath,[gatewayEntry,'--config',configPath,'serve']);connected.push(connection);
    tools=await allTools(connection.client);
   }
   const listSetupMs=performance.now()-started;
   if(mode!=='direct') {
    const search=await connected[0].client.callTool({name:'search',arguments:{limit:1}},undefined,{signal:AbortSignal.timeout(60000)});
    if(search.isError)throw new Error('Gateway discovery failed');
    const parsed=JSON.parse(search.content.find(c=>c.type==='text').text);
    if(parsed.unavailableCount)throw new Error(`Unavailable upstreams: ${parsed.unavailableCount}`);
    discovered=parsed.matched;
   }
   const primary=records.find(r=>r.serverCount===count&&r.mode==='direct');
   if(primary&&primary.upstreamToolCount!==discovered)throw new Error('Gateway did not discover the complete configured catalogue');
   if(mode==='direct') {
    const sizes=upstreamLists.filter(x=>['filesystem','memory'].includes(x.name)).map(x=>x.tools.length);
    if(sizes.length!==2||sizes.reduce((a,b)=>a+b,0)*(count/2)!==discovered)throw new Error('Unexpected upstream tool counts');
   }
   const json=JSON.stringify({tools});
   const record={serverCount:count,distinctServerImplementations:2,mode,upstreamToolCount:discovered,advertisedTools:tools.length,definitionBytes:Buffer.byteLength(json),definitionTokenProxy:enc.encode(json).length,listSetupMs:Math.round(listSetupMs),definitionSha256:createHash('sha256').update(json).digest('hex')};
   records.push(record);
   rawCases.push({...record,definitions:{tools},upstreamRawLists:upstreamLists.map(x=>({server:x.name,tools:x.tools})),config:gatewayConfig});
   console.log(JSON.stringify(record));
  } finally {await Promise.allSettled(connected.map(c=>c.transport.close()));}
 }
}
const archive=gzipSync(JSON.stringify({formatVersion:1,encoding:'o200k_base',cases:rawCases}));
await fs.writeFile(path.join(out,'catalogs.json.gz'),archive);
const summary={generatedAt:new Date().toISOString(),gatewayEntry,records,catalogArchiveSha256:createHash('sha256').update(archive).digest('hex'),caveats:['Real official stdio processes replicated as isolated endpoints; only two server implementations, not 32 distinct vendors.','Definitions are serialized tools/list payloads, not provider-reported model context.','Direct comparable payload retains name, description and inputSchema as in the agent harness; complete original SDK listings are retained in the audit archive.','Startup includes real process connection and listing; tokenization and shutdown are excluded. No latency significance claim from a single catalogue sample.']};
await fs.writeFile(path.join(out,'catalog-summary.json'),JSON.stringify(summary,null,2)+'\n');
const fields=['serverCount','distinctServerImplementations','mode','upstreamToolCount','advertisedTools','definitionBytes','definitionTokenProxy','listSetupMs','definitionSha256'];
await fs.writeFile(path.join(out,'catalog.csv'),[fields.join(','),...records.map(r=>fields.map(f=>r[f]).join(','))].join('\n')+'\n');
