import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  OAuthError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export type LarkMcpOAuthErrorCode =
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_request'
  | 'pkce_required'
  | 'reauth_required'
  | 'server_error';

type ResponseBody = ReturnType<OAuthError['toResponseObject']> & {
  lark_mcp_error: LarkMcpOAuthErrorCode;
};

abstract class LarkOAuthError extends OAuthError {
  constructor(
    errorCode: OAuthError['errorCode'],
    message: string,
    private readonly larkMcpError: LarkMcpOAuthErrorCode,
    errorUri?: string,
  ) {
    super(errorCode, message, errorUri);
  }

  override toResponseObject(): ResponseBody {
    return {
      ...super.toResponseObject(),
      lark_mcp_error: this.larkMcpError,
    };
  }
}

export class LarkInvalidRequestError extends InvalidRequestError {
  constructor(
    message: string,
    public readonly larkMcpError: LarkMcpOAuthErrorCode = 'invalid_request',
  ) {
    super(message);
  }

  override toResponseObject(): ResponseBody {
    return {
      ...super.toResponseObject(),
      lark_mcp_error: this.larkMcpError,
    };
  }
}

export class LarkInvalidClientError extends InvalidClientError {
  constructor(message: string) {
    super(message);
  }

  override toResponseObject(): ResponseBody {
    return {
      ...super.toResponseObject(),
      lark_mcp_error: 'invalid_client',
    };
  }
}

export class LarkInvalidGrantError extends InvalidGrantError {
  constructor(
    message: string,
    public readonly larkMcpError: LarkMcpOAuthErrorCode = 'invalid_grant',
  ) {
    super(message);
  }

  override toResponseObject(): ResponseBody {
    return {
      ...super.toResponseObject(),
      lark_mcp_error: this.larkMcpError,
    };
  }
}

export class LarkReauthRequiredError extends LarkOAuthError {
  constructor(message: string) {
    super('invalid_grant', message, 'reauth_required');
  }
}

export class LarkServerError extends ServerError {
  constructor(message: string) {
    super(message);
  }

  override toResponseObject(): ResponseBody {
    return {
      ...super.toResponseObject(),
      lark_mcp_error: 'server_error',
    };
  }
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function getAxiosErrorDetails(error: any) {
  const status = error?.response?.status ?? error?.status;
  const data = error?.response?.data;
  const description =
    typeof data === 'string'
      ? data
      : data?.error_description || data?.msg || data?.message || JSON.stringify(data || {});

  return {
    status,
    description,
  };
}
