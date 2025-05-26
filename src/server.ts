import { z } from 'zod';

// Durable Object for rate limiting
export class RateLimiter {
  private state: any;
  private env: Env;

  constructor(state: any, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const clientIP = url.searchParams.get('clientIP');
    const limit = parseInt(url.searchParams.get('limit') || '30');
    const windowSeconds = parseInt(url.searchParams.get('windowSeconds') || '60');
    const globalLimit = parseInt(url.searchParams.get('globalLimit') || '100');
    const globalWindowSeconds = parseInt(url.searchParams.get('globalWindowSeconds') || '120');

    if (!clientIP) {
      return new Response('Missing clientIP parameter', { status: 400 });
    }

    // Get current time windows
    const now = Date.now();
    const windowStart = now - (now % (windowSeconds * 1000));
    const globalWindowStart = now - (now % (globalWindowSeconds * 1000));
    
    const windowKey = `${clientIP}:${windowStart}`;
    const globalWindowKey = `global:${globalWindowStart}`;

    // Check per-IP rate limit
    const currentCount = (await this.state.storage.get(windowKey)) || 0;
    if (currentCount >= limit) {
      return new Response(JSON.stringify({
        allowed: false,
        count: currentCount,
        limit: limit,
        resetTime: windowStart + (windowSeconds * 1000),
        reason: 'per_ip_limit'
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check global rate limit
    const globalCount = (await this.state.storage.get(globalWindowKey)) || 0;
    if (globalCount >= globalLimit) {
      return new Response(JSON.stringify({
        allowed: false,
        count: globalCount,
        limit: globalLimit,
        resetTime: globalWindowStart + (globalWindowSeconds * 1000),
        reason: 'global_limit'
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Increment both counters atomically
    const newCount = currentCount + 1;
    const newGlobalCount = globalCount + 1;
    await this.state.storage.put(windowKey, newCount);
    await this.state.storage.put(globalWindowKey, newGlobalCount);

    // Clean up old windows
    const allKeys = await this.state.storage.list();
    for (const [key] of allKeys) {
      if (typeof key === 'string') {
        if (key.startsWith(clientIP)) {
          const keyTime = parseInt(key.split(':')[1]);
          if (keyTime < windowStart - windowSeconds * 1000) {
            await this.state.storage.delete(key);
          }
        } else if (key.startsWith('global:')) {
          const keyTime = parseInt(key.split(':')[1]);
          if (keyTime < globalWindowStart - globalWindowSeconds * 1000) {
            await this.state.storage.delete(key);
          }
        }
      }
    }

    return new Response(JSON.stringify({
      allowed: true,
      count: newCount,
      limit: limit,
      globalCount: newGlobalCount,
      globalLimit: globalLimit,
      resetTime: windowStart + (windowSeconds * 1000)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Digital Ocean Agent MCP Server
 * Provides search tools for Digital Ocean Agent instances with knowledge base retrieval
 */

interface Env {
  DO_AGENT_ENDPOINT?: string; // Default DO Agent endpoint (optional if using multi-agent)
  DO_AGENT_TOKEN?: string; // Default DO Agent bearer token
  KB_DESCRIPTION?: string; // Description of the knowledge base content
  // Rate limiting configuration
  RATE_LIMIT_PER_WINDOW?: string; // Max requests per time window per IP
  RATE_LIMIT_WINDOW_SECONDS?: string; // Time window in seconds
  GLOBAL_RATE_LIMIT_PER_WINDOW?: string; // Max requests per time window globally
  GLOBAL_RATE_LIMIT_WINDOW_SECONDS?: string; // Global time window in seconds
  RATE_LIMITER?: any; // Durable Object for rate limiting
  // Support for multiple DO Agent instances
  DO_AGENT_ENDPOINTS?: string; // Comma-separated list of DO Agent endpoint URLs
  DO_AGENT_TOKENS?: string; // Comma-separated list of bearer tokens
  DO_AGENT_DESCRIPTIONS?: string; // Comma-separated list of descriptions
}

interface DOAgentMessage {
  role: string;
  content: string;
}

interface DOAgentRequest {
  messages: DOAgentMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream: false; // Always false per requirements
  k?: number; // Number of retrieval results (1-10)
  retrieval_method: 'none' | 'rewrite' | 'step_back' | 'sub_queries';
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  include_retrieval_info: true; // Always true per requirements - gives us chunks
  include_functions_info?: boolean;
  include_guardrails_info?: boolean;
  provide_citations?: boolean;
}

interface DOAgentChoice {
  message: DOAgentMessage;
  index: number;
}

interface RetrievedData {
  id: string;
  index: string;
  score: number;
}

interface DOAgentResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DOAgentChoice[];
  retrieval: {
    retrieved_data: RetrievedData[];
  };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: any;
}

interface McpServerInfo {
  name: string;
  version: string;
}

interface McpCapabilities {
  tools?: {};
  logging?: {};
}

class WorkersMcpServer {
  private serverInfo: McpServerInfo;
  private capabilities: McpCapabilities;
  private tools: Map<string, {
    description: string;
    inputSchema: any;
    zodSchema: z.ZodSchema;
    handler: (params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }> = new Map();

  constructor(serverInfo: McpServerInfo, options: { capabilities: McpCapabilities }) {
    this.serverInfo = serverInfo;
    this.capabilities = options.capabilities;
  }

  addTool(
    name: string,
    description: string,
    inputSchema: z.ZodSchema,
    handler: (params: any) => Promise<{ content: Array<{ type: string; text: string }> }>
  ) {
    this.tools.set(name, {
      description,
      inputSchema: this.zodToJsonSchema(inputSchema),
      zodSchema: inputSchema, // Store original Zod schema for validation
      handler
    });
  }

  private zodToJsonSchema(schema: z.ZodSchema): any {
    // Handle union types
    if (schema instanceof z.ZodUnion) {
      const types = schema._def.options.map((opt: z.ZodSchema) => this.zodToJsonSchema(opt));
      return { oneOf: types };
    }
    
    // Basic Zod to JSON Schema conversion
    if (schema instanceof z.ZodObject) {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      
      const shape = schema.shape;
      for (const [key, value] of Object.entries(shape)) {
        if (value instanceof z.ZodString) {
          properties[key] = { type: 'string', description: value.description };
          if (!value.isOptional()) required.push(key);
        } else if (value instanceof z.ZodNumber) {
          properties[key] = { type: 'number', description: value.description };
          if (!value.isOptional()) required.push(key);
        } else if (value instanceof z.ZodBoolean) {
          properties[key] = { type: 'boolean', description: value.description };
          if (!value.isOptional()) required.push(key);
        } else if (value instanceof z.ZodRecord) {
          properties[key] = { type: 'object', description: value.description };
          if (!value.isOptional()) required.push(key);
        } else if (value instanceof z.ZodObject) {
          properties[key] = this.zodToJsonSchema(value);
          if (!value.isOptional()) required.push(key);
        } else if (value instanceof z.ZodOptional) {
          const innerType = value._def.innerType;
          if (innerType instanceof z.ZodString) {
            properties[key] = { type: 'string', description: innerType.description };
          } else if (innerType instanceof z.ZodNumber) {
            properties[key] = { type: 'number', description: innerType.description };
          } else if (innerType instanceof z.ZodBoolean) {
            properties[key] = { type: 'boolean', description: innerType.description };
          } else if (innerType instanceof z.ZodRecord) {
            properties[key] = { type: 'object', description: innerType.description };
          } else if (innerType instanceof z.ZodObject) {
            properties[key] = this.zodToJsonSchema(innerType);
          }
        }
      }
      
      return {
        type: 'object',
        properties,
        required
      };
    }
    
    // Handle primitives
    if (schema instanceof z.ZodString) {
      return { type: 'string', description: schema.description };
    }
    if (schema instanceof z.ZodNumber) {
      return { type: 'number', description: schema.description };
    }
    if (schema instanceof z.ZodBoolean) {
      return { type: 'boolean', description: schema.description };
    }
    
    return { type: 'object' };
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { method, params, id } = request;

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: this.capabilities,
              serverInfo: this.serverInfo
            }
          };

        case 'tools/list':
          const tools: Tool[] = Array.from(this.tools.entries()).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }));
          
          return {
            jsonrpc: '2.0',
            id,
            result: { tools }
          };

        case 'tools/call':
          const { name, arguments: args } = params;
          const tool = this.tools.get(name);
          
          if (!tool) {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: `Tool '${name}' not found`
              }
            };
          }

          // Validate parameters using Zod schema
          try {
            const validatedArgs = tool.zodSchema.parse(args || {});
            const result = await tool.handler(validatedArgs);
            return {
              jsonrpc: '2.0',
              id,
              result
            };
          } catch (validationError) {
            if (validationError instanceof z.ZodError) {
              const errorDetails = validationError.errors.map(err => ({
                field: err.path.join('.'),
                message: err.message,
                code: err.code,
                received: 'received' in err ? err.received : undefined
              }));
              
              // Create more specific error message based on the validation errors
              let specificMessage = 'Invalid params';
              if (errorDetails.length === 1) {
                const error = errorDetails[0];
                if (error.field === 'k') {
                  if (error.code === 'too_small') {
                    specificMessage = 'Parameter k must be at least 1';
                  } else if (error.code === 'too_big') {
                    specificMessage = 'Parameter k must be at most 10';
                  } else if (error.code === 'invalid_type') {
                    specificMessage = 'Parameter k must be a number';
                  } else {
                    specificMessage = `Parameter k is invalid: ${error.message}`;
                  }
                } else if (error.field === 'query') {
                  if (error.code === 'too_small') {
                    specificMessage = 'Parameter query cannot be empty';
                  } else if (error.code === 'too_big') {
                    specificMessage = 'Parameter query must be at most 10,000 characters';
                  } else {
                    specificMessage = `Parameter query is invalid: ${error.message}`;
                  }
                } else {
                  specificMessage = `Parameter ${error.field} is invalid: ${error.message}`;
                }
              } else if (errorDetails.length > 1) {
                const fields = errorDetails.map(e => e.field).join(', ');
                specificMessage = `Multiple parameter validation errors: ${fields}`;
              }
              
              return {
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32602,
                  message: specificMessage,
                  data: {
                    validation_errors: errorDetails,
                    details: `Parameter validation failed for tool '${name}'`
                  }
                }
              };
            }
            
            // Re-throw non-validation errors
            throw validationError;
          }

        case 'resources/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { resources: [] }
          };

        case 'prompts/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { prompts: [] }
          };

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: method ? `Method '${method}' not supported` : 'Method is required'
            }
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`
        }
      };
    }
  }
}

function createServer(env: Env): WorkersMcpServer {
  const kbDescription = env.KB_DESCRIPTION || 'Knowledge Base';
  
  const server = new WorkersMcpServer({
    name: 'digitalocean-agent-mcp',
    version: '1.0.0',
  }, { 
    capabilities: { 
      tools: {},
      logging: {}
    } 
  });

  // Helper function to get available DO Agent instances with validation
  const getDOAgentInstances = () => {
    const instances: Array<{ endpoint: string; token: string; description: string; is_default: boolean }> = [];
    
    // Configuration validation
    const hasMultiEndpoints = env.DO_AGENT_ENDPOINTS;
    const hasMultiTokens = env.DO_AGENT_TOKENS;
    const hasSingleEndpoint = env.DO_AGENT_ENDPOINT;
    const hasSingleToken = env.DO_AGENT_TOKEN;
    
    // Check for conflicting configurations
    if ((hasMultiEndpoints || hasMultiTokens) && (hasSingleEndpoint || hasSingleToken)) {
      throw new Error('Configuration conflict: Cannot mix single agent config (DO_AGENT_ENDPOINT/TOKEN) with multi-agent config (DO_AGENT_ENDPOINTS/TOKENS). Choose one approach.');
    }
    
    // Handle multi-agent configuration
    if (hasMultiEndpoints && hasMultiTokens) {
      const endpoints = env.DO_AGENT_ENDPOINTS!.split(',').map(s => s.trim()).filter(s => s);
      const tokens = env.DO_AGENT_TOKENS!.split(',').map(s => s.trim()).filter(s => s);
      const descriptions = env.DO_AGENT_DESCRIPTIONS?.split(',').map(s => s.trim()) || [];
      
      if (endpoints.length !== tokens.length) {
        throw new Error(`Configuration mismatch: DO_AGENT_ENDPOINTS has ${endpoints.length} items but DO_AGENT_TOKENS has ${tokens.length} items. Must have equal counts.`);
      }
      
      if (endpoints.length === 0) {
        throw new Error('DO_AGENT_ENDPOINTS is empty or contains only whitespace');
      }
      
      endpoints.forEach((endpoint, index) => {
        if (!endpoint) {
          throw new Error(`Empty endpoint at position ${index + 1} in DO_AGENT_ENDPOINTS`);
        }
        if (!tokens[index]) {
          throw new Error(`Empty token at position ${index + 1} in DO_AGENT_TOKENS`);
        }
        instances.push({
          endpoint: endpoint.replace(/\/api\/v1\/chat\/completions$/, ''), // Remove if accidentally included
          token: tokens[index],
          description: descriptions[index] || `DO Agent: ${endpoint}`,
          is_default: index === 0 // First instance is default
        });
      });
    }
    // Handle single agent configuration
    else if (hasSingleEndpoint && hasSingleToken) {
      instances.push({
        endpoint: env.DO_AGENT_ENDPOINT!.replace(/\/api\/v1\/chat\/completions$/, ''), // Remove if accidentally included
        token: env.DO_AGENT_TOKEN!,
        description: 'Default DO Agent instance',
        is_default: true
      });
    }
    // Handle partial configurations
    else if (hasMultiEndpoints && !hasMultiTokens) {
      throw new Error('Multi-agent configuration incomplete: DO_AGENT_ENDPOINTS provided but DO_AGENT_TOKENS missing');
    }
    else if (!hasMultiEndpoints && hasMultiTokens) {
      throw new Error('Multi-agent configuration incomplete: DO_AGENT_TOKENS provided but DO_AGENT_ENDPOINTS missing');
    }
    else if (hasSingleEndpoint && !hasSingleToken) {
      throw new Error('Single agent configuration incomplete: DO_AGENT_ENDPOINT provided but DO_AGENT_TOKEN missing');
    }
    else if (!hasSingleEndpoint && hasSingleToken) {
      throw new Error('Single agent configuration incomplete: DO_AGENT_TOKEN provided but DO_AGENT_ENDPOINT missing');
    }
    else {
      throw new Error('No DO Agent configuration found. Set either DO_AGENT_ENDPOINT+DO_AGENT_TOKEN (single) or DO_AGENT_ENDPOINTS+DO_AGENT_TOKENS (multi)');
    }
    
    return instances;
  };
  
  // Helper function to get default DO Agent instance
  const getDefaultDOAgent = () => {
    const instances = getDOAgentInstances();
    const defaultInstance = instances.find(i => i.is_default) || instances[0];
    if (!defaultInstance) {
      throw new Error('No DO Agent instances configured');
    }
    return defaultInstance;
  };

  // Helper function to get agent by name (agent_1, agent_2, etc.)
  const getAgentByName = (agentName: string) => {
    const instances = getDOAgentInstances();
    
    // Parse agent name (expect format: agent_1, agent_2, etc.)
    const match = agentName.match(/^agent_(\d+)$/);
    if (!match) {
      throw new Error(`Invalid agent name format. Expected format: agent_1, agent_2, etc. Got: ${agentName}`);
    }
    
    const agentIndex = parseInt(match[1]) - 1; // Convert to 0-based index
    if (agentIndex < 0 || agentIndex >= instances.length) {
      throw new Error(`Agent ${agentName} not found. Available agents: ${instances.map((_, i) => `agent_${i + 1}`).join(', ')}`);
    }
    
    return instances[agentIndex];
  };
  
  // Helper function to validate DO Agent endpoint and get instance
  const validateDOAgentEndpoint = (endpoint?: string) => {
    const instances = getDOAgentInstances();
    
    if (endpoint) {
      const instance = instances.find(i => i.endpoint === endpoint);
      if (!instance) {
        throw new Error(`DO Agent endpoint '${endpoint}' not found. Available endpoints: ${instances.map(i => i.endpoint).join(', ')}`);
      }
      return instance;
    }
    
    return getDefaultDOAgent();
  };

  // Helper function to call DO Agent API
  const callDOAgent = async (
    instance: { endpoint: string; token: string },
    requestBody: DOAgentRequest
  ): Promise<DOAgentResponse> => {
    // Create abort controller for 30-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`${instance.endpoint}/api/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${instance.token}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Sanitize error - don't leak backend details
        throw new Error(`Search service temporarily unavailable (${response.status}). Please try again later.`);
      }

      return response.json() as Promise<DOAgentResponse>;
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Sanitize all errors - don't leak internal details
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Search request timed out. Please try again with a shorter query.');
        }
        // For other errors, provide generic message
        throw new Error('Search service temporarily unavailable. Please try again later.');
      }
      throw new Error('Search service temporarily unavailable. Please try again later.');
    }
  };

  // Basic search tool (retrieval_method: "none")
  server.addTool(
    'do_agent_basic_search',
    `Basic search in ${kbDescription} without query enhancement. Returns retrieved document chunks only.`,
    z.object({
      query: z.string().min(1).max(10000).describe('The search query to find relevant documents (1-10,000 chars, required)'),
      k: z.number().int().min(1).max(10).optional().describe('Number of document results to return (valid range: 1-10, default: 10)'),
      include_ai_response: z.boolean().optional().describe('Whether to include the AI-generated response (default: false)'),
      agent_name: z.string().optional().describe('Agent to search (agent_1, agent_2, etc. - default: use default agent)')
    }),
    async ({ query, k, include_ai_response, agent_name }) => {
      try {
        const instance = agent_name ? getAgentByName(agent_name) : getDefaultDOAgent();
        
        const requestBody: DOAgentRequest = {
          messages: [{ role: 'user', content: query }],
          stream: false,
          retrieval_method: 'none',
          k: k ?? 10,
          include_retrieval_info: true,
          max_tokens: 50 // Minimal tokens for cheapest cost
        };

        const result = await callDOAgent(instance, requestBody);
        
        // Filter response based on include_ai_response flag
        const responseToReturn = include_ai_response 
          ? result
          : {
              ...result,
              choices: result.choices.map(choice => ({
                ...choice,
                message: { ...choice.message, content: '[AI response filtered - retrieval data only]' }
              }))
            };
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responseToReturn, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error in DO Agent basic search: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  // Rewrite search tool (retrieval_method: "rewrite") - DEFAULT
  server.addTool(
    'do_agent_rewrite_search',
    `Search in ${kbDescription} with query rewriting for improved retrieval. Returns enhanced document chunks.`,
    z.object({
      query: z.string().min(1).max(10000).describe('The search query to find relevant documents with AI query rewriting (1-10,000 chars, required)'),
      k: z.number().int().min(1).max(10).optional().describe('Number of document results to return (valid range: 1-10, default: 10)'),
      include_ai_response: z.boolean().optional().describe('Whether to include the AI-generated response (default: false)'),
      agent_name: z.string().optional().describe('Agent to search (agent_1, agent_2, etc. - default: use default agent)')
    }),
    async ({ query, k, include_ai_response, agent_name }) => {
      try {
        const instance = agent_name ? getAgentByName(agent_name) : getDefaultDOAgent();
        
        const requestBody: DOAgentRequest = {
          messages: [{ role: 'user', content: query }],
          stream: false,
          retrieval_method: 'rewrite',
          k: k ?? 10,
          include_retrieval_info: true,
          max_tokens: 50 // Minimal tokens for cheapest cost
        };

        const result = await callDOAgent(instance, requestBody);
        
        // Filter response based on include_ai_response flag
        const responseToReturn = include_ai_response 
          ? result
          : {
              ...result,
              choices: result.choices.map(choice => ({
                ...choice,
                message: { ...choice.message, content: '[AI response filtered - retrieval data only]' }
              }))
            };
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responseToReturn, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error in DO Agent rewrite search: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  // Step back search tool (retrieval_method: "step_back")
  server.addTool(
    'do_agent_step_back_search',
    `Search in ${kbDescription} using step-back retrieval method for broader context gathering.`,
    z.object({
      query: z.string().min(1).max(10000).describe('The search query for step-back retrieval strategy (1-10,000 chars, required)'),
      k: z.number().int().min(1).max(10).optional().describe('Number of document results to return (valid range: 1-10, default: 10)'),
      include_ai_response: z.boolean().optional().describe('Whether to include the AI-generated response (default: false)'),
      agent_name: z.string().optional().describe('Agent to search (agent_1, agent_2, etc. - default: use default agent)')
    }),
    async ({ query, k, include_ai_response, agent_name }) => {
      try {
        const instance = agent_name ? getAgentByName(agent_name) : getDefaultDOAgent();
        
        const requestBody: DOAgentRequest = {
          messages: [{ role: 'user', content: query }],
          stream: false,
          retrieval_method: 'step_back',
          k: k ?? 10,
          include_retrieval_info: true,
          max_tokens: 50 // Minimal tokens for cheapest cost
        };

        const result = await callDOAgent(instance, requestBody);
        
        // Filter response based on include_ai_response flag
        const responseToReturn = include_ai_response 
          ? result
          : {
              ...result,
              choices: result.choices.map(choice => ({
                ...choice,
                message: { ...choice.message, content: '[AI response filtered - retrieval data only]' }
              }))
            };
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responseToReturn, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error in DO Agent step-back search: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  // Sub queries search tool (retrieval_method: "sub_queries")
  server.addTool(
    'do_agent_sub_queries_search',
    `Search in ${kbDescription} using sub-queries method for comprehensive information retrieval.`,
    z.object({
      query: z.string().min(1).max(10000).describe('The search query for sub-queries retrieval strategy (1-10,000 chars, required)'),
      k: z.number().int().min(1).max(10).optional().describe('Number of document results to return (valid range: 1-10, default: 10)'),
      include_ai_response: z.boolean().optional().describe('Whether to include the AI-generated response (default: false)'),
      agent_name: z.string().optional().describe('Agent to search (agent_1, agent_2, etc. - default: use default agent)')
    }),
    async ({ query, k, include_ai_response, agent_name }) => {
      try {
        const instance = agent_name ? getAgentByName(agent_name) : getDefaultDOAgent();
        
        const requestBody: DOAgentRequest = {
          messages: [{ role: 'user', content: query }],
          stream: false,
          retrieval_method: 'sub_queries',
          k: k ?? 10,
          include_retrieval_info: true,
          max_tokens: 50 // Minimal tokens for cheapest cost
        };

        const result = await callDOAgent(instance, requestBody);
        
        // Filter response based on include_ai_response flag
        const responseToReturn = include_ai_response 
          ? result
          : {
              ...result,
              choices: result.choices.map(choice => ({
                ...choice,
                message: { ...choice.message, content: '[AI response filtered - retrieval data only]' }
              }))
            };
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responseToReturn, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error in DO Agent sub-queries search: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  // DO Agent management tools
  server.addTool(
    'list_do_agents',
    'List all available agent instances configured in the server',
    z.object({}),
    async () => {
      try {
        const instances = getDOAgentInstances();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              agents: instances.map((instance, index) => ({
                name: `agent_${index + 1}`,
                description: instance.description,
                is_default: instance.is_default
              })),
              total: instances.length,
              default: `agent_${(instances.findIndex(i => i.is_default) + 1) || 1}`
            }, null, 2)
          }]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `Error listing DO Agent instances: ${errorMessage}`
          }]
        };
      }
    }
  );

  server.addTool(
    'get_current_do_agent',
    'Get the currently configured default agent instance',
    z.object({}),
    async () => {
      try {
        const defaultInstance = getDefaultDOAgent();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              current_agent: {
                agent_name: "agent_1",
                description: defaultInstance.description,
                is_default: true
              }
            }, null, 2)
          }]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `Error getting current DO Agent: ${errorMessage}`
          }]
        };
      }
    }
  );

  return server;
}

