const ENGINE_VERSION = "2026-04-13-targeted-debug-1";

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || typeof tab.windowId !== "number") {
    throw new Error("No active tab found.");
  }
  return tab;
}

function isRestrictedUrl(url = "") {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  );
}

async function runInTab(tabId, func, args = [], target = {}) {
  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
      ...(target.allFrames ? { allFrames: true } : {}),
      ...(typeof target.frameIds?.length === "number" ? { frameIds: target.frameIds } : {})
    },
    func,
    args
  });

  return results;
}

async function runInSingleFrame(tabId, func, args = [], frameId = 0) {
  const [result] = await runInTab(tabId, func, args, { frameIds: [frameId] });
  return result?.result;
}

function pageSnapController(action, payload = {}) {
  const stateKey = "__pageSnapState";

  const waitForPaint = (extraFrames = 0) =>
    new Promise((resolve) => {
      const runFrame = (remaining) => {
        window.requestAnimationFrame(() => {
          if (remaining <= 0) {
            resolve();
            return;
          }
          runFrame(remaining - 1);
        });
      };
      runFrame(1 + extraFrames);
    });

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const describeElement = (element) => {
    if (!element) {
      return "unknown";
    }
    const tag = element.tagName?.toLowerCase?.() || "node";
    const id = element.id ? `#${element.id}` : "";
    const className =
      typeof element.className === "string"
        ? element.className
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 4)
            .map((name) => `.${name}`)
            .join("")
        : "";
    return `${tag}${id}${className}`;
  };

  const rectToPlainObject = (rect) => ({
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  });

  const intersectRectWithViewport = (rect) => {
    const left = clamp(rect.left, 0, window.innerWidth);
    const top = clamp(rect.top, 0, window.innerHeight);
    const right = clamp(rect.right, 0, window.innerWidth);
    const bottom = clamp(rect.bottom, 0, window.innerHeight);

    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  };

  const getExtendedDocumentHeight = () => {
    const doc = document.documentElement;
    const body = document.body;
    return Math.max(
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      body?.clientHeight || 0,
      doc?.scrollHeight || 0,
      doc?.offsetHeight || 0,
      doc?.clientHeight || 0
    );
  };

  const getFrameOffsetInTop = () => {
    let currentWindow = window;
    let left = 0;
    let top = 0;

    try {
      while (currentWindow !== currentWindow.top) {
        const frameElement = currentWindow.frameElement;
        if (!frameElement) {
          break;
        }
        const rect = frameElement.getBoundingClientRect();
        left += rect.left;
        top += rect.top;
        currentWindow = currentWindow.parent;
      }
    } catch (_error) {
      return { left: 0, top: 0, accessible: false };
    }

    return { left, top, accessible: true };
  };

  const getDocumentMetrics = () => {
    const doc = document.documentElement;
    const body = document.body;
    const scrollingElement = document.scrollingElement || doc;
    const docScrollHeight = doc?.scrollHeight || 0;
    const docClientHeight = window.innerHeight || doc?.clientHeight || 0;
    const bodyScrollHeight = body?.scrollHeight || 0;
    const bodyClientHeight = body?.clientHeight || 0;
    const fullHeight = getExtendedDocumentHeight();
    const maxScroll = Math.max(0, fullHeight - docClientHeight);

    return {
      bodyClientHeight,
      bodyDescriptor: describeElement(body),
      bodyScrollDelta: Math.max(0, bodyScrollHeight - bodyClientHeight),
      bodyScrollHeight,
      bodyScrollable: bodyScrollHeight - bodyClientHeight > 2,
      docClientHeight,
      docDescriptor: describeElement(doc),
      docScrollDelta: maxScroll,
      docScrollHeight,
      extendedDocumentHeight: fullHeight,
      rootDescriptor: describeElement(scrollingElement),
      windowScrollable: maxScroll > 2
    };
  };

  const canWindowActuallyScroll = () => {
    const scrollingElement = document.scrollingElement || document.documentElement;
    const maxScroll = Math.max(
      0,
      getExtendedDocumentHeight() - (window.innerHeight || document.documentElement.clientHeight || 0)
    );

    if (!scrollingElement || maxScroll < 2) {
      return {
        actuallyScrollable: false,
        clientHeight: window.innerHeight,
        descriptor: describeElement(document.documentElement),
        rootScrollableElement: describeElement(scrollingElement),
        scrollDelta: maxScroll,
        scrollHeight: getExtendedDocumentHeight()
      };
    }

    const originalTop = window.scrollY;
    const attempt = clamp(originalTop + Math.min(64, maxScroll || 64), 0, maxScroll);
    window.scrollTo(0, attempt);
    const movedTop = window.scrollY;
    window.scrollTo(0, originalTop);

    return {
      actuallyScrollable: movedTop !== originalTop || maxScroll > 0,
      clientHeight: window.innerHeight,
      descriptor: window.frameElement ? "frame-document" : describeElement(document.documentElement),
      rootScrollableElement: describeElement(scrollingElement),
      scrollDelta: maxScroll,
      scrollHeight: getExtendedDocumentHeight()
    };
  };

  const canElementActuallyScroll = (element) => {
    const rect = element.getBoundingClientRect();
    const scrollHeight = element.scrollHeight;
    const clientHeight = element.clientHeight;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);

    if (
      maxScroll < 2 ||
      rect.width < 40 ||
      rect.height < 40 ||
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > window.innerHeight ||
      rect.left > window.innerWidth
    ) {
      return {
        actuallyScrollable: false,
        clientHeight,
        descriptor: describeElement(element),
        rect,
        scrollDelta: maxScroll,
        scrollHeight
      };
    }

    const originalTop = element.scrollTop;
    const attempt = clamp(originalTop + Math.min(64, maxScroll || 64), 0, maxScroll);
    element.scrollTop = attempt;
    const movedTop = element.scrollTop;
    element.scrollTop = originalTop;

    return {
      actuallyScrollable: movedTop !== originalTop || maxScroll > 0,
      clientHeight,
      descriptor: describeElement(element),
      rect,
      scrollDelta: maxScroll,
      scrollHeight
    };
  };

  const buildScrollPositions = (viewportHeight, fullHeight) => {
    const maxScrollTop = Math.max(0, fullHeight - viewportHeight);
    const positions = [];

    for (let top = 0; top <= maxScrollTop; top += viewportHeight) {
      positions.push(Math.min(top, maxScrollTop));
    }

    if (positions.length === 0) {
      positions.push(0);
    }

    if (positions[positions.length - 1] !== maxScrollTop) {
      positions.push(maxScrollTop);
    }

    return [...new Set(positions)];
  };

  const candidateScore = (candidate) => {
    const area =
      Math.max(1, Math.round(candidate.rect?.width || window.innerWidth)) *
      Math.max(1, Math.round(candidate.rect?.height || window.innerHeight));
    const scrollDelta = Math.max(1, candidate.scrollDelta || 0);
    const viewportWidth = window.innerWidth || 1;
    const viewportHeight = window.innerHeight || 1;
    const rect = candidate.rect || {
      left: 0,
      top: 0,
      width: viewportWidth,
      height: viewportHeight
    };

    const coversViewport =
      rect.left <= 4 &&
      rect.top <= 4 &&
      rect.width >= viewportWidth * 0.96 &&
      rect.height >= viewportHeight * 0.96;
    const descriptor = candidate.descriptor || "";
    const shellLike =
      coversViewport &&
      /(main|body|page|layout|shell|workspace|content|root)/i.test(descriptor);
    const penalty = shellLike ? 0.35 : 1;

    return Math.round(area * scrollDelta * penalty);
  };

  const inspectTargets = (options = {}) => {
    const documentMetrics = getDocumentMetrics();
    const windowCandidate = canWindowActuallyScroll();
    const candidates = [];
    const rejectedCandidates = [];
    const candidateElements = new Map();

    if (windowCandidate.actuallyScrollable) {
      candidates.push({
        clientHeight: windowCandidate.clientHeight,
        descriptor: windowCandidate.descriptor,
        rect: {
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight
        },
        score: candidateScore(windowCandidate),
        scrollDelta: windowCandidate.scrollDelta,
        scrollHeight: windowCandidate.scrollHeight,
        targetKind: "document"
      });
    }

    for (const element of document.querySelectorAll("*")) {
      if (element === document.documentElement || element === document.body) {
        continue;
      }

      const inspection = canElementActuallyScroll(element);
      if (!inspection.actuallyScrollable) {
        if (inspection.scrollDelta > 0) {
          rejectedCandidates.push({
            clientHeight: inspection.clientHeight,
            descriptor: inspection.descriptor,
            reason: "cannot-actually-scroll",
            scrollDelta: inspection.scrollDelta,
            scrollHeight: inspection.scrollHeight
          });
        }
        continue;
      }

      const candidate = {
        clientHeight: inspection.clientHeight,
        descriptor: inspection.descriptor,
        rect: rectToPlainObject(inspection.rect),
        score: candidateScore(inspection),
        scrollDelta: inspection.scrollDelta,
        scrollHeight: inspection.scrollHeight,
        targetKind: "element"
      };
      candidates.push(candidate);
      candidateElements.set(candidate, element);
    }

    candidates.sort((left, right) => right.score - left.score);

    const target = candidates[0]
      ? {
          clientHeight: candidates[0].clientHeight,
          descriptor: candidates[0].descriptor,
          rect: candidates[0].rect,
          scrollDelta: candidates[0].scrollDelta,
          scrollHeight: candidates[0].scrollHeight,
          targetKind: candidates[0].targetKind
        }
      : null;

    const frameOffset = getFrameOffsetInTop();
    const visibleRect = target?.rect
      ? intersectRectWithViewport({
          left: target.rect.left,
          top: target.rect.top,
          right: target.rect.left + target.rect.width,
          bottom: target.rect.top + target.rect.height
        })
      : {
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight
        };
    const clip = target
      ? {
          left: Math.round(visibleRect.left + frameOffset.left),
          top: Math.round(visibleRect.top + frameOffset.top),
          width: Math.round(visibleRect.width || window.innerWidth),
          height: Math.round(visibleRect.height || window.innerHeight)
        }
      : {
          left: Math.round(frameOffset.left),
          top: Math.round(frameOffset.top),
          width: window.innerWidth,
          height: window.innerHeight
        };

    const viewportHeight = target?.clientHeight || window.innerHeight;
    const fullHeight = target?.scrollHeight || documentMetrics.extendedDocumentHeight;
    const mode =
      target?.targetKind === "element"
        ? "element"
        : window.frameElement
          ? "frame-document"
          : "document";

    const result = {
      candidates: candidates.slice(0, 8),
      clip,
      documentMetrics,
      fullHeight,
      mode,
      positions: buildScrollPositions(viewportHeight, fullHeight),
      rejectedCandidates: rejectedCandidates.slice(0, 8),
      target,
      viewportHeight,
      viewportWidth: clip.width
    };

    if (options.includeElement && target?.targetKind === "element") {
      const elementCandidate = candidates.find(
        (candidate) =>
          candidate.descriptor === target.descriptor &&
          candidate.targetKind === target.targetKind &&
          candidate.scrollHeight === target.scrollHeight
      );
      result.targetElement = elementCandidate ? candidateElements.get(elementCandidate) : null;
    }

    return result;
  };

  const collectFixedDiagnostics = () => {
    const diagnostics = {
      fixed: [],
      fixedFooter: [],
      fixedHeader: [],
      skipped: [],
      sticky: [],
      transformed: []
    };

    for (const element of document.querySelectorAll("*")) {
      const style = window.getComputedStyle(element);
      if (style.position !== "fixed" && style.position !== "sticky") {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const item = {
        bounds: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        descriptor: describeElement(element)
      };

      if (style.position === "sticky") {
        diagnostics.sticky.push(item);
        continue;
      }

      diagnostics.fixed.push(item);
      if (rect.top <= 2) {
        diagnostics.fixedHeader.push(item);
      } else if (rect.bottom >= window.innerHeight - 2) {
        diagnostics.fixedFooter.push(item);
      }
    }

    return diagnostics;
  };

  if (action === "inspect") {
    return waitForPaint().then(() => inspectTargets());
  }

  if (action === "prepare") {
    const inspection = inspectTargets({ includeElement: true });
    const doc = document.documentElement;
    const body = document.body;

    if (!body) {
      throw new Error("This page is not ready to capture.");
    }

    const isTopDocument = inspection.mode === "document" && !window.frameElement;
    const fixedElements = [];

    if (isTopDocument) {
      for (const element of document.querySelectorAll("*")) {
        const style = window.getComputedStyle(element);
        if (style.position === "fixed" || style.position === "sticky") {
          fixedElements.push({
            element,
            visibility: element.style.visibility
          });
          element.style.visibility = "hidden";
        }
      }
    }

    window[stateKey] = {
      bodyScrollBehavior: body.style.scrollBehavior,
      docScrollBehavior: doc.style.scrollBehavior,
      fixedElements,
      originalScrollX: window.scrollX,
      originalScrollY: window.scrollY,
      targetDescriptor: inspection.target?.descriptor || inspection.mode,
      targetElement: inspection.targetElement || null,
      targetKind: inspection.target?.targetKind || "document"
    };

    body.style.scrollBehavior = "auto";
    doc.style.scrollBehavior = "auto";

    return waitForPaint(1).then(() => {
      const { targetElement: _targetElement, ...serializableInspection } = inspection;
      return {
        ...serializableInspection,
        devicePixelRatio: window.devicePixelRatio || 1
      };
    });
  }

  if (action === "scroll") {
    const state = window[stateKey];
    if (!state) {
      throw new Error("Capture state is missing.");
    }

    const top = Number(payload.top) || 0;
    if (state.targetKind === "element" && state.targetElement) {
      state.targetElement.scrollTop = top;
      return waitForPaint(1).then(() => state.targetElement.scrollTop);
    }

    window.scrollTo(0, top);
    return waitForPaint(1).then(() => window.scrollY);
  }

  if (action === "measure-current") {
    const state = window[stateKey];
    const currentTop =
      state?.targetKind === "element" && state.targetElement
        ? state.targetElement.scrollTop
        : window.scrollY;
    const inspection = inspectTargets();

    return {
      currentTop,
      fullHeight: inspection.fullHeight,
      viewportHeight: inspection.viewportHeight
    };
  }

  if (action === "before-capture") {
    return waitForPaint(1).then(() => ({
      fixedDiagnostics: collectFixedDiagnostics()
    }));
  }

  if (action === "restore") {
    const state = window[stateKey];
    if (!state) {
      return;
    }

    for (const item of state.fixedElements || []) {
      item.element.style.visibility = item.visibility;
    }

    const doc = document.documentElement;
    const body = document.body;
    body.style.scrollBehavior = state.bodyScrollBehavior;
    doc.style.scrollBehavior = state.docScrollBehavior;

    if (state.targetKind === "element" && state.targetElement) {
      state.targetElement.scrollTop = 0;
    }

    window.scrollTo(state.originalScrollX, state.originalScrollY);
    delete window[stateKey];

    return waitForPaint(1);
  }

  throw new Error(`Unsupported action: ${action}`);
}

