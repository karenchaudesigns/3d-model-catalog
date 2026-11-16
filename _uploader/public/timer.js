/* ==========================================================================
   Shared Floating Activity & Session Timer Widget
   ========================================================================== */
(function() {
  var TIMER_STORAGE_KEY = 'kcd-catalog-active-timer';

  // Inject styles
  var style = document.createElement('style');
  style.textContent = `
    .floating-session-timer {
      position: fixed;
      left: 1.25rem;
      bottom: 4.5rem;
      z-index: 99;
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      background: var(--bg-surface, #ffffff);
      border: 1px solid var(--border-subtle, rgba(0,0,0,0.15));
      border-radius: 999px;
      padding: 0.35rem 0.65rem 0.35rem 0.75rem;
      box-shadow: 0 4px 18px -2px rgba(0, 0, 0, 0.12), 0 2px 6px -1px rgba(0, 0, 0, 0.08);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: 0.8rem;
      color: var(--text-primary, #1c1917);
      user-select: none;
      transition: all 0.2s ease;
      opacity: 0.94;
    }

    .floating-session-timer:hover {
      opacity: 1;
      transform: translateY(-2px);
      box-shadow: 0 6px 22px -2px rgba(0, 0, 0, 0.16);
    }

    .floating-session-timer.is-paused {
      opacity: 0.82;
      border-color: var(--border-strong, #ccc);
    }

    .timer-indicator-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent-terracotta, #c25e3e);
      box-shadow: 0 0 0 2px var(--accent-soft, rgba(194,94,62,0.2));
      animation: timerPulse 2s infinite ease-in-out;
    }

    .floating-session-timer.is-paused .timer-indicator-dot {
      background: var(--text-muted, #888);
      box-shadow: none;
      animation: none;
    }

    @keyframes timerPulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.7; }
    }

    .timer-display-digits {
      font-family: var(--font-mono, monospace);
      font-size: 0.84rem;
      font-weight: 700;
      color: var(--text-primary, #1c1917);
      letter-spacing: 0.04em;
      min-width: 4rem;
      text-align: center;
    }

    .timer-ctrl-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--text-muted, #777);
      width: 1.45rem;
      height: 1.45rem;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 0.75rem;
      transition: all 0.15s ease;
      padding: 0;
    }

    .timer-ctrl-btn:hover {
      background: var(--bg-subtle, rgba(0,0,0,0.06));
      color: var(--text-primary, #111);
    }

    .timer-ctrl-btn.btn-timer-reset:hover {
      color: var(--danger, #dc2626);
    }

    @media (max-width: 640px) {
      .floating-session-timer {
        left: 0.75rem;
        bottom: 4.75rem;
        padding: 0.28rem 0.5rem 0.28rem 0.6rem;
        font-size: 0.74rem;
      }
      .timer-display-digits {
        font-size: 0.78rem;
        min-width: 3.6rem;
      }
    }
  `;
  document.head.appendChild(style);

  // Load state or initialize
  var state = {
    running: true,
    startTime: Date.now(),
    elapsed: 0
  };

  try {
    var raw = sessionStorage.getItem(TIMER_STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (typeof parsed.elapsed === 'number') {
        state.running = Boolean(parsed.running);
        state.elapsed = parsed.elapsed;
        state.startTime = state.running ? (Date.now() - parsed.elapsed) : Date.now();
      }
    }
  } catch (e) {}

  function saveState() {
    try {
      sessionStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify({
        running: state.running,
        elapsed: state.elapsed
      }));
    } catch (e) {}
  }

  function formatTime(ms) {
    var totalSeconds = Math.floor(ms / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    var pad = function(n) { return (n < 10 ? '0' : '') + n; };
    if (hours > 0) {
      return hours + ':' + pad(minutes) + ':' + pad(seconds);
    }
    return pad(minutes) + ':' + pad(seconds);
  }

  // Create UI element
  var container = document.createElement('div');
  container.className = 'floating-session-timer' + (state.running ? '' : ' is-paused');
  container.setAttribute('role', 'timer');
  container.setAttribute('aria-label', 'Session active time tracker');
  container.title = 'Session Timer — Tracks your time editing and reviewing models';

  var dot = document.createElement('span');
  dot.className = 'timer-indicator-dot';
  dot.setAttribute('aria-hidden', 'true');

  var display = document.createElement('span');
  display.className = 'timer-display-digits';
  display.textContent = formatTime(state.elapsed);

  var btnToggle = document.createElement('button');
  btnToggle.type = 'button';
  btnToggle.className = 'timer-ctrl-btn btn-timer-toggle';
  btnToggle.title = state.running ? 'Pause timer' : 'Resume timer';
  btnToggle.setAttribute('aria-label', btnToggle.title);
  btnToggle.innerHTML = state.running ? '&#10074;&#10074;' : '&#9654;';

  var btnReset = document.createElement('button');
  btnReset.type = 'button';
  btnReset.className = 'timer-ctrl-btn btn-timer-reset';
  btnReset.title = 'Reset timer to 00:00';
  btnReset.setAttribute('aria-label', 'Reset timer');
  btnReset.innerHTML = '&#8634;';

  container.appendChild(dot);
  container.appendChild(display);
  container.appendChild(btnToggle);
  container.appendChild(btnReset);

  // Append once DOM is ready
  function attach() {
    if (document.body && !document.getElementById('floating-session-timer')) {
      container.id = 'floating-session-timer';
      document.body.appendChild(container);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  // Timer loop
  function tick() {
    if (state.running) {
      state.elapsed = Date.now() - state.startTime;
      display.textContent = formatTime(state.elapsed);
      saveState();
    }
  }

  var timerInterval = setInterval(tick, 1000);

  // Toggle Pause / Resume
  btnToggle.addEventListener('click', function(e) {
    e.stopPropagation();
    state.running = !state.running;
    if (state.running) {
      state.startTime = Date.now() - state.elapsed;
      container.classList.remove('is-paused');
      btnToggle.innerHTML = '&#10074;&#10074;';
      btnToggle.title = 'Pause timer';
    } else {
      state.elapsed = Date.now() - state.startTime;
      container.classList.add('is-paused');
      btnToggle.innerHTML = '&#9654;';
      btnToggle.title = 'Resume timer';
    }
    saveState();
  });

  // Reset
  btnReset.addEventListener('click', function(e) {
    e.stopPropagation();
    state.elapsed = 0;
    state.startTime = Date.now();
    display.textContent = formatTime(0);
    saveState();
  });
})();
