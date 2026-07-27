// On-page indicator: pulsing border + Stop button while the agent is active.
//
// Subscribes to chrome.runtime messages from the service worker:
//   SHOW_AGENT_INDICATORS, HIDE_AGENT_INDICATORS,
//   HIDE_FOR_TOOL_USE, SHOW_AFTER_TOOL_USE.
//
// The HIDE_FOR_TOOL_USE / SHOW_AFTER_TOOL_USE pair lets tools that
// take screenshots or click around briefly clear the overlay so it
// doesn't show up in captures or intercept clicks.

(function () {
  const ORANGE = 'rgba(217, 119, 87,';

  let glow: HTMLDivElement | null = null;
  let stopButton: HTMLDivElement | null = null;
  let agentActive = false;
  let wasAgentActive = false;
  let isMcpSession = false;

  function injectStyles(): void {
    if (document.getElementById('dyspel-agent-styles')) return;
    const style = document.createElement('style');
    style.id = 'dyspel-agent-styles';
    style.textContent = `
      @keyframes dyspel-pulse {
        0%   { box-shadow: inset 0 0 10px ${ORANGE}0.5), inset 0 0 20px ${ORANGE}0.3), inset 0 0 30px ${ORANGE}0.1); }
        50%  { box-shadow: inset 0 0 15px ${ORANGE}0.7), inset 0 0 25px ${ORANGE}0.5), inset 0 0 35px ${ORANGE}0.2); }
        100% { box-shadow: inset 0 0 10px ${ORANGE}0.5), inset 0 0 20px ${ORANGE}0.3), inset 0 0 30px ${ORANGE}0.1); }
      }
    `;
    document.head.appendChild(style);
  }

  function makeGlow(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'dyspel-agent-glow';
    el.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
      opacity: 0; transition: opacity 0.3s ease-in-out;
      animation: dyspel-pulse 2s ease-in-out infinite;
      box-shadow: inset 0 0 10px ${ORANGE}0.5), inset 0 0 20px ${ORANGE}0.3), inset 0 0 30px ${ORANGE}0.1);
    `;
    return el;
  }

  function makeStopButton(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.id = 'dyspel-agent-stop';
    wrap.style.cssText = `
      position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
      pointer-events: none; z-index: 2147483647;
    `;

    const btn = document.createElement('button');
    btn.style.cssText = `
      transform: translateY(100px); opacity: 0;
      padding: 12px 16px; border-radius: 12px;
      background: #FAF9F5; color: #141413;
      border: 0.5px solid rgba(31, 30, 29, 0.4);
      font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: pointer; pointer-events: auto; user-select: none; white-space: nowrap;
      box-shadow: 0 40px 80px ${ORANGE}0.24), 0 4px 14px ${ORANGE}0.24);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    `;
    btn.textContent = 'Stop Dyspel';
    btn.addEventListener('mouseenter', () => { if (agentActive) btn.style.background = '#F5F4F0'; });
    btn.addEventListener('mouseleave', () => { if (agentActive) btn.style.background = '#FAF9F5'; });
    btn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ type: 'STOP_AGENT', fromTabId: 'CURRENT_TAB' });
    });

    wrap.appendChild(btn);
    return wrap;
  }

  function show(): void {
    agentActive = true;
    injectStyles();

    if (glow) {
      glow.style.display = '';
    } else {
      glow = makeGlow();
      document.body.appendChild(glow);
    }

    if (!isMcpSession) {
      if (stopButton) {
        stopButton.style.display = '';
      } else {
        stopButton = makeStopButton();
        document.body.appendChild(stopButton);
      }
    }

    requestAnimationFrame(() => {
      if (glow) glow.style.opacity = '1';
      const btn = stopButton?.querySelector('button');
      if (btn) {
        btn.style.transform = 'translateY(0)';
        btn.style.opacity = '1';
      }
    });
  }

  function hide(): void {
    if (!agentActive) return;
    agentActive = false;

    if (glow) glow.style.opacity = '0';
    const btn = stopButton?.querySelector('button');
    if (btn) {
      btn.style.transform = 'translateY(100px)';
      btn.style.opacity = '0';
    }

    setTimeout(() => {
      if (agentActive) return;
      glow?.remove(); glow = null;
      stopButton?.remove(); stopButton = null;
    }, 300);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'SHOW_AGENT_INDICATORS':
        if (message.isMcp === true) isMcpSession = true;
        show();
        sendResponse({ ok: true });
        return false;

      case 'HIDE_AGENT_INDICATORS':
        hide();
        sendResponse({ ok: true });
        return false;

      case 'HIDE_FOR_TOOL_USE':
        wasAgentActive = agentActive;
        if (glow) glow.style.display = 'none';
        if (stopButton) stopButton.style.display = 'none';
        sendResponse({ ok: true });
        return false;

      case 'SHOW_AFTER_TOOL_USE':
        if (wasAgentActive) {
          if (glow) glow.style.display = '';
          if (stopButton) stopButton.style.display = '';
        }
        wasAgentActive = false;
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });

  window.addEventListener('beforeunload', hide);
})();
