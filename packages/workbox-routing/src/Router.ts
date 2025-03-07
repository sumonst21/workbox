/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import {assert} from 'workbox-core/_private/assert.js';
import {logger} from 'workbox-core/_private/logger.js';
import {WorkboxError} from 'workbox-core/_private/WorkboxError.js';
import {getFriendlyURL} from 'workbox-core/_private/getFriendlyURL.js';
import {Route} from './Route.js';
import {HTTPMethod} from './utils/constants.js';
import {normalizeHandler} from './utils/normalizeHandler.js';
import {Handler, HandlerCallback, HandlerCallbackOptions} from './_types.js';
import './_version.js';


type RequestArgs = string | [string, RequestInit?];


interface CacheURLsMessageData {
  type: string;
  payload: {
    urlsToCache: RequestArgs[],
  };
}

/**
 * The Router can be used to process a FetchEvent through one or more
 * [Routes]{@link workbox.routing.Route} responding  with a Request if
 * a matching route exists.
 *
 * If no route matches a given a request, the Router will use a "default"
 * handler if one is defined.
 *
 * Should the matching Route throw an error, the Router will use a "catch"
 * handler if one is defined to gracefully deal with issues and respond with a
 * Request.
 *
 * If a request matches multiple routes, the **earliest** registered route will
 * be used to respond to the request.
 *
 * @memberof workbox.routing
 */
class Router {
  private _routes: Map<HTTPMethod, Route[]>;
  private _defaultHandler: Handler;
  private _catchHandler: Handler;

  /**
   * Initializes a new Router.
   */
  constructor() {
    this._routes = new Map();
  }

  /**
   * @return {Map<string, Array<workbox.routing.Route>>} routes A `Map` of HTTP
   * method name ('GET', etc.) to an array of all the corresponding `Route`
   * instances that are registered.
   */
  get routes() {
    return this._routes;
  }

  /**
   * Adds a fetch event listener to respond to events when a route matches
   * the event's request.
   */
  addFetchListener() {
    self.addEventListener('fetch', (event: FetchEvent) => {
      const {request} = event;
      const responsePromise = this.handleRequest({request, event});
      if (responsePromise) {
        event.respondWith(responsePromise);
      }
    });
  }

  /**
   * Adds a message event listener for URLs to cache from the window.
   * This is useful to cache resources loaded on the page prior to when the
   * service worker started controlling it.
   *
   * The format of the message data sent from the window should be as follows.
   * Where the `urlsToCache` array may consist of URL strings or an array of
   * URL string + `requestInit` object (the same as you'd pass to `fetch()`).
   *
   * ```
   * {
   *   type: 'CACHE_URLS',
   *   payload: {
   *     urlsToCache: [
   *       './script1.js',
   *       './script2.js',
   *       ['./script3.js', {mode: 'no-cors'}],
   *     ],
   *   },
   * }
   * ```
   */
  addCacheListener() {
    self.addEventListener('message', async (event: ExtendableMessageEvent) => {
      if (event.data && event.data.type === 'CACHE_URLS') {
        const {payload}: CacheURLsMessageData = event.data;

        if (process.env.NODE_ENV !== 'production') {
          logger.debug(`Caching URLs from the window`, payload.urlsToCache);
        }

        const requestPromises = Promise.all(payload.urlsToCache.map(
            (entry: string | [string, RequestInit?]) => {
          if (typeof entry === 'string') {
            entry = [entry];
          }

          const request = new Request(...entry);
          return this.handleRequest({request});

        // TODO(philipwalton): Typescript errors without this typecast for
        // some reason (probably a bug). The real type here should work but
        // doesn't: `Array<Promise<Response> | undefined>`.
        }) as any[]); // Typescript

        event.waitUntil(requestPromises);

        // If a MessageChannel was used, reply to the message on success.
        if (event.ports && event.ports[0]) {
          await requestPromises;
          event.ports[0].postMessage(true);
        }
      }
    });
  }

  /**
   * Apply the routing rules to a FetchEvent object to get a Response from an
   * appropriate Route's handler.
   *
   * @param {Object} options
   * @param {Request} options.request The request to handle (this is usually
   *     from a fetch event, but it does not have to be).
   * @param {FetchEvent} [options.event] The event that triggered the request,
   *     if applicable.
   * @return {Promise<Response>|undefined} A promise is returned if a
   *     registered route can handle the request. If there is no matching
   *     route and there's no `defaultHandler`, `undefined` is returned.
   */
  handleRequest({request, event}: {
    request: Request,
    event?: ExtendableEvent,
  }): Promise<Response> | undefined {
    if (process.env.NODE_ENV !== 'production') {
      assert!.isInstance(request, Request, {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'handleRequest',
        paramName: 'options.request',
      });
    }

    const url = new URL(request.url, location.href);
    if (!url.protocol.startsWith('http')) {
      if (process.env.NODE_ENV !== 'production') {
        logger.debug(
            `Workbox Router only supports URLs that start with 'http'.`);
      }
      return;
    }

    let {params, route} = this.findMatchingRoute({url, request, event});
    let handler = route && route.handler;

    let debugMessages = [];
    if (process.env.NODE_ENV !== 'production') {
      if (handler) {
        debugMessages.push([
          `Found a route to handle this request:`, route,
        ]);

        if (params) {
          debugMessages.push([
            `Passing the following params to the route's handler:`, params,
          ]);
        }
      }
    }

    // If we don't have a handler because there was no matching route, then
    // fall back to defaultHandler if that's defined.
    if (!handler && this._defaultHandler) {
      if (process.env.NODE_ENV !== 'production') {
        debugMessages.push(`Failed to find a matching route. Falling ` +
          `back to the default handler.`);
      }
      handler = this._defaultHandler;
    }

    if (!handler) {
      if (process.env.NODE_ENV !== 'production') {
        // No handler so Workbox will do nothing. If logs is set of debug
        // i.e. verbose, we should print out this information.
        logger.debug(`No route found for: ${getFriendlyURL(url)}`);
      }
      return;
    }

    if (process.env.NODE_ENV !== 'production') {
      // We have a handler, meaning Workbox is going to handle the route.
      // print the routing details to the console.
      logger.groupCollapsed(`Router is responding to: ${getFriendlyURL(url)}`);
      debugMessages.forEach((msg) => {
        if (Array.isArray(msg)) {
          logger.log(...msg);
        } else {
          logger.log(msg);
        }
      });

      // The Request and Response objects contains a great deal of information,
      // hide it under a group in case developers want to see it.
      logger.groupCollapsed(`View request details here.`);
      logger.log(request);
      logger.groupEnd();

      logger.groupEnd();
    }

    // Wrap in try and catch in case the handle method throws a synchronous
    // error. It should still callback to the catch handler.
    let responsePromise;
    try {
      responsePromise = handler.handle({url, request, event, params});
    } catch (err) {
      responsePromise = Promise.reject(err);
    }

    if (responsePromise && this._catchHandler) {
      responsePromise = responsePromise.catch((err) => {
        if (process.env.NODE_ENV !== 'production') {
          // Still include URL here as it will be async from the console group
          // and may not make sense without the URL
          logger.groupCollapsed(`Error thrown when responding to: ` +
            ` ${getFriendlyURL(url)}. Falling back to Catch Handler.`);
          logger.error(`Error thrown by:`, route);
          logger.error(err);
          logger.groupEnd();
        }
        return this._catchHandler.handle({url, request, event});
      });
    }

    return responsePromise;
  }

