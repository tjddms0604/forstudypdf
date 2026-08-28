'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const state = {
  pdfDoc: null,
  originalBytes: null,
  fileName: '',
  scale: 1.25,
  annotations: [], // { id, pageNum, pdfPoint: {x,y}, memo, aiExplanation, aiStatus }
};

const els = {
  fileInput: document.getElementById('fileInput'),
  fileNameLabel: document.getElementById('fileNameLabel'),
  viewer: document.getElementById('viewer'),
  sidebar: document.getElementById('sidebar'),
  sidebarList: document.getElementById('sidebarList'),
  toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
  saveBtn: document.getElementById('saveBtn'),
  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomLabel: document.getElementById('zoomLabel'),
  pageJumpInput: document.getElementById('pageJumpInput'),
  totalPagesLabel: document.getElementById('totalPagesLabel'),
  popup: document.getElementById('memoPopup'),
  popover: document.getElementById('notePopover'),
};

let pendingClick = null;
let openPopoverId = null;
let hasUnsavedChanges = false;

// Warn before leaving the page if there are memos that haven't been saved to a PDF yet.
// Browsers don't allow a custom dialog/button here — only their own native
// "leave site? unsaved changes" confirm prompt can be triggered.
window.addEventListener('beforeunload', (e) => {
  if (!hasUnsavedChanges) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---------- File loading ----------

els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  state.fileName = file.name;
  els.fileNameLabel.textContent = file.name;

  const buf = await file.arrayBuffer();
  state.originalBytes = buf.slice(0);
  state.annotations = [];
  openPopoverId = null;
  els.popover.style.display = 'none';
  hasUnsavedChanges = false;

  els.viewer.innerHTML = '<p class="empty-hint">불러오는 중...</p>';

  const loadingTask = pdfjsLib.getDocument({ data: buf.slice(0) });
  state.pdfDoc = await loadingTask.promise;

  els.totalPagesLabel.textContent = String(state.pdfDoc.numPages);
  els.pageJumpInput.max = String(state.pdfDoc.numPages);

  await importExistingAnnotations();
  await renderAllPages();
  renderSidebar();
  updateCurrentPageIndicator();
});

// ---------- Importing annotations already present in the PDF ----------

const MEMO_MARKER = '[내 메모]\n';
const AI_MARKER = '\n\n[AI 설명]\n';
const NOTE_SUBTYPES = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut']);

function parseAnnotationContents(raw) {
  const text = (raw || '').trim();
  if (text.startsWith(MEMO_MARKER)) {
    const aiIdx = text.indexOf(AI_MARKER);
    if (aiIdx !== -1) {
      return {
        memo: text.slice(MEMO_MARKER.length, aiIdx).trim(),
        aiExplanation: text.slice(aiIdx + AI_MARKER.length).trim(),
        aiStatus: 'done',
      };
    }
    return { memo: text.slice(MEMO_MARKER.length).trim(), aiExplanation: '', aiStatus: 'idle' };
  }
  // Not our own format (e.g. an annotation made in another PDF reader) — treat
  // the whole thing as the memo text, ready to have an AI explanation added.
  return { memo: text, aiExplanation: '', aiStatus: 'idle' };
}

async function importExistingAnnotations() {
  let counter = 0;
  for (let pageNum = 1; pageNum <= state.pdfDoc.numPages; pageNum++) {
    const page = await state.pdfDoc.getPage(pageNum);
    const pdfAnnotations = await page.getAnnotations();

    pdfAnnotations.forEach((pdfAnn) => {
      const contentsStr = pdfAnn.contentsObj && pdfAnn.contentsObj.str;
      if (!contentsStr || !contentsStr.trim()) return;
      if (!NOTE_SUBTYPES.has(pdfAnn.subtype)) return;
      if (!Array.isArray(pdfAnn.rect) || pdfAnn.rect.length !== 4) return;

      const { memo, aiExplanation, aiStatus } = parseAnnotationContents(contentsStr);
      if (!memo) return;

      const [x1, y1, x2, y2] = pdfAnn.rect;
      counter += 1;

      state.annotations.push({
        id: 'imported-' + pageNum + '-' + counter,
        pageNum,
        pdfPoint: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
        memo,
        aiExplanation,
        aiStatus,
        imported: true,
        importedRect: pdfAnn.rect,
        importedOriginalContents: contentsStr.trim(),
        importedSnapshot: { aiStatus, aiExplanation },
      });
    });
  }
}

// ---------- Rendering ----------

async function renderAllPages() {
  closeMemoPopup();
  closeNotePopover();
  els.viewer.innerHTML = '';
  const numPages = state.pdfDoc.numPages;
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    await renderPage(pageNum);
  }
}

