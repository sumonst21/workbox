/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import {assert} from 'workbox-core/_private/assert.js';
import {cacheNames} from 'workbox-core/_private/cacheNames.js';
import {getFriendlyURL} from 'workbox-core/_private/getFriendlyURL.js';
import {logger} from 'workbox-core/_private/logger.js';
import {WorkboxError} from 'workbox-core/_private/WorkboxError.js';
import {registerQuotaErrorCallback} from 'workbox-core/registerQuotaErrorCallback.js';
import {WorkboxPlugin} from 'workbox-core/types.js';
import {CacheExpiration} from './CacheExpiration.js';
import './_version.js';

/**
 * This plugin can be used in the Workbox APIs to regularly enforce a
 * limit on the age and / or the number of cached requests.
 *
 * Whenever a cached request is used or updated, this plugin will look
 * at the used Cache and remove any old or extra requests.
 *
 * When using `maxAgeSeconds`, requests may be used *once* after expiring
 * because the expiration clean up will not have occurred until *after* the
 * cached request has been used. If the request has a "Date" header, then
 * a light weight expiration check is performed and the request will not be
 * used immediately.
 *
 * When using `maxEntries`, the entry least-recently requested will be removed
 * from the cache first.
 *
 * @memberof workbox.expiration
 */
class Plugin implements WorkboxPlugin {
  private _config: object;
  private _maxAgeSeconds?: number;
  private _cacheExpirations: Map<string, CacheExpiration>;

  /**
   * @param {Object} config
   * @param {number} [config.maxEntries] The maximum number of entries to cache.
   * Entries used the least will be removed as the maximum is reached.
   * @param {number} [config.maxAgeSeconds] The maximum age of an entry before
   * it's treated as stale and removed.
   * @param {boolean} [config.purgeOnQuotaError] Whether to opt this cache in to
   * automatic deletion if the available storage quota has been exceeded.
   */
  constructor(config: {
    maxEntries?: number;
    maxAgeSeconds?: number;
    purgeOnQuotaError?: boolean;
  } = {}) {
    if (process.env.NODE_ENV !== 'production') {
      if (!(config.maxEntries || config.maxAgeSeconds)) {
        throw new WorkboxError('max-entries-or-age-required', {
          moduleName: 'workbox-expiration',
          className: 'Plugin',
          funcName: 'constructor',
        });
      }

      if (config.maxEntries) {
        assert!.isType(config.maxEntries, 'number', {
          moduleName: 'workbox-expiration',
          className: 'Plugin',
          funcName: 'constructor',
          paramName: 'config.maxEntries',
        });
      }

      if (config.maxAgeSeconds) {
        assert!.isType(config.maxAgeSeconds, 'number', {
          moduleName: 'workbox-expiration',
          className: 'Plugin',
          funcName: 'constructor',
          paramName: 'config.maxAgeSeconds',
        });
      }
    }

    this._config = config;
    this._maxAgeSeconds = config.maxAgeSeconds;
    this._cacheExpirations = new Map();

    if (config.purgeOnQuotaError) {
      registerQuotaErrorCallback(() => this.deleteCacheAndMetadata());
    }
  }

  /**
   * A simple helper method to return a CacheExpiration instance for a given
   * cache name.
   *
   * @param {string} cacheName
   * @return {CacheExpiration}
   *
   * @private
   */
  _getCacheExpiration(cacheName: string): CacheExpiration {
    if (cacheName === cacheNames.getRuntimeName()) {
      throw new WorkboxError('expire-custom-caches-only');
    }

    let cacheExpiration = this._cacheExpirations.get(cacheName);
    if (!cacheExpiration) {
      cacheExpiration = new CacheExpiration(cacheName, this._config);
      this._cacheExpirations.set(cacheName, cacheExpiration);
    }
    return cacheExpiration;
  }

