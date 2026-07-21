const output = document.querySelector("#output");
const summary = document.querySelector("#summary");
const dot = document.querySelector("#dot");
const checkButton = document.querySelector("#check");

async function check() {
  summary.textContent = "確認中";
  dot.className = "dot";

  try {
    const response = await fetch("/api/bootstrap/status", {
      headers: { accept: "application/json" },
    });
    const body = await response.json();
    output.textContent = JSON.stringify(body, null, 2);
    summary.textContent = response.ok
      ? "インフラは応答中"
      : "Workerがエラーを返しました";
    dot.className = response.ok ? "dot ok" : "dot error";
  } catch (error) {
    output.textContent = String(error);
    summary.textContent = "接続失敗";
    dot.className = "dot error";
  }
}

checkButton.addEventListener("click", check);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js");
}
check();
