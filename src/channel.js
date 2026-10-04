// One open window on one computer.
//
// A Durable Object per channel, which is what makes "it appears on the screen"
// work without polling: the object holds the open connections and the event
// log for that one window, so a page arriving is pushed to exactly the right
// screen and nowhere else.
//
// The log is kept, not just broadcast, because polling is a permanent fallback
// for networks that break streaming - and the contract tests assert that
// polling returns exactly what the stream delivered, same events, same order,
// same sequence numbers (docs/api.md section 4).

export class Channel {
  constructor(state) {
    this.state = state;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/publish') {
      const event = await request.json();
      return this.publish(event);
    }

    if (url.pathname === '/events') {
      return this.stream(Number(url.searchParams.get('since') ?? 0));
    }

    if (url.pathname === '/list') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return Response.json({ events: await this.since(since) });
    }

    return new Response('not found', { status: 404 });
  }

  async since(seq) {
    const stored = await this.state.storage.list({ prefix: 'e:' });
    return [...stored.values()].filter((event) => event.seq > seq).sort((a, b) => a.seq - b.seq);
  }

  async publish(event) {
    const seq = ((await this.state.storage.get('seq')) ?? 0) + 1;
    const stamped = { ...event, seq, at: new Date().toISOString() };
    await this.state.storage.put(`e:${seq}`, stamped);
    await this.state.storage.put('seq', seq);

    // Never wait on a browser. A window that has gone away leaves a writer
    // whose queue is full, and awaiting it would block this publish - and with
    // it the phone's upload - until it timed out. Write, and clean up after.
    const frame = new TextEncoder().encode(`data: ${JSON.stringify(stamped)}\n\n`);
    for (const writer of [...this.sockets]) {
      writer.write(frame).catch(() => this.sockets.delete(writer));
    }
    return Response.json(stamped);
  }

  async stream(since) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    this.sockets.add(writer);

    // The backlog is written after this function returns, not before: nothing
    // is reading the other end of the stream until the Response has gone back
    // to the browser, so awaiting a write here deadlocks the connection it is
    // trying to serve.
    const encoder = new TextEncoder();
    (async () => {
      try {
        // A comment line first, so the browser sees the stream open at once.
        await writer.write(encoder.encode(': waiting\n\n'));
        // Then anything that happened while this window was away, so a
        // reconnecting browser misses nothing.
        for (const event of await this.since(since)) {
          await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch {
        this.sockets.delete(writer);
      }
    })();

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    });
  }
}
