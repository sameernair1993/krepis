import type { Observer } from './collector.ts';
import { fieldStorage } from './context.ts';

/**
 * Apollo Server plugin: one Krepis unit of work per GraphQL operation, labelled `<operation> <name>` (for example
 * `query Orders`), so an N+1 inside resolvers is found and reported against the operation that caused it.
 *
 *   new ApolloServer({ schema, plugins: [observer.apolloPlugin()] })
 *
 * The unit is made current with `enterWith` in `requestDidStart`. That covers everything the operation runs: explicit
 * resolvers, default resolvers that call a method on the source object (model classes), type resolvers, and the hooks
 * of plugins listed after this one. Wrapping the schema's resolvers in `AsyncLocalStorage.run` instead was tried and
 * rejected: graphql-js completes child fields in the parent's `.then`, registered outside the wrapper, so a default
 * resolver's I/O was not attributed (test P9).
 *
 * `enterWith` reaches the code that called into Apollo only if it runs before Apollo's first `await`; Apollo 4 and 5
 * await server start-up (and context creation, over HTTP) before `requestDidStart`, so the caller's continuation keeps
 * its own context. Should that ever change, the leak is still harmless: once the operation's unit ends, code still
 * running in it is attributed to the unit that was current when the operation began.
 *
 * `willResolveField` makes the field current (`Order.user`) for the resolver it precedes. Apollo calls it synchronously
 * just before the resolver, so the resolver's queries see it. It is only the call-site fallback for a resolver that
 * returns the query promise without `await`, which leaves no application frame. Pass
 * `{ resolverSites: false }` to skip the per-field hook.
 *
 * No runtime dependency on @apollo/server: the types below are structural.
 */

interface RequestContextLike {
  operationName?: string | null;
  operation?: { operation?: string } | null;
  request?: { variables?: unknown };
}

interface FieldResolverParamsLike {
  info: { fieldName: string; parentType: { name: string } };
}

export interface ApolloPluginOptions {
  /** Name the resolver as the call site when a query leaves no application frame. Default true. */
  resolverSites?: boolean;
}

export interface ApolloPlugin {
  requestDidStart(requestContext: RequestContextLike): Promise<{
    didResolveOperation(requestContext: RequestContextLike): Promise<void>;
    executionDidStart?(): Promise<{ willResolveField(params: FieldResolverParamsLike): void }>;
    willSendResponse(requestContext: RequestContextLike): Promise<void>;
  } | void>;
}

const fieldListener = {
  willResolveField({ info }: FieldResolverParamsLike): void {
    fieldStorage.enterWith(`${info.parentType.name}.${info.fieldName}`);
  },
};

export function apolloPlugin(observer: Observer, options: ApolloPluginOptions = {}): ApolloPlugin {
  const resolverSites = options.resolverSites ?? true;
  return {
    async requestDidStart(requestContext) {
      let unit;
      try {
        unit = observer.begin('graphql');
        unit?.enter();
        unit?.input('variables', () => requestContext.request?.variables);
      } catch {
        observer.internalErrors++;
      }
      if (!unit) return;
      const u = unit;
      return {
        async didResolveOperation({ operation, operationName }) {
          u.label = `${operation?.operation ?? 'operation'} ${operationName ?? 'anonymous'}`;
        },
        ...(resolverSites ? { executionDidStart: async () => fieldListener } : {}),
        async willSendResponse() {
          try {
            u.end();
          } catch {
            observer.internalErrors++;
          }
        },
      };
    },
  };
}
