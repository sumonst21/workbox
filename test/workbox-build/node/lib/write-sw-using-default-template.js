/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

const expect = require('chai').expect;
const path = require('path');
const proxyquire = require('proxyquire');
const sinon = require('sinon');

const errors = require('../../../../packages/workbox-build/src/lib/errors');

describe(`[workbox-build] lib/write-sw-using-default-template.js`, function() {
  const MODULE_PATH = '../../../../packages/workbox-build/src/lib/write-sw-using-default-template';

  it(`should reject with an error when fs-extra.mkdirp() fails`, async function() {
    const writeSWUsingDefaultTemplate = proxyquire(MODULE_PATH, {
      'path': {
        dirname: () => 'ignored',
      },
      'fs-extra': {
        mkdirp: () => Promise.reject(new Error()),
      },
    });

    try {
      await writeSWUsingDefaultTemplate({});
      throw new Error('Unexpected success.');
    } catch (error) {
      expect(error.message).to.have.string(errors['unable-to-make-sw-directory']);
    }
  });

  it(`should reject with an error when fs-extra.writeFile() fails`, async function() {
    const writeSWUsingDefaultTemplate = proxyquire(MODULE_PATH, {
      'path': {
        dirname: () => 'ignored',
      },
      'fs-extra': {
        mkdirp: () => Promise.resolve(),
        writeFile: () => Promise.reject(new Error()),
      },
    });

    try {
      await writeSWUsingDefaultTemplate({});
      throw new Error('Unexpected success.');
    } catch (error) {
      expect(error.message).to.have.string(errors['sw-write-failure']);
    }
  });

  it(`should reject with a specific error when fs-extra.writeFile() fails due to EISDIR`, async function() {
    const eisdirError = new Error();
    eisdirError.code = 'EISDIR';

    const writeSWUsingDefaultTemplate = proxyquire(MODULE_PATH, {
      'path': {
        dirname: () => 'ignored',
      },
      'fs-extra': {
        mkdirp: () => Promise.resolve(),
        readFile: () => Promise.resolve(),
        writeFile: () => Promise.reject(eisdirError),
      },
      './bundle': async () => [{
        name: 'ignored',
        contents: 'ignored',
      }],
    });

    try {
      await writeSWUsingDefaultTemplate({});
      throw new Error('Unexpected success.');
    } catch (error) {
      expect(error.message).to.have.string(errors['sw-write-failure-directory']);
    }
  });

  it(`should call fs-extra.writeFile() with the expected parameters when everything succeeds`, async function() {
    const expectedPath = path.join('expected', 'path');
    const swDest = path.join(expectedPath, 'sw.js');
    const file1 = 'file1.js';
    const file2 = 'file2.js';
    const contents1 = 'contents1';
    const contents2 = 'contents2';

    const writeFileStub = sinon.stub().returns(Promise.resolve());
    const writeSWUsingDefaultTemplate = proxyquire(MODULE_PATH, {
      'fs-extra': {
        mkdirp: (path) => {
          expect(path).to.eql(expectedPath);
        },
        readFile: () => Promise.resolve(),
        writeFile: writeFileStub,
      },
      './bundle': async () => [{
        name: file1,
        contents: contents1,
      }, {
        name: file2,
        contents: contents2,
      }],
      './populate-sw-template': () => '',
    });

    await writeSWUsingDefaultTemplate({swDest});

    // There should be exactly two calls to fs-extra.writeFile().
    expect(writeFileStub.args).to.eql([[
      path.join(expectedPath, file1),
      contents1,
    ], [
      path.join(expectedPath, file2),
      contents2,
    ]]);
  });
});
