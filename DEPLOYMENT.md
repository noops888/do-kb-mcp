# Digital Ocean Agent MCP Server - Deployment Guide

This guide walks through the secure deployment process for first-time users.

## 🔐 Security Overview

**IMPORTANT**: Never commit API tokens to git. This guide uses Cloudflare Workers secrets for secure token storage.

## Step-by-Step Deployment

### 1. Prerequisites

```bash
# Install wrangler CLI if not already installed
npm install -g wrangler

# Login to Cloudflare (opens browser)
wrangler login
```

### 2. Configuration Setup

#### Option A: Single Agent (Recommended for first deployment)

1. **Edit `wrangler.toml`** - Set your endpoint and rate limits (public, safe to commit):
```toml
[vars]
DO_AGENT_ENDPOINT = "https://your-agent.agents.do-ai.run"
# Rate limiting configuration
RATE_LIMIT_PER_WINDOW = "75"
RATE_LIMIT_WINDOW_SECONDS = "120"
GLOBAL_RATE_LIMIT_PER_WINDOW = "100"
GLOBAL_RATE_LIMIT_WINDOW_SECONDS = "120"
```

2. **Set secret token** (never committed to git):
```bash
wrangler secret put DO_AGENT_TOKEN
# Paste your token when prompted: your-actual-bearer-token
```

#### Option B: Multiple Agents (Advanced)

1. **Edit `wrangler.toml`** - Set multiple endpoints and rate limits:
```toml
[vars]
DO_AGENT_ENDPOINTS = "https://agent1.agents.do-ai.run,https://agent2.agents.do-ai.run"
DO_AGENT_DESCRIPTIONS = "Primary KB,Secondary KB"
# Rate limiting configuration
RATE_LIMIT_PER_WINDOW = "75"
RATE_LIMIT_WINDOW_SECONDS = "120"
GLOBAL_RATE_LIMIT_PER_WINDOW = "100"
GLOBAL_RATE_LIMIT_WINDOW_SECONDS = "120"
```

2. **Set secret tokens**:
```bash
wrangler secret put DO_AGENT_TOKENS
# Paste comma-separated tokens: token1,token2
```

### 3. Required: Durable Objects Configuration

The server requires Durable Objects for rate limiting. Ensure your `wrangler.toml` includes:

```toml
[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RateLimiter"]
```

**Note**: This configuration is already included in the project's `wrangler.toml`.

### 4. Validate Configuration

Before deploying, verify your config works:

```bash
# Check current secrets
wrangler secret list

# Test build
npm run build
```

### 4. Deploy

```bash
# Deploy to Cloudflare Workers
npm run deploy
```

## 🔍 Configuration Validation

The server validates your configuration and will show helpful errors:

- ✅ **Valid**: Single endpoint + single token
- ✅ **Valid**: Multiple endpoints + matching number of tokens  
- ❌ **Invalid**: Mixing single and multi-agent configs
- ❌ **Invalid**: Mismatched endpoint/token counts
- ❌ **Invalid**: Missing tokens or endpoints

## 🚀 Testing Your Deployment

After deployment, test with curl:

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

Should return available tools including:
- `do_agent_basic_search`
- `do_agent_rewrite_search` 
- `do_agent_step_back_search`
- `do_agent_sub_queries_search`

## 🔧 Managing Secrets

### View current secrets:
```bash
wrangler secret list
```

### Update a secret:
```bash
wrangler secret put DO_AGENT_TOKEN
```

### Delete a secret:
```bash
wrangler secret delete DO_AGENT_TOKEN
```

## 🐛 Troubleshooting

### "No DO Agent configuration found"
- Ensure you've set both endpoint and token
- Check `wrangler secret list` to verify secrets exist

### "Configuration mismatch"
- Endpoint and token counts must match for multi-agent setup
- Use single agent config if you only have one agent

### "Configuration conflict" 
- Don't mix single agent vars with multi-agent vars
- Choose either `DO_AGENT_ENDPOINT` OR `DO_AGENT_ENDPOINTS`

### "Tool not found" in responses
- Check your endpoint URL is correct
- Verify your token has access to the agent
- Test the agent directly first

### Rate Limiting Errors
- **429 errors**: Normal behavior when limits are exceeded
- **Per-IP limit**: Individual user exceeded their quota
- **Global limit**: Service-wide usage exceeded quota
- **Adjust limits**: Modify `RATE_LIMIT_PER_WINDOW` and `GLOBAL_RATE_LIMIT_PER_WINDOW` as needed

## 🔄 Local Development

For local testing, create `.env`:

```env
# Local development only - never commit this file
DO_AGENT_ENDPOINT=https://your-agent.agents.do-ai.run
DO_AGENT_TOKEN=your-bearer-token
```

Run locally:
```bash
npm run dev
```

## 📋 Pre-Deployment Checklist

- [ ] Endpoint URLs are in `wrangler.toml` (public vars)
- [ ] Tokens are set as secrets via `wrangler secret put` (never in files)
- [ ] `.env` is in `.gitignore` (if using local development)
- [ ] `wrangler.toml` has no hardcoded tokens
- [ ] Configuration validates with `npm run build`
- [ ] Ready to deploy with `npm run deploy`

## 🔗 Next Steps

Once deployed, you can integrate with Claude Desktop or other MCP clients using your worker URL.