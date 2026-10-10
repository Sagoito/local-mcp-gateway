import { exec as shellCommand, execSync as shellCommandSync, spawn as processSpawn, spawnSync as processSpawnSync, execFile as safeFile, spawn as safeSpawn } from 'node:child_process';
import * as cp from 'child_process';

// ruleid: local-mcp.shell-child-process
shellCommand('git ' + userArg);
// ruleid: local-mcp.shell-child-process
shellCommandSync('git ' + userArg);
// ruleid: local-mcp.shell-child-process
processSpawn('git', ['status'], { shell: true });
// ruleid: local-mcp.shell-child-process
processSpawnSync('git', ['status'], { shell: true });
// ruleid: local-mcp.shell-child-process
cp.exec('git ' + userArg);
// ruleid: local-mcp.shell-child-process
cp.spawn('git', ['status'], { shell: true });
// ok: local-mcp.shell-child-process
safeFile('git', ['status']);
// ok: local-mcp.shell-child-process
safeSpawn('git', ['status']);
