const statusCard = document.getElementById("statusCard");
const statusLabelNode = document.getElementById("statusLabel");
const statusMessageNode = document.getElementById("statusMessage");
const previewCard = document.getElementById("previewCard");
const previewImage = document.getElementById("previewImage");
const downloadButton = document.getElementById("downloadButton");
const debugCard = document.getElementById("debugCard");
const debugOutput = document.getElementById("debugOutput");
const sloganNode = document.querySelector(".slogan");

const STRINGS = {
  zh: {
    popupTitle: "Page Snap",
    slogan: "一键截取网页全部内容，并复制到剪贴板。",
    previewAlt: "截图预览",
    downloadLabel: "下载截图",
    downloadFilename: "pagesnap-screenshot",
    status: {
      loadingCapture: {
        label: "正在截图",
        message: "正在滚动页面并拼接整页截图..."
      },
      loadingCopy: {
        label: "正在复制",
        message: "正在写入剪贴板，马上就好。"
      },
      success: {
        label: "已完成",
        message: "已经截屏到剪贴板。"
      },
      error: {
        label: "截图失败",
        message: "发生了未知错误。"
      },
      previewError: "截图预览加载失败。",
      captureError: "截图失败。"
    }
  },
  en: {
    popupTitle: "Page Snap",
    slogan: "Capture the entire page and copy it straight to your clipboard.",
    previewAlt: "Screenshot preview",
    downloadLabel: "Download screenshot",
    downloadFilename: "pagesnap-screenshot",
    status: {
      loadingCapture: {
        label: "Capturing",
        message: "Scrolling and stitching the full page..."
      },
      loadingCopy: {
        label: "Copying",
        message: "Writing the screenshot to your clipboard..."
      },
      success: {
        label: "Done",
        message: "The screenshot has been copied to your clipboard."
      },
      error: {
        label: "Capture failed",
        message: "Something went wrong."
      },
      previewError: "Failed to load the screenshot preview.",
      captureError: "Capture failed."
    }
  }
};

let latestDataUrl = "";

function getLocale() {
  const language = (navigator.language || "en").toLowerCase();
  return language.startsWith("zh") ? "zh" : "en";
}

const locale = getLocale();
const text = STRINGS[locale];

function applyStaticText() {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.title = text.popupTitle;
  sloganNode.textContent = text.slogan;
  previewImage.alt = text.previewAlt;
  downloadButton.setAttribute("aria-label", text.downloadLabel);
  downloadButton.setAttribute("title", text.downloadLabel);
}

function setStatus(state, label, message) {
  statusCard.dataset.state = state;
  statusLabelNode.textContent = label;
  statusMessageNode.textContent = message;
}

function setStatusFromKey(state, key, fallbackMessage) {
  const copy = text.status[key];
  setStatus(state, copy.label, fallbackMessage || copy.message);
}

function resetPreview() {
  latestDataUrl = "";
  previewCard.hidden = true;
  previewImage.removeAttribute("src");
}

function renderDebug(debug) {
  if (!debug) {
    debugCard.hidden = true;
    debugOutput.textContent = "";
    return;
  }

  debugOutput.textContent = JSON.stringify(debug, null, 2);
  debugCard.hidden = false;
}

async function showPreview(dataUrl) {
  const image = new Image();
  image.decoding = "async";

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error(text.status.previewError));
    image.src = dataUrl;
  });

  latestDataUrl = dataUrl;
  previewImage.src = dataUrl;
  previewCard.hidden = false;
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function copyImageToClipboard(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is not supported in this browser.");
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      [blob.type || "image/png"]: blob
    })
  ]);
}

function createFilename() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ];
  return `${text.downloadFilename}-${parts.join("")}.png`;
}

async function downloadCurrentImage() {
  if (!latestDataUrl) {
    return;
  }

  const blob = await dataUrlToBlob(latestDataUrl);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = createFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

async function run() {
  try {
    resetPreview();
    setStatusFromKey("loading", "loadingCapture");

    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_FULL_PAGE"
    });

    if (!response?.ok || !response.dataUrl) {
      renderDebug(response?.debug || null);
      throw new Error(response?.error || text.status.captureError);
    }

    setStatusFromKey("loading", "loadingCopy");
    const blob = await dataUrlToBlob(response.dataUrl);
    await copyImageToClipboard(blob);

    await showPreview(response.dataUrl);
    renderDebug(response.debug || null);
    setStatusFromKey("success", "success");
  } catch (error) {
    resetPreview();
    setStatusFromKey(
      "error",
      "error",
      error instanceof Error ? error.message : text.status.error.message
    );
  }
}

applyStaticText();
downloadButton.addEventListener("click", () => {
  void downloadCurrentImage();
});

run();
