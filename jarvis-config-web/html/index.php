<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jarvis UI V7.3</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <h1>Jarvis V7.3</h1>
    <div class="group">Scripts MCP</div>
    <button class="nav-btn active" data-page="overview">Vue d'ensemble</button>
    <button class="nav-btn" data-page="scripts_admin">Gestion scripts</button>
    <button class="nav-btn" data-page="scripts_test">Test scripts MCP</button>
    <button class="nav-btn" data-page="scripts_catalog">Catalogue MCP</button>
    <button class="nav-btn" data-page="maintenance">Scripts disque</button>
    <div class="group">Runtime</div>
    <button class="nav-btn" data-page="sql">SQL runner</button>
    <button class="nav-btn" data-page="env">ENV</button>
    <button class="nav-btn" data-page="logs">Logs</button>
    <button class="nav-btn" data-page="services">Services</button>
    <button class="nav-btn" data-page="diagnostics">Diagnostics</button>
  </aside>
  <main id="main">
    <header class="topbar">
      <div>
        <h2 id="title">Vue d'ensemble</h2>
        <p id="subtitle">Console admin MCP et runtime</p>
      </div>
      <div class="actions"><button id="refresh-btn" class="secondary-btn">Rafraîchir</button></div>
    </header>
    <section id="content" class="card">Chargement…</section>
  </main>
</div>
<script src="js/app.js"></script>
</body>
</html>
