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

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  return result?.result;
}

function pageSnapController(action, payload = {}) {
  const stateKey = "__pageSnapState";

  const waitForPaint = () =>
    new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
      });
    });

  if (action === "prepare") {
    const doc = document.documentElement;
    const body = document.body;
    const scrollingElement = document.scrollingElement || doc;

    if (!body) {
      throw new Error("This page is not ready to capture.");
    }

    const fixedElements = [];
    const allElements = document.querySelectorAll("*");
    for (const element of allElements) {
      const style = window.getComputedStyle(element);
      if (style.position === "fixed" || style.position === "sticky") {
        fixedElements.push({
          element,
          visibility: element.style.visibility
        });
        element.style.visibility = "hidden";
      }
    }

    window[stateKey] = {
      fixedElements,
      originalScrollX: window.scrollX,
      originalScrollY: window.scrollY,
      bodyOverflow: body.style.overflow,
      docOverflow: doc.style.overflow,
      bodyScrollBehavior: body.style.scrollBehavior,
      docScrollBehavior: doc.style.scrollBehavior
    };

    body.style.overflow = "hidden";
    doc.style.overflow = "hidden";
    body.style.scrollBehavior = "auto";
    doc.style.scrollBehavior = "auto";

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const fullHeight = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      doc.clientHeight,
      doc.scrollHeight,
      doc.offsetHeight
    );
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

    return waitForPaint().then(() => ({
      devicePixelRatio: window.devicePixelRatio || 1,
      fullHeight,
      positions: [...new Set(positions)],
      viewportHeight,
      viewportWidth
    }));
  }

  if (action === "scroll") {
    const top = Number(payload.top) || 0;
    window.scrollTo(0, top);
    return waitForPaint().then(() => window.scrollY);
  }

  if (action === "restore") {
    const state = window[stateKey];
    if (!state) {
      return;
    }

    for (const item of state.fixedElements) {
      item.element.style.visibility = item.visibility;
    }

    const doc = document.documentElement;
    const body = document.body;
    body.style.overflow = state.bodyOverflow;
    doc.style.overflow = state.docOverflow;
    body.style.scrollBehavior = state.bodyScrollBehavior;
    doc.style.scrollBehavior = state.docScrollBehavior;
    window.scrollTo(state.originalScrollX, state.originalScrollY);
    delete window[stateKey];

    return waitForPaint();
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

async function drawSegmentsToCanvas(metrics, captures) {
  const width = Math.round(metrics.viewportWidth * metrics.devicePixelRatio);
  const height = Math.round(metrics.fullHeight * metrics.devicePixelRatio);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Failed to create canvas context.");
  }

  let paintedUntil = 0;

  for (const capture of captures) {
    const response = await fetch(capture.dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

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
      paintedUntil = capture.top + overlapCss + drawHeightCss;
    }

    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function captureFullPage(tab) {
  const metrics = await runInTab(tab.id, pageSnapController, ["prepare"]);

  if (!metrics?.positions?.length) {
    throw new Error("Failed to measure page.");
  }

  const captures = [];

  try {
    for (const top of metrics.positions) {
      const actualTop = await runInTab(tab.id, pageSnapController, [
        "scroll",
        { top }
      ]);

      const dataUrl = await captureVisibleTabWithRetry(tab.windowId);
      captures.push({ dataUrl, top: typeof actualTop === "number" ? actualTop : top });
    }
  } finally {
    await runInTab(tab.id, pageSnapController, ["restore"]).catch(() => {});
  }

  return drawSegmentsToCanvas(metrics, captures);
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

      const dataUrl = await captureFullPage(tab);
      sendResponse({ ok: true, dataUrl });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
});
