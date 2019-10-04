/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Script to bundle lighthouse entry points so that they can be run
 * in the browser (as long as they have access to a debugger protocol Connection).
 */

const fs = require('fs');
const path = require('path');

const LighthouseRunner = require('../lighthouse-core/runner.js');
const exorcist = require('exorcist');
const browserify = require('browserify');
const terser = require('terser');
const makeDir = require('make-dir');
const pkg = require('../package.json');

const VERSION = pkg.version;
const COMMIT_HASH = require('child_process')
  .execSync('git rev-parse HEAD')
  .toString().trim();

const audits = LighthouseRunner.getAuditList()
    .map(f => './lighthouse-core/audits/' + f.replace(/\.js$/, ''));

const gatherers = LighthouseRunner.getGathererList()
    .map(f => './lighthouse-core/gather/gatherers/' + f.replace(/\.js$/, ''));

const locales = fs.readdirSync(__dirname + '/../lighthouse-core/lib/i18n/locales/')
    .map(f => require.resolve(`../lighthouse-core/lib/i18n/locales/${f}`));

/** @param {string} file */
const isDevtools = file => path.basename(file).includes('devtools');
/** @param {string} file */
const isExtension = file => path.basename(file).includes('extension');

const FOOTER = `// lighthouse, browserified. ${VERSION} (${COMMIT_HASH})\n`;

/**
 * Browserify starting at the file at entryPath. Contains entry-point-specific
 * ignores (e.g. for DevTools or the extension) to trim the bundle depending on
 * the eventual use case.
 * @param {string} entryPath
 * @param {string} distPath
 * @return {Promise<void>}
 */
async function browserifyFile(entryPath, distPath) {
  let bundle = browserify(entryPath, {debug: true});

  bundle
  // Transform the fs.readFile etc into inline strings.
  .transform('brfs', {global: true, parserOpts: {ecmaVersion: 10}})
  // Strip everything out of package.json includes except for the version.
  .transform('package-json-versionify');

  // scripts will need some additional transforms, ignores and requires…
  bundle.ignore('source-map')
    .ignore('debug/node')
    .ignore('intl')
    .ignore('intl-pluralrules')
    .ignore('raven')
    .ignore('mkdirp')
    .ignore('rimraf')
    .ignore('pako/lib/zlib/inflate.js');

  // Don't include the desktop protocol connection.
  bundle.ignore(require.resolve('../lighthouse-core/gather/connections/cri.js'));

  // Dont include the stringified report in DevTools.
  if (isDevtools(entryPath)) {
    bundle.ignore(require.resolve('../lighthouse-core/report/html/html-report-assets.js'));
  }

  // Don't include locales in DevTools or the extension for now.
  if (isDevtools(entryPath) || isExtension(entryPath)) {
    // @ts-ignore bundle.ignore does accept an array of strings.
    bundle.ignore(locales);
  }

  // Expose the audits, gatherers, and computed artifacts so they can be dynamically loaded.
  const corePath = './lighthouse-core/';
  const driverPath = `${corePath}gather/`;
  audits.forEach(audit => {
    bundle = bundle.require(audit, {expose: audit.replace(corePath, '../')});
  });
  gatherers.forEach(gatherer => {
    bundle = bundle.require(gatherer, {expose: gatherer.replace(driverPath, '../gather/')});
  });

  // browerify's url shim doesn't work with .URL in node_modules,
  // and within robots-parser, it does `var URL = require('url').URL`, so we expose our own.
  // @see https://github.com/GoogleChrome/lighthouse/issues/5273
  const pathToURLShim = require.resolve('../lighthouse-core/lib/url-shim.js');
  bundle = bundle.require(pathToURLShim, {expose: 'url'});

  const bundleStream = bundle.bundle();

  // Make sure path exists.
  await makeDir(path.dirname(distPath));
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(distPath);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);

    bundleStream
      .pipe(exorcist(`${distPath}.map`))
      .pipe(writeStream);
  });
  fs.writeFileSync(distPath, fs.readFileSync(distPath, 'utf-8') + '\n' + FOOTER);
}

/**
 * Minify a javascript file, in place.
 * @param {string} filePath
 */
function minifyScript(filePath) {
  const result = terser.minify(fs.readFileSync(filePath, 'utf-8'), {
    sourceMap: {
      content: JSON.parse(fs.readFileSync(`${filePath}.map`, 'utf-8')),
    },
  });
  if (result.error) {
    throw result.error;
  }
  const minified = result.code + FOOTER;
  fs.writeFileSync(filePath, minified + '\n' + FOOTER);
  fs.writeFileSync(`${filePath}.map`, result.map);
}
  
/**
 * Browserify starting at entryPath, writing the minified result to distPath.
 * @param {string} entryPath
 * @param {string} distPath
 * @return {Promise<void>}
 */
async function build(entryPath, distPath) {
  await browserifyFile(entryPath, distPath);
  minifyScript(distPath);
}

/**
 * @param {Array<string>} argv
 */
async function cli(argv) {
  // Take paths relative to cwd and build.
  const [entryPath, distPath] = argv.slice(2)
    .map(filePath => path.resolve(process.cwd(), filePath));
  build(entryPath, distPath);
}

// @ts-ignore Test if called from the CLI or as a module.
if (require.main === module) {
  cli(process.argv);
} else {
  module.exports = {
    /** The commit hash for the current HEAD. */
    COMMIT_HASH,
    build,
  };
}
