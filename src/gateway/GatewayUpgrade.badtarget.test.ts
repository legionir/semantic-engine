import { EventEmitter } from 'events';
import type * as http from 'http';
import { GatewayAuth } from './GatewayAuth';
import { handleGatewayUpgrade } from './GatewayUpgrade';
import { parseUrlSafely } from '../server/httpRequestUtils';

/*
| F-04 — `GET // HTTP/1.1` with `Upgrade: websocket` reaches the 'upgrade'
| listener before any authentication. `new URL('//', base)` throws, and a
| synchronous throw inside an event listener is an uncaught exception: one
| unauthenticated request killed the whole Gateway.
*/
describe('request targets that are not valid URLs', () => {
  it('parseUrlSafely returns null instead of throwing', () => {
    expect(parseUrlSafely('//', 'http://x.local')).toBeNull();
    expect(parseUrlSafely('//%', 'http://x.local')).toBeNull();
    expect(parseUrlSafely('/ws/projects/a?token=t', 'http://x.local')?.pathname).toBe('/ws/projects/a');
    expect(parseUrlSafely(undefined, 'http://x.local')?.pathname).toBe('/');
  });

  it('the Gateway upgrade handler answers 400 and does not throw', () => {
    const written: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: (chunk: string) => { written.push(chunk); return true; },
      destroy() { this.destroyed = true; },
    });
    const req = { url: '//', headers: {} } as unknown as http.IncomingMessage;

    expect(() =>
      handleGatewayUpgrade(
        { auth: new GatewayAuth('t'), registry: {} as never, supervisor: {} as never },
        req,
        socket as never,
        Buffer.alloc(0)
      )
    ).not.toThrow();
    expect(written.join('')).toMatch(/^HTTP\/1\.1 400 /);
    expect(socket.destroyed).toBe(true);
  });
});
