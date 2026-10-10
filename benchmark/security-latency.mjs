#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Supply the verified dist directory from the v10 audit bundle as the baseline.
const [baselineArg, outputArg = 'benchmark/results/security-v11/latency.json'] = process.argv.slice(2);
if (!baselineArg) throw new Error('Usage: node benchmark/security-latency.mjs BASELINE_DIST [OUTPUT_JSON]');
const baseline = resolve(baselineArg), current = resolve('dist'), output = resolve(outputArg);
const sha = data => createHash('sha256').update(data).digest('hex');
const sourcePaths = ['src/auth.ts','src/cli.ts','src/config.ts','src/policy.ts','src/results.ts','src/sandbox.ts','src/server.ts','src/types.ts','src/upstreams.ts','src/search.ts'];
const hashFiles = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path,sha(await readFile(path))])));
const sourceHashes = await hashFiles(sourcePaths);
const runnerHash = sha(await readFile(new URL(import.meta.url)));
const baselineHashes = await hashFiles(['server.js','upstreams.js','config.js','search.js'].map(file => join(baseline,file)));
const beforeHashes = await hashFiles(['server.js','upstreams.js','config.js','search.js'].map(file => join(current,file)));
const dir = await mkdtemp(join(tmpdir(),'local-mcp-security-latency-'));
const fixture = resolve('examples/discovery-fixture.mjs');
const configPath = join(dir,'config.json');
const config = {version:1,inlineTools:[],servers:{fixture:{command:process.execPath,args:[fixture,'5000','normal']}}};
await writeFile(configPath,JSON.stringify(config));
const observations=[];
const orders=[['baseline','current'],['current','baseline'],['baseline','current'],['current','baseline']];
const payload={name:'execute',arguments:{call:{server:'fixture',tool:'tool1',args:{value:1}}}};
const search={name:'search',arguments:{query:'xxxxxxxx',includeSchema:false,limit:3}};
const text = result => result.content.find(block=>block.type==='text')?.text;
try {
  for(let pair=0;pair<orders.length;pair++) for(const condition of orders[pair]) {
    const cli=join(condition==='baseline'?baseline:current,'cli.js');
    const client=new Client({name:'security-latency',version:'1.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:[cli,'--config',configPath,'serve'],stderr:'ignore'});
    const calls=[];
    try {
      await client.connect(transport);
      const definitions=(await client.listTools()).tools;
      assert.deepEqual(definitions.map(tool=>tool.name).sort(),['execute','search']);
      for(let i=0;i<20;i++) {await client.callTool(search);await client.callTool(payload);}
      // Alternate operations to include real upstream forwarding and broad-posting search.
      for(let i=0;i<200;i++) {
        const operation=i%2?'call':'search';
        const start=performance.now();
        const result=await client.callTool(operation==='call'?payload:search);
        const elapsedMs=performance.now()-start;
        assert.notEqual(result.isError,true,text(result));
        const value=JSON.parse(text(result));
        if(operation==='search') {assert.equal(value.matched,5000);assert.equal(value.results.length,3);}
        else assert.equal(value,'tool1');
        calls.push({operation,elapsedMs});
      }
      observations.push({pair,condition,definitionBytes:Buffer.byteLength(JSON.stringify(definitions)),calls});
      process.stderr.write(`Completed pair ${pair+1}: ${condition}\n`);
    } finally {await client.close();}
  }
  const summary={};
  for(const condition of ['baseline','current']) {
    summary[condition]={};
    for(const operation of ['search','call']) {
      const values=observations.filter(run=>run.condition===condition).flatMap(run=>run.calls.filter(call=>call.operation===operation).map(call=>call.elapsedMs)).sort((a,b)=>a-b);
      const percentile=p=>values[Math.ceil(p*values.length)-1];
      summary[condition][operation]={count:values.length,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:values.at(-1)};
    }
  }
  const afterHashes=await hashFiles(Object.keys(beforeHashes));
  assert.deepEqual(afterHashes,beforeHashes);
  assert.equal(sha(await readFile(new URL(import.meta.url))),runnerHash);
  assert.deepEqual(await hashFiles(sourcePaths),sourceHashes);
  const portableHashes=hashes=>Object.fromEntries(Object.entries(hashes).map(([path,hash])=>[basename(path),hash]));
  const report={metadata:{node:process.version,startedFrom:'fresh gateway process per condition/pair',scope:'warm local SDK -> gateway stdio -> real stdio fixture; no model/provider/network calls',corpus:'5000 generated tools; shared broad description token; two discovery pages',policy:'both conditions use default unrestricted tool permissions and enabled code; no code execution measured',design:'four balanced process pairs; 20 warmup searches/calls, then 100 searches and 100 structured calls per process',timing:'SDK roundtrip; excludes startup, initial index build and teardown',limitations:'synthetic regression diagnostic; observations within a process are correlated; pooled percentiles are not confidence intervals or a general speedup claim'},hashes:{sourceHashes,baselineHashes:portableHashes(baselineHashes),currentHashes:portableHashes(beforeHashes),fixtureSha256:sha(await readFile(fixture)),runnerSha256:runnerHash,configSha256:sha(JSON.stringify(config))},summary,observations};
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
} finally {await rm(dir,{recursive:true,force:true});}
