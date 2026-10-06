// Runs in an isolated world on every Roblox page. Marks the page so RoValra
// (or user CSS) can detect it is running inside the desktop client.
window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.dataset.rovalraDesktop = process.platform;
});
