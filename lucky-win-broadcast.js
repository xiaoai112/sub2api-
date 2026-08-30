(() => {
  'use strict';

  const API = '/lucky-api/admin/win-broadcast';
  const ID = 'lucky-win-broadcast';
  const STYLE_ID = 'lucky-win-broadcast-style';
  let refreshTimer = null;
  let mounted = false;

  const isHiddenRoute = () => {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    return path === '/'
      || path === '/home'
      || path === '/jiaocheng.html'
      || path === '/lucky-draw.html'
      || path === '/lucky-draw.htm'
      || path === '/community.html'
      || path === '/community.php'
      || path === '/static/lucky-draw.html'
      || path === '/static/lucky-draw.htm'
      || path === '/static/community.html'
      || path === '/static/community.php'
      || path === '/models'
      || path === '/model'
      || path === '/model-square'
      || path === '/model-plaza'
      || path.startsWith('/models/')
      || path.startsWith('/model/')
      || path.startsWith('/model-square/')
      || path.startsWith('/model-plaza/')
      || path === '/login'
      || path.startsWith('/login/');
  };

  function token() {
    return localStorage.getItem('auth_token') || '';
  }

  function remove() {
    const box = document.getElementById(ID);
    const style = document.getElementById(STYLE_ID);
    if (box) box.remove();
    if (style) style.remove();
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    mounted = false;
  }

  function hideOnRestrictedRoute() {
    if (!isHiddenRoute()) return false;
    remove();
    document.documentElement.classList.add('lucky-win-broadcast-hidden');
    return true;
  }

  function mount() {
    if (hideOnRestrictedRoute() || !token()) {
      remove();
      return;
    }
    document.documentElement.classList.remove('lucky-win-broadcast-hidden');
    if (!document.body || mounted || document.getElementById(ID)) return;

    const box = document.createElement('div');
    box.id = ID;
    box.setAttribute('aria-live', 'polite');
    box.innerHTML = '<span class="lucky-win-track"><span class="lucky-win-copy">中奖播报加载中...</span></span>';
    document.body.insertBefore(box, document.body.firstChild);

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.lucky-win-broadcast-hidden #lucky-win-broadcast{display:none!important}#lucky-win-broadcast{position:fixed;left:255px;right:0;top:58px;height:30px;display:block;overflow:hidden;padding:0 16px;background:#e8f6f2;border-top:1px solid #bfe2de;border-bottom:1px solid #bfe2de;color:#0f625f;font:13px/30px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;white-space:nowrap;z-index:30;pointer-events:none}.lucky-win-track{display:inline-flex;min-width:max-content;animation:luckyWinBroadcast 30s linear infinite}.lucky-win-copy{display:inline-block;padding-right:8em}@keyframes luckyWinBroadcast{from{transform:translateX(0)}to{transform:translateX(-5%)}}@media(max-width:700px){#lucky-win-broadcast{left:0;right:0;top:56px;height:28px;padding:0 8px;font-size:11px;line-height:28px}}';
    document.head.appendChild(style);

    const setMessage = (message) => {
      const track = box.querySelector('.lucky-win-track');
      if (!track) return;
      track.innerHTML = Array.from({ length: 24 }, () => `<span class="lucky-win-copy">${message}</span>`).join('');
    };
    setMessage('中奖播报加载中...');

    async function refresh() {
      if (isHiddenRoute() || !token()) {
        remove();
        return;
      }
      const t = token();
      if (!t) return;
      try {
        const res = await fetch(API, {
          headers: { Authorization: 'Bearer ' + t },
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const body = await res.json();
        const payload = body && body.data !== undefined ? body.data : body;
        const items = Array.isArray(payload)
          ? payload
          : (payload && (payload.items || payload.users || payload.records)) || [];
        setMessage(items.length
          ? items.map((item) => {
            const user = item.user || item.username || item.email || item.email_address || '用户';
            const prize = item.prize || item.name || '';
            const value = item.value ?? item.amount;
            return prize === '谢谢参与'
              ? `${user} ${prize} ${value ?? 0} 额度`
              : `${user} ${prize || '中奖'} ${value ?? 0} 额度`;
          }).join('　　|　　')
          : '暂无中奖记录');
      } catch (_) {
        setMessage('中奖播报暂不可用');
      }
    }

    mounted = true;
    refresh();
    refreshTimer = window.setInterval(refresh, 60000);
  }

  function checkRoute() {
    if (hideOnRestrictedRoute()) return;
    mount();
  }

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    window.dispatchEvent(new Event('lucky-route-change'));
    return result;
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    window.dispatchEvent(new Event('lucky-route-change'));
    return result;
  };

  window.addEventListener('popstate', checkRoute);
  window.addEventListener('lucky-route-change', checkRoute);
  window.addEventListener('hashchange', checkRoute);

  const start = () => {
    checkRoute();
    window.setTimeout(checkRoute, 1000);
    window.setTimeout(checkRoute, 3000);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
