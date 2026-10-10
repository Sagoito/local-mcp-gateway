#!/usr/bin/env node
// Diagnostic timings only. Does not change the gateway or inspect relevance labels.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGateway, searchCatalog } from '../dist/server.js';

const [datasetPath, outputPath] = process.argv.slice(2);
if (!datasetPath || !outputPath) throw Error('Usage: node benchmark/search-diagnostic.mjs DATASET OUTPUT');
const bytes = await readFile(datasetPath), data = JSON.parse(bytes);
const tools = data.tools.map(t => ({server:'public',name:t.name,description:t.description,inputSchema:{type:'object',properties:{}}}));
const categories = [...new Set(data.queries.map(q => q.category))].sort();
// Deterministic 5-per-category spread across accepted inputs. No qrels used.
const queries = categories.flatMap(category => {
  const eligible = data.queries.filter(q => q.category === category && q.query.length <= 500);
  return Array.from({length:Math.min(5,eligible.length)}, (_,i) => eligible[Math.floor((i + .5) * eligible.length / 5)]);
});
const upstreams = {listTools:async()=>tools,callTool:async()=>{throw Error('Disabled');},close:async()=>{}};
const server = createGateway(upstreams,undefined,tools,()=>[],()=>[]);
const client = new Client({name:'search-diagnostic',version:'1'});
const [ct,st] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(ct),server.connect(st)]);
const rows=[];
try {
  for (const q of queries.slice(0,3)) searchCatalog(tools,{query:q.query,limit:10,includeSchema:false});
  for (let repetition=0;repetition<2;repetition++) {
    for (const q of queries) {
      const args={query:q.query,limit:10,includeSchema:false};
      let direct, sdk, directMs, sdkMs;
      const directCall=()=>{const start=performance.now();direct=searchCatalog(tools,args);directMs=performance.now()-start;};
      const sdkCall=async()=>{const start=performance.now();const r=await client.callTool({name:'search',arguments:args});sdkMs=performance.now()-start;if(r.isError)throw Error('SDK error');sdk=JSON.parse(r.content[0].text);};
      if(repetition===0){directCall();await sdkCall();}else{await sdkCall();directCall();}
      if(JSON.stringify(direct)!==JSON.stringify(sdk))throw Error('Direct/SDK result mismatch');
      const terms=q.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const serverTerms=new Set(['public']);
      const filtered=terms.some(t=>!serverTerms.has(t))?terms.filter(t=>!serverTerms.has(t)):terms;
      // Measure evidence of score ties in returned candidates, not accuracy.
      const winnerScores=direct.results.map(t=>{
        const original=tools.find(x=>x.name===t.name);
        const name=`${original.server} ${original.name}`.toLowerCase().split(/[^a-z0-9]+/).join(' ');
        const description=original.description.toLowerCase();
        return filtered.reduce((n,term)=>n+(name.includes(term)?3:description.includes(term)?1:0),0)-(/\bdeprecated\b/i.test(`${original.name} ${description}`)?2:0);
      });
      rows.push({queryId:q.id,querySha256:createHash('sha256').update(q.query).digest('hex'),category:q.category,repetition,directMs,sdkMs,matched:direct.matched,uniqueTopTenScores:new Set(winnerScores).size});
    }
  }
} finally {await client.close();await server.close();}
const stats=key=>{const v=rows.map(r=>r[key]).sort((a,b)=>a-b);return {p50:v[Math.ceil(v.length*.5)-1],p95:v[Math.ceil(v.length*.95)-1],mean:v.reduce((a,b)=>a+b,0)/v.length};};
const output={createdAt:new Date().toISOString(),datasetSha256:createHash('sha256').update(bytes).digest('hex'),compiledServerSha256:createHash('sha256').update(await readFile(new URL('../dist/server.js',import.meta.url))).digest('hex'),tools:tools.length,queries:queries.length,callsPerCondition:rows.length,selection:'five evenly spaced accepted queries per category; two repetitions with reversed condition order; no relevance labels inspected',scope:'cached upstream, in-memory SDK, no config file IO, refresh, execution, LLM or billing; diagnostic sample only',directSearchMs:stats('directMs'),sdkRoundTripMs:stats('sdkMs'),matched:stats('matched'),uniqueTopTenScores:stats('uniqueTopTenScores'),memory:process.memoryUsage(),rows};
await mkdir(new URL('.',`file://${outputPath.startsWith('/')?outputPath:process.cwd()+'/'+outputPath}`),{recursive:true});
await writeFile(outputPath,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({...output,rows:undefined},null,2));
