const API_URL = "https://unstamp-ai.connor-y-gui.workers.dev/inpaint";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_DIMENSION = 1024;
const TILE_SIZE = 512;
const MASK_PADDING = 24;
const MASK_PREFILL_SCALE = 16;

const imageInput = document.querySelector("#imageInput");
const uploadZone = document.querySelector("#uploadZone");
const chooseButton = document.querySelector("#chooseButton");
const newImageButton = document.querySelector("#newImageButton");
const canvasStage = document.querySelector("#canvasStage");
const canvasWrap = document.querySelector("#canvasWrap");
const photoCanvas = document.querySelector("#photoCanvas");
const maskCanvas = document.querySelector("#maskCanvas");
const brushCursor = document.querySelector("#brushCursor");
const brushSize = document.querySelector("#brushSize");
const brushOutput = document.querySelector("#brushOutput");
const undoButton = document.querySelector("#undoButton");
const clearButton = document.querySelector("#clearButton");
const promptInput = document.querySelector("#promptInput");
const permissionCheck = document.querySelector("#permissionCheck");
const restoreButton = document.querySelector("#restoreButton");
const chatLog = document.querySelector("#chatLog");
const resultSection = document.querySelector("#resultSection");
const resultImage = document.querySelector("#resultImage");
const downloadButton = document.querySelector("#downloadButton");
const tryAgainButton = document.querySelector("#tryAgainButton");

const photoContext = photoCanvas.getContext("2d");
const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
let drawing = false;
let hasImage = false;
let hasMask = false;
let maskHistory = [];
let resultUrl = "";

function setRestoreState() {
  restoreButton.disabled = !hasImage || !hasMask || !permissionCheck.checked || restoreButton.classList.contains("loading");
}

function addMessage(text, type) {
  const message = document.createElement("div");
  message.className = `message ${type}-message`;
  message.textContent = text;
  chatLog.append(message);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function resetMask() {
  maskContext.save();
  maskContext.globalCompositeOperation = "source-over";
  maskContext.fillStyle = "black";
  maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskContext.restore();
  maskHistory = [];
  hasMask = false;
  undoButton.disabled = true;
  clearButton.disabled = true;
  setRestoreState();
}

function saveMaskState() {
  if (maskHistory.length >= 20) maskHistory.shift();
  maskHistory.push(maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height));
  undoButton.disabled = false;
}

async function loadImage(file) {
  if (!file || !file.type.startsWith("image/")) {
    addMessage("Please choose a PNG, JPG, or WebP image.", "assistant");
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    addMessage("That image is larger than 10 MB. Please choose a smaller file.", "assistant");
    return;
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  photoCanvas.width = maskCanvas.width = width;
  photoCanvas.height = maskCanvas.height = height;
  photoContext.clearRect(0, 0, width, height);
  photoContext.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  hasImage = true;
  uploadZone.hidden = true;
  canvasStage.hidden = false;
  newImageButton.hidden = false;
  resetMask();
  addMessage("Image ready. Paint over the area to rebuild, then describe the correction below.", "assistant");
}

function canvasPoint(event) {
  const rect = maskCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (maskCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (maskCanvas.height / rect.height),
    scale: maskCanvas.width / rect.width
  };
}

function drawMask(event) {
  if (!drawing) return;
  const point = canvasPoint(event);
  maskContext.lineTo(point.x, point.y);
  maskContext.stroke();
  hasMask = true;
  clearButton.disabled = false;
  setRestoreState();
}

function startDrawing(event) {
  event.preventDefault();
  saveMaskState();
  drawing = true;
  const point = canvasPoint(event);
  maskContext.save();
  maskContext.globalCompositeOperation = "source-over";
  maskContext.strokeStyle = "white";
  maskContext.fillStyle = "white";
  maskContext.lineCap = "round";
  maskContext.lineJoin = "round";
  maskContext.lineWidth = Number(brushSize.value) * point.scale;
  maskContext.beginPath();
  maskContext.arc(point.x, point.y, maskContext.lineWidth / 2, 0, Math.PI * 2);
  maskContext.fill();
  maskContext.beginPath();
  maskContext.moveTo(point.x, point.y);
  hasMask = true;
  clearButton.disabled = false;
  setRestoreState();
  maskCanvas.setPointerCapture(event.pointerId);
}

function stopDrawing(event) {
  if (!drawing) return;
  drawing = false;
  maskContext.closePath();
  maskContext.restore();
  if (maskCanvas.hasPointerCapture(event.pointerId)) maskCanvas.releasePointerCapture(event.pointerId);
}

function updateCursor(event) {
  const wrapRect = canvasWrap.getBoundingClientRect();
  const canvasRect = maskCanvas.getBoundingClientRect();
  const displaySize = Number(brushSize.value) * (canvasRect.width / maskCanvas.width);
  brushCursor.style.width = `${displaySize}px`;
  brushCursor.style.height = `${displaySize}px`;
  brushCursor.style.left = `${event.clientX - wrapRect.left + canvasWrap.scrollLeft}px`;
  brushCursor.style.top = `${event.clientY - wrapRect.top + canvasWrap.scrollTop}px`;
  brushCursor.hidden = false;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not prepare image.")), "image/png"));
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function regionHasMask(maskSource, x, y, width, height) {
  const pixels = maskSource.getContext("2d", { willReadFrequently: true }).getImageData(x, y, width, height).data;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] > 127) return true;
  }
  return false;
}

