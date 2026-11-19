async function openPromptMatchPage() {
  const message = document.getElementById("message");
  const retry = document.getElementById("retry");
  if (retry) retry.hidden = true;
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    const configured = Number(options && options.uiPort);
    const port =
      Number.isInteger(configured) && configured > 0 && configured <= 65535
        ? configured
        : 47831;
    const address = new URL(magpie.service || `http://127.0.0.1:${port}/`);
    address.hash = new URLSearchParams({
      theme: JSON.stringify(magpie.theme || {}),
    }).toString();
    location.replace(address.href);
  } catch {
    const isZh = /^zh/i.test((window.magpie && magpie.theme && magpie.theme.lang) || "");
    if (message) {
      message.textContent = isZh
        ? "无法打开 Prompt Match 配置页。请确认插件已启用后重试，或使用 prompt-match CLI。"
        : "Could not open Prompt Match UI. Check that the plugin is enabled and retry, or use prompt-match CLI.";
    }
    if (retry) retry.hidden = false;
  }
}

document.getElementById("retry")?.addEventListener("click", openPromptMatchPage);
openPromptMatchPage();
