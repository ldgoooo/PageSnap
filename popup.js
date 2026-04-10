const statusCard = document.getElementById("statusCard");
const statusLabelNode = document.getElementById("statusLabel");
const statusMessageNode = document.getElementById("statusMessage");
const previewCard = document.getElementById("previewCard");
const previewImage = document.getElementById("previewImage");

function setStatus(state, label, message) {
  statusCard.dataset.state = state;
  statusLabelNode.textContent = label;
  statusMessageNode.textContent = message;
}

function resetPreview() {
  previewCard.hidden = true;
  previewImage.removeAttribute("src");
}

async function showPreview(dataUrl) {
  const image = new Image();
  image.decoding = "async";

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("截图预览加载失败。"));
    image.src = dataUrl;
  });

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

async function run() {
  try {
    resetPreview();
    setStatus("loading", "正在截图", "自动滚动页面并拼接完整内容。");

    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_FULL_PAGE"
    });

    if (!response?.ok || !response.dataUrl) {
      throw new Error(response?.error || "截图失败。");
    }

    setStatus("loading", "正在复制", "正在写入剪贴板，马上就好。");
    const blob = await dataUrlToBlob(response.dataUrl);
    await copyImageToClipboard(blob);

    await showPreview(response.dataUrl);
    setStatus("success", "已完成", "已经截屏到剪贴板。");
  } catch (error) {
    resetPreview();
    setStatus(
      "error",
      "截图失败",
      error instanceof Error ? error.message : "发生了未知错误。"
    );
  }
}

run();