function expandedMask(radius = MASK_PADDING) {
  const expanded = createCanvas(maskCanvas.width, maskCanvas.height);
  const context = expanded.getContext("2d");
  context.fillStyle = "black";
  context.fillRect(0, 0, expanded.width, expanded.height);
  context.globalCompositeOperation = "lighter";

  for (let y = -radius; y <= radius; y += 4) {
    for (let x = -radius; x <= radius; x += 4) {
      if ((x * x) + (y * y) <= radius * radius) context.drawImage(maskCanvas, x, y);
    }
  }
  context.drawImage(maskCanvas, 0, 0);
  context.globalCompositeOperation = "source-over";
  return expanded;
}

function maskBounds(maskSource) {
  const { width, height } = maskSource;
  const pixels = maskSource.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[((y * width) + x) * 4] <= 127) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

function restorationTiles(maskSource) {
  const bounds = maskBounds(maskSource);
  if (!bounds) return [];

  const boundsWidth = bounds.right - bounds.left;
  const boundsHeight = bounds.bottom - bounds.top;
  if (boundsWidth <= TILE_SIZE && boundsHeight <= TILE_SIZE) {
    const cropWidth = Math.min(TILE_SIZE, photoCanvas.width);
    const cropHeight = Math.min(TILE_SIZE, photoCanvas.height);
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const cropX = Math.max(0, Math.min(Math.round(centerX - cropWidth / 2), photoCanvas.width - cropWidth));
    const cropY = Math.max(0, Math.min(Math.round(centerY - cropHeight / 2), photoCanvas.height - cropHeight));
    return [{
      x: bounds.left,
      y: bounds.top,
      coreWidth: boundsWidth,
      coreHeight: boundsHeight,
      cropX,
      cropY,
      cropWidth,
      cropHeight
    }];
  }

  const tiles = [];
  for (let y = 0; y < photoCanvas.height; y += TILE_SIZE) {
    for (let x = 0; x < photoCanvas.width; x += TILE_SIZE) {
      const coreWidth = Math.min(TILE_SIZE, photoCanvas.width - x);
      const coreHeight = Math.min(TILE_SIZE, photoCanvas.height - y);
      if (!regionHasMask(maskSource, x, y, coreWidth, coreHeight)) continue;

      const cropWidth = Math.min(TILE_SIZE, photoCanvas.width);
      const cropHeight = Math.min(TILE_SIZE, photoCanvas.height);
      const cropX = Math.max(0, Math.min(x, photoCanvas.width - cropWidth));
      const cropY = Math.max(0, Math.min(y, photoCanvas.height - cropHeight));
      tiles.push({ x, y, coreWidth, coreHeight, cropX, cropY, cropWidth, cropHeight });
    }
  }
  return tiles;
}

