// FPS counter settings window. The preview is a scaled copy of the screen;
// where the counter is dropped becomes a MangoHud corner anchor + pixel
// offset, so the in-game counter lands in the same spot.
const api = window.rovalraOverlay;
const $ = (id) => document.getElementById(id);
const screenEl = $('screen');
const counter = $('counter');

let state; // { overlay, screen: { width, height }, loaded }

function previewScale() {
    return state.screen.width / screenEl.clientWidth; // real px per preview px
}

function renderCounter() {
    const o = state.overlay;
    const scale = previewScale();
    counter.textContent = o.detailed ? 'FPS 144\n8.3 ms\nCPU 32%  GPU 61%' : 'FPS 144\n8.3 ms';
    counter.style.fontSize = `${Math.max(7, o.fontSize / scale * 1.6)}px`;
    counter.classList.toggle('hidden', !o.visible);

    const [v, h] = o.position.split('-'); // e.g. "top-left"
    const x = o.offsetX / scale;
    const y = o.offsetY / scale;
    counter.style.left = counter.style.right = counter.style.top = counter.style.bottom = '';
    counter.style[h === 'right' ? 'right' : 'left'] = `${x}px`;
    counter.style[v === 'bottom' ? 'bottom' : 'top'] = `${y}px`;

    $('visible').checked = o.visible;
    $('size').value = o.fontSize;
    $('detailed').checked = o.detailed;
    $('visibleNote').textContent = state.loaded
        ? ''
        : 'Sayaç kapalı — Oyun menüsünden açın (sonraki oyunda yüklenir)';
    $('visibleNote').className = state.loaded ? '' : 'warn';
}

let saveTimer;
function update(patch) {
    state.overlay = { ...state.overlay, ...patch };
    renderCounter();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        await api.set(state.overlay);
        $('status').textContent = 'Kaydedildi';
        setTimeout(() => ($('status').textContent = ''), 1200);
    }, 120);
}

// --- dragging ---
let drag = null;
counter.addEventListener('pointerdown', (e) => {
    const box = counter.getBoundingClientRect();
    drag = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    counter.setPointerCapture(e.pointerId);
    counter.classList.add('dragging');
});
counter.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const area = screenEl.getBoundingClientRect();
    const w = counter.offsetWidth;
    const hgt = counter.offsetHeight;
    const left = Math.min(area.width - w, Math.max(0, e.clientX - area.left - drag.dx));
    const top = Math.min(area.height - hgt, Math.max(0, e.clientY - area.top - drag.dy));
    counter.style.right = counter.style.bottom = '';
    counter.style.left = `${left}px`;
    counter.style.top = `${top}px`;
});
counter.addEventListener('pointerup', (e) => {
    if (!drag) return;
    drag = null;
    counter.classList.remove('dragging');
    counter.releasePointerCapture(e.pointerId);

    // Anchor to the nearest corner so the offset stays right at any game size.
    const area = screenEl.getBoundingClientRect();
    const box = counter.getBoundingClientRect();
    const left = box.left - area.left;
    const top = box.top - area.top;
    const right = area.right - box.right;
    const bottom = area.bottom - box.bottom;
    const h = left + box.width / 2 < area.width / 2 ? 'left' : 'right';
    const v = top + box.height / 2 < area.height / 2 ? 'top' : 'bottom';
    const scale = previewScale();
    update({
        position: `${v}-${h}`,
        offsetX: (h === 'left' ? left : right) * scale,
        offsetY: (v === 'top' ? top : bottom) * scale,
    });
});

$('visible').addEventListener('change', (e) => update({ visible: e.target.checked }));
$('size').addEventListener('input', (e) => update({ fontSize: Number(e.target.value) }));
$('detailed').addEventListener('change', (e) => update({ detailed: e.target.checked }));
$('reset').addEventListener('click', async () => update(await api.defaults()));
window.addEventListener('resize', () => state && renderCounter());

api.get().then((s) => {
    state = s;
    renderCounter();
});
