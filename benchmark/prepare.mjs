import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFixtures} from './fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runs=path.resolve(process.argv[2] ?? '.benchmark-runs');
const native = process.argv[3] === '--native';
if (process.argv[3] && !native) throw new Error('Unknown profile; use --native');
const fixtures=path.join(runs,'fixtures');
const metadata=await createFixtures(fixtures);
const questions=JSON.parse(await fs.readFile(path.join(root,'benchmark/questions.json'),'utf8'));
const order=[];
for(let repetition=1;repetition<=2;repetition++) for(let qi=0;qi<questions.length;qi++) {
 const modes=(qi+repetition)%2 ? ['direct','gateway'] : ['gateway','direct'];
 for(const mode of modes){
  const id=`q${qi+1}-${mode}-r${repetition}`;
  const dir=path.join(runs,id);await fs.mkdir(dir,{recursive:true});
  const memory=path.join(dir,'memory.jsonl');await fs.copyFile(path.join(fixtures,'memory.jsonl'),memory);
  const gatewayConfig={version:1,servers:{filesystem:{command:process.execPath,args:[path.join(root,'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'),fixtures]},memory:{command:process.execPath,args:[path.join(root,'node_modules/@modelcontextprotocol/server-memory/dist/index.js')],env:{MEMORY_FILE_PATH:memory}}}};
  if(native) gatewayConfig.nativeTools=[
   {server:'filesystem',tool:'read_text_file'},{server:'filesystem',tool:'search_files'},
   {server:'filesystem',tool:'read_multiple_files'},{server:'memory',tool:'search_nodes'},
   {server:'filesystem',tool:'list_directory'},
  ];
  const question={...questions[qi],prompt:questions[qi].prompt.replaceAll('{{FIXTURE_ROOT}}',fixtures)};
  const prompt=`You are a benchmark task-solving agent. Solve the question using ONLY the MCP interface below. Do not read any local files, configs, scripts, logs, question lists, or expected answers with shell/filesystem helpers. Do not use web, other connectors, subagents, or outside knowledge. The filesystem MCP is the only way to read fixture files; use the memory MCP when asked. Do not modify data.\n\nInterface: use tools.exec_command through functions.exec to run the following commands, then print the entire output with text(result.output). Do not parse, filter, calculate from, truncate, or transform tool responses in host JavaScript or shell. Pure reasoning is allowed; code processing of tool data is allowed ONLY if an exposed MCP tool supports it. Use max_output_tokens:70000 for exec_command and functions.exec to avoid output truncation.\n\nFirst list tool definitions:\nnode ${root}/benchmark/bridge.mjs ${runs} ${id} list\n\nCall an exposed tool:\nnode ${root}/benchmark/bridge.mjs ${runs} ${id} call TOOL_NAME '<JSON arguments>'\n\nFinish with your JSON answer:\nnode ${root}/benchmark/bridge.mjs ${runs} ${id} finish '<JSON answer>'\n\nUse at most 12 tool calls after listing. If you cannot solve it, finish with {"error":"unable to complete"}. Handle tool errors and choose tools yourself; do not fabricate values. After finish, return the same JSON as your final response.\n\nQUESTION: ${question.prompt}`;
  await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({mode,repetition,question,gatewayConfig,model:'gpt-6-luna',reasoningEffort:'medium'},null,2));
  await fs.writeFile(path.join(dir,'prompt.txt'),prompt);
  order.push(id);
 }
}
await fs.writeFile(path.join(runs,'order.json'),JSON.stringify(order,null,2));
await fs.writeFile(path.join(runs,'fixture-metadata.json'),JSON.stringify(metadata,null,2));
console.log(JSON.stringify({runs,metadata,order}));
