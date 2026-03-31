import express, { NextFunction, Request, Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { InitTransportServerFunction } from '../shared';
import { LarkAuthHandler } from '../../auth';
import { parseMCPServerOptionsFromRequest } from './utils';
import { logger } from '../../utils/logger';
import { authStore } from '../../auth/store';

export const initSSEServer: InitTransportServerFunction = async (
  getNewServer,
  options,
  { needAuthFlow } = { needAuthFlow: false },
) => {
  const { userAccessToken, port, host, oauth } = options;

  if (!port || !host) {
    throw new Error('[Lark MCP] Port and host are required');
  }

  const app = express();
  const transports: Map<string, SSEServerTransport> = new Map();

  let authHandler: LarkAuthHandler | undefined;

  if (!userAccessToken && needAuthFlow) {
    if (oauth && options.publicBaseUrl) {
      await authStore.ensurePersistentStorage('Hosted OAuth mode requires persistent storage');
    }
    authHandler = new LarkAuthHandler(app, {
      ...options,
      resourceServerUrl: options.publicBaseUrl ? new URL('/sse', options.publicBaseUrl).toString() : undefined,
    });
    if (oauth) {
      authHandler.setupRoutes();
      const status = await authStore.getStorageStatus();
      logger.info(
        `[SSEServerTransport] OAuth storage status: ready=${status.storageReady}, persistent=${status.persistentStorage}, clients=${status.counts.clients}, sessions=${status.counts.mcpSessions}, credentials=${status.counts.larkCredentials}`,
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

  app.get('/sse', authMiddleware, async (req: Request, res: Response) => {
    logger.info(`[SSEServerTransport] Received GET SSE request`);

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
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      transport.close();
      server.close();
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  });

  app.post('/messages', authMiddleware, async (req: Request, res: Response) => {
    console.log('Received POST messages request');
    logger.info(`[SSEServerTransport] Received POST messages request`);

    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).send('No transport found for sessionId');
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  console.log('⚠️ SSE Mode is deprecated and will be removed in a future version. Please use Streamable mode instead.');

  app.listen(port, host, (error) => {
    if (error) {
      logger.error(`[SSEServerTransport] Server error: ${error}`);
      process.exit(1);
    }
    console.log(`📡 SSE endpoint: http://${host}:${port}/sse`);
    logger.info(`[SSEServerTransport] SSE endpoint: http://${host}:${port}/sse`);
  });
};
