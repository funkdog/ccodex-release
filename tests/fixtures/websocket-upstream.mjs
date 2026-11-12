import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function frame(opcode, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = data.length;
  else if (header.length === 4) {
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

export function websocketUpstream(server, onRequest, onError) {
  const peers = new Set();
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/responses") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    peers.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => peers.delete(socket));
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`, "X-GitHub-Request-Id: SYNTHETIC_WS_REQUEST",
      "X-Copilot-Service-Request-Id: SYNTHETIC_WS_SERVICE", "", "",
    ].join("\r\n"));
    const peer = {
      send(event) { socket.write(frame(1, JSON.stringify(event))); },
      close() { if (!socket.destroyed) socket.end(frame(8, Buffer.alloc(0))); },
      destroy() { socket.destroy(); },
      get closed() { return socket.destroyed; },
    };
    let storage = Buffer.allocUnsafe(65536);
    let buffered = 0;
    const receive = data => {
      if (buffered + data.length > storage.length) {
        const next = Buffer.allocUnsafe(Math.max(storage.length * 2, buffered + data.length));
        storage.copy(next, 0, 0, buffered);
        storage = next;
      }
      data.copy(storage, buffered);
      buffered += data.length;
      let consumed = 0;
      try {
        while (buffered - consumed >= 6) {
          const buffer = storage.subarray(consumed, buffered);
          assert.equal((buffer[0] & 0x80) !== 0, true, "The fixture accepts unfragmented native client frames.");
          assert.equal((buffer[1] & 0x80) !== 0, true, "Client frames must be masked.");
          const opcode = buffer[0] & 15;
          let length = buffer[1] & 127;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 8) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (buffer.length < 14) return;
            const extended = buffer.readBigUInt64BE(2);
            assert.ok(extended <= 256n * 1024n * 1024n);
            length = Number(extended);
            offset = 10;
          }
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          const value = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
          for (let index = 0; index < value.length; index += 1) value[index] ^= mask[index % 4];
          consumed += offset + 4 + length;
          if (opcode === 8) { socket.end(frame(8, value)); return; }
          if (opcode === 9) { socket.write(frame(10, value)); continue; }
          assert.equal(opcode, 1);
          const body = JSON.parse(value.toString("utf8"));
          assert.equal(body.type, "response.create");
          Promise.resolve(onRequest(req, peer, body)).catch(error => {
            onError(error);
            socket.destroy();
          });
        }
      } catch (error) {
        onError(error);
        socket.destroy();
      } finally {
        if (consumed) {
          // Compact only consumed frames, not the whole growing 22 MiB payload
          // on every TCP chunk.
          storage.copyWithin(0, consumed, buffered);
          buffered -= consumed;
        }
      }
    };
    socket.on("data", receive);
    if (head.length) receive(head);
  });
  return {
    get activeSockets() { return peers.size; },
    close() { for (const socket of peers) socket.destroy(); },
  };
}