async function captureVisibleTab(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

function sleep(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function captureVisibleTabWithRetry(windowId, options = {}) {
  const retries = options.retries ?? 4;
  const delayMs = options.delayMs ?? 350;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 0) {
        await sleep(delayMs * attempt);
      }

      return await captureVisibleTab(windowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isQuotaError = message.includes(
        "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND"
      );

      if (!isQuotaError || attempt === retries) {
        throw error;
      }
    }
  }

  throw new Error("Failed to capture the visible tab.");
}

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
  });
}

function createDebugSession(tab) {
  return {
    engineVersion: ENGINE_VERSION,
    startedAt: new Date().toISOString(),
    steps: [],
    tab: {
      id: tab.id,
      url: tab.url
    }
  };
}

function pushDebug(debug, label, data) {
  debug.steps.push({
    at: new Date().toISOString(),
    data,
    label
  });
}

function pickBestInspection(inspections) {
  const successful = inspections
    .filter((entry) => entry.result?.target || entry.result?.positions?.length)
    .map((entry) => ({
      frameId: entry.frameId,
      score:
        entry.result?.candidates?.[0]?.score ||
        Math.max(
          1,
          (entry.result?.fullHeight || 0) * (entry.result?.viewportHeight || 0)
        ),
      result: entry.result
    }));

  successful.sort((left, right) => right.score - left.score);
  return successful[0] || null;
}