async function renderPage(pageNum) {
  const page = await state.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: state.scale });

  const pageContainer = document.createElement('div');
  pageContainer.className = 'page-container';
  pageContainer.style.width = viewport.width + 'px';
  pageContainer.style.height = viewport.height + 'px';
  pageContainer.dataset.pageNumber = String(pageNum);
  pageContainer._viewport = viewport;

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  pageContainer.appendChild(canvas);

  const highlightLayerDiv = document.createElement('div');
  highlightLayerDiv.className = 'highlightLayer';
  pageContainer.appendChild(highlightLayerDiv);
  pageContainer._highlightLayer = highlightLayerDiv;

  els.viewer.appendChild(pageContainer);

  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
    openMemoPopup({
      pageNum,
      pageContainer,
      pdfPoint: { x: pdfX, y: pdfY },
      localX: x,
      localY: y,
    });
  });

  drawHighlightsForPage(pageNum);
}

async function applyZoom(nextScale) {
  state.scale = Math.min(3, Math.max(0.5, nextScale));
  els.zoomLabel.textContent = Math.round((state.scale / 1.25) * 100) + '%';
  await renderAllPages();
  updateCurrentPageIndicator();
}

els.zoomInBtn.addEventListener('click', () => {
  if (!state.pdfDoc) return;
  applyZoom(state.scale + 0.15);
});

els.zoomOutBtn.addEventListener('click', () => {
  if (!state.pdfDoc) return;
  applyZoom(state.scale - 0.15);
});

// Ctrl + wheel to zoom
let wheelZoomTimer = null;
els.viewer.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey || !state.pdfDoc) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    state.scale = Math.min(3, Math.max(0.5, state.scale + delta));
    els.zoomLabel.textContent = Math.round((state.scale / 1.25) * 100) + '%';
    clearTimeout(wheelZoomTimer);
    wheelZoomTimer = setTimeout(() => {
      renderAllPages().then(updateCurrentPageIndicator);
    }, 150);
  },
  { passive: false }
);

// ---------- Current page indicator ----------

els.viewer.addEventListener('scroll', () => {
  window.requestAnimationFrame(updateCurrentPageIndicator);
});

function updateCurrentPageIndicator() {
  if (!state.pdfDoc) return;
  const containers = Array.from(els.viewer.querySelectorAll('.page-container'));
  if (!containers.length) return;

  const viewerRect = els.viewer.getBoundingClientRect();
  const mid = viewerRect.top + viewerRect.height / 2;

  let current = 1;
  for (const c of containers) {
    const r = c.getBoundingClientRect();
    if (r.top <= mid) current = Number(c.dataset.pageNumber);
  }

  if (document.activeElement !== els.pageJumpInput) {
    els.pageJumpInput.value = String(current);
  }
}

function jumpToPage(pageNum) {
  if (!state.pdfDoc) return;
  const clamped = Math.min(state.pdfDoc.numPages, Math.max(1, pageNum));
  const pageContainer = els.viewer.querySelector(
    `.page-container[data-page-number="${clamped}"]`
  );
  if (pageContainer) pageContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.pageJumpInput.value = String(clamped);
}

els.pageJumpInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  jumpToPage(Number(els.pageJumpInput.value));
  els.pageJumpInput.blur();
});

els.pageJumpInput.addEventListener('blur', () => {
  if (els.pageJumpInput.value) jumpToPage(Number(els.pageJumpInput.value));
});

// ---------- Click -> memo popup ----------

function openMemoPopup({ pageNum, pageContainer, pdfPoint, localX, localY }) {
  closeNotePopover();
  pendingClick = { pageNum, pdfPoint };
  pageContainer.appendChild(els.popup);
  els.popup.style.top = localY + 12 + 'px';
  els.popup.style.left = Math.max(0, localX - 150) + 'px';
  els.popup.style.display = 'block';
  const textarea = els.popup.querySelector('textarea');
  textarea.value = '';
  textarea.focus();
}

function closeMemoPopup() {
  els.popup.style.display = 'none';
  pendingClick = null;
}

els.popup.querySelector('.btn-cancel').addEventListener('click', closeMemoPopup);

els.popup.querySelector('textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.popup.querySelector('.btn-save').click();
  }
});

els.popup.querySelector('.btn-save').addEventListener('click', async () => {
  if (!pendingClick) return;
  const memo = els.popup.querySelector('textarea').value.trim();
  const click = pendingClick;
  closeMemoPopup();

  if (!memo) return;

  const id = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const annotation = {
    id,
    pageNum: click.pageNum,
    pdfPoint: click.pdfPoint,
    memo,
    aiExplanation: '',
    aiStatus: 'loading',
  };
  state.annotations.push(annotation);
  hasUnsavedChanges = true;
  drawHighlightForAnnotation(annotation);
  renderSidebar();

  const pos = annotationScreenPos(annotation);
  if (pos) showNotePopover(annotation.id, pos.pageContainer, pos.x, pos.y);

  await requestAiExplanation(annotation);
  renderSidebar();
  renderNotePopover();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (pendingClick) closeMemoPopup();
  if (openPopoverId) closeNotePopover();
});

