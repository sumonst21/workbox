/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

const assert = require('assert');
const ol = require('common-tags').oneLine;
const path = require('path');
const prettyBytes = require('pretty-bytes');
const watch = require('glob-watcher');
const workboxBuild = require('workbox-build');

const constants = require('./lib/constants');
const errors = require('./lib/errors');
const logger = require('./lib/logger');
const readConfig = require('./lib/read-config');
const runWizard = require('./lib/run-wizard');

/**
 * Runs the specified build command with the provided configuration.
 *
 * @param {Object} options
 */
async function runBuildCommand({command, config, watch}) {
  try {
    const {count, filePaths, size, warnings} =
        await workboxBuild[command](config);

    for (const warning of warnings) {
      logger.warn(warning);
    }

    if (filePaths.length === 1) {
      logger.log(`The service worker file was written to ${config.swDest}`);
    } else {
      const message = filePaths
          .sort()
          .map((filePath) => `  • ${filePath}`)
          .join(`\n`);
      logger.log(`The service worker files were written to:\n${message}`);
    }

    logger.log(`The service worker will precache ${count} URLs, ` +
        `totaling ${prettyBytes(size)}.`);

    if (watch) {
      logger.log(`\nWatching for changes...`);
    }
  } catch (error) {
    // See https://github.com/hapijs/joi/blob/v11.3.4/API.md#errors
    if (typeof error.annotate === 'function') {
      throw new Error(
          `${errors['config-validation-failed']}\n${error.annotate()}`);
    }
    logger.error(errors['workbox-build-runtime-error']);
    throw error;
  }
}

module.exports = async (params = {}) => {
  // This should not be a user-visible error, unless meow() messes something up.
  assert(Array.isArray(params.input), errors['missing-input']);

  // Default to showing the help message if there's no command provided.
  const [command = 'help', option] = params.input;

  switch (command) {
    case 'wizard': {
      await runWizard(params.flags);
      break;
    }

    case 'copyLibraries': {
      assert(option, errors['missing-dest-dir-param']);
      const parentDirectory = path.resolve(process.cwd(), option);

      const dirName = await workboxBuild.copyWorkboxLibraries(parentDirectory);
      const fullPath = path.join(parentDirectory, dirName);

      logger.log(`The Workbox libraries were copied to ${fullPath}`);
      logger.log(ol`Add a call to workbox.setConfig({modulePathPrefix: '...'})
        to your service worker to use these local libraries.`);
      logger.log(`See https://goo.gl/Fo9gPX for further documentation.`);
      break;
    }

    case 'generateSW':
    case 'injectManifest': {
      const configPath = path.resolve(process.cwd(),
          option || constants.defaultConfigFile);

      let config;
      try {
        config = readConfig(configPath);
      } catch (error) {
        logger.error(errors['invalid-common-js-module']);
        throw error;
      }

      logger.log(`Using configuration from ${configPath}.`);

      // Determine whether we're in --watch mode, or one-off mode.
      if (params.flags && params.flags.watch) {
        const options = {ignoreInitial: false};
        if (config.globIgnores) {
          options.ignored = config.globIgnores;
        }
        if (config.globDirectory) {
          options.cwd = config.globDirectory;
        }

        watch(config.globPatterns, options,
            () => runBuildCommand({command, config, watch: true}));
      } else {
        await runBuildCommand({command, config, watch: false});
      }
      break;
    }

    case 'help': {
      params.showHelp();
      break;
    }

    default: {
      throw new Error(errors['unknown-command'] + ` ` + command);
    }
  }
};
