// ruleid: local-mcp.host-dynamic-code
const runCode = eval('1 + 1');
// ruleid: local-mcp.host-dynamic-code
const makeCode = new Function('return 1');
// ok: local-mcp.host-dynamic-code
const guest = await context.evalCode(userProgram);
