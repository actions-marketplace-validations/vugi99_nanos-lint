print(SharedConfig.retries)

local hud = WebUI("hud", "file://hud.html")
print(hud)

-- Instance APIs of a server-declared class stay available on the client.
---@param weapon Weapon
local function readAmmo(weapon)
  return weapon:GetAmmoClip()
end
print(readAmmo)
