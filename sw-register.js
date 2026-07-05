if ("serviceWorker" in navigator) {
  // 新しいService Workerが制御を引き継いだら1回だけ自動リロードし、最新版へ即時更新する。
  // （refreshingフラグでリロードの無限ループを防止）
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // タブを開いたままの時も定期的に更新を確認（1時間ごと）
      setInterval(() => reg.update(), 60 * 60 * 1000);
    });
  });
}