function clipNearlyMatchesViewport(metrics, bitmap) {
  const clip = metrics.clip;
  const viewportWidth = bitmap.width / metrics.devicePixelRatio;
  const viewportHeight = bitmap.height / metrics.devicePixelRatio;
  return (
    clip.left <= 4 &&
    clip.top <= 4 &&
    clip.width >= viewportWidth * 0.96 &&
    clip.height >= viewportHeight * 0.96
  );
}

async function getBitmapFromDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

function sampleDifference(dataA, dataB, indexA, indexB) {
  return (
    Math.abs(dataA[indexA] - dataB[indexB]) +
    Math.abs(dataA[indexA + 1] - dataB[indexB + 1]) +
    Math.abs(dataA[indexA + 2] - dataB[indexB + 2]) +
    Math.abs(dataA[indexA + 3] - dataB[indexB + 3])
  );
}

async function analyzeStaticBands(metrics, captures, bitmaps, debug) {
  if (captures.length < 2 || bitmaps.length < 2 || metrics.mode !== "element") {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }

  if (!clipNearlyMatchesViewport(metrics, bitmaps[0])) {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }

  const clipPx = {
    left: Math.max(0, Math.round(metrics.clip.left * metrics.devicePixelRatio)),
    top: Math.max(0, Math.round(metrics.clip.top * metrics.devicePixelRatio)),
    width: Math.round(metrics.clip.width * metrics.devicePixelRatio),
    height: Math.round(metrics.clip.height * metrics.devicePixelRatio)
  };

  const canvas = new OffscreenCanvas(bitmaps[0].width, bitmaps[0].height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }

  context.drawImage(bitmaps[0], 0, 0);
  const dataA = context.getImageData(0, 0, bitmaps[0].width, bitmaps[0].height).data;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmaps[1], 0, 0);
  const dataB = context.getImageData(0, 0, bitmaps[1].width, bitmaps[1].height).data;

  const rowStep = Math.max(8, Math.floor(clipPx.width / 36));
  const columnStep = Math.max(8, Math.floor(clipPx.height / 30));
  const identicalThreshold = 24;
  let top = 0;
  let left = 0;

  const rowsEqual = (offsetY) => {
    const y = clipPx.top + offsetY;
    for (let x = clipPx.left; x < clipPx.left + clipPx.width; x += rowStep) {
      const indexA = (y * bitmaps[0].width + x) * 4;
      const indexB = (y * bitmaps[1].width + x) * 4;
      if (sampleDifference(dataA, dataB, indexA, indexB) > identicalThreshold) {
        return false;
      }
    }
    return true;
  };

  for (; top < Math.floor(clipPx.height * 0.4); top += 1) {
    if (!rowsEqual(top)) {
      break;
    }
  }

  const columnsEqual = (offsetX) => {
    const x = clipPx.left + offsetX;
    for (
      let y = clipPx.top + top;
      y < clipPx.top + clipPx.height;
      y += columnStep
    ) {
      const indexA = (y * bitmaps[0].width + x) * 4;
      const indexB = (y * bitmaps[1].width + x) * 4;
      if (sampleDifference(dataA, dataB, indexA, indexB) > identicalThreshold) {
        return false;
      }
    }
    return true;
  };

  for (; left < Math.floor(clipPx.width * 0.35); left += 1) {
    if (!columnsEqual(left)) {
      break;
    }
  }

  const insets = {
    left: left / metrics.devicePixelRatio,
    right: 0,
    top: top / metrics.devicePixelRatio,
    bottom: 0
  };

  pushDebug(debug, "static-bands", {
    clipPx,
    insets
  });

  return insets;
}

