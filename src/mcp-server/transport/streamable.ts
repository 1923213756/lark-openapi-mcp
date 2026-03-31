import express, { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InitTransportServerFunction } from '../shared';
import { parseMCPServerOptionsFromRequest, sendJsonRpcError } from './utils';
import { LarkAuthHandler } from '../../auth';
import { logger } from '../../utils/logger';
import { authStore } from '../../auth/store';

function sendStreamableJsonRpcError(
  res: Response,
  httpStatus: number,
  message: string,
  larkMcpError: string,
  details?: Record<string, unknown>,
) {
  res.status(httpStatus).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
      data: {
        lark_mcp_error: larkMcpError,
        ...details,
      },
    },
    id: null,
  });
}

export const initStreamableServer: InitTransportServerFunction = async (
  getNewServer,
  options,
  { needAuthFlow } = { needAuthFlow: false },
) => {
  const { userAccessToken, oauth, port, host } = options;

  if (!port || !host) {
    throw new Error('[Lark MCP] Port and host are required');
  }

  const app = express();
  app.use(express.json());

  let authHandler: LarkAuthHandler | undefined;

  if (!userAccessToken && needAuthFlow) {
    if (oauth && options.publicBaseUrl) {
      await authStore.ensurePersistentStorage('Hosted OAuth mode requires persistent storage');
    }
    authHandler = new LarkAuthHandler(app, {
      ...options,
      resourceServerUrl: options.publicBaseUrl ? new URL('/mcp', options.publicBaseUrl).toString() : undefined,
    });
    if (oauth) {
      authHandler.setupRoutes();
      const status = await authStore.getStorageStatus();
      logger.info(
        `[StreamableServerTransport] OAuth storage status: ready=${status.storageReady}, persistent=${status.persistentStorage}, clients=${status.counts.clients}, sessions=${status.counts.mcpSessions}, credentials=${status.counts.larkCredentials}`,
      );
    }
  }

  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (authHandler && oauth) {
      authHandler.authenticateRequest(req, res, next);
    } else {
      const authToken = req.headers.authorization?.split(' ')[1];
      if (authToken) {
        req.auth = { token: authToken, clientId: 'client_id_for_local_auth', scopes: [] };
      }
      next();
    }
  };

  app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const acceptHeader = req.headers.accept || '';
    const contentType = req.headers['content-type'] || '';
    if (
      typeof acceptHeader !== 'string' ||
      !acceptHeader.includes('application/json') ||
      !acceptHeader.includes('text/event-stream')
    ) {
      sendStreamableJsonRpcError(
        res,
        406,
        'Not Acceptable: Client must accept both application/json and text/event-stream.',
        'invalid_accept_header',
        { required_accept: 'application/json, text/event-stream' },
      );
      return;
    }

    if (typeof contentType !== 'string' || !contentType.startsWith('application/json')) {
      sendStreamableJsonRpcError(
        res,
        415,
        'Unsupported Media Type: Content-Type must be application/json.',
        'invalid_content_type',
        { required_content_type: 'application/json' },
      );
      return;
    }

    const bearerToken = req.auth?.token;
    const resolvedUserAccessToken =
      authHandler && oauth && typeof authHandler.resolveUserAccessToken === 'function'
        ? await authHandler.resolveUserAccessToken(bearerToken)
        : bearerToken;
    const { data } = parseMCPServerOptionsFromRequest(req);
    const server = getNewServer(
      { ...options, ...data, userAccessToken: data.userAccessToken || resolvedUserAccessToken },
      authHandler,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const handleMethodNotAllowed = async (_req: Request, res: Response) => {
    sendStreamableJsonRpcError(res, 405, 'Method not allowed. Use POST /mcp.', 'method_not_allowed', {
      allowed_method: 'POST',
      endpoint: '/mcp',
    });
  };

  app.get('/mcp', async (req: Request, res: Response) => {
    try {
      console.log('Received GET MCP request');
      logger.info(`[StreamableServerTransport] Received GET MCP request`);
      await handleMethodNotAllowed(req, res);
    } catch (error) {
      sendJsonRpcError(res, error as Error);
    }
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    try {
      console.log('Received DELETE MCP request');
      logger.info(`[StreamableServerTransport] Received DELETE MCP request`);
      await handleMethodNotAllowed(req, res);
    } catch (error) {
      sendJsonRpcError(res, error as Error);
    }
  });

  app.listen(port, host, (error) => {
    if (error) {
      logger.error(`[StreamableServerTransport] Server error: ${error}`);
      process.exit(1);
    }
    console.log(`📡 Streamable endpoint: http://${host}:${port}/mcp`);
    logger.info(`[StreamableServerTransport] Streamable endpoint: http://${host}:${port}/mcp`);
  });
};
