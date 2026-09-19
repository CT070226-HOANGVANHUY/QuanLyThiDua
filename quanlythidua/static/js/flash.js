(() => {
  const HOLD_MS = 10000;
  const OUT_MS = 400;

  function dismiss(el) {
    if (el.classList.contains("is-leaving")) return;
    el.style.maxHeight = `${el.scrollHeight}px`;
    el.getBoundingClientRect();
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), OUT_MS);
  }

  function arm(el) {
    let remaining = HOLD_MS;
    let started = 0;
    let timer = 0;

    function play() {
      if (el.classList.contains("is-leaving") || !el.isConnected) return;
      el.classList.remove("is-paused");
      started = Date.now();
      timer = window.setTimeout(() => dismiss(el), remaining);
    }

    function pause() {
      if (el.classList.contains("is-leaving")) return;
      window.clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - started));
      el.classList.add("is-paused");
    }

    el.addEventListener("mouseenter", pause);
    el.addEventListener("mouseleave", play);
    el.addEventListener("focusin", pause);
    el.addEventListener("focusout", (event) => {
      if (!el.contains(event.relatedTarget)) play();
    });
    play();
  }

  document.querySelectorAll(".flash[role='alert']").forEach((el) => {
    if (!String(el.textContent || "").trim()) return;
    arm(el);
  });
})();