async function drawDocumentSegments(metrics, captures, bitmaps, debug) {
  const width = bitmaps[0].width;
  const height = Math.round(metrics.fullHeight * metrics.devicePixelRatio);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Failed to create canvas context.");
  }

  let paintedUntil = 0;

  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index];
    const bitmap = bitmaps[index];
    const overlapCss = Math.max(0, paintedUntil - capture.top);
    const sourceY = Math.round(overlapCss * metrics.devicePixelRatio);
    const destY = Math.round((capture.top + overlapCss) * metrics.devicePixelRatio);
    const remainingCss = metrics.fullHeight - (capture.top + overlapCss);
    const drawHeightCss = Math.min(
      metrics.viewportHeight - overlapCss,
      remainingCss
    );
    const drawHeight = Math.round(drawHeightCss * metrics.devicePixelRatio);

    if (drawHeight > 0) {
      context.drawImage(
        bitmap,
        0,
        sourceY,
        width,
        drawHeight,
        0,
        destY,
        width,
        drawHeight
      );
      pushDebug(debug, "draw-segment", {
        dest: {
          height: drawHeight,
          width,
          x: 0,
          y: destY
        },
        index,
        overlapCss,
        source: {
          height: drawHeight,
          width,
          x: 0,
          y: sourceY
        }
      });
      paintedUntil = capture.top + overlapCss + drawHeightCss;
    }
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function drawRegionSegments(metrics, captures, bitmaps, debug) {
  const baseBitmap = bitmaps[0];
  const insets = await analyzeStaticBands(metrics, captures, bitmaps, debug);
  const dynamicClip = {
    left: metrics.clip.left + insets.left,
    top: metrics.clip.top + insets.top,
    width: Math.max(1, metrics.clip.width - insets.left - insets.right),
    height: Math.max(1, metrics.clip.height - insets.top - insets.bottom)
  };
  const dynamicClipPx = {
    left: Math.round(dynamicClip.left * metrics.devicePixelRatio),
    top: Math.round(dynamicClip.top * metrics.devicePixelRatio),
    width: Math.round(dynamicClip.width * metrics.devicePixelRatio),
    height: Math.round(dynamicClip.height * metrics.devicePixelRatio)
  };
  const baseHeightCss = baseBitmap.height / metrics.devicePixelRatio;
  const finalHeightCss = baseHeightCss + Math.max(0, metrics.fullHeight - metrics.clip.height);
  const canvas = new OffscreenCanvas(
    baseBitmap.width,
    Math.round(finalHeightCss * metrics.devicePixelRatio)
  );
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Failed to create canvas context.");
  }

  context.drawImage(baseBitmap, 0, 0);
  let paintedUntil = dynamicClip.height;

  for (let index = 1; index < captures.length; index += 1) {
    const capture = captures[index];
    const bitmap = bitmaps[index];
    const overlapCss = Math.max(0, paintedUntil - capture.top);
    const remainingCss = metrics.fullHeight - (capture.top + overlapCss);
    const drawHeightCss = Math.min(dynamicClip.height - overlapCss, remainingCss);

    if (drawHeightCss <= 0) {
      continue;
    }

    const source = {
      x: dynamicClipPx.left,
      y: dynamicClipPx.top + Math.round(overlapCss * metrics.devicePixelRatio),
      width: dynamicClipPx.width,
      height: Math.round(drawHeightCss * metrics.devicePixelRatio)
    };
    const dest = {
      x: dynamicClipPx.left,
      y: Math.round((dynamicClip.top + capture.top + overlapCss) * metrics.devicePixelRatio),
      width: dynamicClipPx.width,
      height: source.height
    };

    context.drawImage(
      bitmap,
      source.x,
      source.y,
      source.width,
      source.height,
      dest.x,
      dest.y,
      dest.width,
      dest.height
    );
    pushDebug(debug, "draw-segment", {
      dest,
      dynamicClip,
      index,
      overlapCss,
      source
    });
    paintedUntil = capture.top + overlapCss + drawHeightCss;
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function drawSegmentsToCanvas(metrics, captures, debug) {
  const bitmaps = [];

  try {
    for (const capture of captures) {
      bitmaps.push(await getBitmapFromDataUrl(capture.dataUrl));
    }

    if (metrics.mode === "document") {
      return await drawDocumentSegments(metrics, captures, bitmaps, debug);
    }

    return await drawRegionSegments(metrics, captures, bitmaps, debug);
  } finally {
    for (const bitmap of bitmaps) {
      bitmap.close();
    }
  }
}

async function captureFullPage(tab) {
  const debug = createDebugSession(tab);
  const inspections = await runInTab(tab.id, pageSnapController, ["inspect"], {
    allFrames: true
  });
  const best = pickBestInspection(inspections);

  if (!best) {
    throw new Error("Failed to find a scrollable capture target.");
  }

  pushDebug(debug, "inspected", {
    frameCandidates: inspections.map((entry) => ({
      frameId: entry.frameId,
      mode: entry.result?.mode,
      target: entry.result?.target || null
    }))
  });

  const metrics = await runInSingleFrame(tab.id, pageSnapController, ["prepare"], best.frameId);
  if (!metrics?.positions?.length) {
    throw new Error("Failed to measure page.");
  }

  pushDebug(debug, "prepared", {
    ...metrics,
    frameId: best.frameId
  });

  const captures = [];

  try {
    for (const top of metrics.positions) {
      const actualTop = await runInSingleFrame(
        tab.id,
        pageSnapController,
        ["scroll", { top }],
        best.frameId
      );
      const measured = await runInSingleFrame(
        tab.id,
        pageSnapController,
        ["measure-current"],
        best.frameId
      );

      pushDebug(debug, "step", {
        actualTop,
        measured,
        refreshed: measured?.fullHeight !== metrics.fullHeight,
        remainingSteps: Math.max(0, metrics.positions.length - captures.length - 1),
        requestedTop: top
      });

      const fixedInfo = await runInSingleFrame(
        tab.id,
        pageSnapController,
        ["before-capture"],
        best.frameId
      );
      pushDebug(debug, "before-capture", {
        ...fixedInfo,
        isFirstStep: captures.length === 0,
        isLastStep: captures.length === metrics.positions.length - 1
      });

      const dataUrl = await captureVisibleTabWithRetry(tab.windowId);
      captures.push({ dataUrl, top: typeof actualTop === "number" ? actualTop : top });
      await sleep(80);
    }
  } finally {
    await runInSingleFrame(tab.id, pageSnapController, ["restore"], best.frameId).catch(
      () => {}
    );
  }

  pushDebug(debug, "draw", {
    capturesLength: captures.length,
    finalFullHeight: metrics.fullHeight,
    finalPositionsLength: metrics.positions.length
  });

  const dataUrl = await drawSegmentsToCanvas(metrics, captures, debug);
  return { dataUrl, debug };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CAPTURE_FULL_PAGE") {
    return false;
  }

  (async () => {
    try {
      const tab = await getActiveTab();
      if (isRestrictedUrl(tab.url)) {
        throw new Error("This page cannot be captured by the extension.");
      }

      const result = await captureFullPage(tab);
      sendResponse({ ok: true, dataUrl: result.dataUrl, debug: result.debug });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
});