  /**
   * Checks a request and URL (and optionally an event) against the list of
   * registered routes, and if there's a match, returns the corresponding
   * route along with any params generated by the match.
   *
   * @param {Object} options
   * @param {URL} options.url
   * @param {Request} options.request The request to match.
   * @param {Event} [options.event] The corresponding event (unless N/A).
   * @return {Object} An object with `route` and `params` properties.
   *     They are populated if a matching route was found or `undefined`
   *     otherwise.
   */
  findMatchingRoute({url, request, event}: {
    url: URL,
    request: Request,
    event?: ExtendableEvent
  }): {route?: Route, params?: HandlerCallbackOptions['params']} {
    if (process.env.NODE_ENV !== 'production') {
      assert!.isInstance(url, URL, {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'findMatchingRoute',
        paramName: 'options.url',
      });
      assert!.isInstance(request, Request, {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'findMatchingRoute',
        paramName: 'options.request',
      });
    }

    const routes = this._routes.get(request.method as HTTPMethod) || [];
    for (const route of routes) {
      let params;
      let matchResult = route.match({url, request, event});
      if (matchResult) {
        if (Array.isArray(matchResult) && matchResult.length > 0) {
          // Instead of passing an empty array in as params, use undefined.
          params = matchResult;
        } else if ((matchResult.constructor === Object &&
            Object.keys(matchResult).length > 0)) {
          // Instead of passing an empty object in as params, use undefined.
          params = matchResult;
        }

        // Return early if have a match.
        return {route, params};
      }
    }
    // If no match was found above, return and empty object.
    return {};
  }

  /**
   * Define a default `handler` that's called when no routes explicitly
   * match the incoming request.
   *
   * Without a default handler, unmatched requests will go against the
   * network as if there were no service worker present.
   *
   * @param {workbox.routing.Route~handlerCallback} handler A callback
   * function that returns a Promise resulting in a Response.
   */
  setDefaultHandler(handler: HandlerCallback) {
    this._defaultHandler = normalizeHandler(handler);
  }

  /**
   * If a Route throws an error while handling a request, this `handler`
   * will be called and given a chance to provide a response.
   *
   * @param {workbox.routing.Route~handlerCallback} handler A callback
   * function that returns a Promise resulting in a Response.
   */
  setCatchHandler(handler: HandlerCallback) {
    this._catchHandler = normalizeHandler(handler);
  }

  /**
   * Registers a route with the router.
   *
   * @param {workbox.routing.Route} route The route to register.
   */
  registerRoute(route: Route) {
    if (process.env.NODE_ENV !== 'production') {
      assert!.isType(route, 'object', {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'registerRoute',
        paramName: 'route',
      });

      assert!.hasMethod(route, 'match', {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'registerRoute',
        paramName: 'route',
      });

      assert!.isType(route.handler, 'object', {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'registerRoute',
        paramName: 'route',
      });

      assert!.hasMethod(route.handler, 'handle', {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'registerRoute',
        paramName: 'route.handler',
      });

      assert!.isType(route.method, 'string', {
        moduleName: 'workbox-routing',
        className: 'Router',
        funcName: 'registerRoute',
        paramName: 'route.method',
      });
    }

    if (!this._routes.has(route.method)) {
      this._routes.set(route.method, []);
    }

    // Give precedence to all of the earlier routes by adding this additional
    // route to the end of the array.
    this._routes.get(route.method)!.push(route);
  }

  /**
   * Unregisters a route with the router.
   *
   * @param {workbox.routing.Route} route The route to unregister.
   */
  unregisterRoute(route: Route) {
    if (!this._routes.has(route.method)) {
      throw new WorkboxError(
          'unregister-route-but-not-found-with-method', {
            method: route.method,
          }
      );
    }

    const routeIndex = this._routes.get(route.method)!.indexOf(route);
    if (routeIndex > -1) {
      this._routes.get(route.method)!.splice(routeIndex, 1);
    } else {
      throw new WorkboxError('unregister-route-route-not-registered');
    }
  }
}

export {Router};
