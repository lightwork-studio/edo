import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeHelloRequest,
  maxSyncEnvelopeBytes,
  type NegotiatedSync,
  negotiateHello,
  type SyncErrorCode,
  type SyncRelease,
  SyncWireError,
  syncCandidate,
} from "@edo/contract";
import type { SyncStore } from "./sync-store.ts";

export interface SyncAccess {
  readonly accountBinding: string;
  /** A stable opaque key for the session returned by trusted authentication. */
  readonly sessionKey: string;
}

export interface SyncHttpOptions {
  readonly store: SyncStore;
  readonly authorize: (request: IncomingMessage) => SyncAccess | null | Promise<SyncAccess | null>;
  readonly releases?: readonly SyncRelease[];
}

const routes = new Set(["/sync/hello", "/sync/history", "/sync/push", "/sync/pull"]);
const maxSessions = 1024;
// Leave room for one compact outcome per submission even when IDs need JSON escaping.
const maxRequestBytes = (maxSyncEnvelopeBytes * 3) / 4;
const statusForCode: Record<SyncErrorCode, number> = {
  "invalid-request": 400,
  unauthorized: 401,
  "update-required": 426,
  "write-disabled": 403,
  "account-changed": 409,
  "lineage-changed": 409,
  "cursor-reset": 409,
  unavailable: 503,
};

function send(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maxSyncEnvelopeBytes) {
    throw new SyncWireError("unavailable", "The response exceeded the sync limit");
  }
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function fail(response: ServerResponse, error: unknown) {
  if (error instanceof SyncWireError) {
    send(response, statusForCode[error.code], {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  send(response, 503, { error: { code: "unavailable", message: "Account sync is unavailable" } });
}

class RequestTooLarge extends Error {}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new SyncWireError("invalid-request", "Expected JSON");
  if (Number(request.headers["content-length"]) > maxRequestBytes) throw new RequestTooLarge();
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > maxRequestBytes) throw new RequestTooLarge();
    parts.push(part);
  }
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    return JSON.parse(utf8.decode(Buffer.concat(parts, bytes)));
  } catch {
    throw new SyncWireError("invalid-request", "Invalid JSON request");
  }
}

/** Candidate transport. Callers supply an authenticator and choose where to expose it. */
export function syncHttp({ store, authorize, releases = [syncCandidate] }: SyncHttpOptions) {
  const sessions = new Map<string, NegotiatedSync>();

  function remember(key: string, session: NegotiatedSync) {
    sessions.delete(key);
    sessions.set(key, session);
    if (sessions.size > maxSessions) {
      const first = sessions.keys().next().value;
      if (first !== undefined) sessions.delete(first);
    }
  }

  return async function handleSync(request: IncomingMessage, response: ServerResponse) {
    const path = request.url?.split("?", 1)[0] ?? "";
    if (!routes.has(path)) return false;
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" }).end();
      return true;
    }
    try {
      const access = await authorize(request);
      if (!access?.sessionKey) {
        throw new SyncWireError("unauthorized", "Account sync authorization is required");
      }
      const { accountBinding, sessionKey } = access;
      const body = await jsonBody(request);
      const verified = await authorize(request);
      if (
        !verified ||
        verified.sessionKey !== sessionKey ||
        verified.accountBinding !== accountBinding
      ) {
        throw new SyncWireError("unauthorized", "Account sync authorization changed");
      }
      const history = store.history(accountBinding);
      if (!history) throw new SyncWireError("unauthorized", "Account sync authorization changed");
      if (path === "/sync/hello" || path === "/sync/history") {
        const connect = path === "/sync/hello";
        const request = connect ? body : { ...decodeHelloRequest(body), features: [] };
        const hello = negotiateHello(request, history, releases);
        if (hello.status === "update-required") {
          if (connect) sessions.delete(sessionKey);
          send(response, 426, hello);
        } else {
          if (connect) remember(sessionKey, hello.session);
          send(response, 200, hello.response);
        }
        return true;
      }
      const session = sessions.get(sessionKey);
      if (!session || session.accountBinding !== accountBinding) {
        throw new SyncWireError("update-required", "Connect again before syncing records");
      }
      remember(sessionKey, session);
      send(
        response,
        200,
        path === "/sync/push"
          ? store.push(accountBinding, session, body)
          : store.pull(accountBinding, session, body),
      );
    } catch (error) {
      request.resume();
      if (error instanceof RequestTooLarge) {
        response.setHeader("Connection", "close");
        send(response, 413, {
          error: { code: "invalid-request", message: "The request exceeded the sync limit" },
        });
      } else {
        fail(response, error);
      }
    }
    return true;
  };
}
