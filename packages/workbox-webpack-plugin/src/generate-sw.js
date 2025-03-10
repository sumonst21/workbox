/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

const {RawSource} = require('webpack-sources');
const bundle = require('workbox-build/build/lib/bundle');
const populateSWTemplate =
  require('workbox-build/build/lib/populate-sw-template');
const validate = require('workbox-build/build/entry-points/options/validate');
const webpackGenerateSWSchema = require(
    'workbox-build/build/entry-points/options/webpack-generate-sw-schema');

const getManifestEntriesFromCompilation =
  require('./lib/get-manifest-entries-from-compilation');
const relativeToOutputPath = require('./lib/relative-to-output-path');

/**
 * This class supports creating a new, ready-to-use service worker file as
 * part of the webpack compilation process.
 *
 * Use an instance of `GenerateSW` in the
 * [`plugins` array](https://webpack.js.org/concepts/plugins/#usage) of a
 * webpack config.
 *
 * @module workbox-webpack-plugin
 */
class GenerateSW {
  /**
   * Creates an instance of GenerateSW.
   *
   * @param {Object} [config] See the
   * [configuration guide](https://developers.google.com/web/tools/workbox/modules/workbox-webpack-plugin#configuration)
   * for all supported options and defaults.
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {Object} [compiler] default compiler object passed from webpack
   *
   * @private
   */
  propagateWebpackConfig(compiler) {
    // Because this.config is listed last, properties that are already set
    // there take precedence over derived properties from the compiler.
    this.config = Object.assign({
      mode: compiler.options.mode,
      sourcemap: Boolean(compiler.options.devtool),
    }, this.config);
  }

  /**
   * @param {Object} [compiler] default compiler object passed from webpack
   *
   * @private
   */
  apply(compiler) {
    this.propagateWebpackConfig(compiler);

    compiler.hooks.emit.tapPromise(
        this.constructor.name,
        (compilation) => this.handleEmit(compilation).catch(
            (error) => compilation.errors.push(error))
    );
  }

  /**
   * @param {Object} compilation The webpack compilation.
   *
   * @private
   */
  async handleEmit(compilation) {
    try {
      this.config = validate(this.config, webpackGenerateSWSchema);
    } catch (error) {
      throw new Error(`Please check your ${this.constructor.name} plugin ` +
        `configuration:\n${error.message}`);
    }

    this.config.manifestEntries = getManifestEntriesFromCompilation(
        compilation, this.config);

    const unbundledCode = populateSWTemplate(this.config);

    const files = await bundle({
      babelPresetEnvTargets: this.config.babelPresetEnvTargets,
      inlineWorkboxRuntime: this.config.inlineWorkboxRuntime,
      mode: this.config.mode,
      sourcemap: this.config.sourcemap,
      swDest: relativeToOutputPath(compilation, this.config.swDest),
      unbundledCode,
    });

    for (const file of files) {
      compilation.assets[file.name] = new RawSource(file.contents);
    }
  }
}

module.exports = GenerateSW;
