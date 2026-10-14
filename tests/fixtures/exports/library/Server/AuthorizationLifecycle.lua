local AuthorizationLifecycle = {}

---@class ExportsLibraryPerms
local VPerms = {}

---@param player Player
function VPerms.LoadPlayer(player) end

---@return integer
function VPerms.GetLoadedCount() return 0 end

---@class ExportsLibraryLifecycle
---@field VPerms ExportsLibraryPerms

---@return ExportsLibraryLifecycle
function AuthorizationLifecycle.New()
    return { VPerms = VPerms }
end

return AuthorizationLifecycle
