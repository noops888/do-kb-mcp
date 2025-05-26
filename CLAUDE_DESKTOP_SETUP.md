# Claude Desktop Configuration

## Quick Setup (Copy & Paste)

1. **Open Claude Desktop configuration file:**
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

2. **Add this configuration to your `mcpServers` section:**

```json
{
  "mcpServers": {
    "do-kb-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-mcp-server.your-subdomain.workers.dev"
      ],
      "env": {}
    }
  }
}
```

## Complete Configuration Example

If your file is empty or you need the full structure:

```json
{
  "mcpServers": {
    "do-kb-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-mcp-server.your-subdomain.workers.dev"
      ],
      "env": {}
    }
  },
  "globalShortcut": "Cmd+Shift+.",
  "appearance": "system"
}
```

## After Configuration

1. **Restart Claude Desktop** completely
2. **Verify connection** - You should see the MCP server connect in Claude Desktop
3. **Test with a query:**

```
Use the Digital Ocean Agent to search for "how to set up a load balancer"
```

## Available Tools

Once connected, Claude Desktop will have access to:

### Search Tools
- `do_agent_basic_search` - Basic search without enhancement
- `do_agent_rewrite_search` - Enhanced search with query rewriting (recommended)
- `do_agent_step_back_search` - Broader context search
- `do_agent_sub_queries_search` - Comprehensive multi-query search

### Management Tools  
- `list_do_agents` - Show configured agents
- `get_current_do_agent` - Show default agent info

## Usage Examples

### Basic Usage
```
Search the Digital Ocean knowledge base for database backup procedures
```

### Specific Search Method
```
Use the step-back search method to find information about monitoring and alerts
```

### Advanced Query
```
Use sub-queries search to find comprehensive information about troubleshooting connection issues, and return 5 results
```

## Troubleshooting

### Connection Issues
1. **Check URL**: Ensure `https://your-mcp-server.your-subdomain.workers.dev` is accessible
2. **Restart Claude**: Completely quit and reopen Claude Desktop
3. **Check logs**: Look for MCP connection errors in Claude Desktop

### Tool Not Available
1. **Verify configuration**: Ensure JSON syntax is correct
2. **Check file location**: Confirm you're editing the right config file
3. **Restart required**: Always restart Claude Desktop after config changes

### Test Connection
```bash
# Test MCP server directly
curl -X POST https://your-mcp-server.your-subdomain.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

Should return a list of available tools.

## Security Note

This configuration connects to a public MCP server. The server uses secured Digital Ocean Agent tokens and only returns knowledge base search results. No sensitive data is transmitted through this connection.