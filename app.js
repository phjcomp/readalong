(function () {
  'use strict';

  /* ─── Config ─── */
  const FIREBASE_URL = 'https://read-along-sync-default-rtdb.firebaseio.com';

  /* ─── Helpers ─── */
  function gsToHttp(url) {
    // Convert gs://bucket/path to https://firebasestorage.googleapis.com/v0/b/bucket/o/path?alt=media
    if (!url.startsWith('gs://')) return url;
    const noPrefix = url.slice(5); // remove 'gs://'
    const slashIdx = noPrefix.indexOf('/');
    if (slashIdx === -1) return url;
    const bucket = noPrefix.slice(0, slashIdx);
    const path = encodeURIComponent(noPrefix.slice(slashIdx + 1));
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${path}?alt=media`;
  }

  /* ─── DOM refs ─── */
  const $ = id => document.getElementById(id);
  const audioEl = $('audioEl');
  const librarySelect = $('librarySelect');
  const addBtn = $('addBtn');
  const deleteBtn = $('deleteBtn');
  const settingsBtn = $('settingsBtn');
  const uploadModal = $('uploadModal');
  const pinModal = $('pinModal');
  const pinInput = $('pinInput');
  const pinSubmit = $('pinSubmit');
  const inputTitle = $('inputTitle');
  const inputMp3Url = $('inputMp3Url');
  const inputSrtFile = $('inputSrtFile');
  const cancelUpload = $('cancelUpload');
  const saveUpload = $('saveUpload');
  const pageContent = $('pageContent');
  const emptyState = $('emptyState');
  const pageInfo = $('pageInfo');
  const prevPageBtn = $('prevPage');
  const nextPageBtn = $('nextPage');
  const playerBar = $('playerBar');
  const playPauseBtn = $('playPauseBtn');
  const seekBar = $('seekBar');
  const timeDisplay = $('timeDisplay');
  const progressPercent = $('progressPercent');
  const progressBarFill = $('progressBarFill');
  const progressBarContainer = $('progressBarContainer');
  const settingsPanel = $('settingsPanel');
  const closeSettings = $('closeSettings');
  const fontSizeSlider = $('fontSizeSlider');
  const lineHeightSlider = $('lineHeightSlider');
  const marginSlider = $('marginSlider');
  const fontFamilySelect = $('fontFamilySelect');
  const highlightColorSelect = $('highlightColorSelect');
  const fontSizeVal = $('fontSizeVal');
  const lineHeightVal = $('lineHeightVal');
  const marginVal = $('marginVal');
  const togglePauseAfter = $('togglePauseAfter');
  const toggleAutoTurnLong = $('toggleAutoTurnLong');
  const measureDiv = $('measureDiv');

  /* ─── State ─── */
  let userPin = null;
  let library = {};
  let currentBookId = null;
  let srtBlocks = [];
  let pages = [];
  let currentPage = 0;
  let lastHighlightedBlock = -1;
  let pauseGuardTime = 0;
  let animFrameId = null;
  let isSeeking = false;
  let progressDirty = false;

  let settings = {
    fontSize: 20, lineHeight: 1.8, margin: 60,
    fontFamily: "'Inter', system-ui, sans-serif",
    pauseAfterSentence: false, autoTurnLong: true,
    highlightColor: 'yellow'
  };

  const HIGHLIGHT_COLORS = {
    yellow: { bg: 'rgba(255, 255, 0, 0.45)', border: 'rgba(200, 200, 0, 0.7)' },
    green: { bg: 'rgba(0, 255, 100, 0.35)', border: 'rgba(0, 200, 80, 0.6)' },
    pink: { bg: 'rgba(255, 105, 180, 0.35)', border: 'rgba(255, 80, 160, 0.6)' },
    blue: { bg: 'rgba(0, 180, 255, 0.35)', border: 'rgba(0, 150, 220, 0.6)' },
    orange: { bg: 'rgba(255, 165, 0, 0.4)', border: 'rgba(220, 140, 0, 0.65)' }
  };

  /* ═══ SRT PARSER ═══ */
  function parseSRT(text) {
    const blocks = [];
    const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const parts = raw.split(/\n\n+/);
    for (const part of parts) {
      const lines = part.trim().split('\n');
      if (lines.length < 3) continue;
      const index = parseInt(lines[0].trim(), 10);
      if (isNaN(index)) continue;
      const timeLine = lines[1].trim();
      const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/;
      const m = timeLine.match(re);
      if (!m) continue;
      const startTime = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
      const endTime = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
      const textLines = lines.slice(2).join(' ').trim();
      blocks.push({ index, startTime, endTime, text: textLines });
    }
    return blocks;
  }

  /* ═══ FIREBASE REST API ═══ */
  async function fbGet(path) {
    try {
      const res = await fetch(`${FIREBASE_URL}/${path}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) { console.error('Firebase read error:', err); return null; }
  }
  async function fbPut(path, data) {
    try {
      await fetch(`${FIREBASE_URL}/${path}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (err) { console.error('Firebase write error:', err); }
  }
  async function fbDelete(path) {
    try {
      await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' });
    } catch (err) { console.error('Firebase delete error:', err); }
  }

  /* ═══ LOCAL SETTINGS (per-device) ═══ */
  function getLocalSettings() {
    try { return JSON.parse(localStorage.getItem('ra_deviceSettings')) || {}; }
    catch { return {}; }
  }
  function setLocalSettings(s) {
    localStorage.setItem('ra_deviceSettings', JSON.stringify(s));
  }

  /* ═══ PIN MANAGEMENT ═══ */
  function showPinModal() {
    pinInput.value = '';
    pinModal.classList.add('active');
    pinInput.focus();
  }
  pinSubmit.addEventListener('click', onPinSubmit);
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') onPinSubmit(); });

  async function onPinSubmit() {
    const pin = pinInput.value.trim();
    if (!pin) return alert('Please enter a PIN.');
    userPin = pin;
    localStorage.setItem('ra_pin', pin);
    pinModal.classList.remove('active');
    await loadLibrary();
  }

  /* ═══ LIBRARY MANAGEMENT (Firebase) ═══ */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function loadLibrary() {
    library = (await fbGet(`users/${userPin}/library`)) || {};
    refreshLibraryUI();
    showEmptyState();
    // Load per-device settings from localStorage
    const ds = getLocalSettings();
    if (ds.fontSize) settings.fontSize = ds.fontSize;
    if (ds.lineHeight) settings.lineHeight = ds.lineHeight;
    if (ds.margin) settings.margin = ds.margin;
    if (ds.fontFamily) settings.fontFamily = ds.fontFamily;
    if (ds.highlightColor) settings.highlightColor = ds.highlightColor;
    applySettings();
  }

  function refreshLibraryUI() {
    librarySelect.innerHTML = '<option value="">— Select Audiobook —</option>';
    const books = Object.values(library);
    books.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    books.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.title;
      if (b.id === currentBookId) opt.selected = true;
      librarySelect.appendChild(opt);
    });
  }

  /* ═══ ADD BOOK FLOW ═══ */
  addBtn.addEventListener('click', () => {
    inputTitle.value = '';
    inputMp3Url.value = '';
    inputSrtFile.value = '';
    uploadModal.classList.add('active');
    inputTitle.focus();
  });
  cancelUpload.addEventListener('click', () => { uploadModal.classList.remove('active'); });
  uploadModal.addEventListener('click', e => {
    if (e.target === uploadModal) uploadModal.classList.remove('active');
  });

  // Auto-fill title from SRT filename
  inputSrtFile.addEventListener('change', () => {
    const file = inputSrtFile.files[0];
    if (file && !inputTitle.value.trim()) {
      inputTitle.value = file.name.replace(/\.[^.]+$/, '');
    }
  });

  // Auto-fill title from MP3 URL if title is empty
  inputMp3Url.addEventListener('input', () => {
    if (!inputTitle.value.trim()) {
      const url = inputMp3Url.value.trim();
      const match = url.match(/\/([^/?]+\.mp3)/i) || url.match(/\/([^/]+)$/i);
      if (match) {
        inputTitle.value = decodeURIComponent(match[1]).replace(/\.[^.]+$/, '');
      }
    }
  });

  saveUpload.addEventListener('click', async () => {
    const title = inputTitle.value.trim();
    const mp3Url = inputMp3Url.value.trim();
    const srtFile = inputSrtFile.files[0];
    if (!title) return alert('Please enter a title.');
    if (!mp3Url) return alert('Please paste the MP3 URL.');
    if (!srtFile) return alert('Please select an SRT file.');
    saveUpload.disabled = true;
    saveUpload.textContent = 'Saving…';
    try {
      const srtText = await srtFile.text();
      const id = generateId();
      const finalMp3Url = gsToHttp(mp3Url);
      const bookEntry = { id, title, mp3Url: finalMp3Url, createdAt: Date.now() };
      await fbPut(`users/${userPin}/library/${id}`, bookEntry);
      await fbPut(`users/${userPin}/srt/${id}`, srtText);
      library[id] = bookEntry;
      refreshLibraryUI();
      uploadModal.classList.remove('active');
      await loadBook(id);
    } catch (err) {
      console.error('Save error:', err);
      alert('Failed to save: ' + err.message);
    } finally {
      saveUpload.disabled = false;
      saveUpload.textContent = 'Save Audiobook';
    }
  });

  /* ═══ DELETE ═══ */
  deleteBtn.addEventListener('click', async () => {
    if (!currentBookId) return alert('No audiobook selected.');
    const book = library[currentBookId];
    if (!book) return;
    if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
    await fbDelete(`users/${userPin}/library/${currentBookId}`);
    await fbDelete(`users/${userPin}/progress/${currentBookId}`);
    await fbDelete(`users/${userPin}/srt/${currentBookId}`);
    delete library[currentBookId];
    currentBookId = null;
    srtBlocks = []; pages = []; currentPage = 0;
    audioEl.pause(); audioEl.src = '';
    showEmptyState();
    refreshLibraryUI();
  });

  /* ═══ LOAD BOOK ═══ */
  librarySelect.addEventListener('change', async () => {
    const id = librarySelect.value;
    if (!id) return;
    await loadBook(id);
  });

  async function loadBook(id) {
    try {
      const book = library[id];
      if (!book) { alert('Audiobook not found.'); return; }
      currentBookId = id;
      librarySelect.value = id;

      // Load SRT text from Firebase Realtime Database
      const srtText = await fbGet(`users/${userPin}/srt/${id}`);
      if (!srtText) { alert('SRT data not found. Please re-add this book.'); return; }
      srtBlocks = parseSRT(srtText);
      if (srtBlocks.length === 0) { alert('No valid SRT blocks found.'); return; }

      // Load per-device display settings from localStorage
      const ds = getLocalSettings();
      if (ds.fontSize) settings.fontSize = ds.fontSize;
      if (ds.lineHeight) settings.lineHeight = ds.lineHeight;
      if (ds.margin) settings.margin = ds.margin;
      if (ds.fontFamily) settings.fontFamily = ds.fontFamily;
      if (ds.highlightColor) settings.highlightColor = ds.highlightColor;
      if (ds.pauseAfterSentence !== undefined) settings.pauseAfterSentence = ds.pauseAfterSentence;
      if (ds.autoTurnLong !== undefined) settings.autoTurnLong = ds.autoTurnLong;
      applySettings();

      // Set audio source (streams from Cloudinary)
      audioEl.src = book.mp3Url;
      await new Promise((resolve, reject) => {
        audioEl.addEventListener('loadedmetadata', resolve, { once: true });
        audioEl.addEventListener('error', reject, { once: true });
      });

      // Load progress from Firebase (shared across devices)
      const progress = (await fbGet(`users/${userPin}/progress/${id}`)) || {};
      if (progress.lastTime && progress.lastTime > 0) {
        audioEl.currentTime = progress.lastTime;
      }

      playerBar.style.display = 'block';
      emptyState.style.display = 'none';
      paginateContent();

      if (progress.lastPageIndex && progress.lastPageIndex < pages.length) {
        currentPage = progress.lastPageIndex;
      } else {
        currentPage = findPageForTime(audioEl.currentTime);
      }
      renderCurrentPage();
      startSyncLoop();
    } catch (err) {
      console.error('Load error:', err);
      alert('Failed to load audiobook: ' + err.message);
    }
  }

  function showEmptyState() {
    emptyState.style.display = 'flex';
    pageContent.innerHTML = '';
    playerBar.style.display = 'none';
    pageInfo.textContent = '';
  }

  /* ═══ PAGINATION ENGINE ═══ */
  function paginateContent() {
    pages = [];
    if (srtBlocks.length === 0) return;
    const container = $('pageContainer');
    const containerHeight = container.clientHeight
      - parseInt(getComputedStyle(container).paddingTop)
      - parseInt(getComputedStyle(container).paddingBottom);
    measureDiv.style.width = (container.clientWidth
      - parseInt(getComputedStyle(container).paddingLeft)
      - parseInt(getComputedStyle(container).paddingRight)) + 'px';
    measureDiv.style.fontFamily = settings.fontFamily;
    measureDiv.style.fontSize = settings.fontSize + 'px';
    measureDiv.style.lineHeight = String(settings.lineHeight);
    measureDiv.style.wordWrap = 'break-word';
    measureDiv.style.overflowWrap = 'break-word';

    let currentPageBlocks = [];
    let currentHeight = 0;
    for (let i = 0; i < srtBlocks.length; i++) {
      const block = srtBlocks[i];
      const blockHeight = measureBlockHeight(block.text);
      if (currentHeight + blockHeight <= containerHeight) {
        currentPageBlocks.push({
          blockIdx: i, text: block.text,
          isPartial: false, partIdx: 0, totalParts: 1
        });
        currentHeight += blockHeight;
      } else if (currentPageBlocks.length === 0) {
        const parts = splitBlockToFitPages(block.text, containerHeight);
        for (let p = 0; p < parts.length; p++) {
          pages.push([{
            blockIdx: i, text: parts[p],
            isPartial: parts.length > 1, partIdx: p, totalParts: parts.length
          }]);
        }
        currentHeight = 0;
        currentPageBlocks = [];
      } else {
        // Try to break at a sentence boundary (last block ending with . ? !)
        let breakAt = currentPageBlocks.length; // default: push all current blocks
        for (let j = currentPageBlocks.length - 1; j >= 1; j--) {
          const txt = currentPageBlocks[j - 1].text.trimEnd();
          if (/[.!?]$/.test(txt)) {
            breakAt = j;
            break;
          }
        }
        pages.push(currentPageBlocks.slice(0, breakAt));
        const remaining = currentPageBlocks.slice(breakAt);
        currentPageBlocks = [];
        currentHeight = 0;
        for (const item of remaining) {
          currentHeight += measureBlockHeight(item.text);
          currentPageBlocks.push(item);
        }
        i--;
      }
    }
    if (currentPageBlocks.length > 0) pages.push([...currentPageBlocks]);
  }

  function measureBlockHeight(text) {
    measureDiv.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'srt-block';
    el.style.marginBottom = '0.4em';
    el.style.padding = '4px 8px';
    el.style.borderLeft = '3px solid transparent';
    el.textContent = text;
    measureDiv.appendChild(el);
    const marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0;
    return el.offsetHeight + marginBottom;
  }

  function splitBlockToFitPages(text, maxHeight) {
    // Split text into sentences (keeping the delimiter attached)
    const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
    // If last part was missed (no ending punctuation), add remainder
    const joined = sentences.join('');
    if (joined.length < text.length) {
      sentences.push(text.slice(joined.length));
    }

    const parts = [];
    let currentPart = '';
    for (let i = 0; i < sentences.length; i++) {
      const candidate = currentPart ? currentPart + sentences[i] : sentences[i];
      if (measureBlockHeight(candidate) <= maxHeight) {
        currentPart = candidate;
      } else {
        // Push what we have so far (if anything)
        if (currentPart.trim()) {
          parts.push(currentPart.trim());
        }
        // Check if this single sentence fits on its own
        if (measureBlockHeight(sentences[i]) <= maxHeight) {
          currentPart = sentences[i];
        } else {
          // Single sentence too long — fall back to word splitting
          const words = sentences[i].split(/\s+/);
          let wStart = 0;
          while (wStart < words.length) {
            let lo = 1, hi = words.length - wStart, best = 1;
            while (lo <= hi) {
              const mid = Math.floor((lo + hi) / 2);
              const testText = words.slice(wStart, wStart + mid).join(' ');
              if (measureBlockHeight(testText) <= maxHeight) { best = mid; lo = mid + 1; }
              else { hi = mid - 1; }
            }
            if (best < 1) best = 1;
            parts.push(words.slice(wStart, wStart + best).join(' '));
            wStart += best;
          }
          currentPart = '';
        }
      }
    }
    if (currentPart.trim()) parts.push(currentPart.trim());
    return parts;
  }

  /* ═══ PAGE RENDERING ═══ */
  function renderCurrentPage() {
    if (pages.length === 0) { pageContent.innerHTML = ''; pageInfo.textContent = ''; return; }
    if (currentPage < 0) currentPage = 0;
    if (currentPage >= pages.length) currentPage = pages.length - 1;
    const pg = pages[currentPage];
    pageContent.innerHTML = '';
    pg.forEach(item => {
      const div = document.createElement('div');
      div.className = 'srt-block';
      div.dataset.blockIdx = item.blockIdx;
      const span = document.createElement('span');
      span.className = 'srt-text';
      span.textContent = item.text;
      div.appendChild(span);
      pageContent.appendChild(div);
    });
    pageContent.classList.remove('fade-in');
    void pageContent.offsetWidth;
    pageContent.classList.add('fade-in');
    pageInfo.textContent = `Page ${currentPage + 1} / ${pages.length}`;
    updateHighlight();
    markProgressDirty();
  }

  function updateHighlight() {
    const activeIdx = findActiveBlockIndex(audioEl.currentTime);
    const blockEls = pageContent.querySelectorAll('.srt-block');
    blockEls.forEach(el => {
      const idx = parseInt(el.dataset.blockIdx, 10);
      const isActive = idx === activeIdx;
      el.classList.toggle('active', isActive);
      const span = el.querySelector('.srt-text');
      if (span) span.classList.toggle('active', isActive);
    });
  }

  /* ═══ PAGE NAVIGATION ═══ */
  function goToPage(n) {
    if (n < 0 || n >= pages.length) return;
    currentPage = n;
    renderCurrentPage();
  }
  prevPageBtn.addEventListener('click', () => goToPage(currentPage - 1));
  nextPageBtn.addEventListener('click', () => goToPage(currentPage + 1));

  /* ═══ READ-ALONG SYNC ═══ */
  function findActiveBlockIndex(time) {
    let lo = 0, hi = srtBlocks.length - 1, result = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (srtBlocks[mid].startTime <= time) { result = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (result >= 0 && time <= srtBlocks[result].endTime) return result;
    if (result >= 0) return result;
    return -1;
  }

  function findPageForBlock(blockIdx) {
    for (let i = 0; i < pages.length; i++) {
      for (const item of pages[i]) { if (item.blockIdx === blockIdx) return i; }
    }
    return 0;
  }

  function findPageForTime(time) {
    const blockIdx = findActiveBlockIndex(time);
    if (blockIdx < 0) return 0;
    return findPageForBlockWithSubpage(blockIdx, time);
  }

  function findPageForBlockWithSubpage(blockIdx, time) {
    const blockPages = [];
    for (let i = 0; i < pages.length; i++) {
      for (const item of pages[i]) {
        if (item.blockIdx === blockIdx) blockPages.push({ pageIdx: i, item });
      }
    }
    if (blockPages.length === 0) return 0;
    if (blockPages.length === 1) return blockPages[0].pageIdx;
    if (settings.autoTurnLong) {
      const block = srtBlocks[blockIdx];
      const duration = block.endTime - block.startTime;
      if (duration <= 0) return blockPages[0].pageIdx;
      const elapsed = time - block.startTime;
      const proportion = Math.min(Math.max(elapsed / duration, 0), 0.999);
      const subPageIdx = Math.floor(proportion * blockPages.length);
      return blockPages[Math.min(subPageIdx, blockPages.length - 1)].pageIdx;
    }
    return blockPages[0].pageIdx;
  }

  function syncLoop() {
    if (!audioEl.paused && !isSeeking) {
      const time = audioEl.currentTime;
      const blockIdx = findActiveBlockIndex(time);
      if (blockIdx >= 0) {
        const targetPage = findPageForBlockWithSubpage(blockIdx, time);
        if (targetPage !== currentPage) { currentPage = targetPage; renderCurrentPage(); }
        else { updateHighlight(); }
        if (settings.pauseAfterSentence && blockIdx >= 0) {
          const block = srtBlocks[blockIdx];
          if (time >= block.endTime - 0.05) {
            const now = performance.now();
            if (now - pauseGuardTime > 500) {
              audioEl.pause(); pauseGuardTime = now; updatePlayPauseBtn();
            }
          }
        }
      }
      updateProgressDisplay();
    }
    animFrameId = requestAnimationFrame(syncLoop);
  }

  function startSyncLoop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = requestAnimationFrame(syncLoop);
  }

  /* ═══ PLAYBACK CONTROLS ═══ */
  playPauseBtn.addEventListener('click', togglePlayPause);
  function togglePlayPause() {
    if (!currentBookId) return;
    if (audioEl.paused) audioEl.play(); else audioEl.pause();
    updatePlayPauseBtn();
  }
  function updatePlayPauseBtn() {
    playPauseBtn.textContent = audioEl.paused ? '▶' : '⏸';
  }
  audioEl.addEventListener('play', updatePlayPauseBtn);
  audioEl.addEventListener('pause', updatePlayPauseBtn);

  seekBar.addEventListener('input', () => {
    isSeeking = true;
    const ratio = seekBar.value / 1000;
    if (audioEl.duration) audioEl.currentTime = ratio * audioEl.duration;
  });
  seekBar.addEventListener('change', () => {
    isSeeking = false;
    const targetPage = findPageForTime(audioEl.currentTime);
    if (targetPage !== currentPage) { currentPage = targetPage; renderCurrentPage(); }
    updateProgressDisplay();
  });

  progressBarContainer.addEventListener('click', e => {
    if (!audioEl.duration) return;
    const rect = progressBarContainer.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioEl.currentTime = ratio * audioEl.duration;
    const targetPage = findPageForTime(audioEl.currentTime);
    if (targetPage !== currentPage) { currentPage = targetPage; renderCurrentPage(); }
    updateProgressDisplay();
  });

  audioEl.addEventListener('timeupdate', () => {
    if (!isSeeking && audioEl.duration) seekBar.value = (audioEl.currentTime / audioEl.duration) * 1000;
    updateProgressDisplay();
  });

  function updateProgressDisplay() {
    if (!audioEl.duration) return;
    const cur = audioEl.currentTime, dur = audioEl.duration;
    timeDisplay.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    progressPercent.textContent = (cur / dur * 100).toFixed(1) + '%';
    progressBarFill.style.width = (cur / dur * 100) + '%';
  }

  function fmtTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  /* ═══ SENTENCE NAVIGATION ═══ */
  function jumpToBlock(blockIdx) {
    if (blockIdx < 0 || blockIdx >= srtBlocks.length) return;
    audioEl.currentTime = srtBlocks[blockIdx].startTime;
    pauseGuardTime = 0;
    const targetPage = findPageForBlock(blockIdx);
    if (targetPage !== currentPage) { currentPage = targetPage; renderCurrentPage(); }
    else { updateHighlight(); }
    if (audioEl.paused) { audioEl.play(); updatePlayPauseBtn(); }
    updateProgressDisplay();
  }
  function prevSentence() {
    const idx = findActiveBlockIndex(audioEl.currentTime);
    if (idx > 0) jumpToBlock(idx - 1); else if (idx === 0) jumpToBlock(0);
  }
  function currentSentenceRepeat() {
    const idx = findActiveBlockIndex(audioEl.currentTime);
    if (idx >= 0) jumpToBlock(idx);
  }
  function nextSentence() {
    const idx = findActiveBlockIndex(audioEl.currentTime);
    if (idx < srtBlocks.length - 1) jumpToBlock(idx + 1);
  }

  /* ═══ KEYBOARD SHORTCUTS ═══ */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    switch (e.key.toLowerCase()) {
      case 'a': e.preventDefault(); prevSentence(); break;
      case 's': e.preventDefault(); currentSentenceRepeat(); break;
      case 'd': e.preventDefault(); nextSentence(); break;
      case ' ': e.preventDefault(); togglePlayPause(); break;
      case 'arrowleft': e.preventDefault(); goToPage(currentPage - 1); break;
      case 'arrowright': e.preventDefault(); goToPage(currentPage + 1); break;
    }
  });

  /* ═══ SETTINGS ═══ */
  settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('open'));
  closeSettings.addEventListener('click', () => settingsPanel.classList.remove('open'));

  function applySettings() {
    document.documentElement.style.setProperty('--reader-font-size', settings.fontSize + 'px');
    document.documentElement.style.setProperty('--reader-line-height', String(settings.lineHeight));
    document.documentElement.style.setProperty('--reader-margin', settings.margin + 'px');
    document.documentElement.style.setProperty('--font-reader', settings.fontFamily);
    const hc = HIGHLIGHT_COLORS[settings.highlightColor] || HIGHLIGHT_COLORS.yellow;
    document.documentElement.style.setProperty('--highlight-bg', hc.bg);
    document.documentElement.style.setProperty('--highlight-border', hc.border);
    fontSizeSlider.value = settings.fontSize;
    fontSizeVal.textContent = settings.fontSize + 'px';
    lineHeightSlider.value = settings.lineHeight;
    lineHeightVal.textContent = settings.lineHeight.toFixed(1);
    marginSlider.value = settings.margin;
    marginVal.textContent = settings.margin + 'px';
    fontFamilySelect.value = settings.fontFamily;
    highlightColorSelect.value = settings.highlightColor;
    togglePauseAfter.classList.toggle('on', settings.pauseAfterSentence);
    toggleAutoTurnLong.classList.toggle('on', settings.autoTurnLong);
  }

  function onSettingChange() {
    settings.fontSize = parseInt(fontSizeSlider.value, 10);
    settings.lineHeight = parseFloat(lineHeightSlider.value);
    settings.margin = parseInt(marginSlider.value, 10);
    settings.fontFamily = fontFamilySelect.value;
    settings.highlightColor = highlightColorSelect.value;
    fontSizeVal.textContent = settings.fontSize + 'px';
    lineHeightVal.textContent = settings.lineHeight.toFixed(1);
    marginVal.textContent = settings.margin + 'px';
    applySettings();
    if (srtBlocks.length > 0) {
      const currentBlockIdx = pages[currentPage] ? pages[currentPage][0].blockIdx : 0;
      paginateContent();
      currentPage = findPageForBlock(currentBlockIdx);
      renderCurrentPage();
    }
    saveDeviceSettings();
  }

  fontSizeSlider.addEventListener('input', onSettingChange);
  lineHeightSlider.addEventListener('input', onSettingChange);
  marginSlider.addEventListener('input', onSettingChange);
  fontFamilySelect.addEventListener('change', onSettingChange);
  highlightColorSelect.addEventListener('change', onSettingChange);

  togglePauseAfter.addEventListener('click', () => {
    settings.pauseAfterSentence = !settings.pauseAfterSentence;
    togglePauseAfter.classList.toggle('on', settings.pauseAfterSentence);
    pauseGuardTime = 0;
    saveDeviceSettings();
  });
  toggleAutoTurnLong.addEventListener('click', () => {
    settings.autoTurnLong = !settings.autoTurnLong;
    toggleAutoTurnLong.classList.toggle('on', settings.autoTurnLong);
    saveDeviceSettings();
  });

  function saveDeviceSettings() {
    setLocalSettings({
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      margin: settings.margin,
      fontFamily: settings.fontFamily,
      highlightColor: settings.highlightColor,
      pauseAfterSentence: settings.pauseAfterSentence,
      autoTurnLong: settings.autoTurnLong
    });
  }

  /* Add Change PIN button to settings panel */
  const changePinDiv = document.createElement('div');
  changePinDiv.style.cssText = 'margin-top:32px;padding-top:16px;border-top:1px solid var(--border);';
  changePinDiv.innerHTML = '<button class="btn-ghost" id="changePinBtn" style="width:100%">🔗 Change Sync PIN</button>';
  settingsPanel.appendChild(changePinDiv);
  $('changePinBtn').addEventListener('click', () => {
    localStorage.removeItem('ra_pin');
    userPin = null;
    currentBookId = null;
    srtBlocks = []; pages = []; currentPage = 0;
    audioEl.pause(); audioEl.src = '';
    showEmptyState();
    refreshLibraryUI();
    settingsPanel.classList.remove('open');
    showPinModal();
  });

  /* ═══ PROGRESS SAVE/RESTORE (Firebase — shared across devices) ═══ */
  function markProgressDirty() { progressDirty = true; }

  async function flushProgress() {
    if (!progressDirty || !currentBookId || !userPin) return;
    progressDirty = false;
    await fbPut(`users/${userPin}/progress/${currentBookId}`, {
      lastTime: audioEl.currentTime || 0,
      lastPageIndex: currentPage,
      lastUpdated: Date.now()
    });
  }

  setInterval(() => {
    if (currentBookId && progressDirty) flushProgress();
  }, 3000);

  window.addEventListener('beforeunload', () => {
    if (currentBookId && userPin) {
      const url = `${FIREBASE_URL}/users/${userPin}/progress/${currentBookId}.json`;
      const data = JSON.stringify({
        lastTime: audioEl.currentTime || 0,
        lastPageIndex: currentPage,
        lastUpdated: Date.now()
      });
      fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true });
    }
  });

  /* ═══ WINDOW RESIZE ═══ */
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (srtBlocks.length > 0) {
        const currentBlockIdx = pages[currentPage] ? pages[currentPage][0].blockIdx : 0;
        paginateContent();
        currentPage = findPageForBlock(currentBlockIdx);
        renderCurrentPage();
      }
    }, 200);
  });

  /* ═══ INIT ═══ */
  async function init() {
    userPin = localStorage.getItem('ra_pin');
    if (!userPin) {
      showPinModal();
    } else {
      await loadLibrary();
    }
  }

  init();
})();
