import { apiKeyGuard, unauthorized } from '../../../lib/auth';
import { callMcpTool, listMcpTools } from '../../../lib/mcp-tools';

// ── MCP Streamable HTTP endpoint (protocol version 2024-11-05) ────────────────
// Single POST handler for all JSON-RPC 2.0 messages. Auth: Bearer API key (same
// as the REST surface). Responses are always application/json — no SSE streaming
// (tools were synchronous until notify_robin (Phase 1); notify_robin does async
// network I/O — callMcpTool is awaited regardless). Notifications (no id) return 202
// with no body.

const PROTOCOL_VERSION = '2024-11-05';

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const authed = await apiKeyGuard(req);
  if (!authed) return unauthorized();

  let msg: JsonRpcMessage;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg.id ?? null, -32600, 'Invalid Request');
  }

  // Notifications have no id field — acknowledge without a response body.
  if (!('id' in msg)) {
    return new Response(null, { status: 202 });
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id ?? null, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mot', version: '0.1.0' },
        });

      case 'ping':
        return rpcResult(id ?? null, {});

      case 'tools/list':
        return rpcResult(id ?? null, { tools: listMcpTools() });

      case 'tools/call': {
        const p = params as { name?: string; arguments?: Record<string, unknown> };
        if (!p?.name) return rpcError(id ?? null, -32602, 'Missing tool name');
        const toolName = p.name;
        const argKeys = Object.keys(p.arguments ?? {}).join(',');
        // eslint-disable-next-line no-console
        console.log(`[MOT/MCP] call: ${toolName}(${argKeys})`);
        const content = await callMcpTool(toolName, p.arguments ?? {});
        return rpcResult(id ?? null, { content, isError: false });
      }

      default:
        return rpcError(id ?? null, -32601, `Method not found: ${method}`);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Internal error';
    // Tool errors surface as successful JSON-RPC responses with isError=true,
    // per the MCP spec (the tool call itself succeeded; the tool reported failure).
    if (method === 'tools/call') {
      const toolName = (params as { name?: string })?.name ?? 'unknown';
      // eslint-disable-next-line no-console
      console.error(`[MOT/MCP] error: ${toolName}: ${message}`);
      return rpcResult(id ?? null, {
        content: [{ type: 'text', text: message }],
        isError: true,
      });
    }
    return rpcError(id ?? null, -32603, message);
  }
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}
