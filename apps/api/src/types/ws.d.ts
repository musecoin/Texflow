// Minimal typings for the subset of `ws` used here (@types/ws was not installable offline).
declare module 'ws' {
  import type { EventEmitter } from 'node:events';
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';
  class WebSocket extends EventEmitter {
    constructor(address: string, protocols?: string | string[]);
    readonly OPEN: 1;
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  }
  export class WebSocketServer extends EventEmitter {
    constructor(opts: { noServer?: boolean; handleProtocols?: (protocols: Set<string>, req: IncomingMessage) => string | false });
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket) => void): void;
    close(): void;
  }
  export type { WebSocket };
  export default WebSocket;
}
