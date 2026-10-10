import * as isolated from 'node:vm';
import { runInNewContext as runGuest } from 'vm';

// ruleid: local-mcp.node-vm-execution
isolated.runInNewContext(userCode, {});
// ruleid: local-mcp.node-vm-execution
runGuest(userCode, {});
// ok: local-mcp.node-vm-execution
quickjs.executeCode(userCode);