async function triggerAiExplanation(ann) {
  ann.aiStatus = 'loading';
  hasUnsavedChanges = true;
  renderSidebar();
  renderNotePopover();
  await requestAiExplanation(ann);
  renderSidebar();
  renderNotePopover();
}

async function requestAiExplanation(annotation) {
  try {
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memo: annotation.memo }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
    annotation.aiExplanation = data.explanation;
    annotation.aiStatus = 'done';
  } catch (err) {
    annotation.aiStatus = 'error';
    annotation.aiExplanation = 'AI 설명을 가져오지 못했습니다: ' + err.message;
  }
}

// ---------- Pin drawing & note popover ----------

function annotationScreenPos(ann) {
  const pageContainer = els.viewer.querySelector(
    `.page-container[data-page-number="${ann.pageNum}"]`
  );
  if (!pageContainer) return null;
  const [x, y] = pageContainer._viewport.convertToViewportPoint(ann.pdfPoint.x, ann.pdfPoint.y);
  return { pageContainer, x, y };
}

function drawHighlightForAnnotation(ann) {
  const pos = annotationScreenPos(ann);
  if (!pos) return;
  const { pageContainer, x, y } = pos;
  const layer = pageContainer._highlightLayer;

  const div = document.createElement('div');
  div.className = 'pin-mark';
  div.style.left = x + 'px';
  div.style.top = y + 'px';
  div.dataset.noteId = ann.id;
  div.title = ann.memo || '';
  div.addEventListener('click', (e) => {
    e.stopPropagation();
    showNotePopover(ann.id, pageContainer, x, y);
  });
  layer.appendChild(div);
}

function drawHighlightsForPage(pageNum) {
  state.annotations.filter((a) => a.pageNum === pageNum).forEach(drawHighlightForAnnotation);
}

function showNotePopover(id, pageContainer, localX, localY) {
  closeMemoPopup();
  openPopoverId = id;
  pageContainer.appendChild(els.popover);
  els.popover.style.top = localY + 12 + 'px';
  els.popover.style.left = Math.max(0, localX - 140) + 'px';
  renderNotePopover();
}

function closeNotePopover() {
  openPopoverId = null;
  els.popover.style.display = 'none';
}

function renderNotePopover() {
  if (!openPopoverId) {
    els.popover.style.display = 'none';
    return;
  }
  const ann = state.annotations.find((a) => a.id === openPopoverId);
  if (!ann) {
    closeNotePopover();
    return;
  }

  const aiBody = aiStatusBody(ann);

  els.popover.innerHTML = `
    <div class="popover-header">
      <span class="note-page">p.${ann.pageNum}</span>
      <button class="popover-close" title="닫기">×</button>
    </div>
    <div class="popover-memo">${escapeHtml(ann.memo)}</div>
    <div class="note-ai ${ann.aiStatus}">${aiBody}</div>
    <button class="popover-delete">이 메모 삭제</button>
  `;
  els.popover.style.display = 'block';

  els.popover.querySelector('.popover-close').addEventListener('click', closeNotePopover);
  els.popover.querySelector('.popover-delete').addEventListener('click', () => {
    deleteAnnotation(ann.id);
    closeNotePopover();
  });
  const requestBtn = els.popover.querySelector('.request-ai-btn');
  if (requestBtn) requestBtn.addEventListener('click', () => triggerAiExplanation(ann));
}

function aiStatusBody(ann) {
  if (ann.aiStatus === 'loading') return '<span class="spinner"></span>AI 설명 생성 중...';
  if (ann.aiStatus === 'done') return '<span class="ai-tag">AI</span>' + escapeHtml(ann.aiExplanation);
  if (ann.aiStatus === 'error') return escapeHtml(ann.aiExplanation);
  return '<button class="request-ai-btn">AI 설명 요청</button>';
}

document.addEventListener('click', (e) => {
  if (!openPopoverId) return;
  if (
    els.popover.contains(e.target) ||
    els.popup.contains(e.target) ||
    e.target.closest('.pin-mark')
  ) {
    return;
  }
  closeNotePopover();
});

// ---------- Sidebar ----------

els.toggleSidebarBtn.addEventListener('click', () => {
  els.sidebar.classList.toggle('collapsed');
});

