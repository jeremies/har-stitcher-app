/**
 * HAR Video Stream Stitcher - Core Engine
 * 
 * Analyzes HAR recordings containing multi-bitrate HLS streams, discovers
 * recorded segments across disparate variant tracks, correlates the playback
 * trajectory timeline, and synthesizes a single stitched HLS playlist with
 * appropriate #EXT-X-DISCONTINUITY and #EXT-X-MAP tags. Rewrites the master
 * manifest in the HAR to eliminate ABR stalls.
 *
 * Compatible with Node.js and Browser environments.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HarStitcher = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Helper: Resolve a relative URI against a base URL
   */
  function resolveUrl(relativeOrAbsolute, baseUrl) {
    if (!relativeOrAbsolute) return '';
    try {
      return new URL(relativeOrAbsolute, baseUrl).href;
    } catch (e) {
      // Fallback if baseUrl is not a full URL
      if (relativeOrAbsolute.startsWith('http://') || relativeOrAbsolute.startsWith('https://')) {
        return relativeOrAbsolute;
      }
      var baseParts = (baseUrl || '').split('?')[0].split('/');
      baseParts.pop(); // remove file name
      var base = baseParts.join('/');
      if (relativeOrAbsolute.startsWith('/')) {
        var originMatch = baseUrl.match(/^(https?:\/\/[^\/]+)/);
        if (originMatch) return originMatch[1] + relativeOrAbsolute;
        return relativeOrAbsolute;
      }
      return base ? base + '/' + relativeOrAbsolute : relativeOrAbsolute;
    }
  }

  /**
   * Helper: Normalize URL by stripping fragments and trailing slashes for lookup
   */
  function normalizeUrl(url) {
    if (!url) return '';
    try {
      var u = new URL(url);
      return u.origin + u.pathname + u.search;
    } catch (e) {
      return url.split('#')[0];
    }
  }

  /**
   * Helper: Safely extract text from HAR response content
   */
  function extractResponseText(content) {
    if (!content) return '';
    if (typeof content.text !== 'string') return '';
    
    if (content.encoding === 'base64') {
      try {
        if (typeof atob === 'function') {
          return atob(content.text);
        } else if (typeof Buffer !== 'undefined') {
          return Buffer.from(content.text, 'base64').toString('utf8');
        }
      } catch (e) {
        return content.text;
      }
    }
    return content.text;
  }

  /**
   * Helper: Extract filename from URL
   */
  function getFilenameFromUrl(url) {
    if (!url) return '';
    try {
      var pathname = new URL(url).pathname;
      return pathname.substring(pathname.lastIndexOf('/') + 1) || 'manifest.m3u8';
    } catch (e) {
      var parts = url.split('?')[0].split('/');
      return parts[parts.length - 1] || 'manifest.m3u8';
    }
  }

  /**
   * 1. Parse HAR: Extracts all entries, manifests, media segments, and init segments
   * @param {Object|string} harData - Parsed HAR object or JSON string
   * @returns {Object} Structured data with rawEntries, manifestEntries, segmentEntries
   */
  function parseHAR(harData) {
    var parsed = harData;
    if (typeof harData === 'string') {
      try {
        parsed = JSON.parse(harData);
      } catch (err) {
        throw new Error('Invalid JSON format for HAR: ' + err.message);
      }
    }

    if (!parsed || !parsed.log || !Array.isArray(parsed.log.entries)) {
      throw new Error('Invalid HAR structure: missing log.entries array');
    }

    var rawEntries = parsed.log.entries;
    var manifestEntries = [];
    var segmentEntries = [];
    var segmentUrlMap = new Map();

    for (var i = 0; i < rawEntries.length; i++) {
      var entry = rawEntries[i];
      var req = entry.request;
      var res = entry.response;
      if (!req || !res) continue;

      var url = req.url || '';
      var mimeType = (res.content && res.content.mimeType) ? res.content.mimeType.toLowerCase() : '';
      var cleanUrl = url.split('?')[0].toLowerCase();
      var text = extractResponseText(res.content);

      var isM3U8 = cleanUrl.endsWith('.m3u8') ||
                    mimeType.includes('mpegurl') ||
                    mimeType.includes('apple.m3u8') ||
                    text.startsWith('#EXTM3U');

      var isMediaSegment = cleanUrl.endsWith('.ts') ||
                           cleanUrl.endsWith('.m4s') ||
                           cleanUrl.endsWith('.mp4') ||
                           cleanUrl.endsWith('.aac') ||
                           mimeType.includes('video/mp2t') ||
                           mimeType.includes('video/mp4') ||
                           mimeType.includes('video/iso.segment') ||
                           mimeType.includes('audio/mp4');

      if (isM3U8) {
        manifestEntries.push({
          index: i,
          url: url,
          normalizedUrl: normalizeUrl(url),
          mimeType: mimeType,
          status: res.status,
          content: text,
          entry: entry
        });
      } else if (isMediaSegment) {
        var segItem = {
          index: i,
          url: url,
          normalizedUrl: normalizeUrl(url),
          status: res.status,
          mimeType: mimeType,
          size: (res.content && res.content.size) || (res.bodySize) || 0,
          startedDateTime: entry.startedDateTime,
          time: entry.time,
          entry: entry
        };
        segmentEntries.push(segItem);
        segmentUrlMap.set(normalizeUrl(url), segItem);
      }
    }

    return {
      rawEntries: rawEntries,
      manifestEntries: manifestEntries,
      segmentEntries: segmentEntries,
      segmentUrlMap: segmentUrlMap,
      har: parsed
    };
  }

  /**
   * Helper: Parse tag attributes like BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f"
   */
  function parseAttributes(attrString) {
    var attrs = {};
    var regex = /([A-Z0-9\-]+)=(?:("([^"]*)")|([^,]+))/g;
    var match;
    while ((match = regex.exec(attrString)) !== null) {
      var key = match[1];
      var value = match[3] !== undefined ? match[3] : match[4];
      attrs[key] = value;
    }
    return attrs;
  }

  /**
   * 2. Analyze Manifests: Distinguishes Master from Variant playlists and parses segment info
   */
  function analyzeManifests(manifestEntries, segmentUrlMap) {
    var masterPlaylists = [];
    var variantPlaylists = [];

    for (var m = 0; m < manifestEntries.length; m++) {
      var item = manifestEntries[m];
      var lines = item.content.split(/\r?\n/).map(function (l) { return l.trim(); });
      
      var isMaster = false;
      for (var l = 0; l < lines.length; l++) {
        if (lines[l].startsWith('#EXT-X-STREAM-INF') || lines[l].startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
          isMaster = true;
          break;
        }
      }

      if (isMaster) {
        // Parse Master Playlist variants
        var declaredVariants = [];
        var currentStreamInf = null;

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('#EXT-X-STREAM-INF:')) {
            currentStreamInf = parseAttributes(line.substring(18));
          } else if (line && !line.startsWith('#') && currentStreamInf) {
            var streamUrl = resolveUrl(line, item.url);
            declaredVariants.push({
              uri: line,
              resolvedUrl: streamUrl,
              normalizedUrl: normalizeUrl(streamUrl),
              attributes: currentStreamInf,
              bandwidth: parseInt(currentStreamInf.BANDWIDTH || '0', 10),
              resolution: currentStreamInf.RESOLUTION || '',
              codecs: currentStreamInf.CODECS || '',
              name: currentStreamInf.NAME || (currentStreamInf.RESOLUTION ? currentStreamInf.RESOLUTION : ('Bandwidth ' + currentStreamInf.BANDWIDTH))
            });
            currentStreamInf = null;
          }
        }

        masterPlaylists.push({
          url: item.url,
          normalizedUrl: item.normalizedUrl,
          entry: item.entry,
          content: item.content,
          variants: declaredVariants
        });

      } else {
        // Parse Child Variant Playlist
        var mediaSequence = 0;
        var targetDuration = 0;
        var playlistType = null;
        var isEndlist = false;
        var segments = [];
        var currentExtinf = null;
        var currentMap = null;
        var hasDiscontinuityNext = false;
        var currentByteRange = null;

        for (var j = 0; j < lines.length; j++) {
          var vLine = lines[j];
          if (!vLine) continue;

          if (vLine.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            mediaSequence = parseInt(vLine.split(':')[1], 10) || 0;
          } else if (vLine.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = parseFloat(vLine.split(':')[1]) || 0;
          } else if (vLine.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
            playlistType = vLine.split(':')[1].trim();
          } else if (vLine.startsWith('#EXT-X-ENDLIST')) {
            isEndlist = true;
          } else if (vLine.startsWith('#EXT-X-DISCONTINUITY')) {
            hasDiscontinuityNext = true;
          } else if (vLine.startsWith('#EXT-X-MAP:')) {
            var mapAttrs = parseAttributes(vLine.substring(11));
            var mapUri = mapAttrs.URI || '';
            var resolvedMapUri = resolveUrl(mapUri, item.url);
            currentMap = {
              rawTag: vLine,
              uri: mapUri,
              resolvedUrl: resolvedMapUri,
              byteRange: mapAttrs.BYTERANGE || null
            };
          } else if (vLine.startsWith('#EXT-X-BYTERANGE:')) {
            currentByteRange = vLine.split(':')[1].trim();
          } else if (vLine.startsWith('#EXTINF:')) {
            var commaIdx = vLine.indexOf(',');
            var durStr = commaIdx !== -1 ? vLine.substring(8, commaIdx) : vLine.substring(8);
            var title = commaIdx !== -1 ? vLine.substring(commaIdx + 1) : '';
            currentExtinf = {
              duration: parseFloat(durStr) || 0,
              title: title
            };
          } else if (!vLine.startsWith('#') && currentExtinf) {
            var segUri = vLine;
            var segResolved = resolveUrl(segUri, item.url);
            var segNormalized = normalizeUrl(segResolved);
            var recordedMatch = segmentUrlMap ? segmentUrlMap.get(segNormalized) : null;

            var segIndex = mediaSequence + segments.length;
            segments.push({
              index: segIndex,
              localIndex: segments.length,
              duration: currentExtinf.duration,
              title: currentExtinf.title,
              uri: segUri,
              resolvedUrl: segResolved,
              normalizedUrl: segNormalized,
              hasDiscontinuity: hasDiscontinuityNext,
              map: currentMap,
              byteRange: currentByteRange,
              isRecorded: !!recordedMatch && (recordedMatch.status >= 200 && recordedMatch.status < 300),
              recordedStatus: recordedMatch ? recordedMatch.status : null,
              recordedSize: recordedMatch ? recordedMatch.size : 0,
              recordedEntry: recordedMatch ? recordedMatch.entry : null
            });

            currentExtinf = null;
            hasDiscontinuityNext = false;
            currentByteRange = null;
          }
        }

        // Calculate cumulative timeline duration for each segment in this variant
        var cumulativeTime = 0;
        for (var s = 0; s < segments.length; s++) {
          segments[s].startTime = cumulativeTime;
          cumulativeTime += segments[s].duration;
          segments[s].endTime = cumulativeTime;
        }

        // Infer variant label from filename / path
        var variantLabel = getFilenameFromUrl(item.url);
        variantPlaylists.push({
          url: item.url,
          normalizedUrl: item.normalizedUrl,
          entry: item.entry,
          content: item.content,
          label: variantLabel,
          mediaSequence: mediaSequence,
          targetDuration: targetDuration,
          playlistType: playlistType,
          isEndlist: isEndlist,
          segments: segments,
          totalDuration: cumulativeTime,
          recordedSegmentCount: segments.filter(function (s) { return s.isRecorded; }).length,
          initialMap: segments.length > 0 ? segments[0].map : null
        });
      }
    }

    // Associate Master Playlist declared variants with parsed Child Playlists
    if (masterPlaylists.length > 0) {
      for (var mp = 0; mp < masterPlaylists.length; mp++) {
        var master = masterPlaylists[mp];
        for (var v = 0; v < master.variants.length; v++) {
          var declared = master.variants[v];
          for (var cp = 0; cp < variantPlaylists.length; cp++) {
            var child = variantPlaylists[cp];
            if (child.normalizedUrl === declared.normalizedUrl ||
                child.url.endsWith(declared.uri) ||
                declared.resolvedUrl.endsWith(child.label)) {
              child.masterVariantInfo = declared;
              if (declared.resolution) {
                child.label = declared.resolution + ' (' + (Math.round(declared.bandwidth / 1000)) + 'k)';
              } else if (declared.name) {
                child.label = declared.name;
              }
              break;
            }
          }
        }
      }
    }

    return {
      masterPlaylists: masterPlaylists,
      variantPlaylists: variantPlaylists
    };
  }

  /**
   * 3. Build Timeline: Maps recorded segments to temporal indices and identifies trajectory
   */
  function buildTimeline(variantPlaylists, segmentEntries) {
    if (!variantPlaylists || variantPlaylists.length === 0) {
      return {
        timeline: [],
        metrics: {
          totalSegments: 0,
          totalDuration: 0,
          recordedCount: 0,
          variantsUsed: {},
          transitionsCount: 0,
          gapsCount: 0,
          totalGapDuration: 0
        }
      };
    }

    // Discover the global range of sequence indices
    var minSeq = Infinity;
    var maxSeq = -Infinity;
    var allIndicesSet = new Set();

    variantPlaylists.forEach(function (variant) {
      variant.segments.forEach(function (seg) {
        if (seg.index < minSeq) minSeq = seg.index;
        if (seg.index > maxSeq) maxSeq = seg.index;
        allIndicesSet.add(seg.index);
      });
    });

    if (minSeq === Infinity) {
      minSeq = 0;
      maxSeq = -1;
    }

    // Build timeline entry for each sequence index
    var timeline = [];
    var variantsUsed = {};
    var transitionsCount = 0;
    var gapsCount = 0;
    var totalGapDuration = 0;
    var prevVariantKey = null;

    // Track contiguous index sequence
    for (var idx = minSeq; idx <= maxSeq; idx++) {
      // Find candidate segments across variants at this index
      var candidates = [];
      for (var v = 0; v < variantPlaylists.length; v++) {
        var variant = variantPlaylists[v];
        for (var s = 0; s < variant.segments.length; s++) {
          if (variant.segments[s].index === idx) {
            candidates.push({
              variant: variant,
              segment: variant.segments[s]
            });
            break;
          }
        }
      }

      if (candidates.length === 0) {
        continue;
      }

      // Pick recorded segment
      var recordedCandidates = candidates.filter(function (c) {
        return c.segment.isRecorded;
      });

      var chosen = null;

      if (recordedCandidates.length === 1) {
        chosen = recordedCandidates[0];
      } else if (recordedCandidates.length > 1) {
        // If multiple variants have a recorded segment at this index (e.g. overlap during ABR shift):
        // 1. Prefer continuing with current variant to avoid unnecessary discontinuity
        var sameVariant = recordedCandidates.find(function (c) {
          return c.variant.label === prevVariantKey;
        });
        if (sameVariant) {
          chosen = sameVariant;
        } else {
          // 2. Prefer highest bandwidth/resolution
          recordedCandidates.sort(function (a, b) {
            var bwA = (a.variant.masterVariantInfo && a.variant.masterVariantInfo.bandwidth) || 0;
            var bwB = (b.variant.masterVariantInfo && b.variant.masterVariantInfo.bandwidth) || 0;
            return bwB - bwA;
          });
          chosen = recordedCandidates[0];
        }
      }

      if (chosen) {
        var currentVariantKey = chosen.variant.label;
        var isTransition = prevVariantKey !== null && prevVariantKey !== currentVariantKey;
        if (isTransition) {
          transitionsCount++;
        }

        variantsUsed[currentVariantKey] = (variantsUsed[currentVariantKey] || 0) + 1;

        timeline.push({
          index: idx,
          isGap: false,
          variant: chosen.variant,
          variantLabel: currentVariantKey,
          segment: chosen.segment,
          duration: chosen.segment.duration,
          resolvedUrl: chosen.segment.resolvedUrl,
          uri: chosen.segment.uri,
          map: chosen.segment.map,
          byteRange: chosen.segment.byteRange,
          isTransition: isTransition,
          prevVariantLabel: prevVariantKey
        });

        prevVariantKey = currentVariantKey;
      } else {
        // Gap: no variant recorded a segment for this sequence index!
        // Approximate gap duration from candidate segments
        var approxDur = candidates[0].segment.duration || 2.0;
        gapsCount++;
        totalGapDuration += approxDur;

        timeline.push({
          index: idx,
          isGap: true,
          duration: approxDur,
          candidates: candidates,
          prevVariantLabel: prevVariantKey
        });
      }
    }

    // Calculate cumulative timeline offsets for stitched sequence
    var runningTime = 0;
    var validSegments = [];
    for (var t = 0; t < timeline.length; t++) {
      var item = timeline[t];
      item.timelineStartTime = runningTime;
      runningTime += item.duration;
      item.timelineEndTime = runningTime;
      if (!item.isGap) {
        validSegments.push(item);
      }
    }

    return {
      timeline: timeline,
      validSegments: validSegments,
      metrics: {
        totalSegments: validSegments.length,
        totalDuration: runningTime - totalGapDuration,
        fullTimelineDuration: runningTime,
        recordedCount: validSegments.length,
        variantsUsed: variantsUsed,
        transitionsCount: transitionsCount,
        gapsCount: gapsCount,
        totalGapDuration: totalGapDuration
      }
    };
  }

  /**
   * 4. Synthesize Stitched Playlist: Generates RFC 8216 HLS playlist
   * Injects #EXT-X-DISCONTINUITY at variant transitions and after gaps,
   * and #EXT-X-MAP for fMP4 streams.
   */
  function synthesizeStitchedPlaylist(timelineResult, options) {
    options = options || {};
    var timeline = timelineResult.timeline || [];
    var validSegments = timelineResult.validSegments || [];

    if (validSegments.length === 0) {
      return {
        playlistText: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:0\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n',
        targetDuration: 0,
        segmentCount: 0,
        filename: 'stitched_trajectory.m3u8'
      };
    }

    var maxDuration = 0;
    for (var i = 0; i < validSegments.length; i++) {
      if (validSegments[i].duration > maxDuration) {
        maxDuration = validSegments[i].duration;
      }
    }
    var targetDuration = Math.ceil(maxDuration) || 6;
    var firstSeq = validSegments[0].index;

    // Detect if any segment uses fMP4 (#EXT-X-MAP)
    var hasFmp4Map = false;
    for (var f = 0; f < validSegments.length; f++) {
      if (validSegments[f].map) {
        hasFmp4Map = true;
        break;
      }
    }

    var lines = [
      '#EXTM3U',
      hasFmp4Map ? '#EXT-X-VERSION:7' : '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:' + targetDuration,
      '#EXT-X-MEDIA-SEQUENCE:' + firstSeq,
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS'
    ];

    var currentActiveMapUri = null;
    var hadGap = false;
    var lastVariantLabel = null;

    for (var k = 0; k < timeline.length; k++) {
      var item = timeline[k];

      if (item.isGap) {
        hadGap = true;
        continue;
      }

      var variantChanged = lastVariantLabel !== null && lastVariantLabel !== item.variantLabel;
      var needsDiscontinuity = variantChanged || hadGap;

      if (needsDiscontinuity) {
        lines.push('#EXT-X-DISCONTINUITY');
        hadGap = false;
      }

      // Handle fMP4 #EXT-X-MAP init header
      if (item.map && item.map.uri) {
        var mapUriToOutput = item.map.resolvedUrl || item.map.uri;
        if (mapUriToOutput !== currentActiveMapUri || needsDiscontinuity) {
          var mapTag = '#EXT-X-MAP:URI="' + mapUriToOutput + '"';
          if (item.map.byteRange) {
            mapTag += ',BYTERANGE="' + item.map.byteRange + '"';
          }
          lines.push(mapTag);
          currentActiveMapUri = mapUriToOutput;
        }
      }

      // Byte range if present
      if (item.byteRange) {
        lines.push('#EXT-X-BYTERANGE:' + item.byteRange);
      }

      // Extinf and segment URI
      lines.push('#EXTINF:' + item.duration.toFixed(3) + ',');
      // Always use the absolute resolved URL so har-player can match request.url accurately
      lines.push(item.resolvedUrl);

      lastVariantLabel = item.variantLabel;
    }

    lines.push('#EXT-X-ENDLIST');
    var playlistText = lines.join('\n') + '\n';

    return {
      playlistText: playlistText,
      targetDuration: targetDuration,
      segmentCount: validSegments.length,
      filename: 'stitched_trajectory.m3u8'
    };
  }

  /**
   * 5. Patch HAR: Rewrites Master Manifest and injects stitched_trajectory.m3u8
   */
  function patchHAR(harData, stitchedResult, options) {
    options = options || {};
    var harCopy;
    try {
      harCopy = JSON.parse(JSON.stringify(harData));
    } catch (e) {
      throw new Error('Could not clone HAR data: ' + e.message);
    }

    var parsed = parseHAR(harCopy);
    var analysis = analyzeManifests(parsed.manifestEntries, parsed.segmentUrlMap);
    var masterPlaylists = analysis.masterPlaylists;

    var stitchedFilename = (stitchedResult && stitchedResult.filename) || 'stitched_trajectory.m3u8';
    var stitchedContent = stitchedResult ? stitchedResult.playlistText : '';

    var masterManifestUrl = null;
    var stitchedManifestUrl = null;
    var originalMasterContent = null;
    var rewrittenMasterContent = null;

    if (masterPlaylists.length > 0) {
      var primaryMaster = masterPlaylists[0];
      masterManifestUrl = primaryMaster.url;
      originalMasterContent = primaryMaster.content;

      // Determine stitched manifest URL in the same directory as master manifest
      stitchedManifestUrl = resolveUrl(stitchedFilename, masterManifestUrl);

      // Highest bandwidth variant attributes for the single stream-inf
      var maxBandwidth = 5000000;
      var codecs = 'avc1.4d401f,mp4a.40.2';
      var resolution = '1920x1080';
      if (primaryMaster.variants && primaryMaster.variants.length > 0) {
        var sorted = primaryMaster.variants.slice().sort(function (a, b) {
          return (b.bandwidth || 0) - (a.bandwidth || 0);
        });
        if (sorted[0].bandwidth) maxBandwidth = sorted[0].bandwidth;
        if (sorted[0].codecs) codecs = sorted[0].codecs;
        if (sorted[0].resolution) resolution = sorted[0].resolution;
      }

      rewrittenMasterContent = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-STREAM-INF:BANDWIDTH=' + maxBandwidth + ',RESOLUTION=' + resolution + ',CODECS="' + codecs + '",NAME="Stitched Trajectory"',
        stitchedManifestUrl
      ].join('\n') + '\n';

      // Rewrite content in the actual master manifest entry in the HAR
      for (var i = 0; i < harCopy.log.entries.length; i++) {
        var ent = harCopy.log.entries[i];
        if (ent.request && ent.request.url === masterManifestUrl) {
          if (!ent.response.content) ent.response.content = {};
          ent.response.content.text = rewrittenMasterContent;
          ent.response.content.size = rewrittenMasterContent.length;
          ent.response.content.mimeType = 'application/vnd.apple.mpegurl';
          ent.response.content.encoding = undefined;
          ent.response.bodySize = rewrittenMasterContent.length;
          break;
        }
      }
    } else if (analysis.variantPlaylists.length > 0) {
      // No master manifest was found in the HAR, only variant manifests
      var primaryChild = analysis.variantPlaylists[0];
      masterManifestUrl = primaryChild.url;
      stitchedManifestUrl = resolveUrl(stitchedFilename, primaryChild.url);
      
      // We can also create a synthetic master manifest or point from the primary child
      // For maximum compatibility, replace the first child variant with the stitched content
      for (var j = 0; j < harCopy.log.entries.length; j++) {
        var cEnt = harCopy.log.entries[j];
        if (cEnt.request && cEnt.request.url === primaryChild.url) {
          if (!cEnt.response.content) cEnt.response.content = {};
          cEnt.response.content.text = stitchedContent;
          cEnt.response.content.size = stitchedContent.length;
          cEnt.response.content.mimeType = 'application/vnd.apple.mpegurl';
          cEnt.response.content.encoding = undefined;
          cEnt.response.bodySize = stitchedContent.length;
          break;
        }
      }
    } else {
      stitchedManifestUrl = 'http://localhost/video/stitched_trajectory.m3u8';
    }

    // Inject stitched_trajectory.m3u8 entry into log.entries so har-player can serve it
    var newEntry = {
      startedDateTime: new Date().toISOString(),
      time: 5,
      request: {
        method: 'GET',
        url: stitchedManifestUrl,
        httpVersion: 'HTTP/1.1',
        headers: [
          { name: 'Accept', value: '*/*' },
          { name: 'User-Agent', value: 'HAR-Video-Stream-Stitcher' }
        ],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: 0
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [
          { name: 'Content-Type', value: 'application/vnd.apple.mpegurl' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Content-Length', value: String(stitchedContent.length) }
        ],
        cookies: [],
        content: {
          size: stitchedContent.length,
          mimeType: 'application/vnd.apple.mpegurl',
          text: stitchedContent
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: stitchedContent.length
      },
      cache: {},
      timings: { send: 0, wait: 5, receive: 0 }
    };

    harCopy.log.entries.unshift(newEntry);

    return {
      patchedHar: harCopy,
      masterManifestUrl: masterManifestUrl,
      stitchedManifestUrl: stitchedManifestUrl,
      originalMasterContent: originalMasterContent,
      rewrittenMasterContent: rewrittenMasterContent,
      stitchedContent: stitchedContent
    };
  }

  /**
   * Complete pipeline helper: runs parse, analyze, timeline, synthesize, and patch
   */
  function processHar(harData, options) {
    var parsed = parseHAR(harData);
    var analysis = analyzeManifests(parsed.manifestEntries, parsed.segmentUrlMap);
    var timelineResult = buildTimeline(analysis.variantPlaylists, parsed.segmentEntries);
    var stitchedResult = synthesizeStitchedPlaylist(timelineResult, options);
    var patchResult = patchHAR(parsed.har, stitchedResult, options);

    return {
      parsed: parsed,
      analysis: analysis,
      timelineResult: timelineResult,
      stitchedResult: stitchedResult,
      patchResult: patchResult
    };
  }

  return {
    parseHAR: parseHAR,
    analyzeManifests: analyzeManifests,
    buildTimeline: buildTimeline,
    synthesizeStitchedPlaylist: synthesizeStitchedPlaylist,
    patchHAR: patchHAR,
    processHar: processHar,
    resolveUrl: resolveUrl,
    normalizeUrl: normalizeUrl
  };
}));