// Rate limiting function using Durable Objects
async function checkRateLimit(request: Request, env: Env): Promise<Response | null> {
  if (!env.RATE_LIMITER) {
    console.error('RATE_LIMITER Durable Object namespace not found - rate limiting disabled');
    return null;
  }

  const rateLimit = parseInt(env.RATE_LIMIT_PER_WINDOW || '30');
  const windowSeconds = parseInt(env.RATE_LIMIT_WINDOW_SECONDS || '60');
  const globalRateLimit = parseInt(env.GLOBAL_RATE_LIMIT_PER_WINDOW || '100');
  const globalWindowSeconds = parseInt(env.GLOBAL_RATE_LIMIT_WINDOW_SECONDS || '120');
  
  // Get client IP - Cloudflare Workers automatically populate CF-Connecting-IP
  const clientIP = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For') || 
                   request.headers.get('X-Real-IP') ||
                   'fallback-ip'; // Use fallback instead of bypassing completely

  try {
    // Create or get the Durable Object instance for global rate limiting
    // Use a fixed ID for global rate limiting to ensure all requests go to the same instance
    const globalId = env.RATE_LIMITER.idFromName('global-rate-limiter');
    const rateLimiterObject = env.RATE_LIMITER.get(globalId);
    
    // Call the Durable Object with both per-IP and global rate limiting parameters
    const rateLimitUrl = new URL('https://rate-limiter');
    rateLimitUrl.searchParams.set('clientIP', clientIP);
    rateLimitUrl.searchParams.set('limit', rateLimit.toString());
    rateLimitUrl.searchParams.set('windowSeconds', windowSeconds.toString());
    rateLimitUrl.searchParams.set('globalLimit', globalRateLimit.toString());
    rateLimitUrl.searchParams.set('globalWindowSeconds', globalWindowSeconds.toString());
    
    const response = await rateLimiterObject.fetch(rateLimitUrl.toString());
    const result = await response.json();
    
    if (!result.allowed) {
      // Rate limit exceeded - determine if it's per-IP or global
      const isGlobalLimit = result.reason === 'global_limit';
      const limitValue = isGlobalLimit ? globalRateLimit : rateLimit;
      const windowValue = isGlobalLimit ? globalWindowSeconds : windowSeconds;
      const limitType = isGlobalLimit ? 'global' : 'per IP';
      
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32099, // Custom rate limit error code
          message: 'Rate limit exceeded',
          data: {
            limit: limitValue,
            window: `${windowValue} seconds`,
            retry_after: windowValue,
            reason: limitType,
            message: `Too many requests. ${isGlobalLimit ? 'Global' : 'Per-IP'} limit: ${limitValue} requests per ${windowValue} seconds. Please try again later.`
          }
        },
        id: null
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': windowValue.toString(),
          'X-RateLimit-Limit': limitValue.toString(),
          'X-RateLimit-Remaining': Math.max(0, limitValue - result.count).toString(),
          'X-RateLimit-Reset': result.resetTime.toString(),
          'X-RateLimit-Type': limitType
        }
      });
    }
    
    // Request allowed
    return null;
    
  } catch (error) {
    // If rate limiting fails, allow the request (fail open)
    console.error('Rate limiting error:', error);
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Check rate limiting first (before any processing)
      const rateLimitResponse = await checkRateLimit(request, env);
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
          }
        });
      }

      // Only handle POST requests for MCP
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Invalid Request - only POST method supported'
          },
          id: null
        }), {
          status: 405,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
          }
        });
      }

      const body = await request.json() as JsonRpcRequest;
      const server = createServer(env);
      const response = await server.handleRequest(body);
      
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Rate-Limit-Applied': 'true'
        }
      });
      
    } catch (error) {
      console.error('Error handling MCP request:', error);
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Internal server error: ${error instanceof Error ? error.message : String(error)}`
        },
        id: null
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};