function prepareTile(tile, maskSource) {
  const image = createCanvas(TILE_SIZE, TILE_SIZE);
  const imageContext = image.getContext("2d", { willReadFrequently: true });
  imageContext.drawImage(
    photoCanvas,
    tile.cropX, tile.cropY, tile.cropWidth, tile.cropHeight,
    0, 0, TILE_SIZE, TILE_SIZE
  );

  const mask = createCanvas(TILE_SIZE, TILE_SIZE);
  const context = mask.getContext("2d");
  context.fillStyle = "black";
  context.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  const scaleX = TILE_SIZE / tile.cropWidth;
  const scaleY = TILE_SIZE / tile.cropHeight;
  context.save();
  context.beginPath();
  context.rect(
    (tile.x - tile.cropX) * scaleX,
    (tile.y - tile.cropY) * scaleY,
    tile.coreWidth * scaleX,
    tile.coreHeight * scaleY
  );
  context.clip();
  context.drawImage(
    maskSource,
    tile.cropX, tile.cropY, tile.cropWidth, tile.cropHeight,
    0, 0, TILE_SIZE, TILE_SIZE
  );
  context.restore();

  const reducedSize = Math.max(8, Math.round(TILE_SIZE / MASK_PREFILL_SCALE));
  const reduced = createCanvas(reducedSize, reducedSize);
  reduced.getContext("2d").drawImage(image, 0, 0, reducedSize, reducedSize);
  const blurred = createCanvas(TILE_SIZE, TILE_SIZE);
  const blurredContext = blurred.getContext("2d", { willReadFrequently: true });
  blurredContext.imageSmoothingEnabled = true;
  blurredContext.imageSmoothingQuality = "high";
  blurredContext.drawImage(reduced, 0, 0, TILE_SIZE, TILE_SIZE);

  const imagePixels = imageContext.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const blurredPixels = blurredContext.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  const maskPixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  for (let index = 0; index < maskPixels.length; index += 4) {
    if (maskPixels[index] <= 127) continue;
    imagePixels.data[index] = blurredPixels[index];
    imagePixels.data[index + 1] = blurredPixels[index + 1];
    imagePixels.data[index + 2] = blurredPixels[index + 2];
  }
  imageContext.putImageData(imagePixels, 0, 0);
  return { image, mask };
}

async function restoreTile(tile, instruction, maskSource) {
  const prepared = prepareTile(tile, maskSource);
  const form = new FormData();
  form.append("image", await canvasBlob(prepared.image), "original.png");
  form.append("mask", await canvasBlob(prepared.mask), "mask.png");
  form.append("prompt", instruction);
  form.append("authorized", "true");

  const response = await fetch(API_URL, { method: "POST", body: form });
  if (!response.ok) {
    let message = "The restoration could not be completed.";
    try { message = (await response.json()).error || message; } catch {}
    if (response.status >= 500 && /could not be completed|clear mask/i.test(message)) {
      message = "Image restoration is unavailable right now. Unstamp's free daily AI allowance may have been used; if so, try again after Cloudflare's reset at 00:00 UTC (8:00 PM Eastern during daylight saving time; 7:00 PM otherwise). If the problem continues after the reset, adjust the painted area and try again.";
    }
    throw new Error(message);
  }

  return createImageBitmap(await response.blob());
}

function applyTile(resultContext, tile, bitmap, maskSource) {
  const generated = createCanvas(tile.cropWidth, tile.cropHeight);
  generated.getContext("2d").drawImage(bitmap, 0, 0, tile.cropWidth, tile.cropHeight);
  bitmap.close();

  const localX = tile.x - tile.cropX;
  const localY = tile.y - tile.cropY;
  const generatedPixels = generated.getContext("2d").getImageData(
    localX, localY, tile.coreWidth, tile.coreHeight
  );
  const originalPixels = resultContext.getImageData(tile.x, tile.y, tile.coreWidth, tile.coreHeight);
  const maskPixels = maskSource.getContext("2d", { willReadFrequently: true })
    .getImageData(tile.x, tile.y, tile.coreWidth, tile.coreHeight).data;

  for (let index = 0; index < maskPixels.length; index += 4) {
    if (maskPixels[index] <= 127) continue;
    originalPixels.data[index] = generatedPixels.data[index];
    originalPixels.data[index + 1] = generatedPixels.data[index + 1];
    originalPixels.data[index + 2] = generatedPixels.data[index + 2];
    originalPixels.data[index + 3] = 255;
  }
  resultContext.putImageData(originalPixels, tile.x, tile.y);
}

