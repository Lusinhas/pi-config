import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";

export interface WsConnection {
  send(text: string): void;
  close(): void;
}

export interface WsCallbacks {
  onMessage(text: string): void;
  onClose(reason: string): void;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  consumed: number;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function parseFrame(buffer: Buffer): ParsedFrame | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket frame too large");
    length = Number(big);
    offset += 8;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { fin, opcode, payload, consumed: offset + length };
}

function attach(socket: Socket, callbacks: WsCallbacks): WsConnection {
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let closed = false;

  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    socket.removeAllListeners("data");
    socket.destroy();
    callbacks.onClose(reason);
  };

  const writeFrame = (opcode: number, payload: Buffer): void => {
    try {
      socket.write(encodeFrame(opcode, payload));
    } catch {
      finish("write failed");
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (!closed) {
      let frame: ParsedFrame | null;
      try {
        frame = parseFrame(buffer);
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
        return;
      }
      if (frame === null) break;
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        writeFrame(0x8, Buffer.alloc(0));
        finish("closed by IDE");
        return;
      }
      if (frame.opcode === 0x9) {
        writeFrame(0xa, frame.payload);
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x0 || frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (frame.opcode !== 0x0) fragmentOpcode = frame.opcode;
        fragments.push(frame.payload);
        if (frame.fin) {
          const message = Buffer.concat(fragments);
          const kind = fragmentOpcode;
          fragments = [];
          fragmentOpcode = 0;
          if (kind === 0x1) callbacks.onMessage(message.toString("utf8"));
        }
      }
    }
  });
  socket.on("error", (error: Error) => finish(error.message));
  socket.on("close", () => finish("socket closed"));

  return {
    send(text: string): void {
      if (closed) throw new Error("websocket is closed");
      writeFrame(0x1, Buffer.from(text, "utf8"));
    },
    close(): void {
      if (closed) return;
      writeFrame(0x8, Buffer.alloc(0));
      finish("closed");
    },
  };
}

export function wsConnect(
  host: string,
  port: number,
  headers: Record<string, string>,
  timeoutMs: number,
  callbacks: WsCallbacks,
): Promise<WsConnection> {
  return new Promise((resolvePromise, rejectPromise) => {
    const key = randomBytes(16).toString("base64");
    const req = request({
      host,
      port,
      path: "/",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        ...headers,
      },
      timeout: timeoutMs,
    });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      rejectPromise(error);
    };
    req.on("timeout", () => fail(new Error("connection timed out")));
    req.on("error", (error: Error) => fail(error));
    req.on("response", (res) => fail(new Error(`websocket handshake rejected with status ${res.statusCode}`)));
    req.on("upgrade", (res, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        fail(new Error("websocket handshake returned an invalid accept header"));
        return;
      }
      settled = true;
      socket.setNoDelay(true);
      resolvePromise(attach(socket, callbacks));
    });
    req.end();
  });
}
