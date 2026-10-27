/**
 * Synthetic Test Script for HAR Video Stream Stitcher
 * Replicates the exact real-world scenario:
 * Playback starts at 720p (segments 0 & 1), ABR upswitches to 1080p at sec 4 (segments 2 & 3).
 * Verifies timeline building, #EXT-X-DISCONTINUITY insertion, and HAR patching.
 */

const assert = require('assert');
const stitcher = require('./stitcher.js');

function createSampleHar() {
  const masterUrl = 'https://video.example.com/stream/master.m3u8';
  const v720Url = 'https://video.example.com/stream/720p/playlist.m3u8';
  const v1080Url = 'https://video.example.com/stream/1080p/playlist.m3u8';

  const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/playlist.m3u8
`;

  const v720Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.000,
seg_0.ts
#EXTINF:2.000,
seg_1.ts
#EXTINF:2.000,
seg_2.ts
#EXTINF:2.000,
seg_3.ts
#EXT-X-ENDLIST
`;

  const v1080Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.000,
seg_0.ts
#EXTINF:2.000,
seg_1.ts
#EXTINF:2.000,
seg_2.ts
#EXTINF:2.000,
seg_3.ts
#EXT-X-ENDLIST
`;

  // Only 720p seg 0,1 and 1080p seg 2,3 were recorded during the live playback!
  const entries = [
    {
      request: { method: 'GET', url: masterUrl },
      response: {
        status: 200,
        content: { text: masterContent, mimeType: 'application/vnd.apple.mpegurl', size: masterContent.length }
      }
    },
    {
      request: { method: 'GET', url: v720Url },
      response: {
        status: 200,
        content: { text: v720Content, mimeType: 'application/vnd.apple.mpegurl', size: v720Content.length }
      }
    },
    {
      request: { method: 'GET', url: v1080Url },
      response: {
        status: 200,
        content: { text: v1080Content, mimeType: 'application/vnd.apple.mpegurl', size: v1080Content.length }
      }
    },
    // 720p segment 0 (seconds 0-2)
    {
      startedDateTime: '2026-10-27T10:00:00.000Z',
      time: 80,
      request: { method: 'GET', url: 'https://video.example.com/stream/720p/seg_0.ts' },
      response: { status: 200, content: { size: 625000, mimeType: 'video/mp2t' } }
    },
    // 720p segment 1 (seconds 2-4)
    {
      startedDateTime: '2026-10-27T10:00:02.000Z',
      time: 75,
      request: { method: 'GET', url: 'https://video.example.com/stream/720p/seg_1.ts' },
      response: { status: 200, content: { size: 625000, mimeType: 'video/mp2t' } }
    },
    // 1080p segment 2 (seconds 4-6) - ABR switched up to 1080p!
    {
      startedDateTime: '2026-10-27T10:00:04.000Z',
      time: 90,
      request: { method: 'GET', url: 'https://video.example.com/stream/1080p/seg_2.ts' },
      response: { status: 200, content: { size: 1250000, mimeType: 'video/mp2t' } }
    },
    // 1080p segment 3 (seconds 6-8)
    {
      startedDateTime: '2026-10-27T10:00:06.000Z',
      time: 95,
      request: { method: 'GET', url: 'https://video.example.com/stream/1080p/seg_3.ts' },
      response: { status: 200, content: { size: 1250000, mimeType: 'video/mp2t' } }
    }
  ];

  return {
    log: {
      version: '1.2',
      creator: { name: 'Synthetic HAR Generator', version: '1.0' },
      entries: entries
    }
  };
}

function runTests() {
  console.log('🧪 Running HAR Video Stream Stitcher Test Suite...\n');

  const sampleHar = createSampleHar();

  // Test 1: parseHAR
  console.log('1. Testing parseHAR...');
  const parsed = stitcher.parseHAR(sampleHar);
  assert.strictEqual(parsed.manifestEntries.length, 3, 'Should discover 3 manifest entries');
  assert.strictEqual(parsed.segmentEntries.length, 4, 'Should discover 4 media segment entries');
  console.log('   ✓ Extracted 3 manifests and 4 media segments successfully');

  // Test 2: analyzeManifests
  console.log('2. Testing analyzeManifests...');
  const analysis = stitcher.analyzeManifests(parsed.manifestEntries, parsed.segmentUrlMap);
  assert.strictEqual(analysis.masterPlaylists.length, 1, 'Should find 1 master playlist');
  assert.strictEqual(analysis.variantPlaylists.length, 2, 'Should find 2 variant playlists');
  
  const p720 = analysis.variantPlaylists.find(v => v.url.includes('720p'));
  const p1080 = analysis.variantPlaylists.find(v => v.url.includes('1080p'));
  assert(p720, '720p playlist must exist');
  assert(p1080, '1080p playlist must exist');
  assert.strictEqual(p720.recordedSegmentCount, 2, '720p should have exactly 2 recorded segments');
  assert.strictEqual(p1080.recordedSegmentCount, 2, '1080p should have exactly 2 recorded segments');
  console.log('   ✓ Correlated child playlists with master variants');

  // Test 3: buildTimeline
  console.log('3. Testing buildTimeline...');
  const timelineResult = stitcher.buildTimeline(analysis.variantPlaylists, parsed.segmentEntries);
  assert.strictEqual(timelineResult.validSegments.length, 4, 'Timeline should have 4 valid segments');
  assert.strictEqual(timelineResult.metrics.transitionsCount, 1, 'Should detect exactly 1 variant transition');
  assert.strictEqual(timelineResult.metrics.gapsCount, 0, 'No gaps expected in continuous playback');

  assert.strictEqual(timelineResult.validSegments[0].segment.index, 0);
  assert(timelineResult.validSegments[0].variant.url.includes('720p'), 'Segment 0 should be from 720p');
  assert(timelineResult.validSegments[1].variant.url.includes('720p'), 'Segment 1 should be from 720p');
  assert(timelineResult.validSegments[2].variant.url.includes('1080p'), 'Segment 2 should be from 1080p');
  assert(timelineResult.validSegments[3].variant.url.includes('1080p'), 'Segment 3 should be from 1080p');
  assert.strictEqual(timelineResult.validSegments[2].isTransition, true, 'Segment 2 must be flagged as transition');
  console.log('   ✓ Successfully correlated trajectory: 720p (seg 0, 1) -> 1080p (seg 2, 3)');

  // Test 4: synthesizeStitchedPlaylist
  console.log('4. Testing synthesizeStitchedPlaylist...');
  const stitched = stitcher.synthesizeStitchedPlaylist(timelineResult);
  console.log('--- Generated Stitched Manifest ---');
  console.log(stitched.playlistText);
  console.log('-----------------------------------');

  assert(stitched.playlistText.includes('#EXT-X-DISCONTINUITY'), 'Playlist MUST contain #EXT-X-DISCONTINUITY');
  const lines = stitched.playlistText.split('\n');
  const disconIdx = lines.findIndex(l => l.startsWith('#EXT-X-DISCONTINUITY'));
  assert(disconIdx !== -1, 'Discontinuity tag index found');
  
  // The discontinuity must appear right before 1080p segment 2
  const seg2Idx = lines.findIndex(l => l.includes('1080p/seg_2.ts'));
  assert(seg2Idx > disconIdx, 'Discontinuity must precede 1080p seg 2');
  assert(seg2Idx <= disconIdx + 2, 'Discontinuity must directly precede #EXTINF and segment 2 URI');
  console.log('   ✓ Injected #EXT-X-DISCONTINUITY at correct variant boundary');

  // Test 5: patchHAR
  console.log('5. Testing patchHAR...');
  const patched = stitcher.patchHAR(sampleHar, stitched);
  assert(patched.stitchedManifestUrl, 'Must return stitched manifest URL');
  assert(patched.masterManifestUrl, 'Must return master manifest URL');
  
  // Check master manifest rewritten in patched HAR
  const rewrittenMaster = patched.patchedHar.log.entries.find(e => e.request.url === patched.masterManifestUrl);
  assert(rewrittenMaster, 'Rewritten master manifest entry must exist in HAR');
  assert(rewrittenMaster.response.content.text.includes(patched.stitchedManifestUrl), 'Master manifest must point to stitched trajectory');
  assert(!rewrittenMaster.response.content.text.includes('720p/playlist.m3u8'), 'Original 720p variant should be removed from master');
  assert(!rewrittenMaster.response.content.text.includes('1080p/playlist.m3u8'), 'Original 1080p variant should be removed from master');

  // Check stitched_trajectory.m3u8 injected into log.entries
  const stitchedEntry = patched.patchedHar.log.entries.find(e => e.request.url === patched.stitchedManifestUrl);
  assert(stitchedEntry, 'stitched_trajectory.m3u8 must be present in log.entries');
  assert.strictEqual(stitchedEntry.response.status, 200, 'Injected entry status must be 200');
  assert.strictEqual(stitchedEntry.response.content.text, stitched.playlistText, 'Injected entry content must match stitched playlist');
  console.log('   ✓ Master manifest rewritten to single stitched stream');
  console.log('   ✓ stitched_trajectory.m3u8 injected into log.entries with HTTP 200');

  // Test 6: Gap handling verification
  console.log('6. Testing Gap handling (omitted segment with #EXT-X-DISCONTINUITY)...');
  const gapHar = createSampleHar();
  // Remove 1080p seg_2 so sequence 2 is missing, only sequence 3 exists after sequence 1
  gapHar.log.entries = gapHar.log.entries.filter(e => !e.request.url.includes('seg_2.ts'));
  const gapResult = stitcher.processHar(gapHar);
  assert.strictEqual(gapResult.timelineResult.metrics.gapsCount, 1, 'Should detect 1 gap');
  assert(gapResult.stitchedResult.playlistText.includes('#EXT-X-DISCONTINUITY'), 'Gap must trigger discontinuity tag');
  console.log('   ✓ Gaps properly omitted and bridged with #EXT-X-DISCONTINUITY');

  // Test 7: fMP4 #EXT-X-MAP injection test
  console.log('7. Testing fMP4 #EXT-X-MAP injection on variant transition...');
  const fmp4Har = createSampleHar();
  // Update segment URLs to .m4s in entries
  fmp4Har.log.entries.forEach(e => {
    if (e.request.url.endsWith('.ts')) {
      e.request.url = e.request.url.replace('.ts', '.m4s');
      e.response.content.mimeType = 'video/iso.segment';
    }
  });
  // Add #EXT-X-MAP to child playlists
  const p720Entry = fmp4Har.log.entries.find(e => e.request.url.includes('720p/playlist.m3u8'));
  p720Entry.response.content.text = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init_720.mp4"\n#EXTINF:2.000,\nseg_0.m4s\n#EXTINF:2.000,\nseg_1.m4s\n#EXTINF:2.000,\nseg_2.m4s\n#EXTINF:2.000,\nseg_3.m4s\n#EXT-X-ENDLIST\n`;
  const p1080Entry = fmp4Har.log.entries.find(e => e.request.url.includes('1080p/playlist.m3u8'));
  p1080Entry.response.content.text = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init_1080.mp4"\n#EXTINF:2.000,\nseg_0.m4s\n#EXTINF:2.000,\nseg_1.m4s\n#EXTINF:2.000,\nseg_2.m4s\n#EXTINF:2.000,\nseg_3.m4s\n#EXT-X-ENDLIST\n`;
  
  const fmp4Processed = stitcher.processHar(fmp4Har);
  console.log('--- Generated fMP4 Stitched Manifest ---');
  console.log(fmp4Processed.stitchedResult.playlistText);
  console.log('----------------------------------------');
  assert(fmp4Processed.stitchedResult.playlistText.includes('#EXT-X-MAP:URI="https://video.example.com/stream/720p/init_720.mp4"'), 'Must have 720p init map');
  assert(fmp4Processed.stitchedResult.playlistText.includes('#EXT-X-MAP:URI="https://video.example.com/stream/1080p/init_1080.mp4"'), 'Must have 1080p init map');
  console.log('   ✓ Injected #EXT-X-MAP headers correctly during fMP4 variant transitions');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests();
