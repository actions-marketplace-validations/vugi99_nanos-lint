-- Cross-realm violation: server-only static class.
Server.ChangeMap("some-map")

ClientSideState = 42

local hud = WebUI("hud", "file://hud.html")
print(hud)
