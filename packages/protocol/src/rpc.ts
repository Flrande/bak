import {
  type BakErrorCodeValue,
  BakErrorCode as BakErrorCodes,
  JSON_RPC_VERSION,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcSuccess
} from './types.js';

export class RpcError extends Error {
  readonly code: number;
  readonly bakCode?: BakErrorCodeValue;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: number,
    bakCode?: BakErrorCodeValue,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.bakCode = bakCode;
    this.details = details;
  }
}

export const BAK_ERROR_TO_RPC_CODE: Record<BakErrorCodeValue, number> = {
  [BakErrorCodes.E_NOT_PAIRED]: 4001,
  [BakErrorCodes.E_PERMISSION]: 4003,
  [BakErrorCodes.E_NOT_FOUND]: 4004,
  [BakErrorCodes.E_NEED_USER_CONFIRM]: 4090,
  [BakErrorCodes.E_TIMEOUT]: 4080,
  [BakErrorCodes.E_INVALID_PARAMS]: -32602,
  [BakErrorCodes.E_INTERNAL]: -32603,
  [BakErrorCodes.E_NOT_READY]: 4250
};

export function ok<TResult>(id: JsonRpcId, result: TResult): JsonRpcSuccess<TResult> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result
  };
}

export function fail(
  id: JsonRpcId,
  message: string,
  bakCode: BakErrorCodeValue,
  details?: Record<string, unknown>
): JsonRpcFailure {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code: BAK_ERROR_TO_RPC_CODE[bakCode],
      message,
      data: {
        bakCode,
        ...details
      }
    }
  };
}

export function parseJsonRpcLine(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as JsonRpcRequest;
  if (parsed.jsonrpc !== JSON_RPC_VERSION || typeof parsed.method !== 'string') {
    throw new RpcError('Invalid JSON-RPC message', -32600, BakErrorCodes.E_INVALID_PARAMS);
  }
  return parsed;
}