  /**
   * A "lifecycle" callback that will be triggered automatically by the
   * `workbox.strategies` handlers when a `Response` is about to be returned
   * from a [Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache) to
   * the handler. It allows the `Response` to be inspected for freshness and
   * prevents it from being used if the `Response`'s `Date` header value is
   * older than the configured `maxAgeSeconds`.
   *
   * @param {Object} options
   * @param {string} options.cacheName Name of the cache the response is in.
   * @param {Response} options.cachedResponse The `Response` object that's been
   *     read from a cache and whose freshness should be checked.
   * @return {Response} Either the `cachedResponse`, if it's
   *     fresh, or `null` if the `Response` is older than `maxAgeSeconds`.
   *
   * @private
   */
  cachedResponseWillBeUsed: WorkboxPlugin['cachedResponseWillBeUsed'] = async ({
    event,
    request,
    cacheName,
    cachedResponse
  }) => {
    if (!cachedResponse) {
      return null;
    }

    let isFresh = this._isResponseDateFresh(cachedResponse);

    // Expire entries to ensure that even if the expiration date has
    // expired, it'll only be used once.
    const cacheExpiration = this._getCacheExpiration(cacheName);
    cacheExpiration.expireEntries();

    // Update the metadata for the request URL to the current timestamp,
    // but don't `await` it as we don't want to block the response.
    const updateTimestampDone = cacheExpiration.updateTimestamp(request.url);
    if (event) {
      try {
        event.waitUntil(updateTimestampDone);
      } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
          // The event may not be a fetch event; only log the URL if it is.
          if ('request' in event) {
            logger.warn(`Unable to ensure service worker stays alive when ` +
              `updating cache entry for ` +
              `'${getFriendlyURL((<FetchEvent> event).request.url)}'.`);
          }
        }
      }
    }

    return isFresh ? cachedResponse : null;
  }

  /**
   * @param {Response} cachedResponse
   * @return {boolean}
   *
   * @private
   */
  _isResponseDateFresh(cachedResponse: Response): boolean {
    if (!this._maxAgeSeconds) {
      // We aren't expiring by age, so return true, it's fresh
      return true;
    }

    // Check if the 'date' header will suffice a quick expiration check.
    // See https://github.com/GoogleChromeLabs/sw-toolbox/issues/164 for
    // discussion.
    const dateHeaderTimestamp = this._getDateHeaderTimestamp(cachedResponse);
    if (dateHeaderTimestamp === null) {
      // Unable to parse date, so assume it's fresh.
      return true;
    }

    // If we have a valid headerTime, then our response is fresh iff the
    // headerTime plus maxAgeSeconds is greater than the current time.
    const now = Date.now();
    return dateHeaderTimestamp >= now - (this._maxAgeSeconds * 1000);
  }

  /**
   * This method will extract the data header and parse it into a useful
   * value.
   *
   * @param {Response} cachedResponse
   * @return {number|null}
   *
   * @private
   */
  _getDateHeaderTimestamp(cachedResponse: Response): number | null {
    if (!cachedResponse.headers.has('date')) {
      return null;
    }

    const dateHeader = cachedResponse.headers.get('date');
    const parsedDate = new Date(dateHeader!);
    const headerTime = parsedDate.getTime();

    // If the Date header was invalid for some reason, parsedDate.getTime()
    // will return NaN.
    if (isNaN(headerTime)) {
      return null;
    }

    return headerTime;
  }

  /**
   * A "lifecycle" callback that will be triggered automatically by the
   * `workbox.strategies` handlers when an entry is added to a cache.
   *
   * @param {Object} options
   * @param {string} options.cacheName Name of the cache that was updated.
   * @param {string} options.request The Request for the cached entry.
   *
   * @private
   */
  cacheDidUpdate: WorkboxPlugin['cacheDidUpdate'] = async ({
    cacheName,
    request
  }) => {
    if (process.env.NODE_ENV !== 'production') {
      assert!.isType(cacheName, 'string', {
        moduleName: 'workbox-expiration',
        className: 'Plugin',
        funcName: 'cacheDidUpdate',
        paramName: 'cacheName',
      });
      assert!.isInstance(request, Request, {
        moduleName: 'workbox-expiration',
        className: 'Plugin',
        funcName: 'cacheDidUpdate',
        paramName: 'request',
      });
    }

    const cacheExpiration = this._getCacheExpiration(cacheName);
    await cacheExpiration.updateTimestamp(request.url);
    await cacheExpiration.expireEntries();
  }


  /**
   * This is a helper method that performs two operations:
   *
   * - Deletes *all* the underlying Cache instances associated with this plugin
   * instance, by calling caches.delete() on your behalf.
   * - Deletes the metadata from IndexedDB used to keep track of expiration
   * details for each Cache instance.
   *
   * When using cache expiration, calling this method is preferable to calling
   * `caches.delete()` directly, since this will ensure that the IndexedDB
   * metadata is also cleanly removed and open IndexedDB instances are deleted.
   *
   * Note that if you're *not* using cache expiration for a given cache, calling
   * `caches.delete()` and passing in the cache's name should be sufficient.
   * There is no Workbox-specific method needed for cleanup in that case.
   */
  async deleteCacheAndMetadata() {
    // Do this one at a time instead of all at once via `Promise.all()` to
    // reduce the chance of inconsistency if a promise rejects.
    for (const [cacheName, cacheExpiration] of this._cacheExpirations) {
      await caches.delete(cacheName);
      await cacheExpiration.delete();
    }

    // Reset this._cacheExpirations to its initial state.
    this._cacheExpirations = new Map();
  }
}

export {Plugin};
