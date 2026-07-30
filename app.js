const API_URL = "https://unstamp-ai.connor-y-gui.workers.dev/inpaint";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_DIMENSION = 1024;

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

async function restoreImage() {
  const instruction = promptInput.value.trim() || "Restore the painted area naturally to match the surrounding background.";
  addMessage(instruction, "user");
  restoreButton.classList.add("loading");
  restoreButton.querySelector("span").textContent = "Restoring";
  setRestoreState();

  try {
    const form = new FormData();
    form.append("image", await canvasBlob(photoCanvas), "original.png");
    form.append("mask", await canvasBlob(maskCanvas), "mask.png");
    form.append("prompt", instruction);
    form.append("authorized", "true");

    const response = await fetch(API_URL, { method: "POST", body: form });
    if (!response.ok) {
      let message = "The restoration could not be completed.";
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }

    const result = await response.blob();
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