async function restoreImage() {
  const instruction = promptInput.value.trim() || "Restore the painted area naturally to match the surrounding background.";
  addMessage(instruction, "user");
  restoreButton.classList.add("loading");
  restoreButton.querySelector("span").textContent = "Restoring";
  setRestoreState();

  try {
    const restorationMask = expandedMask();
    const tiles = restorationTiles(restorationMask);
    if (!tiles.length) throw new Error("Paint over at least one area to restore.");
    addMessage(`Restoring ${tiles.length} image section${tiles.length === 1 ? "" : "s"}. This can take a few minutes.`, "assistant");

    let completed = 0;
    const bitmaps = await Promise.all(tiles.map(async tile => {
      const bitmap = await restoreTile(tile, instruction, restorationMask);
      completed += 1;
      restoreButton.querySelector("span").textContent = `Restoring ${completed}/${tiles.length}`;
      return bitmap;
    }));

    const restored = createCanvas(photoCanvas.width, photoCanvas.height);
    const restoredContext = restored.getContext("2d");
    restoredContext.drawImage(photoCanvas, 0, 0);
    tiles.forEach((tile, index) => applyTile(restoredContext, tile, bitmaps[index], restorationMask));
    const result = await canvasBlob(restored);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(result);
    resultImage.src = resultUrl;
    downloadButton.href = resultUrl;
    resultSection.hidden = false;
    addMessage("Your restoration is ready. Review the result below.", "assistant");
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    addMessage(error.message || "Something went wrong while restoring the image.", "assistant");
  } finally {
    restoreButton.classList.remove("loading");
    restoreButton.querySelector("span").textContent = "Restore with AI";
    setRestoreState();
  }
}

chooseButton.addEventListener("click", () => imageInput.click());
newImageButton.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => loadImage(imageInput.files[0]));
permissionCheck.addEventListener("change", setRestoreState);
restoreButton.addEventListener("click", restoreImage);

for (const eventName of ["dragenter", "dragover"]) {
  uploadZone.addEventListener(eventName, event => { event.preventDefault(); uploadZone.classList.add("dragging"); });
}
for (const eventName of ["dragleave", "drop"]) {
  uploadZone.addEventListener(eventName, event => { event.preventDefault(); uploadZone.classList.remove("dragging"); });
}
uploadZone.addEventListener("drop", event => loadImage(event.dataTransfer.files[0]));

brushSize.addEventListener("input", () => { brushOutput.value = brushSize.value; });
maskCanvas.addEventListener("pointerdown", startDrawing);
maskCanvas.addEventListener("pointermove", event => { updateCursor(event); drawMask(event); });
maskCanvas.addEventListener("pointerup", stopDrawing);
maskCanvas.addEventListener("pointercancel", stopDrawing);
maskCanvas.addEventListener("pointerleave", event => { brushCursor.hidden = true; if (drawing) stopDrawing(event); });

undoButton.addEventListener("click", () => {
  const previous = maskHistory.pop();
  if (!previous) return;
  maskContext.putImageData(previous, 0, 0);
  hasMask = maskHistory.length > 0 || maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data.some((value, index) => index % 4 !== 3 && value > 0);
  undoButton.disabled = maskHistory.length === 0;
  clearButton.disabled = !hasMask;
  setRestoreState();
});
clearButton.addEventListener("click", resetMask);

document.querySelectorAll("[data-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    promptInput.value = button.dataset.prompt;
    promptInput.focus();
  });
});

tryAgainButton.addEventListener("click", () => {
  resultSection.hidden = true;
  document.querySelector(".workspace").scrollIntoView({ behavior: "smooth", block: "start" });
});