function renderSidebar() {
  els.sidebarList.innerHTML = '';
  if (!state.annotations.length) {
    els.sidebarList.innerHTML = '<p class="empty-hint">아직 남긴 메모가 없습니다.</p>';
    return;
  }

  state.annotations
    .slice()
    .sort((a, b) => a.pageNum - b.pageNum)
    .forEach((ann) => {
      const card = document.createElement('div');
      card.className = 'note-card';
      card.dataset.noteId = ann.id;

      const aiBody = aiStatusBody(ann);

      card.innerHTML = `
        <div class="note-header">
          <span class="note-page">p.${ann.pageNum}</span>
          <button class="note-delete" title="삭제">×</button>
        </div>
        <div class="note-memo">${escapeHtml(ann.memo)}</div>
        <div class="note-ai ${ann.aiStatus}">${aiBody}</div>
      `;

      card.querySelector('.note-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAnnotation(ann.id);
      });

      const requestBtn = card.querySelector('.request-ai-btn');
      if (requestBtn) {
        requestBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          triggerAiExplanation(ann);
        });
      }

      card.addEventListener('click', () => {
        const pageContainer = els.viewer.querySelector(
          `.page-container[data-page-number="${ann.pageNum}"]`
        );
        if (pageContainer) pageContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      els.sidebarList.appendChild(card);
    });
}

function deleteAnnotation(id) {
  state.annotations = state.annotations.filter((a) => a.id !== id);
  hasUnsavedChanges = true;
  document.querySelectorAll(`.pin-mark[data-note-id="${id}"]`).forEach((el) => el.remove());
  if (openPopoverId === id) closeNotePopover();
  renderSidebar();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Save as annotated PDF ----------

els.saveBtn.addEventListener('click', saveAnnotatedPdf);

async function saveAnnotatedPdf() {
  if (!state.originalBytes) {
    alert('먼저 PDF를 불러오세요.');
    return;
  }

  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString } = PDFLib;
  const pdfDoc = await PDFDocument.load(state.originalBytes.slice(0));
  const pages = pdfDoc.getPages();
  const context = pdfDoc.context;

  function buildContents(ann) {
    const parts = ['[내 메모]\n' + ann.memo];
    if (ann.aiExplanation && ann.aiStatus === 'done') {
      parts.push('[AI 설명]\n' + ann.aiExplanation);
    }
    return parts.join('\n\n');
  }

  function findMatchingAnnotDict(page, rect, originalContents) {
    const annotsArray = page.node.lookup(PDFName.of('Annots'));
    if (!(annotsArray instanceof PDFArray)) return null;
    for (let i = 0; i < annotsArray.size(); i++) {
      const dict = context.lookup(annotsArray.get(i));
      if (!(dict instanceof PDFDict)) continue;
      const rectObj = dict.lookup(PDFName.of('Rect'));
      const contentsObj = dict.lookup(PDFName.of('Contents'));
      if (!rectObj || !contentsObj) continue;
      const rectNums = rectObj.asArray().map((n) => n.asNumber());
      const sameRect = rect.every((v, i2) => Math.abs(v - rectNums[i2]) < 0.01);
      if (sameRect && contentsObj.decodeText() === originalContents) {
        return dict;
      }
    }
    return null;
  }

  state.annotations.forEach((ann) => {
    const page = pages[ann.pageNum - 1];
    if (!page) return;

    const contents = buildContents(ann);

    if (ann.imported) {
      const unchanged =
        ann.aiStatus === ann.importedSnapshot.aiStatus &&
        ann.aiExplanation === ann.importedSnapshot.aiExplanation;
      if (unchanged) return; // leave the original annotation's bytes untouched

      const existingDict = findMatchingAnnotDict(page, ann.importedRect, ann.importedOriginalContents);
      if (existingDict) {
        existingDict.set(PDFName.of('Contents'), PDFHexString.fromText(contents));
        return;
      }
      // Couldn't find the original (e.g. file changed elsewhere) — fall through
      // and add it as a new annotation instead of silently dropping the note.
    }

    const { x, y } = ann.pdfPoint;
    const half = 11; // sticky-note icon half-size, in PDF points

    const noteDict = context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [x - half, y - half, x + half, y + half],
      Name: 'Comment',
      C: [1, 0.81, 0.25],
      Contents: PDFHexString.fromText(contents),
      T: PDFHexString.fromText('ForStudyPdf'),
    });
    const ref = context.register(noteDict);

    const existing = page.node.lookup(PDFName.of('Annots'));
    if (existing instanceof PDFArray) {
      existing.push(ref);
    } else {
      page.node.set(PDFName.of('Annots'), context.obj([ref]));
    }
  });

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  const baseName = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}_내주석_${stamp}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  hasUnsavedChanges = false;
  URL.revokeObjectURL(url);
}
