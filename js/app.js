// Renders news.json into the page: a featured card, a grid of cards,
// topic filter chips, and a search box. No frameworks, no build step --
// this file is loaded directly by index.html.

const TOPICS = [
  { id: 'product-management', label: 'Product Management', color: '--topic-product-management', icon: '🧭' },
  { id: 'gcc-politics', label: 'GCC Politics', color: '--topic-gcc-politics', icon: '🏛️' },
  { id: 'ai-consulting', label: 'AI in Consulting', color: '--topic-ai-consulting', icon: '🤖' },
];

const state = {
  articles: [],
  topic: 'all',
  query: '',
};

function topicMeta(id) {
  return TOPICS.find((t) => t.id === id) || { label: id, color: '--text-muted', icon: '📰' };
}

// "3h", "2d", "just now"
function formatAge(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// Swaps a broken <img> for the topic banner, so a dead image link never
// leaves a blank hole in the layout. Exposed globally so the inline
// onerror= handler on each <img> can call it without any HTML escaping.
window.handleImageError = function handleImageError(imgEl, topicId) {
  const meta = topicMeta(topicId);
  const media = imgEl.closest('.media');
  if (!media) return;
  const banner = document.createElement('div');
  banner.className = 'media-fallback';
  banner.innerHTML = `<span>${meta.icon}</span>`;
  imgEl.replaceWith(banner);
};

// Shared "media" block: real image with lazy loading, or a colored
// topic banner + icon if there's no image / it fails to load.
function renderMedia(article) {
  const meta = topicMeta(article.topic);
  const tagHtml = `<span class="topic-tag" style="background:var(${meta.color});">${meta.label}</span>`;

  if (!article.image) {
    return `
      <div class="media">
        ${tagHtml}
        <div class="media-fallback"><span>${meta.icon}</span></div>
      </div>
    `;
  }

  return `
    <div class="media">
      ${tagHtml}
      <img
        src="${escapeAttr(article.image)}"
        alt=""
        loading="lazy"
        onerror="handleImageError(this, '${escapeAttr(article.topic)}')"
      />
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

function renderCard(article) {
  return `
    <a class="card" href="${escapeAttr(article.link)}" target="_blank" rel="noopener">
      ${renderMedia(article)}
      <div class="card-body">
        <p class="headline">${escapeHtml(article.headline)}</p>
        <div class="card-meta">
          <span class="source">${escapeHtml(article.source)}</span>
          <span class="age">${formatAge(article.published)}</span>
        </div>
      </div>
    </a>
  `;
}

function renderFeatured(article) {
  return `
    <a class="featured-card" href="${escapeAttr(article.link)}" target="_blank" rel="noopener">
      ${renderMedia(article)}
      <div class="card-body">
        <p class="headline">${escapeHtml(article.headline)}</p>
        <div class="card-meta">
          <span class="source">${escapeHtml(article.source)}</span>
          <span class="age">${formatAge(article.published)}</span>
        </div>
      </div>
    </a>
  `;
}

function getFilteredArticles() {
  const q = state.query.trim().toLowerCase();
  return state.articles.filter((a) => {
    const topicOk = state.topic === 'all' || a.topic === state.topic;
    const queryOk = !q || a.headline.toLowerCase().includes(q);
    return topicOk && queryOk;
  });
}

function render() {
  const featuredEl = document.getElementById('featured');
  const gridEl = document.getElementById('grid');
  const emptyEl = document.getElementById('emptyState');

  const filtered = getFilteredArticles();
  const showFeatured = state.topic === 'all' && !state.query.trim() && filtered.length > 0;

  if (showFeatured) {
    featuredEl.innerHTML = renderFeatured(filtered[0]);
    featuredEl.hidden = false;
    gridEl.innerHTML = filtered.slice(1).map(renderCard).join('');
  } else {
    featuredEl.hidden = true;
    featuredEl.innerHTML = '';
    gridEl.innerHTML = filtered.map(renderCard).join('');
  }

  emptyEl.hidden = filtered.length > 0;
}

function renderChips() {
  const chipsEl = document.getElementById('chips');
  const allTopics = [{ id: 'all', label: 'All' }, ...TOPICS];
  chipsEl.innerHTML = allTopics
    .map(
      (t) => `
      <button class="chip" data-topic="${t.id}" aria-pressed="${t.id === state.topic}">
        ${escapeHtml(t.label)}
      </button>
    `
    )
    .join('');

  chipsEl.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.topic = btn.dataset.topic;
      renderChips();
      render();
    });
  });
}

function formatLastUpdated(isoDate) {
  const d = new Date(isoDate);
  return `Updated ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(
    undefined,
    { hour: 'numeric', minute: '2-digit' }
  )}`;
}

async function init() {
  const loadingEl = document.getElementById('loadingState');
  try {
    const res = await fetch('news.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.articles = data.articles || [];
    document.getElementById('lastUpdated').textContent = data.generatedAt
      ? formatLastUpdated(data.generatedAt)
      : '';
  } catch (err) {
    loadingEl.textContent =
      "Couldn't load news.json. Run fetch-feeds.js first, then reload this page. (" + err.message + ')';
    return;
  }

  loadingEl.hidden = true;
  renderChips();
  render();

  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.query = e.target.value;
    render();
  });
}

init();
