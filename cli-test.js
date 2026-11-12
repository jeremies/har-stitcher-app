/**
 * CLI test suite for har-stitch (cli.js).
 * Spawns the CLI as a subprocess against fixture HARs in a temp directory
 * and verifies outputs, flags, and exit codes.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const stitcher = require('./stitcher.js');
const { createSampleHar } = require('./sample-test.js');

const CLI = path.join(__dirname, 'cli.js');

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
}

function stripVolatile(har) {
  // patchHAR stamps the injected entry with the current time
  const copy = JSON.parse(JSON.stringify(har));
  copy.log.entries.forEach(e => { delete e.startedDateTime; });
  return copy;
}

function runTests() {
  console.log('🧪 Running har-stitch CLI Test Suite...\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-stitch-test-'));

  try {
    const input = path.join(dir, 'recording.har');
    writeJson(input, createSampleHar());

    console.log('1. Default output path and summary...');
    let r = runCli([input]);
    assert.strictEqual(r.code, 0, r.stderr);
    const defaultOut = path.join(dir, 'recording.stitched.har');
    assert(fs.existsSync(defaultOut), 'Default output <input>.stitched.har must exist');
    assert(r.stdout.includes('Transitions:       1'), 'Summary should report 1 transition');
    assert(r.stdout.includes('Segments:          4'), 'Summary should report 4 segments');
    console.log('   ✓ Wrote recording.stitched.har and printed summary');

    console.log('2. Output matches stitcher.js processHar (same engine as web app)...');
    const expected = stitcher.processHar(createSampleHar()).patchResult.patchedHar;
    const actual = JSON.parse(fs.readFileSync(defaultOut, 'utf8'));
    assert.deepStrictEqual(stripVolatile(actual), stripVolatile(expected));
    console.log('   ✓ Patched HAR identical to library output');

    console.log('3. Refuses to overwrite without --force...');
    r = runCli([input]);
    assert.strictEqual(r.code, 1);
    assert(r.stderr.includes('already exists'), r.stderr);
    r = runCli([input, '--force', '--quiet']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout, '', '--quiet must print nothing');
    console.log('   ✓ --force overrides, --quiet silences output');

    console.log('4. -o and --m3u8...');
    const customOut = path.join(dir, 'custom.har');
    const m3u8Out = path.join(dir, 'out.m3u8');
    r = runCli([input, '-o', customOut, '--m3u8', m3u8Out]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert(fs.existsSync(customOut));
    const playlist = fs.readFileSync(m3u8Out, 'utf8');
    assert(playlist.includes('#EXT-X-DISCONTINUITY'));
    assert(playlist.includes('\nseg_2.ts\n'), 'Default playlist keeps verbatim relative URIs');
    console.log('   ✓ Custom HAR path and stitched playlist written');

    console.log('5. --absolute-urls...');
    const absM3u8 = path.join(dir, 'abs.m3u8');
    r = runCli([input, '-o', path.join(dir, 'abs.har'), '--m3u8', absM3u8, '--absolute-urls', '--quiet']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert(fs.readFileSync(absM3u8, 'utf8').includes('https://video.example.com/stream/1080p/seg_2.ts'));
    console.log('   ✓ Absolute segment URLs emitted');

    console.log('6. --json...');
    r = runCli([input, '-o', path.join(dir, 'json.har'), '--json']);
    assert.strictEqual(r.code, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.strictEqual(summary.totalSegments, 4);
    assert.strictEqual(summary.transitionsCount, 1);
    assert.strictEqual(summary.gapsCount, 0);
    assert(summary.stitchedManifestUrl.endsWith('stitched_trajectory.m3u8'));
    console.log('   ✓ Machine-readable JSON summary');

    console.log('7. Error handling...');
    const badJson = path.join(dir, 'bad.har');
    fs.writeFileSync(badJson, '{ not json');
    assert.strictEqual(runCli([badJson]).code, 1, 'Invalid JSON -> exit 1');
    const badHar = path.join(dir, 'nolog.har');
    writeJson(badHar, { foo: 1 });
    assert.strictEqual(runCli([badHar]).code, 1, 'Invalid HAR structure -> exit 1');
    assert.strictEqual(runCli([path.join(dir, 'missing.har')]).code, 1, 'Missing file -> exit 1');
    assert.strictEqual(runCli([]).code, 1, 'No input -> exit 1');
    assert.strictEqual(runCli([input, '--bogus']).code, 1, 'Unknown flag -> exit 1');
    assert.strictEqual(runCli([input, '--quiet', '--json']).code, 1, '--quiet + --json -> exit 1');
    assert.strictEqual(runCli([input, '-o', input, '--force']).code, 1, 'Never overwrite input');
    console.log('   ✓ Exit 1 on invalid input and usage errors');

    console.log('8. No stitchable segments...');
    const empty = path.join(dir, 'empty.har');
    writeJson(empty, { log: { version: '1.2', entries: [] } });
    r = runCli([empty]);
    assert.strictEqual(r.code, 2);
    assert(r.stderr.includes('no stitchable segments'));
    assert(!fs.existsSync(path.join(dir, 'empty.stitched.har')), 'Nothing written');
    console.log('   ✓ Exit 2 and nothing written');

    console.log('9. --help and --version...');
    r = runCli(['--help']);
    assert.strictEqual(r.code, 0);
    assert(r.stdout.includes('Usage: har-stitch'));
    r = runCli(['--version']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout.trim(), require('./package.json').version);
    console.log('   ✓ Help and version');

    console.log('\n🎉 ALL CLI TESTS PASSED SUCCESSFULLY! 🚀');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runTests();
