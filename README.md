# Digital Ocean Agent MCP Server

A Model Context Protocol (MCP) server that provides search capabilities for Digital Ocean Agent knowledge bases. This server enables Claude and other MCP-compatible AI tools to search and retrieve information from Digital Ocean Agent instances.

## Features

- **4 Search Methods**: Basic, Rewrite (default), Step-back, and Sub-queries retrieval strategies
- **Multi-Agent Support**: Configure single or multiple DO Agent instances
- **Chunk-Focused**: Returns document chunks with minimal AI overhead for cost optimization
- **Cloudflare Workers Deployment**: Scalable serverless deployment
- **Dual-Layer Rate Limiting**: Per-IP and global rate limits for cost protection
- **Security Hardened**: Sanitized error messages, request timeouts, secure agent selection

## Search Tools

1. **`do_agent_basic_search`** - Basic search without query enhancement (`retrieval_method: "none"`)
2. **`do_agent_rewrite_search`** - Search with AI query rewriting (`retrieval_method: "rewrite"`) 
3. **`do_agent_step_back_search`** - Step-back strategy for broader context (`retrieval_method: "step_back"`)
4. **`do_agent_sub_queries_search`** - Sub-queries method for comprehensive retrieval (`retrieval_method: "sub_queries"`)

Additional management tools:
- **`list_do_agents`** - List all configured agent instances
- **`get_current_do_agent`** - Get default agent information

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Secure Deployment Setup

**⚠️ IMPORTANT**: Follow the [complete deployment guide](./DEPLOYMENT.md) for secure production setup.

**Quick local development:**
```bash
# Copy environment template (local dev only)
cp .env.example .env
# Edit .env with your endpoint and token
npm run dev
```

**Production deployment:**
```bash
# 1. Edit wrangler.toml with your endpoint (public)
# 2. Set token as secret (never committed):
wrangler secret put DO_AGENT_TOKEN
# 3. Deploy securely:
npm run deploy
```

📖 **[Read the full deployment guide](./DEPLOYMENT.md)** for step-by-step instructions, security best practices, and troubleshooting.

## Usage Examples

### Basic Search
```json
{
  "tool": "do_agent_basic_search",
  "parameters": {
    "query": "How do I configure load balancers?",
    "k": 5
  }
}
```

### Rewrite Search (Recommended)
```json
{
  "tool": "do_agent_rewrite_search", 
  "parameters": {
    "query": "database backup procedures",
    "k": 10,
    "include_ai_response": false
  }
}
```

### Multi-Agent Search
```json
{
  "tool": "do_agent_step_back_search",
  "parameters": {
    "query": "troubleshooting connection issues",
    "agent_name": "agent_2"
  }
}
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query (max 10,000 chars) |
| `k` | number | 10 | Number of document results to return (valid range: 1-10) |
| `include_ai_response` | boolean | false | Include AI-generated response |
| `agent_name` | string | agent_1 | Agent to search (agent_1, agent_2, etc.) |

## Configuration

### Environment Variables

- `DO_AGENT_ENDPOINT` - Single agent endpoint URL
- `DO_AGENT_TOKEN` - Single agent bearer token
- `DO_AGENT_ENDPOINTS` - Comma-separated agent endpoints
- `DO_AGENT_TOKENS` - Comma-separated bearer tokens  
- `DO_AGENT_DESCRIPTIONS` - Comma-separated agent descriptions

### Rate Limiting

**Per-IP Rate Limiting:**
- `RATE_LIMIT_PER_WINDOW` - Max requests per IP per time window (default: 75)
- `RATE_LIMIT_WINDOW_SECONDS` - Time window in seconds (default: 120)

**Global Rate Limiting:**
- `GLOBAL_RATE_LIMIT_PER_WINDOW` - Max requests globally per time window (default: 100)
- `GLOBAL_RATE_LIMIT_WINDOW_SECONDS` - Global time window in seconds (default: 120)

The server enforces both per-IP and global rate limits to prevent cost explosion. Rate limit errors return specific messages indicating whether the per-IP or global limit was exceeded.

### Security Features

- **Request Timeouts**: 30-second timeout on all DO Agent API calls
- **Error Sanitization**: Backend errors are sanitized to prevent information leakage  
- **Secure Agent Selection**: Uses agent names (agent_1, agent_2) instead of exposing internal endpoints
- **Input Validation**: Comprehensive parameter validation with specific error messages

### Response Filtering

By default, AI responses are filtered out to focus on retrieval chunks and minimize costs. Set `include_ai_response: true` to include the full AI response.

### Fixed Settings

The following are automatically configured for optimal performance:
- `stream: false` - Non-streaming responses
- `include_retrieval_info: true` - Always include document chunks
- `max_tokens: 50` - Minimal tokens for cost optimization

## Architecture

This MCP server acts as a bridge between MCP clients (like Claude) and Digital Ocean Agents:

```
MCP Client (Claude) ↔ MCP Server ↔ DO Agent API ↔ Knowledge Base
```

The server optimizes for:
- **Cost**: Minimal token usage, cheapest DO models
- **Relevance**: Advanced retrieval methods for better chunks
- **Scalability**: Cloudflare Workers deployment
- **Flexibility**: Single/multi-agent configurations

## Development

Built with:
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Zod](https://zod.dev/) for schema validation
- TypeScript for type safety

## License

MIT