// ===== Rocket crash animation: 💥 =====
(function () {
  const style = document.createElement("style");
  style.textContent = `
    .rocket-explosion {
      position: fixed;
      left: 50%;
      top: 42%;
      transform: translate(-50%, -50%) scale(.2);
      z-index: 99999;
      pointer-events: none;
      font-size: clamp(70px, 18vw, 180px);
      line-height: 1;
      opacity: 0;
      filter: drop-shadow(0 0 18px rgba(255,180,0,.9));
      animation: rocketBoom .9s cubic-bezier(.16,1.2,.3,1) forwards;
    }
    .rocket-crash-number {
      position: fixed;
      left: 50%;
      top: 57%;
      transform: translate(-50%, -50%);
      z-index: 100000;
      pointer-events: none;
      font: 900 clamp(28px, 7vw, 64px)/1.1 system-ui, sans-serif;
      text-align: center;
      opacity: 0;
      animation: crashNumber 1.15s ease-out forwards;
    }
    @keyframes rocketBoom {
      0%   { opacity: 0; transform: translate(-50%,-50%) scale(.2) rotate(-12deg); }
      35%  { opacity: 1; transform: translate(-50%,-50%) scale(1.25) rotate(8deg); }
      65%  { opacity: 1; transform: translate(-50%,-50%) scale(.95) rotate(-4deg); }
      100% { opacity: 0; transform: translate(-50%,-50%) scale(1.5) rotate(0); }
    }
    @keyframes crashNumber {
      0%   { opacity: 0; transform: translate(-50%,-50%) scale(.65); }
      20%  { opacity: 1; transform: translate(-50%,-50%) scale(1.08); }
      75%  { opacity: 1; transform: translate(-50%,-50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%,-50%) scale(.96); }
    }
  `;
  document.head.appendChild(style);

  window.showRocketExplosion = function (value) {
    document.querySelectorAll(".rocket-explosion,.rocket-crash-number")
      .forEach(el => el.remove());

    const boom = document.createElement("div");
    boom.className = "rocket-explosion";
    boom.textContent = "💥";

    const number = document.createElement("div");
    number.className = "rocket-crash-number";
    number.textContent = `💥 انفجر عند ${Number(value).toFixed(2)}x`;

    document.body.append(boom, number);

    setTimeout(() => {
      boom.remove();
      number.remove();
    }, 1300);
  };

  // Hook directly into the WebSocket messages used by the demo.
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new NativeWebSocket(...args);
    ws.addEventListener("message", event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "crash") {
          showRocketExplosion(msg.crashPoint ?? msg.multiplier);
        }
      } catch (_) {}
    });
    return ws;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
})();
