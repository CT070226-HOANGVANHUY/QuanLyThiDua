(() => {
  const prefixes = {
    nghi: ["ho_ten", "ngay", "ghi_chu"],
    di_muon: ["ho_ten", "ngay", "so_luong", "ghi_chu"],
    trang_phuc: ["ho_ten", "ngay", "so_luong", "ghi_chu"],
    phu_hieu: ["ho_ten", "ngay", "so_luong", "ghi_chu"],
    vp_khac: ["ho_ten", "ngay", "so_luong", "ghi_chu"],
    thai_do: ["ho_ten", "tiet_mon", "noi_dung", "ngay", "ghi_chu"],
  };
  const forms = [...document.querySelectorAll("form[data-dirty-guard]")];
  let dirty = false;
  const mark = () => {
    dirty = true;
    document.querySelectorAll("[data-save-state]").forEach((node) => node.textContent = "Chưa lưu");
  };
  for (const form of forms) {
    form.addEventListener("input", mark);
    form.addEventListener("change", mark);
    form.addEventListener("submit", () => { dirty = false; });
  }
  document.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add-row]");
    if (add) {
      const prefix = add.dataset.addRow;
      const tbody = document.querySelector(`#tbl-${CSS.escape(prefix)} tbody`);
      if (!tbody) return;
      const indexes = [...tbody.querySelectorAll(`[name^="${prefix}_"]`)]
        .map((input) => Number(input.name.match(new RegExp(`^${prefix}_(\\d+)_`))?.[1]))
        .filter(Number.isFinite);
      const index = indexes.length ? Math.max(...indexes) + 1 : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = prefixes[prefix].map((field) => {
        const type = field === "ngay" ? "date" : field === "so_luong" ? "number" : null;
        const limits = type === "date" ? ` min="${document.querySelector('input[name=week_start]')?.value || ''}" max="${document.querySelector('input[name=ngay_lap]')?.max || ''}"` : "";
        const attrs = type ? ` type="${type}"${type === "number" ? ' min="1" step="1"' : limits}` : "";
        const control = ["ghi_chu", "noi_dung"].includes(field)
          ? `<textarea name="${prefix}_${index}_${field}"></textarea>`
          : `<input name="${prefix}_${index}_${field}"${attrs}>`;
        return `<td>${control}</td>`;
      }).join("") + `<td><button type="button" class="btn ghost sm" data-delete-row aria-label="Xóa dòng ${index + 1}">Xóa dòng</button></td>`;
      tbody.appendChild(tr);
      tr.querySelector("input,textarea")?.focus();
      mark();
      return;
    }
    const remove = event.target.closest("[data-delete-row]");
    if (remove) { remove.closest("tr")?.remove(); mark(); return; }
    const link = event.target.closest("a[href]");
    if (dirty && link && !confirm("Có thay đổi chưa lưu. Chọn OK để bỏ thay đổi, Cancel để ở lại.")) event.preventDefault();
  });
  addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
})();
