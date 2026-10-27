/**
 * HAR Video Stream Stitcher — UI Application Controller
 */

(function () {
  'use strict';

  // State
  let currentHarData = null;
  let currentFilename = 'recording.har';
  let processedResult = null;
  let selectedSegmentIdx = null;

  // Variant color palette
  const variantColors = [
    '#06b6d4', // Cyan
    '#8b5cf6', // Violet
    '#10b981', // Emerald
    '#f59e0b', // Amber
    '#ec4899', // Pink
    '#3b82f6', // Blue
    '#14b8a6'  // Teal
  ];
  const variantColorMap = new Map();

  function getVariantColor(variantLabel) {
    if (!variantColorMap.has(variantLabel)) {
      const idx = variantColorMap.size % variantColors.length;
      variantColorMap.set(variantLabel, variantColors[idx]);
    }
    return variantColorMap.get(variantLabel);
  }

  // DOM Elements
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const loadSampleBtn = document.getElementById('loadSampleBtn');
  const resultsDashboard = document.getElementById('resultsDashboard');

  const metricDuration = document.getElementById('metricDuration');
  const metricTimelineRange = document.getElementById('metricTimelineRange');
  const metricSegments = document.getElementById('metricSegments');
  const metricTargetDur = document.getElementById('metricTargetDur');
  const metricVariants = document.getElementById('metricVariants');
  const metricVariantBreakdown = document.getElementById('metricVariantBreakdown');
  const metricTransitions = document.getElementById('metricTransitions');
  const metricGaps = document.getElementById('metricGaps');
  const metricGapsSub = document.getElementById('metricGapsSub');

  const timelineTrack = document.getElementById('timelineTrack');
  const timelineLegend = document.getElementById('timelineLegend');
  const segmentDetailDrawer = document.getElementById('segmentDetailDrawer');
  const detailIndex = document.getElementById('detailIndex');
  const detailVariant = document.getElementById('detailVariant');
  const detailDuration = document.getElementById('detailDuration');
  const detailUrl = document.getElementById('detailUrl');
  const detailStatus = document.getElementById('detailStatus');
  const detailMap = document.getElementById('detailMap');

  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const stitchedCode = document.getElementById('stitchedCode');
  const origMasterCode = document.getElementById('origMasterCode');
  const rewrittenMasterCode = document.getElementById('rewrittenMasterCode');
  const variantsContainer = document.getElementById('variantsContainer');

  const downloadHarBtn = document.getElementById('downloadHarBtn');
  const downloadM3u8Btn = document.getElementById('downloadM3u8Btn');
  const resetBtn = document.getElementById('resetBtn');
  const exportSummary = document.getElementById('exportSummary');

  // File Upload Handlers
  browseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  function handleFile(file) {
    currentFilename = file.name || 'recording.har';
    const reader = new FileReader();
    reader.onload = function (evt) {
      try {
        const text = evt.target.result;
        const harJson = JSON.parse(text);
        processAndDisplay(harJson);
      } catch (err) {
        alert('Error parsing HAR file: ' + err.message);
      }
    };
    reader.onerror = function () {
      alert('Error reading file');
    };
    reader.readAsText(file);
  }

  // Load Built-in 720p -> 1080p Sample
  loadSampleBtn.addEventListener('click', () => {
    currentFilename = 'abr_upswitch_sample.har';
    const sample = generateSampleHarData();
    processAndDisplay(sample);
  });

  function processAndDisplay(harJson) {
    try {
      currentHarData = harJson;
      variantColorMap.clear();

      processedResult = HarStitcher.processHar(harJson);
      renderDashboard(processedResult);

      dropZone.classList.add('hidden');
      resultsDashboard.classList.remove('hidden');
    } catch (err) {
      alert('Stitching failed: ' + err.message);
      console.error(err);
    }
  }

  // Render Dashboard
  function renderDashboard(result) {
    const timelineRes = result.timelineResult;
    const metrics = timelineRes.metrics;
    const analysis = result.analysis;
    const stitched = result.stitchedResult;
    const patch = result.patchResult;

    // Metrics Cards
    metricDuration.textContent = metrics.totalDuration.toFixed(2) + 's';
    if (timelineRes.validSegments.length > 0) {
      const firstSeq = timelineRes.validSegments[0].index;
      const lastSeq = timelineRes.validSegments[timelineRes.validSegments.length - 1].index;
      metricTimelineRange.textContent = `Segments #${firstSeq} to #${lastSeq}`;
    } else {
      metricTimelineRange.textContent = 'No segments';
    }

    metricSegments.textContent = metrics.totalSegments;
    metricTargetDur.textContent = `Target dur: ${stitched.targetDuration}s`;

    const variantKeys = Object.keys(metrics.variantsUsed);
    metricVariants.textContent = variantKeys.length;
    metricVariantBreakdown.textContent = variantKeys.map(k => `${k}: ${metrics.variantsUsed[k]}`).join(' | ') || 'None';

    metricTransitions.textContent = metrics.transitionsCount;
    metricGaps.textContent = metrics.gapsCount;
    metricGapsSub.textContent = `${metrics.totalGapDuration.toFixed(1)}s skipped`;

    exportSummary.textContent = patch.masterManifestUrl
      ? `Rewrote master manifest at ${patch.masterManifestUrl} and injected ${stitched.filename}.`
      : `Injected ${stitched.filename} into log.entries.`;

    // Render Timeline Track
    renderTimelineTrack(timelineRes.timeline);

    // Render Code Views
    stitchedCode.textContent = stitched.playlistText;
    origMasterCode.textContent = patch.originalMasterContent || 'No Master Playlist found in HAR (Single variant mode)';
    rewrittenMasterCode.textContent = patch.rewrittenMasterContent || 'Master playlist not rewritten (Single variant mode)';

    // Render Variants tab
    renderVariantsTab(analysis.variantPlaylists);

    // Default select first segment for drawer
    if (timelineRes.validSegments.length > 0) {
      selectSegment(timelineRes.validSegments[0]);
    }
  }

  function renderTimelineTrack(timeline) {
    timelineTrack.innerHTML = '';
    timelineLegend.innerHTML = '';

    const seenVariants = new Set();

    timeline.forEach((item, i) => {
      if (item.isGap) {
        // Gap chip
        const gapEl = document.createElement('div');
        gapEl.className = 'gap-chip';
        gapEl.innerHTML = `
          <strong>GAP #${item.index}</strong>
          <span>${item.duration.toFixed(2)}s missing</span>
        `;
        timelineTrack.appendChild(gapEl);

        // Discontinuity indicator after gap
        const disconEl = document.createElement('div');
        disconEl.className = 'discontinuity-marker';
        disconEl.innerHTML = `
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          <span>#EXT-X-DISCONTINUITY</span>
        `;
        timelineTrack.appendChild(disconEl);
        return;
      }

      const color = getVariantColor(item.variantLabel);
      seenVariants.add(item.variantLabel);

      // If transition, add Discontinuity Marker
      if (item.isTransition) {
        const disconEl = document.createElement('div');
        disconEl.className = 'discontinuity-marker';
        disconEl.innerHTML = `
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          <span>#EXT-X-DISCONTINUITY</span>
        `;
        timelineTrack.appendChild(disconEl);
      }

      // Segment chip
      const chip = document.createElement('div');
      chip.className = 'timeline-chip';
      chip.style.setProperty('--chip-color', color);
      chip.dataset.index = item.index;

      const segName = item.segment.uri.split('?')[0].split('/').pop();
      chip.innerHTML = `
        <div class="chip-header">
          <span class="chip-seq">#${item.index}</span>
          <span class="chip-variant-badge">${item.variantLabel}</span>
        </div>
        <div class="chip-body">${escapeHtml(segName)}</div>
        <div class="chip-footer">
          <span>${item.duration.toFixed(2)}s</span>
          <span>${item.segment.recordedStatus ? item.segment.recordedStatus + ' OK' : '200 OK'}</span>
        </div>
      `;

      chip.addEventListener('click', () => {
        document.querySelectorAll('.timeline-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        selectSegment(item);
      });

      timelineTrack.appendChild(chip);
    });

    // Populate Legend
    seenVariants.forEach(variantLabel => {
      const color = getVariantColor(variantLabel);
      const legItem = document.createElement('div');
      legItem.style.display = 'flex';
      legItem.style.alignItems = 'center';
      legItem.style.gap = '0.35rem';
      legItem.innerHTML = `
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};"></span>
        <span style="color:var(--text-muted);font-weight:600;">${escapeHtml(variantLabel)}</span>
      `;
      timelineLegend.appendChild(legItem);
    });
  }

  function selectSegment(item) {
    segmentDetailDrawer.classList.remove('hidden');
    detailIndex.textContent = '#' + item.index;
    detailVariant.textContent = item.variantLabel;
    detailDuration.textContent = `${item.duration.toFixed(3)}s (${item.timelineStartTime.toFixed(2)}s – ${item.timelineEndTime.toFixed(2)}s)`;
    detailUrl.textContent = item.resolvedUrl;
    
    const sizeKb = item.segment.recordedSize ? (item.segment.recordedSize / 1024).toFixed(1) + ' KB' : 'Unknown size';
    detailStatus.textContent = `${item.segment.recordedStatus || 200} OK (${sizeKb})`;

    if (item.map && item.map.uri) {
      detailMap.textContent = item.map.uri;
    } else {
      detailMap.textContent = 'None (Standard MPEG-TS)';
    }
  }

  function renderVariantsTab(variants) {
    variantsContainer.innerHTML = '';
    if (!variants || variants.length === 0) {
      variantsContainer.innerHTML = '<p style="color:var(--text-muted);">No child variants detected.</p>';
      return;
    }

    variants.forEach(v => {
      const color = getVariantColor(v.label);
      const card = document.createElement('div');
      card.className = 'code-view-container';
      card.innerHTML = `
        <div class="code-header">
          <span style="color:${color};font-weight:700;">${escapeHtml(v.label)} (${v.recordedSegmentCount} recorded / ${v.segments.length} declared segments)</span>
          <span style="font-size:0.75rem;color:var(--text-dim);">${escapeHtml(v.url)}</span>
        </div>
        <pre class="code-block">${escapeHtml(v.content)}</pre>
      `;
      variantsContainer.appendChild(card);
    });
  }

  // Tabs Navigation
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.add('hidden'));

      btn.classList.add('active');
      const targetPane = document.getElementById(btn.dataset.tab);
      if (targetPane) targetPane.classList.remove('hidden');
    });
  });

  // Copy buttons
  document.querySelectorAll('.code-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copyTarget;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        navigator.clipboard.writeText(targetEl.textContent).then(() => {
          const origText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = origText; }, 1800);
        });
      }
    });
  });

  // Export Patched HAR
  downloadHarBtn.addEventListener('click', () => {
    if (!processedResult || !processedResult.patchResult) return;
    const patchedHar = processedResult.patchResult.patchedHar;
    const jsonStr = JSON.stringify(patchedHar, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const downloadName = currentFilename.replace(/\.har$/i, '') + '.stitched.har';
    triggerDownload(blob, downloadName);
  });

  // Export .m3u8
  downloadM3u8Btn.addEventListener('click', () => {
    if (!processedResult || !processedResult.stitchedResult) return;
    const m3u8Text = processedResult.stitchedResult.playlistText;
    const blob = new Blob([m3u8Text], { type: 'application/x-mpegURL' });
    triggerDownload(blob, 'stitched_trajectory.m3u8');
  });

  // Reset
  resetBtn.addEventListener('click', () => {
    currentHarData = null;
    processedResult = null;
    resultsDashboard.classList.add('hidden');
    dropZone.classList.remove('hidden');
    fileInput.value = '';
  });

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Generator for Synthetic 720p (seg 0,1) -> 1080p (seg 2,3) HAR
  function generateSampleHarData() {
    const masterUrl = 'https://stream.example.com/hls/master.m3u8';
    const v720Url = 'https://stream.example.com/hls/720p.m3u8';
    const v1080Url = 'https://stream.example.com/hls/1080p.m3u8';

    const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
`;

    const v720Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.000,
720p_segment_0.ts
#EXTINF:2.000,
720p_segment_1.ts
#EXTINF:2.000,
720p_segment_2.ts
#EXTINF:2.000,
720p_segment_3.ts
#EXT-X-ENDLIST
`;

    const v1080Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.000,
1080p_segment_0.ts
#EXTINF:2.000,
1080p_segment_1.ts
#EXTINF:2.000,
1080p_segment_2.ts
#EXTINF:2.000,
1080p_segment_3.ts
#EXT-X-ENDLIST
`;

    return {
      log: {
        version: '1.2',
        creator: { name: 'HAR Video Stream Stitcher Sample', version: '1.0' },
        entries: [
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
          // 720p segments 0 and 1 were recorded
          {
            startedDateTime: '2026-10-27T10:00:00.000Z',
            time: 65,
            request: { method: 'GET', url: 'https://stream.example.com/hls/720p_segment_0.ts' },
            response: { status: 200, content: { size: 680000, mimeType: 'video/mp2t' } }
          },
          {
            startedDateTime: '2026-10-27T10:00:02.000Z',
            time: 70,
            request: { method: 'GET', url: 'https://stream.example.com/hls/720p_segment_1.ts' },
            response: { status: 200, content: { size: 710000, mimeType: 'video/mp2t' } }
          },
          // 1080p segments 2 and 3 were recorded (ABR upswitched at sec 4)
          {
            startedDateTime: '2026-10-27T10:00:04.000Z',
            time: 85,
            request: { method: 'GET', url: 'https://stream.example.com/hls/1080p_segment_2.ts' },
            response: { status: 200, content: { size: 1350000, mimeType: 'video/mp2t' } }
          },
          {
            startedDateTime: '2026-10-27T10:00:06.000Z',
            time: 90,
            request: { method: 'GET', url: 'https://stream.example.com/hls/1080p_segment_3.ts' },
            response: { status: 200, content: { size: 1380000, mimeType: 'video/mp2t' } }
          }
        ]
      }
    };
  }

})();

