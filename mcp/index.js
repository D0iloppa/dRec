#!/usr/bin/env node
'use strict';

// dRec MCP 서버 — dobis 가 mcp.json 에 stdio 로 등록해 spawn 한다(doil-sb/mcp 와 동일 패턴).
// 도구는 tools.js 에서 정의하고, 백엔드 호출은 client.js 가 담당한다.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { tools } = require('./tools.js');

const server = new Server(
  { name: 'drec', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const toolMap = new Map(tools.map((t) => [t.name, t]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await tool.handler(args || {});
    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('drec MCP server error:', error);
  process.exit(1);
});
