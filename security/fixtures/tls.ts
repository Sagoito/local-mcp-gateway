// ruleid: local-mcp.disabled-tls-verification
const unsafeAgent = new Agent({ rejectUnauthorized: false });
// ruleid: local-mcp.disabled-tls-verification
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// ok: local-mcp.disabled-tls-verification
const verifiedAgent = new Agent({ rejectUnauthorized: true });
// ok: local-mcp.disabled-tls-verification
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
