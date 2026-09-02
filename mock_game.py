import asyncio
import json
import random
import websockets

clients = set()
players = {}
crash_history = []


def snapshot(phase, multiplier=1.0, countdown=5, crash_point=2.8):
    return {
        "type": "state_snapshot",
        "state": {
            "phase": phase,
            "countdown": countdown,
            "multiplier": multiplier,
            "crashPoint": crash_point,
            "activePlayers": list(players.values()),
            "playersTotal": len(players),
            "botsCount": 0,
            "viewersCount": len(clients),
            "crashHistory": list(crash_history)
        }
    }


async def broadcast(message):
    if clients:
        await asyncio.gather(*(client.send(json.dumps(message)) for client in clients), return_exceptions=True)


async def game_loop():
    while True:
        crash_point = round(random.uniform(1.35, 6.5), 2)
        for countdown in range(5, 0, -1):
            await broadcast(snapshot("countdown", 1.0, countdown, crash_point))
            await asyncio.sleep(1)
        await broadcast({"type": "phase_change", "phase": "flying", "multiplier": 1.0, "activePlayers": list(players.values()), "playersTotal": len(players), "crashPoint": crash_point})
        step = 1
        while round(1 + step * 0.06, 2) < crash_point:
            multiplier = round(1 + step * 0.06, 2)
            await broadcast({"type": "multiplier_update", "multiplier": multiplier})
            await asyncio.sleep(0.35)
            step += 1
        crash_history.append(crash_point)
        del crash_history[:-20]
        await broadcast({"type": "crash", "crashPoint": crash_point, "activePlayers": list(players.values()), "playersTotal": len(players), "crashHistory": list(crash_history)})
        players.clear()
        await asyncio.sleep(2)


async def handle(websocket):
    clients.add(websocket)
    await websocket.send(json.dumps(snapshot("countdown", crash_point=crash_history[-1] if crash_history else 2.8)))
    try:
        async for raw in websocket:
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if message.get("type") == "ping":
                await websocket.send(json.dumps({"type": "pong"}))
            elif message.get("type") == "place_bet":
                chat_id = str(message.get("chatId", "demo"))
                player = {"chatId": chat_id, "name": "Demo Player", "betAmount": float(message.get("betAmount", 1) or 1), "cashedOut": False, "isPending": False}
                players[chat_id] = player
                await websocket.send(json.dumps({"type": "bet_response", "success": True}))
                await websocket.send(json.dumps({"type": "pending_bet_added", "player": player}))
                await websocket.send(json.dumps({"type": "self_roster_entry", "player": player}))
            elif message.get("type") == "cancel_bet":
                players.pop(str(message.get("chatId", "demo")), None)
                await websocket.send(json.dumps({"type": "bet_cancelled"}))
            elif message.get("type") == "cash_out":
                chat_id = str(message.get("chatId", "demo"))
                player = players.get(chat_id)
                if player:
                    player["cashedOut"] = True
                    player["cashOutMultiplier"] = float(message.get("multiplier", 1))
                    multiplier = float(message.get("multiplier", 1))
                    win_amount = round(player["betAmount"] * multiplier, 2)
                else:
                    multiplier = float(message.get("multiplier", 1))
                    win_amount = 0
                await websocket.send(json.dumps({"type": "player_cashed_out", "chatId": chat_id, "multiplier": multiplier, "winAmount": win_amount}))
                if player and win_amount > 4:
                    await websocket.send(json.dumps({"type": "gift_won", "awardId": f"demo-{chat_id}-{int(multiplier * 100)}", "giftName": "Vice Cream", "giftPriceTon": 4.08, "giftImageUrl": "/api/gift-image/vice-cream.webp", "wonAtMultiplier": multiplier, "winAmountTon": win_amount}))
    finally:
        clients.discard(websocket)


async def main():
    async with websockets.serve(handle, "localhost", 8765):
        await game_loop()


asyncio.run(main())
