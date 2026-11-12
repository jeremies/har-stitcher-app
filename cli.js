#!/usr/bin/env node
/**
 * har-stitch — Command-line interface for the HAR Video Stream Stitcher.
 *
 * Thin wrapper around stitcher.js (the same engine used by the web app).
 * All stitching logic lives in stitcher.js; this file only handles
 * argument parsing, file I/O, reporting, and exit codes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const HarStitcher = require('./stitcher.js');

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NO_SEGMENTS = 2;

const HELP = `Usage: har-stitch <input.har> [options]

Stitch recorded HLS segments across ABR variants into a single playlist and
write a patched HAR for har-player. Uses the same engine (stitcher.js) as the
web app.

Options:
  -o, --output <path>   Patched HAR output path
                        (default: <input>.stitched.har)
      --m3u8 <path>     Also write the stitched .m3u8 playlist to <path>
      --absolute-urls   Write resolved absolute segment URLs in the stitched
                        playlist instead of verbatim source URIs
      --force           Overwrite existing output files
      --quiet           Print nothing on success
      --json            Print the result summary as JSON
  -h, --help            Show this help
  -v, --version         Show version

Exit codes:
  0  success
  1  usage error, unreadable/invalid input, or output exists without --force
  2  no stitchable segments found (nothing written)
`;

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.exitCode = code === undefined ? EXIT_ERROR : code;
  }
}

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    m3u8: null,
    absoluteUrls: false,
    force: false,
    quiet: false,
    json: false,
    help: false,
    version: false
  };

  function takeValue(i, flag) {
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith('-') && value !== '-')) {
      throw new CliError(`Option ${flag} requires a path argument`);
    }
    return value;
  }

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq !== -1) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }

    switch (arg) {
      case '-o':
      case '--output':
        opts.output = inlineValue !== undefined ? inlineValue : takeValue(i++, arg);
        break;
      case '--m3u8':
        opts.m3u8 = inlineValue !== undefined ? inlineValue : takeValue(i++, arg);
        break;
      case '--absolute-urls':
        opts.absoluteUrls = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new CliError(`Unknown option: ${arg}\nRun 'har-stitch --help' for usage.`);
        }
        if (opts.input !== null) {
          throw new CliError('Only one input HAR file may be given per run.');
        }
        opts.input = arg;
    }
  }

  if (opts.help || opts.version) return opts;

  if (!opts.input) {
    throw new CliError(`Missing input HAR file.\n\n${HELP}`);
  }
  if (opts.quiet && opts.json) {
    throw new CliError('--quiet and --json cannot be used together.');
  }
  return opts;
}

function defaultOutputPath(inputPath) {
  // Mirrors the web app: currentFilename.replace(/\.har$/i, '') + '.stitched.har'
  return inputPath.replace(/\.har$/i, '') + '.stitched.har';
}

function readHar(inputPath) {
  let text;
  try {
    text = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot read input file '${inputPath}': ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`Invalid JSON in '${inputPath}': ${err.message}`);
  }
}

function ensureWritable(target, inputPath, force) {
  if (path.resolve(target) === path.resolve(inputPath)) {
    throw new CliError(`Refusing to overwrite the input file '${inputPath}'.`);
  }
  if (!force && fs.existsSync(target)) {
    throw new CliError(`Output file '${target}' already exists (use --force to overwrite).`);
  }
}

function writeFile(target, content) {
  try {
    fs.writeFileSync(target, content, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot write '${target}': ${err.message}`);
  }
}

function formatDuration(seconds) {
  return (seconds || 0).toFixed(3) + 's';
}

function buildSummary(result, outputs) {
  const metrics = result.timelineResult.metrics;
  const patch = result.patchResult;
  return {
    variantsUsed: metrics.variantsUsed,
    totalSegments: metrics.totalSegments,
    transitionsCount: metrics.transitionsCount,
    gapsCount: metrics.gapsCount,
    totalGapDuration: metrics.totalGapDuration,
    playableDuration: metrics.totalDuration,
    masterManifestUrl: patch.masterManifestUrl,
    stitchedManifestUrl: patch.stitchedManifestUrl,
    outputs: outputs
  };
}

function printHumanSummary(summary) {
  const lines = [];
  lines.push('HAR stitched successfully');
  lines.push('  Variants used:');
  const variants = Object.keys(summary.variantsUsed);
  if (variants.length === 0) lines.push('    (none)');
  variants.forEach(function (label) {
    lines.push(`    - ${label}: ${summary.variantsUsed[label]} segment(s)`);
  });
  lines.push(`  Segments:          ${summary.totalSegments}`);
  lines.push(`  Transitions:       ${summary.transitionsCount}`);
  lines.push(`  Gaps:              ${summary.gapsCount} (${formatDuration(summary.totalGapDuration)})`);
  lines.push(`  Playable duration: ${formatDuration(summary.playableDuration)}`);
  lines.push(`  Master manifest:   ${summary.masterManifestUrl || '(none)'}`);
  lines.push(`  Stitched manifest: ${summary.stitchedManifestUrl}`);
  lines.push(`  Wrote HAR:         ${summary.outputs.har}`);
  if (summary.outputs.m3u8) {
    lines.push(`  Wrote playlist:    ${summary.outputs.m3u8}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function run(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (opts.version) {
    let version = 'unknown';
    try {
      version = require('./package.json').version;
    } catch (e) { /* ignore */ }
    process.stdout.write(version + '\n');
    return EXIT_OK;
  }

  const outputPath = opts.output || defaultOutputPath(opts.input);
  const har = readHar(opts.input);

  // Check outputs before doing any work so nothing is half-written.
  ensureWritable(outputPath, opts.input, opts.force);
  if (opts.m3u8) {
    if (path.resolve(opts.m3u8) === path.resolve(outputPath)) {
      throw new CliError('--m3u8 path must differ from the HAR output path.');
    }
    ensureWritable(opts.m3u8, opts.input, opts.force);
  }

  let result;
  try {
    result = HarStitcher.processHar(har, { useAbsoluteUrls: opts.absoluteUrls });
  } catch (err) {
    throw new CliError(`Failed to process '${opts.input}': ${err.message}`);
  }

  if (result.timelineResult.metrics.totalSegments === 0) {
    process.stderr.write(
      `Warning: no stitchable segments found in '${opts.input}'. Nothing was written.\n`
    );
    return EXIT_NO_SEGMENTS;
  }

  // Same serialization as the web app's "Download Patched .har" button.
  writeFile(outputPath, JSON.stringify(result.patchResult.patchedHar, null, 2));
  const outputs = { har: outputPath, m3u8: null };

  if (opts.m3u8) {
    writeFile(opts.m3u8, result.stitchedResult.playlistText);
    outputs.m3u8 = opts.m3u8;
  }

  const summary = buildSummary(result, outputs);
  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else if (!opts.quiet) {
    printHumanSummary(summary);
  }
  return EXIT_OK;
}

if (require.main === module) {
  let code;
  try {
    code = run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`Error: ${err.message}\n`);
      code = err.exitCode;
    } else {
      process.stderr.write(`Unexpected error: ${err && err.stack ? err.stack : err}\n`);
      code = EXIT_ERROR;
    }
  }
  process.exitCode = code;
}

module.exports = { run, parseArgs, defaultOutputPath };
