import type { Observer, Unit } from './collector.ts';

/**
 * One unit of work per request for Fastify, Koa and Hono, labelled with the route pattern (`GET /users/:id`) when the
 * framework exposes it. Express and Connect (and NestJS on Express) use `observer.middleware()`.
 *
 * Only structural types are used here, so the kit has no dependency on any framework.
 */

const ID_SEGMENT = /^(?:[0-9a-f]{24}|[0-9a-f-]{36}|\d+)$/i;
/** A catch-all route (`*`, Express 5 `/*splat`, `(.*)`, Hono `/*`): its pattern says nothing about the page. */
export const WILDCARD_ROUTE = /^\/?(?:\*\w*|\(\.\*\))$/;

/** The path without its query string, with id-like segments masked: `/users/42?x=1` → `/users/:id`. */
export function maskedPath(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.split('/').map((s) => (ID_SEGMENT.test(s) ? ':id' : s)).join('/');
}

function label(method: string | undefined, pattern: unknown, url: string): string {
  const route = typeof pattern === 'string' && pattern !== '' && !WILDCARD_ROUTE.test(pattern) ? pattern : maskedPath(url);
  return `${method ?? 'REQUEST'} ${route}`;
}

interface FastifyRequestLike { method: string; url: string; routeOptions?: { url?: string }; routerPath?: string; body?: unknown; query?: unknown; params?: unknown }
interface FastifyReplyLike { raw: { once(event: 'finish' | 'close', listener: () => void): unknown } }
type FastifyHook = (request: FastifyRequestLike, reply: FastifyReplyLike, done: () => void) => void;
interface FastifyLike { addHook(name: 'onRequest' | 'preValidation' | 'preHandler', hook: FastifyHook): unknown }

/** A Fastify plugin: `await app.register(observer.fastifyPlugin())`. */
export type FastifyPlugin = ((fastify: FastifyLike, options: unknown, done: () => void) => void) & Record<symbol, unknown>;

const fastifyLabel = (r: FastifyRequestLike) => label(r.method, r.routeOptions?.url ?? r.routerPath, r.url);

export function fastifyPlugin(observer: Observer): FastifyPlugin {
  const units = new WeakMap<object, Unit>();
  // Request bodies are read in stream callbacks, outside the unit, so the hooks after parsing enter it again.
  const reenter: FastifyHook = (request, _reply, done) => {
    const unit = units.get(request);
    if (unit) unit.run(done);
    else done();
  };
  const plugin = ((fastify, _options, done) => {
    fastify.addHook('onRequest', (request, reply, next) => {
      const unit = observer.begin(fastifyLabel(request));
      if (!unit) return next();
      units.set(request, unit);
      unit.input('body', () => request.body);
      unit.input('query', () => request.query);
      unit.input('params', () => request.params);
      const finish = () => {
        unit.label = fastifyLabel(request);
        unit.end();
      };
      reply.raw.once('finish', finish);
      reply.raw.once('close', finish);
      unit.run(next);
    });
    fastify.addHook('preValidation', reenter);
    fastify.addHook('preHandler', reenter);
    done();
  }) as FastifyPlugin;
  // Apply the hooks to the whole application, not only to routes registered inside this plugin.
  plugin[Symbol.for('skip-override')] = true;
  plugin[Symbol.for('fastify.display-name')] = 'krepis';
  return plugin;
}

interface KoaContextLike { method: string; path: string; _matchedRoute?: unknown; request?: { body?: unknown }; query?: unknown; params?: unknown }

/** Koa middleware: `app.use(observer.koaMiddleware())`, before the router. The route pattern comes from @koa/router. */
export function koaMiddleware(observer: Observer): (ctx: KoaContextLike, next: () => Promise<unknown>) => Promise<unknown> {
  return async (ctx, next) => {
    const unit = observer.begin(label(ctx.method, undefined, ctx.path));
    if (!unit) return next();
    unit.input('body', () => ctx.request?.body);
    unit.input('query', () => ctx.query);
    unit.input('params', () => ctx.params);
    try {
      return await unit.run(next);
    } finally {
      unit.label = label(ctx.method, ctx._matchedRoute, ctx.path);
      unit.end();
    }
  };
}

interface HonoContextLike { req: { method: string; path: string; routePath?: string; json?: () => Promise<unknown> } }

/** Hono middleware: `app.use(observer.honoMiddleware())`. Runs where AsyncLocalStorage does (Node, Bun, Deno). */
export function honoMiddleware(observer: Observer): (c: HonoContextLike, next: () => Promise<void>) => Promise<void> {
  return async (c, next) => {
    const unit = observer.begin(label(c.req.method, undefined, c.req.path));
    if (!unit) return next();
    // Hono parses a body only when asked, and keeps the promise, not the value: note the value as it is handed out.
    const json = c.req.json;
    if (observer.readsInput && typeof json === 'function') {
      let body: unknown;
      c.req.json = function (this: unknown) {
        const parsed = json.call(this);
        parsed.then((value) => (body = value), () => undefined);
        return parsed;
      };
      unit.input('body', () => body);
    }
    try {
      await unit.run(next);
    } finally {
      // After `next()`, routePath is the pattern of the last handler that ran: the route.
      unit.label = label(c.req.method, c.req.routePath, c.req.path);
      unit.end();
    }
  };
}
