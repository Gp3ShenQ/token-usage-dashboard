<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <p class="eyebrow">Token 用量儀表板</p>
      <h1>用量總覽</h1>
      <p class="sidebar-note">在桌面上掌握 Claude 與 Codex 的使用狀況。</p>
    </div>
    <nav class="sidebar-nav">
      <RouterLink to="/">總覽</RouterLink>
      <RouterLink to="/sessions">任務排行與搜尋</RouterLink>
      <RouterLink to="/settings">設定</RouterLink>
    </nav>
    <div class="sidebar-footnote">
      <span>資料來源</span>
      <strong>本機記錄檔與狀態列</strong>
    </div>
  </aside>
</template>
