// A Node request as the Function URL event the Lambdas receive (payload format 2.0), and their
// structured result back onto the Node response. The UI server runs the same handler code as `Bff`
// and `PublicWeb`, including the `/api` prefix stripping and the headers they set.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}

let sequence = 0;

export function functionUrlEvent(request: IncomingMessage, body: Buffer): APIGatewayProxyEventV2 {
  const url = new URL(request.url ?? "/", "http://ui-server.local");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  const method = request.method ?? "GET";
  sequence += 1;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    isBase64Encoded: body.length > 0,
    ...(body.length > 0 ? { body: body.toString("base64") } : {}),
    requestContext: {
      accountId: "anonymous",
      apiId: "ui-server",
      domainName: url.host,
      domainPrefix: "ui-server",
      http: { method, path: url.pathname, protocol: "HTTP/1.1", sourceIp: request.socket.remoteAddress ?? "127.0.0.1", userAgent: headers["user-agent"] ?? "" },
      requestId: `ui-server-${sequence.toString().padStart(8, "0")}`,
      routeKey: "$default",
      stage: "$default",
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
    },
  };
}

export function writeResult(response: ServerResponse, result: APIGatewayProxyStructuredResultV2): void {
  const headers: Record<string, string | number | boolean> = { ...(result.headers ?? {}) };
  response.writeHead(result.statusCode ?? 200, Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)])));
  if (result.body === undefined) {
    response.end();
    return;
  }
  response.end(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
}
