(() => {
  const KEY = "thidua-theme";
  const root = document.documentElement;
  const button = document.getElementById("themeToggle");

  function theme() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function apply(next) {
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(KEY, next); } catch {}
    if (button) {
      button.setAttribute("aria-label", next === "dark" ? "Chuyển sang chế độ sáng" : "Chuyển sang chế độ tối");
      button.title = next === "dark" ? "Đang tối — bấm để sáng" : "Đang sáng — bấm để tối";
    }
  }

  apply(theme());
  button?.addEventListener("click", () => apply(theme() === "dark" ? "light" : "dark"));
})();
